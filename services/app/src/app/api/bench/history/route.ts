/**
 * GET /api/bench/history — liste les runs du bench (CLI ou UI) stockés
 * dans /data/bench/runs/<timestamp>/results.json.
 *
 * Renvoie un tableau ordonné par date desc avec un résumé par run :
 *   { id, generated_at, n_executed, local_avg, cloud_avg, ratio, by_category }
 *
 * Le résultat complet d'un run particulier est accessible via
 * /api/bench/history/<id> (à implémenter en V2 si besoin).
 *
 * Auth admin uniquement (l'observabilité expose des données infra
 * sensibles : noms d'agents, structure d'évaluation, etc.).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const BENCH_RUNS_DIR = process.env.BENCH_RUNS_DIR
  || path.join(process.env.CONNECTORS_STATE_DIR || "/data", "bench", "runs");

interface RunSummary {
  id: string;
  generated_at: string | null;
  n_executed: number;
  n_skipped: number;
  local_avg_score: number | null;
  cloud_avg_score: number | null;
  ratio_local_over_cloud: number | null;
  local_avg_latency_s: number | null;
  cloud_avg_latency_s: number | null;
  by_category: Record<string, { local_avg: number; cloud_avg: number; n: number }>;
}

async function listRuns(dir: string): Promise<RunSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") return [];
    throw e;
  }

  const out: RunSummary[] = [];
  for (const id of entries) {
    const resultsPath = path.join(dir, id, "results.json");
    try {
      const raw = await fs.readFile(resultsPath, "utf8");
      const data = JSON.parse(raw);
      const s = data.summary || {};
      const m = s.meta || {};
      out.push({
        id,
        generated_at: m.generated_at || null,
        n_executed: m.n_executed || 0,
        n_skipped: s.n_skipped || 0,
        local_avg_score: s.local_avg_score ?? null,
        cloud_avg_score: s.cloud_avg_score ?? null,
        ratio_local_over_cloud: s.ratio_local_over_cloud ?? null,
        local_avg_latency_s: s.local_avg_latency_s ?? null,
        cloud_avg_latency_s: s.cloud_avg_latency_s ?? null,
        by_category: s.by_category || {},
      });
    } catch {
      // Run incomplet ou corrompu — on skip silencieusement
    }
  }

  // Tri date desc (string ISO comparé alphabétiquement = OK)
  out.sort((a, b) => (b.generated_at || "").localeCompare(a.generated_at || ""));
  return out;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const runs = await listRuns(BENCH_RUNS_DIR);
  return NextResponse.json({
    runs,
    runs_dir: BENCH_RUNS_DIR,
    total: runs.length,
  });
}
