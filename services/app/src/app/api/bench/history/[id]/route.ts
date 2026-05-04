/**
 * GET /api/bench/history/<id> — détail complet d'un run de benchmark.
 *
 * Retourne le contenu de /data/bench/runs/<id>/results.json (results +
 * summary), permettant à l'UI d'afficher prompt par prompt :
 *   - score local + détail des scorers (passed/failed avec raison)
 *   - score cloud + détail
 *   - réponse extraite (truncated 5000 chars)
 *   - latence
 *
 * Auth admin uniquement (mêmes raisons que /api/bench/history).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const BENCH_RUNS_DIR = process.env.BENCH_RUNS_DIR
  || path.join(process.env.CONNECTORS_STATE_DIR || "/data", "bench", "runs");

// Anti-traversal : un run id ne peut contenir que des [a-zA-Z0-9_-]+
const RUN_ID_RE = /^[a-zA-Z0-9_-]+$/;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as { isAdmin?: boolean })?.isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!RUN_ID_RE.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const resultsPath = path.join(BENCH_RUNS_DIR, id, "results.json");
  let raw: string;
  try {
    raw = await fs.readFile(resultsPath, "utf-8");
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") {
      return NextResponse.json(
        { error: "not_found", message: `Run ${id} introuvable ou pas encore terminé` },
        { status: 404 },
      );
    }
    throw e;
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "corrupt_json" }, { status: 500 });
  }

  return NextResponse.json(data);
}
