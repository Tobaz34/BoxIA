/**
 * GET /api/workflows/<id>/executions — liste des exécutions du workflow.
 * Lecture pour tous les users authentifiés (utilisé par /workflows pour
 * afficher l'historique).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listExecutions, executionsStats } from "@/lib/n8n";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }
  const [executions, stats] = await Promise.all([
    listExecutions(id, 25),
    executionsStats(id, 7, 200),
  ]);
  return NextResponse.json({ executions, stats });
}
