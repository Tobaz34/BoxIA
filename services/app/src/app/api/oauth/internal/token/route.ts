/**
 * GET /api/oauth/internal/token?provider=google&connector_slug=google-drive
 *
 * Endpoint INTERNE pour les workers connecteurs Python (rag-gdrive,
 * rag-msgraph, email-msgraph, calendar). Retourne le access_token déchiffré
 * + son expiration. Auto-refresh appliqué si proche de l'expiration.
 *
 * Auth : header `X-Connector-Token: <CONNECTOR_INTERNAL_TOKEN>` ; ce token
 * est partagé via env entre Next.js et les workers via /srv/ai-stack/.env.
 * Aucune session NextAuth requise — les workers ne se connectent pas comme
 * un user.
 *
 * Sécu : endpoint accessible uniquement depuis le réseau docker interne
 * (les workers tournent dans le compose stack et atteignent
 * http://aibox-app:3100/...). Pour blinder davantage, on pourrait restreindre
 * via IP whitelist, mais le shared secret + le binding LAN suffisent en V1.
 *
 * Réponse :
 *   { access_token: string, expires_at: number, account_email?, scopes }
 *   ou 404 si pas de connection, 401 si token invalide.
 */
import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/oauth-device-flow";
import { _readStore } from "@/lib/oauth-storage";

export const dynamic = "force-dynamic";

function expectedToken(): string | null {
  const t = process.env.CONNECTOR_INTERNAL_TOKEN;
  return t && t.length >= 16 ? t : null;
}

export async function GET(req: Request) {
  const expected = expectedToken();
  if (!expected) {
    // Pas de token configuré : on refuse plutôt que d'exposer
    return NextResponse.json({ error: "internal_token_not_configured" }, { status: 503 });
  }
  const got = req.headers.get("x-connector-token");
  if (got !== expected) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const connectorSlug = url.searchParams.get("connector_slug");
  if (!provider || !connectorSlug) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  const id = `${provider}:${connectorSlug}`;

  const store = await _readStore();
  const conn = store.connections[id];
  if (!conn) {
    return NextResponse.json({ error: "no_connection" }, { status: 404 });
  }

  const accessToken = await getAccessToken(id);
  if (!accessToken) {
    return NextResponse.json({ error: "token_unavailable" }, { status: 503 });
  }

  return NextResponse.json({
    access_token: accessToken,
    expires_at: conn.expires_at,
    account_email: conn.account_email,
    account_name: conn.account_name,
    scopes: conn.scopes,
    provider_id: conn.provider_id,
    connector_slug: conn.connector_slug,
  });
}
