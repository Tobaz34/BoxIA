/**
 * Helpers communs aux endpoints `/api/agents-tools/<connector>_*` qui
 * utilisent un access_token OAuth d'un provider (Google ou Microsoft).
 *
 * Pattern : l'agent Dify call `/api/agents-tools/gmail_read_inbox`,
 * Bearer AGENTS_API_KEY → handler récupère le token user actif via
 * getAccessToken("google:gmail-workspace") → call Gmail API → retourne
 * une réponse simplifiée parseable par le LLM.
 *
 * Si pas de connection : retourne un message clair que l'agent peut
 * relayer au user ("Connectez d'abord votre compte Google dans
 * Connecteurs → Gmail").
 */
import { NextResponse } from "next/server";
import { getAccessToken } from "@/lib/oauth-device-flow";
import { _readStore } from "@/lib/oauth-storage";
import type { OAuthProviderId } from "@/lib/oauth-providers";

export interface ToolTokenResult {
  ok: true;
  token: string;
  account_email?: string;
}
export interface ToolTokenError {
  ok: false;
  status: number;
  body: { error: string; hint?: string; connector_slug?: string };
}

/**
 * Récupère un access_token OAuth frais pour (provider, connector_slug)
 * ou retourne une erreur explicite que l'agent peut surfacer au user.
 */
export async function getToolToken(
  provider: OAuthProviderId,
  connectorSlug: string,
): Promise<ToolTokenResult | ToolTokenError> {
  const id = `${provider}:${connectorSlug}`;
  const store = await _readStore();
  const conn = store.connections[id];
  if (!conn) {
    return {
      ok: false,
      status: 404,
      body: {
        error: "connector_not_connected",
        connector_slug: connectorSlug,
        hint:
          `Aucune connexion ${provider} pour ${connectorSlug}. ` +
          `L'admin doit d'abord cliquer « Connecter avec ${provider === "google" ? "Google" : "Microsoft"} » ` +
          `dans /connectors → ${connectorSlug}.`,
      },
    };
  }
  const token = await getAccessToken(id);
  if (!token) {
    return {
      ok: false,
      status: 503,
      body: {
        error: "token_unavailable",
        hint: "Le token OAuth est présent mais ne peut pas être déchiffré. Reconnectez le connecteur.",
      },
    };
  }
  return { ok: true, token, account_email: conn.account_email };
}

/** Wrap une erreur d'API tier dans une réponse JSON propre pour Dify. */
export function apiError(status: number, message: string, hint?: string) {
  return NextResponse.json(
    { error: message, hint, status },
    { status: status >= 500 ? 502 : status },
  );
}
