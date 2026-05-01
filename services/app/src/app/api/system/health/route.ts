/**
 * GET /api/system/health — probe les services backend de la AI Box
 * (Dify API, Ollama, Authentik, n8n, Prometheus). Retourne pour chacun :
 *   { name, ok, latency_ms?, error?, version? }
 *
 * Cet endpoint est consommé par le dashboard /system pour l'indicateur
 * « tout est vert ». Il sert aussi de check rapide en démo.
 *
 * Conçu pour être rapide : timeout de 2.5 s par probe, exécutés en
 * parallèle. Pas d'auth requise au niveau du dashboard (les valeurs
 * sont déjà filtrées au niveau /system côté UI), mais l'endpoint
 * exige une session authentifiée pour éviter l'exposition publique
 * des URLs internes.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface HealthResult {
  /** Identifiant stable (slug) — utilisé côté UI pour mapper l'icône. */
  key: string;
  /** Nom affichable. */
  name: string;
  /** Service joignable et HTTP status acceptable. */
  ok: boolean;
  /** Temps de la requête (round-trip), en ms. Null si erreur réseau. */
  latency_ms: number | null;
  /** Statut HTTP retourné (utile au debug). */
  status?: number;
  /** Message d'erreur court si ok=false. */
  error?: string;
  /** Version du service si exposée par le probe (ex. Ollama). */
  version?: string;
  /** Service optionnel (sidecar feature-flag) : un down ne casse pas l'overall. */
  optional?: boolean;
}

interface ProbeSpec {
  key: string;
  name: string;
  url: string;
  /** Codes HTTP qui comptent comme « up ». Defaut: 200, 204. */
  okCodes?: number[];
  /** Si la réponse est du JSON, extraire un champ « version ». */
  versionField?: string;
  /** Si true et probe down → ne casse pas l'overall (service activable
   *  selon HW_PROFILE et features). */
  optional?: boolean;
}

const TIMEOUT_MS = 2500;

async function probe(spec: ProbeSpec): Promise<HealthResult> {
  const t0 = Date.now();
  const okCodes = spec.okCodes || [200, 204];
  try {
    const r = await fetch(spec.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // Petit hint UA pour les logs des services en face
      headers: { "user-agent": "aibox-app/health-probe" },
    });
    const latency_ms = Date.now() - t0;
    const ok = okCodes.includes(r.status);
    let version: string | undefined;
    if (ok && spec.versionField) {
      try {
        const j = await r.json();
        if (j && typeof j[spec.versionField] === "string") {
          version = j[spec.versionField];
        }
      } catch { /* ignore */ }
    }
    return {
      key: spec.key,
      name: spec.name,
      ok,
      latency_ms,
      status: r.status,
      error: ok ? undefined : `HTTP ${r.status}`,
      version,
      optional: spec.optional || false,
    };
  } catch (e: unknown) {
    return {
      key: spec.key,
      name: spec.name,
      ok: false,
      latency_ms: null,
      error: errorMessage(e),
      optional: spec.optional || false,
    };
  }
}

function errorMessage(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return `timeout ${TIMEOUT_MS}ms`;
  }
  return (err?.message || "unreachable").slice(0, 120);
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Configuration des probes — URLs lues depuis l'env (avec fallbacks
  // identiques au reste de l'app). Si une URL est absente, on skip
  // simplement le service plutôt que d'afficher un faux rouge.
  const DIFY = process.env.DIFY_BASE_URL || "http://localhost:8081";
  const N8N = process.env.N8N_BASE_URL || "http://localhost:5678";
  const AUTHENTIK = process.env.AUTHENTIK_API_URL || "http://localhost:9000";
  const PROM = process.env.PROMETHEUS_URL || "http://localhost:9090";
  // Ollama : pas de var dédiée pour l'app (Dify lui parle directement),
  // mais on peut le sonder via l'URL host par défaut.
  const OLLAMA = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  // Sidecars optionnels (services activés selon HW_PROFILE et features)
  const QDRANT = process.env.QDRANT_URL || "http://localhost:6333";
  const AGENTS = process.env.AGENTS_BASE_URL || "http://localhost:8085";
  const MEM0 = process.env.MEM0_BASE_URL || "http://localhost:8087";
  const PENNYLANE = process.env.PENNYLANE_TOOL_URL || "http://localhost:8090";
  const FEC = process.env.FEC_TOOL_URL || "http://localhost:8091";

  const probes: ProbeSpec[] = [
    {
      key: "dify",
      name: "Dify",
      // /console/api/setup retourne 200 que le wizard soit fait ou non.
      url: `${DIFY}/console/api/setup`,
    },
    {
      key: "ollama",
      name: "Ollama",
      url: `${OLLAMA}/api/version`,
      versionField: "version",
    },
    {
      key: "authentik",
      name: "Authentik",
      // /-/health/live/ retourne 204 quand l'app est démarrée
      url: `${AUTHENTIK}/-/health/live/`,
      okCodes: [200, 204],
    },
    {
      key: "n8n",
      name: "n8n",
      url: `${N8N}/healthz`,
    },
    {
      key: "prometheus",
      name: "Prometheus",
      // /-/healthy renvoie « Prometheus Server is Healthy. »
      url: `${PROM}/-/healthy`,
    },
    {
      key: "qdrant",
      name: "Qdrant",
      // /readyz vs /healthz selon version. /readyz est stable depuis 1.7.
      url: `${QDRANT}/readyz`,
    },
    {
      key: "agents",
      name: "Agents Autonomes",
      url: `${AGENTS}/healthz`,
      optional: true,
    },
    {
      key: "memory",
      name: "Mémoire long-terme",
      url: `${MEM0}/healthz`,
      optional: true,
    },
    {
      key: "pennylane",
      name: "Connecteur Pennylane",
      url: `${PENNYLANE}/healthz`,
      optional: true,
    },
    {
      key: "fec",
      name: "Import FEC",
      url: `${FEC}/healthz`,
      optional: true,
    },
  ];

  const results = await Promise.all(probes.map(probe));
  // Pour le summary/overall, on ne compte QUE les services core (non optionnels).
  // Les sidecars (agents/mem0/pennylane/fec) sont visibles dans la liste mais
  // ne font pas passer l'overall en degraded s'ils sont down (feature off).
  const core = results.filter((r) => !r.optional);
  const summary = {
    total: core.length,
    up: core.filter((r) => r.ok).length,
    down: core.filter((r) => !r.ok).length,
  };
  const overall: "ok" | "degraded" | "down" =
    summary.down === 0 ? "ok"
    : summary.up === 0 ? "down"
    : "degraded";

  return NextResponse.json({
    overall,
    summary,
    services: results,
    checked_at: new Date().toISOString(),
  });
}
