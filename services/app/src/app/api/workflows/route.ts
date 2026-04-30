/**
 * GET /api/workflows — liste les workflows n8n (admin only).
 *
 * Source : n8n REST API via login admin (cookies).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listWorkflows } from "@/lib/n8n";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Pour l'instant, lecture pour tous (les workflows sont infos
  // utiles aux managers/employés). Toggle d'activation = admin only
  // dans /api/workflows/[id]/...
  const workflows = await listWorkflows();
  return NextResponse.json({ workflows });
}
