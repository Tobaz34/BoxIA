/**
 * POST /api/seed-demo — charge les données de démo dans la KB.
 *
 * Lit les fichiers Markdown depuis le dossier public seed (montés dans
 * le container) et les uploade comme documents Dify dans le dataset
 * partagé. Idempotent : skip les docs déjà présents.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { DIFY_BASE_URL, DIFY_KB_API_KEY, DIFY_DEFAULT_DATASET_ID } from "@/lib/dify-kb";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

// Le dossier seed-data du repo est monté dans le container à /seed-data
// (cf. docker-compose.yml).
const SEED_DIR = process.env.SEED_DEMO_DIR || "/seed-data";

interface DifyDoc { id: string; name: string; }

async function listExistingDocs(): Promise<Set<string>> {
  try {
    const r = await fetch(
      `${DIFY_BASE_URL}/v1/datasets/${DIFY_DEFAULT_DATASET_ID}/documents?limit=100`,
      { headers: { Authorization: `Bearer ${DIFY_KB_API_KEY}` } },
    );
    if (!r.ok) return new Set();
    const j = await r.json();
    return new Set((j.data || []).map((d: DifyDoc) => d.name));
  } catch {
    return new Set();
  }
}

async function uploadOne(filePath: string, filename: string): Promise<{
  ok: boolean; skipped?: boolean; error?: string;
}> {
  try {
    const buffer = await fs.readFile(filePath);
    const fd = new FormData();
    fd.append("data", JSON.stringify({
      indexing_technique: "high_quality",
      process_rule: { mode: "automatic" },
    }));
    const blob = new Blob([buffer], { type: "text/markdown" });
    fd.append("file", blob, filename);

    const r = await fetch(
      `${DIFY_BASE_URL}/v1/datasets/${DIFY_DEFAULT_DATASET_ID}/document/create-by-file`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${DIFY_KB_API_KEY}` },
        body: fd,
      },
    );
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, error: `${r.status} ${text.slice(0, 100)}` };
    }
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!DIFY_KB_API_KEY || !DIFY_DEFAULT_DATASET_ID) {
    return NextResponse.json(
      { error: "kb_unavailable",
        message: "La KB n'est pas configurée. Lancer le provisioning d'abord." },
      { status: 503 },
    );
  }

  let files: string[];
  try {
    files = await fs.readdir(SEED_DIR);
  } catch (e: unknown) {
    return NextResponse.json(
      { error: "seed_dir_unreadable",
        path: SEED_DIR,
        message: (e as Error).message,
      },
      { status: 500 },
    );
  }
  const seedFiles = files
    .filter((f) => /\.(md|txt|pdf|docx)$/i.test(f))
    .sort();

  const existing = await listExistingDocs();
  const report: Array<{ name: string; status: string; error?: string }> = [];
  let uploaded = 0, skipped = 0, failed = 0;

  for (const filename of seedFiles) {
    if (existing.has(filename)) {
      report.push({ name: filename, status: "skipped" });
      skipped++;
      continue;
    }
    const result = await uploadOne(path.join(SEED_DIR, filename), filename);
    if (result.ok) {
      report.push({ name: filename, status: "uploaded" });
      uploaded++;
    } else {
      report.push({ name: filename, status: "error", error: result.error });
      failed++;
    }
  }

  await logAction("settings.update", "seed-demo", {
    uploaded, skipped, failed,
  }, ipFromHeaders(req));

  return NextResponse.json({
    ok: true,
    summary: { total: seedFiles.length, uploaded, skipped, failed },
    report,
  });
}
