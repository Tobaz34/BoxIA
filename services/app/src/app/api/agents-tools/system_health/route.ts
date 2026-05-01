/**
 * GET /api/agents-tools/system_health
 *
 * Proxy autour de /api/system/health pour le concierge. Renvoie l'état
 * compact des services BoxIA. Utile quand un user demande
 * "tout fonctionne ?" ou "qu'est-ce qui est down ?".
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();
  try {
    // Appel interne — on accepte les redirects et bypass NextAuth via header
    // spécial. Note : /api/system/health est public côté NextAuth (utilisé
    // par les tests de healthcheck), donc cet appel passe.
    const r = await fetch("http://127.0.0.1:3100/api/system/health", {
      cache: "no-store",
    });
    if (!r.ok) {
      return NextResponse.json(
        { error: "health_check_failed", status: r.status },
        { status: 502 },
      );
    }
    const data = await r.json();
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json(
      { error: "health_check_failed", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }
}
