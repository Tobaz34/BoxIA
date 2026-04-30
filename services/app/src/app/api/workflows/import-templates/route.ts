/**
 * POST /api/workflows/import-templates — admin only
 *
 * Importe les workflows JSON présents dans le repo (`templates/n8n/`)
 * dans n8n via son API REST. Idempotent : si un workflow du même nom
 * existe déjà, il est skippé.
 *
 * Utile :
 *   - Au 1er accès à /workflows quand la liste est vide (le wizard n'a
 *     pas eu le temps d'importer, ou import-templates a échoué)
 *   - Pour re-importer après suppression accidentelle
 *
 * Le dossier templates/ est monté en lecture seule dans le container
 * via /srv/ai-stack/templates → /templates (cf. compose si bind mount,
 * sinon on lit depuis /srv/ai-stack/templates/n8n directement, ce qui
 * marche en network_mode: host).
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listWorkflows, createWorkflow } from "@/lib/n8n";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

// Le dossier `templates/` du repo est bind-mounté en /templates:ro
// dans le container (cf. services/app/docker-compose.yml). On lit
// les workflows JSON dans /templates/n8n.
const TEMPLATES_DIR =
  process.env.N8N_TEMPLATES_DIR || "/templates/n8n";

interface ImportEntry {
  filename: string;
  name: string;
  status: "imported" | "skipped" | "error";
  workflow_id?: string;
  error?: string;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 1. Liste les fichiers .json dans le dossier
  let files: string[];
  try {
    files = await fs.readdir(TEMPLATES_DIR);
  } catch (e) {
    return NextResponse.json(
      {
        error: "templates_dir_unreadable",
        path: TEMPLATES_DIR,
        message: (e as Error).message,
        hint: "Vérifier que /srv/ai-stack/templates/n8n existe et est lisible.",
      },
      { status: 500 },
    );
  }
  const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();

  // 2. Récupère la liste des workflows déjà existants pour skip-by-name
  const existing = await listWorkflows();
  const existingNames = new Set(existing.map((w) => w.name));

  // 3. Import un par un
  const report: ImportEntry[] = [];
  let imported = 0, skipped = 0, failed = 0;
  for (const filename of jsonFiles) {
    try {
      const content = await fs.readFile(
        path.join(TEMPLATES_DIR, filename),
        "utf-8",
      );
      const tpl = JSON.parse(content);
      const name = tpl.name || filename.replace(/\.json$/, "");
      if (existingNames.has(name)) {
        report.push({ filename, name, status: "skipped" });
        skipped++;
        continue;
      }
      const wf = await createWorkflow(tpl);
      if (wf) {
        report.push({
          filename, name, status: "imported", workflow_id: wf.id,
        });
        imported++;
      } else {
        report.push({
          filename, name, status: "error",
          error: "n8n createWorkflow a renvoyé null",
        });
        failed++;
      }
    } catch (e) {
      report.push({
        filename,
        name: filename,
        status: "error",
        error: (e as Error).message.slice(0, 200),
      });
      failed++;
    }
  }

  await logAction(
    "settings.update",
    "workflows.import-templates",
    { imported, skipped, failed },
    ipFromHeaders(req),
  );

  return NextResponse.json({
    ok: true,
    summary: { total: jsonFiles.length, imported, skipped, failed },
    report,
  });
}
