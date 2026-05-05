/**
 * POST /api/agents-tools/install_workflow
 *
 * Body : { file: string, approval_token?: string }
 *
 * Installe un workflow marketplace dans n8n. Le workflow est créé
 * `active: false` (l'admin l'activera après config des creds éventuels).
 *
 * SÉCURITÉ — Approval gate côté serveur (cf. lib/approval-gate.ts) :
 * Au 1er appel sans `approval_token`, on enregistre une demande pending
 * et on retourne 202 + action_id. L'admin valide via le banner UI ;
 * le frontend re-poste avec `approval_token=action_id` qui débloque
 * l'exécution. Cela neutralise les prompt injections qui essaieraient
 * de faire installer un workflow non sollicité.
 */
import { NextResponse } from "next/server";
import {
  installMarketplaceWorkflow,
  readCatalog,
} from "@/lib/n8n-marketplace";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { logAction } from "@/lib/audit-helper";
import { requireApproval } from "@/lib/approval-gate";
import {
  toolError,
  toolValidationError,
  toolUpstreamError,
} from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "install_workflow", req });

  let body: { file?: unknown; approval_token?: unknown };
  try {
    body = (await req.json()) as { file?: unknown; approval_token?: unknown };
  } catch {
    tracer.failure({ errorCode: "bad_json", retryable: false, httpStatus: 400 });
    return toolValidationError("bad_json", "Body JSON invalide");
  }
  const file = typeof body.file === "string" ? body.file : "";
  if (!file) {
    tracer.failure({ errorCode: "missing_file", retryable: false, httpStatus: 400 });
    return toolValidationError("missing_file", "Champ 'file' requis");
  }

  // Vérifie le whitelist catalogue AVANT de créer le pending : pas la
  // peine de demander l'approbation pour un truc qui va planter.
  const catalog = await readCatalog().catch(() => null);
  const entry = catalog?.workflows.find((w) => w.file === file);
  if (!entry) {
    tracer.failure({
      errorCode: "not_in_catalog",
      retryable: false,
      httpStatus: 404,
      metadata: { file },
    });
    return toolError({
      error: "not_in_catalog",
      hint: `Le workflow '${file}' n'existe pas dans le catalogue marketplace.`,
      status: 404,
      retryable: false,
      detail: `file=${file}`,
    });
  }

  // Approval gate : 1ère passe → enregistre pending + 202.
  // 2ème passe (avec approval_token) → continue avec les params APPROUVÉS
  // (pas ceux du body, qui pourraient avoir été altérés entre temps).
  const gate = await requireApproval<{ file: string }>({
    body: body as { file: string; approval_token?: unknown },
    action: "install_workflow",
    description: `Installer le workflow n8n « ${entry.name || file} » (désactivé par défaut)`,
    params: { file },
    caller_actor: "concierge-agent",
  });
  if (!gate.go) {
    // Approval pending (202) ou refusée — tracer comme « failure » légère
    // (action non exécutée). Pas un vrai échec : on utilise un code dédié.
    tracer.failure({
      errorCode: "approval_pending_or_denied",
      retryable: false,
      metadata: { stage: "approval_gate", file },
    });
    return gate.response;
  }
  const approvedFile = gate.params.file;

  try {
    const result = await installMarketplaceWorkflow(approvedFile);
    if ("already_installed" in result) {
      tracer.success(
        { already_installed: true, name: result.name },
        { file: approvedFile, via: "approval-gate" },
      );
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
      {
        file: approvedFile,
        name: result.name,
        workflow_id: result.workflow_id,
        via: "approval-gate",
      },
      null,
    );
    tracer.success(
      { workflow_id: result.workflow_id, name: result.name },
      { file: approvedFile, via: "approval-gate" },
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
    tracer.failure({
      errorCode: "install_failed",
      retryable: true,
      httpStatus: 502,
      metadata: { file: approvedFile },
    });
    return toolUpstreamError({
      error: "install_failed",
      hint: "L'installation du workflow a échoué (n8n upstream). Réessayable.",
      detail: String(e).slice(0, 300),
    });
  }
}
