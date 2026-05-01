/**
 * POST /api/workflows/upload — upload custom n8n workflow JSON.
 *
 * Permet à l'admin de coller le JSON d'un workflow (depuis n8n.io ou un
 * collègue) directement dans aibox-app, sans ouvrir n8n. Idempotent : si
 * un workflow du même nom existe déjà, on skip.
 *
 * Admin only.
 *
 * Body : { content: string (JSON), name?: string (override) }
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listWorkflows, createWorkflow } from "@/lib/n8n";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { content?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (!body.content || typeof body.content !== "string") {
    return NextResponse.json({ error: "missing_content" }, { status: 400 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.content);
  } catch {
    return NextResponse.json(
      { error: "invalid_json", detail: "Le JSON fourni n'est pas valide." },
      { status: 400 },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    return NextResponse.json({ error: "invalid_workflow" }, { status: 400 });
  }
  if (body.name && body.name.trim()) {
    parsed.name = body.name.trim();
  }
  if (!parsed.name) {
    return NextResponse.json(
      { error: "missing_name", detail: "Le workflow doit avoir un champ `name`." },
      { status: 400 },
    );
  }
  // Idempotence : skip si déjà présent par nom
  const existing = await listWorkflows();
  if (existing.some((w) => w.name === parsed.name)) {
    return NextResponse.json(
      { ok: true, status: "skipped", message: "Un workflow du même nom existe déjà." },
      { status: 200 },
    );
  }
  const created = await createWorkflow(parsed);
  if (!created) {
    return NextResponse.json(
      { error: "create_failed", detail: "n8n a refusé le workflow (voir logs)." },
      { status: 502 },
    );
  }
  await logAction(
    "workflow.upload",
    session.user.email,
    { workflow_id: created.id, name: created.name },
    ipFromHeaders(req),
  );
  return NextResponse.json({ ok: true, status: "created", workflow: created });
}
