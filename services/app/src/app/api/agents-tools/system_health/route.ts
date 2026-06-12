/**
 * GET /api/agents-tools/system_health
 *
 * État compact des services BoxIA pour le concierge. Utile quand un user
 * demande "tout fonctionne ?" ou "qu'est-ce qui est down ?".
 *
 * Appelle directement lib/system-health.ts : l'ancien fetch loopback vers
 * /api/system/health (route protégée par session NextAuth) partait sans
 * cookie et renvoyait systématiquement 401 — le tool était inutilisable.
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { runHealthProbes } from "@/lib/system-health";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();
  try {
    return NextResponse.json(await runHealthProbes());
  } catch (e) {
    return NextResponse.json(
      { error: "health_check_failed", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }
}
