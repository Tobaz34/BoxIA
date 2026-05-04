/**
 * GET /api/connectors/sync-status?slug=google-drive
 *
 * Statut runtime d'un worker connecteur (rag-gdrive, rag-msgraph) :
 *   - container running ? Up since X
 *   - docker logs : dernière ligne contenant "Sync OK" ou "Sync KO"
 *   - Qdrant collection : count points
 *   - state : idle | syncing | error
 *
 * Lit via docker socket Unix (/var/run/docker.sock mounté en RO dans
 * services/app/docker-compose.yml). Pas de docker CLI dans le container —
 * on parle directement à l'API Docker Engine HTTP via socketPath.
 *
 * Ne déclenche PAS un sync — ça c'est /api/connectors/sync-now.
 *
 * Admin only (lecture d'état infra).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import http from "node:http";

export const dynamic = "force-dynamic";

// Mapping slug UI → container worker + collection Qdrant
const SLUG_MAP: Record<
  string,
  { container: string; collection_prefix: string; provider: "google" | "microsoft" }
> = {
  "google-drive": {
    container: "aibox-conn-rag-gdrive",
    collection_prefix: "rag_gdrive_",
    provider: "google",
  },
  "onedrive": {
    container: "aibox-conn-rag-msgraph",
    collection_prefix: "rag_msgraph_",
    provider: "microsoft",
  },
  "sharepoint-online": {
    container: "aibox-conn-rag-msgraph",
    collection_prefix: "rag_msgraph_",
    provider: "microsoft",
  },
};

const DOCKER_SOCK = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";

interface DockerInspect {
  State?: {
    Status?: string;
    Running?: boolean;
    StartedAt?: string;
    FinishedAt?: string;
    ExitCode?: number;
  };
}

/**
 * Requête HTTP vers le Docker Engine via socket Unix.
 * Renvoie { status, body } où body est parsé JSON si possible.
 */
function dockerRequest(
  path: string,
  opts: { method?: string; query?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let url = path;
    if (opts.query && Object.keys(opts.query).length > 0) {
      const qs = new URLSearchParams(opts.query).toString();
      url += `?${qs}`;
    }
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: url,
        method: opts.method || "GET",
        headers: { Host: "docker", Accept: "application/json" },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { data += c; });
        res.on("end", () => {
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep raw */ }
          resolve({ status: res.statusCode || 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("docker_socket_timeout"));
    });
    req.end();
  });
}

async function getContainerState(name: string): Promise<{
  found: boolean;
  running: boolean;
  startedAt?: string;
  status?: string;
  exitCode?: number;
}> {
  const r = await dockerRequest(`/containers/${name}/json`);
  if (r.status === 404) return { found: false, running: false };
  if (r.status !== 200) {
    throw new Error(`docker_inspect_${r.status}`);
  }
  const i = r.body as DockerInspect;
  return {
    found: true,
    running: !!i.State?.Running,
    startedAt: i.State?.StartedAt,
    status: i.State?.Status,
    exitCode: i.State?.ExitCode,
  };
}

/**
 * Récupère les dernières lignes de logs (stdout+stderr) du container.
 * Filtre côté Node sur le pattern, garde la dernière qui matche.
 */
async function getLastLogLine(
  container: string,
  pattern: RegExp,
  tailLines: number = 200,
): Promise<string | null> {
  // L'API Docker /logs renvoie un stream multiplexé (8 octets de header par
  // frame stdout/stderr). On demande tail=200 et on parse côté Node.
  const r = await dockerRequest(`/containers/${container}/logs`, {
    query: { stdout: "1", stderr: "1", tail: String(tailLines), timestamps: "0" },
  });
  if (r.status !== 200) return null;
  // Body est string (raw, on a JSON.parse échoué → fallback string).
  const raw = typeof r.body === "string" ? r.body : "";
  if (!raw) return null;
  // Démultiplexer : chaque frame = 8 bytes header [stream, 0,0,0, sz_be32] + payload.
  // En pratique Node a déjà décodé le stream en utf-8, donc les bytes header
  // apparaissent comme caractères de contrôle. On ignore les caractères de
  // contrôle non-printables et on split sur newline.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  const lines = cleaned.split("\n").filter(Boolean);
  // Dernière ligne qui matche
  for (let i = lines.length - 1; i >= 0; i--) {
    if (pattern.test(lines[i])) return lines[i].trim();
  }
  return null;
}

async function getQdrantCount(collection: string): Promise<{ count: number; status: string } | null> {
  try {
    const base = process.env.QDRANT_URL || "http://localhost:6333";
    const apiKey = process.env.QDRANT_API_KEY || "";
    const r = await fetch(`${base}/collections/${collection}`, {
      headers: apiKey ? { "api-key": apiKey } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (r.status === 404) return { count: 0, status: "no_collection" };
    if (!r.ok) return null;
    const j = await r.json();
    return {
      count: j.result?.points_count || 0,
      status: j.result?.status || "unknown",
    };
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug || !SLUG_MAP[slug]) {
    return NextResponse.json(
      { error: "unsupported_slug", slug, supported: Object.keys(SLUG_MAP) },
      { status: 400 },
    );
  }
  const m = SLUG_MAP[slug];
  const tenant = (process.env.CLIENT_NAME || "default").toUpperCase();
  const collection = `${m.collection_prefix}${tenant}`;

  // 1. Container state
  let containerState;
  try {
    containerState = await getContainerState(m.container);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({
      slug,
      container: m.container,
      collection,
      running: false,
      error: "docker_unreachable",
      hint: errMsg,
    });
  }

  if (!containerState.found) {
    return NextResponse.json({
      slug,
      container: m.container,
      collection,
      running: false,
      not_started: true,
      hint:
        `Le worker ${m.container} n'est pas démarré. Lance ` +
        `tools/start-connector.sh ${slug.includes("drive") ? "rag-gdrive" : "rag-msgraph"} --rebuild ` +
        `(ou utilise le bouton « Synchroniser » dans l'UI).`,
    });
  }

  // 2. Qdrant count (parallèle avec les logs si on veut, sinon en série)
  const [qdrant, lastSync] = await Promise.all([
    getQdrantCount(collection),
    getLastLogLine(m.container, /Sync OK|Sync KO/),
  ]);

  const lastSyncOk = lastSync?.includes("Sync OK") ?? null;

  // Heuristique state : running + last_sync OK récent → idle ; running + KO → error ;
  // running + jamais de Sync ligne → syncing (premier run en cours)
  let state: "idle" | "syncing" | "error" | "stopped" = "stopped";
  if (containerState.running) {
    if (lastSync === null) state = "syncing";
    else if (lastSyncOk) state = "idle";
    else state = "error";
  }

  return NextResponse.json({
    slug,
    container: m.container,
    collection,
    running: containerState.running,
    state,
    started_at: containerState.startedAt,
    container_status: containerState.status,
    qdrant: qdrant
      ? { points: qdrant.count, status: qdrant.status }
      : { points: 0, status: "qdrant_unreachable" },
    last_sync: {
      ok: lastSyncOk,
      log_line: lastSync || null,
    },
  });
}
