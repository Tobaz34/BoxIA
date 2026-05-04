/**
 * POST /api/bench/run — lance un run de benchmark en background.
 *
 * Spawn `python3 tools/bench/run-bench.py` avec les args choisis par l'UI.
 * Retourne immédiatement avec un `run_id` que l'UI peut poller via
 * /api/bench/run/<run_id> (à implémenter en V2 si besoin) ou en
 * relisant /api/bench/history.
 *
 * GET /api/bench/run — liste les runs en cours (status indicator).
 *
 * NOTE V1 : implémentation simplifiée — on spawn et on oublie. Pas de
 * vrai job queue (pas de Redis/PG worker). Le runner Python écrit le
 * progress dans /data/bench/runs/<id>/progress.json (à ajouter au
 * runner CLI). Pour V1 on se contente d'un fichier `started_at` qui
 * indique qu'un run est actif, et on considère terminé quand le
 * results.json apparaît.
 *
 * Auth admin uniquement.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { logAction } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const BENCH_RUNS_DIR = process.env.BENCH_RUNS_DIR
  || path.join(process.env.CONNECTORS_STATE_DIR || "/data", "bench", "runs");

// Le runner Python est dans tools/bench/run-bench.py côté repo. Côté
// container le repo est bind-mount sur /repo (cf. docker-compose.yml).
// Si le bind n'est pas fait, on tente /workspace puis le chemin relatif.
const REPO_PATHS = [
  process.env.AIBOX_REPO_PATH,
  "/repo",
  "/workspace",
  "/app/.repo",
].filter((p): p is string => !!p);

interface BenchRunBody {
  category?: string;
  prompt_id?: string;
  agent?: string;
  skip_cloud?: boolean;
  skip_local?: boolean;
}

async function findRunner(): Promise<string | null> {
  for (const base of REPO_PATHS) {
    const p = path.join(base, "tools", "bench", "run-bench.py");
    try {
      await fs.access(p);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

async function listActiveRuns(): Promise<Array<{id: string; started_at: string; pid?: number}>> {
  let entries: string[];
  try { entries = await fs.readdir(BENCH_RUNS_DIR); }
  catch { return []; }
  const out: Array<{id: string; started_at: string; pid?: number}> = [];
  for (const id of entries) {
    const startedFile = path.join(BENCH_RUNS_DIR, id, "started_at");
    const resultsFile = path.join(BENCH_RUNS_DIR, id, "results.json");
    try {
      // Started but not finished
      const meta = JSON.parse(await fs.readFile(startedFile, "utf8"));
      try { await fs.access(resultsFile); continue; } catch { /* not finished, keep */ }
      out.push({ id, started_at: meta.started_at, pid: meta.pid });
    } catch { /* skip */ }
  }
  return out;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!(session?.user as { isAdmin?: boolean })?.isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const active = await listActiveRuns();
  return NextResponse.json({ active });
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!(session?.user as { isAdmin?: boolean })?.isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: BenchRunBody = {};
  try { body = await req.json(); } catch { /* body vide accepté */ }

  // 1. Vérifier qu'aucun run n'est déjà en cours (un seul à la fois pour
  //    pas saturer le GPU — le bench est intensif).
  const active = await listActiveRuns();
  if (active.length > 0) {
    return NextResponse.json(
      {
        error: "run_in_progress",
        active,
        message: `Un run est déjà en cours (${active[0].id}). Attendez sa fin ou tuez le process.`,
      },
      { status: 409 },
    );
  }

  // 2. Localiser le runner
  const runner = await findRunner();
  if (!runner) {
    return NextResponse.json(
      {
        error: "runner_not_found",
        searched: REPO_PATHS.map((p) => path.join(p, "tools/bench/run-bench.py")),
        message: "Le script tools/bench/run-bench.py n'est pas accessible depuis le container. "
               + "Bind-mount /repo dans services/app/docker-compose.yml.",
      },
      { status: 503 },
    );
  }

  // 3. Préparer le run
  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outDir = path.join(BENCH_RUNS_DIR, runId);
  await fs.mkdir(outDir, { recursive: true });

  // 4. Cookie session : on récupère depuis le header (l'UI poste avec
  //    son propre cookie, on le passe au subprocess).
  const cookie = req.headers.get("cookie") || "";

  // 5. Build args
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3100";
  const args = [
    runner,
    "--base-url", baseUrl,
    "--cookie", cookie,
    "--out-dir", outDir,
  ];
  if (body.category) args.push("--category", body.category);
  if (body.prompt_id) args.push("--prompt-id", body.prompt_id);
  if (body.agent) args.push("--agent", body.agent);
  if (body.skip_cloud) args.push("--skip-cloud");
  if (body.skip_local) args.push("--skip-local");

  // 6. Spawn detached pour ne pas bloquer la réponse
  const child = spawn("python3", args, {
    detached: true,
    stdio: ["ignore",
      // Redirige stdout/stderr dans le run dir pour debug
      await fs.open(path.join(outDir, "stdout.log"), "a").then((h) => h.fd).catch(() => "ignore" as const),
      await fs.open(path.join(outDir, "stderr.log"), "a").then((h) => h.fd).catch(() => "ignore" as const),
    ],
    env: {
      ...process.env,
      BENCH_COOKIE: cookie,
      PYTHONIOENCODING: "utf-8",
    },
  });
  child.unref();

  // 7. Marquer comme started
  await fs.writeFile(
    path.join(outDir, "started_at"),
    JSON.stringify({
      run_id: runId,
      started_at: new Date().toISOString(),
      started_by: session?.user?.email,
      pid: child.pid,
      args: { ...body, base_url: baseUrl },
    }),
    "utf8",
  );

  // 8. Audit
  await logAction("bench.start", runId, body as Record<string, unknown>);

  return NextResponse.json({
    ok: true,
    run_id: runId,
    pid: child.pid,
    out_dir: outDir,
    message: "Bench démarré en background. Recharger /api/bench/history pour voir le résultat (typiquement 1-30 min selon scope).",
  });
}
