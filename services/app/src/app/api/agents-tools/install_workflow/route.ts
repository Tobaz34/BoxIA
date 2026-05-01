/**
 * POST /api/agents-tools/install_workflow
 *
 * Body : { file: string }
 *
 * Installe un workflow marketplace dans n8n. Le workflow est créé
 * `active: false` (l'admin l'activera après config des creds éventuels).
 *
 * Action SENSIBLE — l'agent Concierge doit demander confirmation à
 * l'utilisateur avant d'appeler ce tool. La vérification de
 * confirmation est faite par l'agent (pas par cet endpoint, qui se
 * contente de l'auth Bearer).
 */
import { NextResponse } from "next/server";
import {
  installMarketplaceWorkflow,
  readCatalog,
} from "@/lib/n8n-marketplace";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { logAction } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

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

  // Vérifie le whitelist catalogue
  const catalog = await readCatalog().catch(() => null);
  const entry = catalog?.workflows.find((w) => w.file === file);
  if (!entry) {
    return NextResponse.json({ error: "not_in_catalog", file }, { status: 404 });
  }

  try {
    const result = await installMarketplaceWorkflow(file);
    if ("already_installed" in result) {
      return NextResponse.json({
        ok: true,
        already_installed: true,
        name: result.name,
        message: `« ${result.name} » est déjà installé.`,
      });
    }
    await logAction(
      "workflow.install_template",
      "concierge-agent",
      { file, name: result.name, workflow_id: result.workflow_id },
      null,
    );
    return NextResponse.json({
      ok: true,
      workflow_id: result.workflow_id,
      name: result.name,
      message: `« ${result.name} » installé (désactivé). ${
        entry.credentials_required.length > 0
          ? `Configure les credentials suivants avant d'activer : ${entry.credentials_required.join(", ")}.`
          : "Tu peux l'activer depuis /workflows."
      }`,
      next_action_url: "/workflows",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "install_failed", detail: String(e).slice(0, 300) },
      { status: 502 },
    );
  }
}
