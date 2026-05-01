/**
 * POST /api/workflows/marketplace/install — installe un workflow marketplace
 * dans n8n (toujours désactivé).
 *
 * Admin only. Body : { file: string }
 *
 * Réponse :
 *   - { ok: true, workflow_id, name }              → import OK
 *   - { ok: true, already_installed: true, name }  → déjà présent côté n8n
 *   - { error, detail }                            → échec (lecture template,
 *                                                    n8n down, etc.)
 *
 * Le workflow est créé `active: false`. L'admin doit ensuite :
 *   1. Configurer les credentials_required (cf. catalog) dans la console n8n
 *   2. Activer le workflow depuis /workflows
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  installMarketplaceWorkflow,
  readCatalog,
} from "@/lib/n8n-marketplace";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { file?: unknown };
  try {
    body = (await req.json()) as { file?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const file = typeof body.file === "string" ? body.file : "";
  if (!file) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  // Vérifie que le fichier appartient bien au catalogue (whitelist anti-traversal)
  let catalog;
  try {
    catalog = await readCatalog();
  } catch (e) {
    return NextResponse.json(
      { error: "catalog_unreadable", detail: String(e).slice(0, 300) },
      { status: 500 },
    );
  }
  const entry = catalog.workflows.find((w) => w.file === file);
  if (!entry) {
    return NextResponse.json(
      { error: "not_in_catalog", file },
      { status: 404 },
    );
  }

  try {
    const result = await installMarketplaceWorkflow(file);
    if ("already_installed" in result) {
      return NextResponse.json({
        ok: true,
        already_installed: true,
        name: result.name,
      });
    }
    await logAction(
      "workflow.install_template",
      session.user.email,
      {
        file,
        name: result.name,
        workflow_id: result.workflow_id,
        category: entry.category,
      },
      ipFromHeaders(req),
    );
    return NextResponse.json({
      ok: true,
      workflow_id: result.workflow_id,
      name: result.name,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "install_failed", detail: String(e).slice(0, 500) },
      { status: 502 },
    );
  }
}
