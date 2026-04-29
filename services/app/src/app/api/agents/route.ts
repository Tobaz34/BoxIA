/**
 * GET /api/agents — liste les agents disponibles pour cet utilisateur.
 *
 * Renvoie uniquement les métadonnées publiques (slug, nom, icône,
 * description) — pas les clés API.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listAvailableAgents } from "@/lib/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const agents = listAvailableAgents();
  return NextResponse.json({ agents });
}
