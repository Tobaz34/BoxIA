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
/**
 * Lit les logs bruts (Buffer non-décodé) du container via UDS, parse les
 * frames du stream multiplexé Docker, et renvoie la dernière ligne qui
 * matche le pattern.
 *
 * Frame Docker = 8 bytes header [stream(1), 0,0,0, size_be32(4)] + payload.
 */
function dockerLogsRaw(container: string, tailLines: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({
      stdout: "1", stderr: "1", tail: String(tailLines), timestamps: "0",
    }).toString();
    const req = http.request(
      {
        socketPath: DOCKER_SOCK,
        path: `/containers/${container}/logs?${qs}`,
        method: "GET",
        headers: { Host: "docker", Accept: "application/octet-stream" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        // Pas de setEncoding — on veut les bytes bruts pour parser les
        // frame headers (qui contiennent des octets non-utf8 valides).
        res.on("data", (c: Buffer) => { chunks.push(c); });
        res.on("end", () => {
          if ((res.statusCode || 0) !== 200) {
            return reject(new Error(`docker_logs_${res.statusCode}`));
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("docker_logs_timeout")));
    req.end();
  });
}

async function getLastLogLine(
  container: string,
  pattern: RegExp,
  tailLines: number = 200,
): Promise<string | null> {
  let buf: Buffer;
  try {
    buf = await dockerLogsRaw(container, tailLines);
  } catch {
    return null;
  }
  if (buf.length === 0) return null;

  // Démultiplexage frame-par-frame.
  // Header = stream(1) ∈ {0,1,2}, 3 bytes padding (0), size_be32(4).
  let offset = 0;
  let payload = "";
  while (offset + 8 <= buf.length) {
    const stream = buf[offset];
    if (
      stream > 2 ||
      buf[offset + 1] !== 0 ||
      buf[offset + 2] !== 0 ||
      buf[offset + 3] !== 0
    ) {
      // Pas un header valide → fallback : traiter tout le reste comme
      // texte brut (containers en mode tty:true).
      payload += buf.slice(offset).toString("utf-8");
      break;
    }
    const size = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + size > buf.length) break; // frame tronquée
    payload += buf.slice(offset, offset + size).toString("utf-8");
    offset += size;
  }

  const lines = payload.split("\n").filter(Boolean);
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
