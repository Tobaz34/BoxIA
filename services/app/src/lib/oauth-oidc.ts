/**
 * OAuth 2.0 Authorization Code Grant + PKCE (OIDC).
 *
 * Le pattern « Sign in with Google/Microsoft » classique :
 *   1. UI ouvre une popup/redirect vers /api/oauth/start?provider=...&connector_slug=...
 *   2. /api/oauth/start génère code_verifier + state, pose un cookie httpOnly,
 *      redirige vers le authorize_endpoint du provider
 *   3. User autorise sur Google/Microsoft
 *   4. Provider redirige vers /api/oauth/callback?code=...&state=...
 *   5. /api/oauth/callback vérifie state (anti-CSRF), exchange code+verifier
 *      contre access_token + refresh_token, persiste, ferme la popup
 *
 * Pré-requis prod : NEXTAUTH_URL (ou OAUTH_REDIRECT_BASE_URL si défini)
 * doit être joignable par Google/Microsoft → HTTPS + domaine public.
 * Sans ça, basculer sur le Device Flow (lib/oauth-device-flow.ts).
 */
import * as crypto from "node:crypto";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth-providers";
import { encryptToken, type OAuthConnection, _readStore, _writeStore } from "./oauth-storage";

export const OAUTH_STATE_COOKIE = "aibox_oauth_state";

/** Base URL utilisée pour le redirect_uri (visible côté Google).
 *  Doit matcher EXACTEMENT une URI déclarée dans le OAuth client provider. */
export function getRedirectBaseUrl(): string {
  const base = process.env.OAUTH_REDIRECT_BASE_URL
    || process.env.NEXTAUTH_URL
    || "http://localhost:3100";
  return base.replace(/\/$/, "");
}

export function getRedirectUri(): string {
  return `${getRedirectBaseUrl()}/api/oauth/callback`;
}

interface PendingOIDC {
  state: string;
  code_verifier: string;
  provider_id: OAuthProviderId;
  connector_slug: string;
  scopes: string[];
  initiated_at: number;
  initiated_by?: string;
}

// =========================================================================
// PKCE helpers
// =========================================================================

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function generateCodeVerifier(): string {
  return base64UrlEncode(crypto.randomBytes(32));
}

function codeChallengeFromVerifier(verifier: string): string {
  return base64UrlEncode(crypto.createHash("sha256").update(verifier).digest());
}

// =========================================================================
// Start — génère URL d'autorisation
// =========================================================================

export interface StartOIDCResult {
  authorize_url: string;
  state: string;
  /** Cookie value à poser côté response. Sérialise tout le contexte chiffré. */
  state_cookie_value: string;
  redirect_uri: string;
}

/** Sérialise le pending OIDC dans le cookie (chiffré, courte durée).
 *  On évite de persister sur disque pour ne pas accumuler des pending
 *  jamais consommés (cookie disparaît tout seul à la fin de session). */
function packPending(p: PendingOIDC): string {
  const json = JSON.stringify(p);
  return encryptToken(json);
}

export function startOIDC(
  providerId: OAuthProviderId,
  connectorSlug: string,
  initiatedBy?: string,
  extraScopes?: string[],
): StartOIDCResult {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) throw new Error(`unknown_provider:${providerId}`);
  if (!provider.client_id) {
    throw new Error(
      `oauth_client_not_configured:${providerId}. ` +
      `Configure ${provider.client_id_env} dans .env (cf docs).`,
    );
  }
  const scopes = (extraScopes && extraScopes.length > 0)
    ? extraScopes
    : (provider.connector_scopes?.[connectorSlug] || provider.default_scopes);

  const verifier = generateCodeVerifier();
  const challenge = codeChallengeFromVerifier(verifier);
  const state = base64UrlEncode(crypto.randomBytes(16));

  const params = new URLSearchParams({
    client_id: provider.client_id,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (provider.requires_offline_access) {
    params.set("access_type", "offline");
  }
  if (provider.requires_consent_prompt) {
    params.set("prompt", "consent");
  }

  const pending: PendingOIDC = {
    state,
    code_verifier: verifier,
    provider_id: providerId,
    connector_slug: connectorSlug,
    scopes,
    initiated_at: Date.now(),
    initiated_by: initiatedBy,
  };
  return {
    authorize_url: `${provider.authorize_endpoint}?${params.toString()}`,
    state,
    state_cookie_value: packPending(pending),
    redirect_uri: getRedirectUri(),
  };
}

// =========================================================================
// Callback — exchange code → tokens
// =========================================================================

export interface CallbackResult {
  ok: true;
  connection: OAuthConnection;
}
export interface CallbackError {
  ok: false;
  error: string;
}

import { decryptToken } from "./oauth-storage";

function unpackPending(blob: string): PendingOIDC | null {
  try {
    const json = decryptToken(blob);
    if (!json) return null;
    return JSON.parse(json) as PendingOIDC;
  } catch {
    return null;
  }
}

export async function handleOIDCCallback(
  cookieValue: string,
  receivedState: string,
  code: string,
): Promise<CallbackResult | CallbackError> {
  const pending = unpackPending(cookieValue);
  if (!pending) return { ok: false, error: "missing_or_invalid_state_cookie" };
  if (pending.state !== receivedState) {
    return { ok: false, error: "state_mismatch" };
  }
  // Cap à 10 min entre start et callback
  if (Date.now() - pending.initiated_at > 10 * 60_000) {
    return { ok: false, error: "state_expired" };
  }

  const provider = OAUTH_PROVIDERS[pending.provider_id];
  if (!provider) return { ok: false, error: "provider_disappeared" };

  const body = new URLSearchParams({
    client_id: provider.client_id || "",
    code,
    code_verifier: pending.code_verifier,
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code",
  });
  if (provider.client_secret) {
    body.set("client_secret", provider.client_secret);
  }
  const r = await fetch(provider.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return { ok: false, error: `token_endpoint_${r.status}: ${txt.slice(0, 300)}` };
  }
  const data = await r.json();
  const accessToken = data.access_token as string;
  const refreshToken = data.refresh_token as string | undefined;
  const expiresIn = (data.expires_in as number) || 3600;

  // Récupère email + name
  let accountEmail: string | undefined;
  let accountName: string | undefined;
  if (provider.userinfo_endpoint) {
    try {
      const ui = await fetch(provider.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (ui.ok) {
        const uj = await ui.json();
        accountEmail = uj.email || uj.mail || uj.userPrincipalName;
        accountName = uj.name || uj.displayName;
      }
    } catch { /* tolère */ }
  }

  const id = `${pending.provider_id}:${pending.connector_slug}`;
  const conn: OAuthConnection = {
    id,
    provider_id: pending.provider_id,
    connector_slug: pending.connector_slug,
    scopes: pending.scopes,
    access_token_encrypted: encryptToken(accessToken),
    refresh_token_encrypted: refreshToken ? encryptToken(refreshToken) : undefined,
    expires_at: Date.now() + expiresIn * 1000,
    account_email: accountEmail,
    account_name: accountName,
    connected_at: Date.now(),
    connected_by: pending.initiated_by,
    last_refreshed_at: Date.now(),
  };
  const s = await _readStore();
  s.connections[id] = conn;
  await _writeStore(s);
  return { ok: true, connection: conn };
}
