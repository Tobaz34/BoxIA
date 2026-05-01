/**
 * GET /api/agents — liste les agents disponibles pour l'utilisateur courant.
 *
 * Filtré côté serveur par le rôle de l'utilisateur (calculé depuis ses
 * groupes Authentik). Renvoie uniquement les métadonnées publiques —
 * jamais les clés API.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listAllAvailableAgents, roleFromGroups } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const groups = (session.user as { groups?: string[] }).groups || [];
  const role = roleFromGroups(groups);
  // Fusionne agents statiques (hardcoded) + dynamiques (installés via marketplace)
  const agents = await listAllAvailableAgents(role);
  return NextResponse.json({ agents, role });
}
