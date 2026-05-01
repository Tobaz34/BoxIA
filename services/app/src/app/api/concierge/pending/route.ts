/**
 * GET /api/concierge/pending — liste les actions Concierge en attente
 * d'approbation utilisateur.
 *
 * Auth : session NextAuth admin (le banner est admin-only — un employee
 * ne valide pas une action qui peut affecter toute la box).
 *
 * Polling-friendly : retourne en quelques ms même si vide. Le frontend
 * poll toutes les 3-5s.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listActive } from "@/lib/approval-gate";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ pending: [] }); // silencieux pour non-admin
  }
  const pending = await listActive();
  return NextResponse.json({ pending });
}
