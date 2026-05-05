/**
 * GET /api/oauth/providers — liste des providers OAuth supportés + leur
 * statut de configuration (client_id présent ou absent).
 *
 * Public : info utile pour l'UI, ne révèle aucun secret. Le caller voit
 * "google : configured" ou "google : missing_client_id" pour décider
 * d'afficher le bouton "Connecter" ou un message "Provider non configuré".
 */
import { NextResponse } from "next/server";
import { OAUTH_PROVIDERS } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

export async function GET() {
  const providers = Object.values(OAUTH_PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    configured: Boolean(p.client_id),
    client_id_env: p.client_id_env,
    console_url: p.console_url,
  }));
  return NextResponse.json({ providers });
}
