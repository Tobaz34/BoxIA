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
import { listAvailableAgents, roleFromGroups, type AgentRole } from "@/lib/agents";
import { listCustomAgents } from "@/lib/custom-agents";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const groups = (session.user as { groups?: string[] }).groups || [];
  const role = roleFromGroups(groups);
  const agents = listAvailableAgents(role);

  // Fusion avec les agents custom : on filtre par rôle et on aplatit
  // la structure (sans api_key) pour l'affichage. Les customs sont
  // marqués custom: true pour permettre des actions supplémentaires
  // côté UI (suppression).
  try {
    const custom = await listCustomAgents();
    for (const c of custom) {
      if (c.allowedRoles.length > 0 && !c.allowedRoles.includes(role as AgentRole)) {
        continue;
      }
      agents.push({
        slug: c.slug,
        name: c.name,
        icon: c.icon,
        description: c.description,
        available: true,
        isDefault: false,
        allowedRoles: c.allowedRoles,
        vision: c.vision,
        openingStatement: c.opening_statement,
        suggestedQuestions: c.suggested_questions,
        // marqueur custom
        custom: true,
      } as typeof agents[number] & { custom?: boolean });
    }
  } catch (e) {
    console.warn("[/api/agents] listCustomAgents error:", e);
  }
  return NextResponse.json({ agents, role });
}
