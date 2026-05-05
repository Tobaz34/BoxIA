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
  /**
   * "select_account" → force le provider à afficher le sélecteur de
   *   compte même si l'utilisateur a une session active. Indispensable
   *   pour le bouton « Ajouter un autre compte ».
   * "consent" → re-demande explicitement le consent (utile pour Google
   *   quand on veut être sûr d'obtenir un refresh_token).
   * "none" → laisse le provider décider (default).
   */
  promptMode?: "select_account" | "consent" | "none",
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
  // Choix du `prompt` :
  //   - select_account explicit (override par l'appelant) → toujours
  //   - sinon, requires_consent_prompt (Google) → consent
  //   - sinon rien (= "none" implicite, provider décide)
  if (promptMode === "select_account") {
    params.set("prompt", "select_account");
  } else if (promptMode === "consent" || provider.requires_consent_prompt) {
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

  // Récupère email + name — important pour :
  //   - afficher "Connecté avec X" dans l'UI
  //   - regrouper les sibling-slugs sous le même account_email
  //   - le check "écraser un autre account ?" du broadcast sibling
  // Si userinfo échoue silencieusement on log une erreur explicite (visible
  // dans `docker logs aibox-app`) au lieu de juste laisser un null.
  let accountEmail: string | undefined;
  let accountName: string | undefined;
  if (provider.userinfo_endpoint) {
    try {
      const ui = await fetch(provider.userinfo_endpoint, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!ui.ok) {
        const txt = await ui.text().catch(() => "");
        console.error(
          `[oauth-oidc] userinfo fetch failed for ${pending.provider_id}: ` +
          `HTTP ${ui.status} — ${txt.slice(0, 200)}`,
        );
      } else {
        const uj = await ui.json();
        // Microsoft Graph /me : `mail` (souvent null pour comptes perso) ou
        // `userPrincipalName` (toujours présent). Google : `email`.
        accountEmail = uj.email || uj.mail || uj.userPrincipalName;
        accountName = uj.name || uj.displayName;
        if (!accountEmail) {
          console.warn(
            `[oauth-oidc] userinfo OK mais aucun email pour ${pending.provider_id} — ` +
            `payload keys: ${Object.keys(uj).join(",")}`,
          );
        }
      }
    } catch (e) {
      console.error(`[oauth-oidc] userinfo throw for ${pending.provider_id}:`, e);
    }
  }

  const id = `${pending.provider_id}:${pending.connector_slug}`;
  const accessTokenEncrypted = encryptToken(accessToken);
  const refreshTokenEncrypted = refreshToken ? encryptToken(refreshToken) : undefined;
  const expiresAt = Date.now() + expiresIn * 1000;

  const conn: OAuthConnection = {
    id,
    provider_id: pending.provider_id,
    connector_slug: pending.connector_slug,
    scopes: pending.scopes,
    access_token_encrypted: accessTokenEncrypted,
    refresh_token_encrypted: refreshTokenEncrypted,
    expires_at: expiresAt,
    account_email: accountEmail,
    account_name: accountName,
    connected_at: Date.now(),
    connected_by: pending.initiated_by,
    last_refreshed_at: Date.now(),
  };

  const s = await _readStore();
  s.connections[id] = conn;

  // ---- Account-sharing : si le token couvre les scopes des slugs
  // frères (ex Google Drive + Gmail + Calendar), on auto-crée des
  // entrées pour eux. L'admin n'a pas besoin de re-cliquer "Connecter
  // avec Google" sur chaque connecteur. Cf siblingSlugs() dans
  // oauth-providers.ts.
  //
  // Règles :
  //   - On ne broadcast QUE si on a effectivement reçu les scopes
  //     requis par le sibling (cas du mode broad=1 de /api/oauth/start).
  //   - On n'écrase PAS une entrée sibling existante avec un account
  //     DIFFÉRENT (l'admin a peut-être un compte perso pour Drive et un
  //     compte pro pour Gmail — on respecte ça).
  const broadcastedSlugs: string[] = [pending.connector_slug];
  try {
    const { siblingSlugs } = await import("./oauth-providers");
    const grantedScopes = String(data.scope || "").split(/\s+/).filter(Boolean);
    const haveScopes = new Set([...pending.scopes, ...grantedScopes]);
    const siblings = siblingSlugs(pending.provider_id);
    const { OAUTH_PROVIDERS } = await import("./oauth-providers");
    const provider = OAUTH_PROVIDERS[pending.provider_id];

    for (const sib of siblings) {
      if (sib === pending.connector_slug) continue;
      const sibId = `${pending.provider_id}:${sib}`;
      const existing = s.connections[sibId];
      if (existing && existing.account_email && accountEmail
          && existing.account_email !== accountEmail) {
        // Compte différent → on ne touche pas
        continue;
      }
      // Le sibling exige-t-il des scopes qu'on a effectivement reçus ?
      const requiredSibScopes = provider.connector_scopes?.[sib] || [];
      const haveAll = requiredSibScopes.every((sc) => haveScopes.has(sc));
      if (!haveAll) continue;
      s.connections[sibId] = {
        id: sibId,
        provider_id: pending.provider_id,
        connector_slug: sib,
        scopes: requiredSibScopes,
        access_token_encrypted: accessTokenEncrypted,
        refresh_token_encrypted: refreshTokenEncrypted,
        expires_at: expiresAt,
        account_email: accountEmail,
        account_name: accountName,
        connected_at: existing?.connected_at || Date.now(),
        connected_by: pending.initiated_by,
        last_refreshed_at: Date.now(),
      };
      broadcastedSlugs.push(sib);
    }
  } catch {
    // best-effort, on ne bloque pas la connexion principale
  }

  await _writeStore(s);

  // ---- Auto-activate des slugs touchés dans connectors-state ----
  // Sans ça, l'OAuth donne le token mais le connector reste "inactive"
  // → invisible dans la sidebar « Connecteurs (N) ». Pour le user
  // c'est confusing : il connecte Microsoft mais ne voit que SharePoint
  // dans la sidebar (pas Outlook ni Calendar) parce qu'il n'a pas
  // re-cliqué « Activer » sur chaque connecteur. On automatise.
  //
  // Les `required` fields sont skippés grâce au check `oauthProvider`
  // dans activateConnector — donc une activation sans saisie marche.
  // Best-effort : on ne bloque pas la connexion OAuth si l'activation
  // échoue (ex: connector spec absent).
  try {
    const { activateConnector } = await import("./connectors-state");
    const { getConnector } = await import("./connectors");
    for (const slug of broadcastedSlugs) {
      try {
        const spec = getConnector(slug);
        if (!spec) continue; // slug pas dans le catalog (ex: marketplace MCP)
        await activateConnector(slug, {});
      } catch (e) {
        console.warn(`[oauth-oidc] auto-activate failed for ${slug}:`, e);
      }
    }
  } catch (e) {
    console.error("[oauth-oidc] auto-activate broadcast failed:", e);
  }

  return { ok: true, connection: conn };
}
