/**
 * POST /api/workflows/<id>/run — déclenche manuellement l'exécution d'un
 * workflow n8n. Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { runWorkflow } from "@/lib/n8n";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const result = await runWorkflow(id);
  if (!result.ok) {
    return NextResponse.json(
      { error: "run_failed", detail: result.error },
      { status: 502 },
    );
  }
  await logAction(
    "workflow.run_manual",
    session.user.email,
    { workflow_id: id, execution_id: result.executionId },
    ipFromHeaders(req),
  );
  return NextResponse.json({ ok: true, execution_id: result.executionId });
}
