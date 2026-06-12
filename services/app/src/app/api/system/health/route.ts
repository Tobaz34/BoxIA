/**
 * GET /api/system/health — probe les services backend de la AI Box
 * (Dify API, Ollama, Authentik, n8n, Prometheus). Retourne pour chacun :
 *   { name, ok, latency_ms?, error?, version? }
 *
 * Cet endpoint est consommé par le dashboard /system pour l'indicateur
 * « tout est vert ». Il sert aussi de check rapide en démo.
 *
 * La logique de probe vit dans lib/system-health.ts (partagée avec le
 * tool Concierge /api/agents-tools/system_health). Session requise pour
 * éviter l'exposition publique des URLs internes.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { runHealthProbes } from "@/lib/system-health";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await runHealthProbes());
}
