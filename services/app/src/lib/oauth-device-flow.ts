/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628).
 *
 * Fallback pour les déploiements LAN sans domaine HTTPS public (où le
 * flow OIDC standard ne marche pas car Google/Microsoft refusent les
 * redirect_uri non-HTTPS hors localhost).
 *
 * Le storage des tokens est dans lib/oauth-storage.ts (commun avec
 * oauth-oidc.ts). Ici uniquement la logique device flow : start +
 * poll + refresh.
 */
import * as crypto from "node:crypto";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth-providers";
import {
  encryptToken, decryptToken,
  _readStore, _writeStore,
  type OAuthConnection, type DeviceCodePending,
} from "./oauth-storage";

// =========================================================================
// Device flow — start
// =========================================================================

export interface StartDeviceFlowResult {
  request_id: string;
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_in_seconds: number;
  interval: number;
}

export async function startDeviceFlow(
  providerId: OAuthProviderId,
  connectorSlug: string,
  initiatedBy?: string,
  extraScopes?: string[],
): Promise<StartDeviceFlowResult> {
  const provider = OAUTH_PROVIDERS[providerId];
  if (!provider) throw new Error(`unknown_provider:${providerId}`);
  if (!provider.client_id) {
    throw new Error(
      `oauth_client_not_configured:${providerId}. ` +
      `Configure ${provider.client_id_env} dans /srv/ai-stack/.env (cf docs/oauth-setup.md).`,
    );
  }
  const scopes = (extraScopes && extraScopes.length > 0)
    ? extraScopes
    : (provider.connector_scopes?.[connectorSlug] || provider.default_scopes);

  const body = new URLSearchParams({
    client_id: provider.client_id,
    scope: scopes.join(" "),
  });
  const r = await fetch(provider.device_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    throw new Error(`device_endpoint_${r.status}: ${await r.text().catch(() => "")}`);
  }
  const data = await r.json();
  const requestId = crypto.randomUUID();
  const pending: DeviceCodePending = {
    request_id: requestId,
    provider_id: providerId,
    connector_slug: connectorSlug,
    scopes,
    device_code: data.device_code,
    user_code: data.user_code,
    verification_url: data.verification_uri || data.verification_url,
    verification_url_complete: data.verification_uri_complete,
    expires_at: Date.now() + (data.expires_in || 900) * 1000,
    interval: data.interval || 5,
    initiated_at: Date.now(),
    initiated_by: initiatedBy,
  };
  const s = await _readStore();
  s.pending[requestId] = pending;
  await _writeStore(s);
  return {
    request_id: requestId,
    user_code: pending.user_code,
    verification_url: pending.verification_url,
    verification_url_complete: pending.verification_url_complete,
    expires_in_seconds: Math.floor((pending.expires_at - Date.now()) / 1000),
    interval: pending.interval,
  };
}

// =========================================================================
// Device flow — poll
// =========================================================================

export type PollResult =
  | { state: "pending"; interval: number; expires_in_seconds: number }
  | { state: "slow_down"; interval: number }
  | { state: "success"; connection: OAuthConnection }
  | { state: "error"; error: string };

export async function pollDeviceFlow(requestId: string): Promise<PollResult> {
  const s = await _readStore();
  const pending = s.pending[requestId];
  if (!pending) return { state: "error", error: "unknown_or_expired_request" };
  if (pending.expires_at < Date.now()) {
    delete s.pending[requestId];
    await _writeStore(s);
    return { state: "error", error: "device_code_expired" };
  }
  const provider = OAUTH_PROVIDERS[pending.provider_id];
  if (!provider) return { state: "error", error: "provider_disappeared" };

  const body = new URLSearchParams({
    client_id: provider.client_id || "",
    device_code: pending.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  if (provider.client_secret) {
    body.set("client_secret", provider.client_secret);
  }
  const r = await fetch(provider.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await r.json().catch(() => ({} as Record<string, unknown>));

  if (!r.ok) {
    const err = String(data.error || "");
    if (err === "authorization_pending") {
      return {
        state: "pending",
        interval: pending.interval,
        expires_in_seconds: Math.floor((pending.expires_at - Date.now()) / 1000),
      };
    }
    if (err === "slow_down") {
      pending.interval = pending.interval + 5;
      await _writeStore(s);
      return { state: "slow_down", interval: pending.interval };
    }
    delete s.pending[requestId];
    await _writeStore(s);
    return { state: "error", error: err || `token_endpoint_${r.status}` };
  }

  const accessToken = data.access_token as string;
  const refreshToken = data.refresh_token as string | undefined;
  const expiresIn = (data.expires_in as number) || 3600;

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
  s.connections[id] = conn;
  delete s.pending[requestId];
  await _writeStore(s);
  return { state: "success", connection: conn };
}

// =========================================================================
// Refresh — utilisé par les workers connecteurs avant un appel API
// =========================================================================

export async function getAccessToken(id: string): Promise<string | null> {
  const s = await _readStore();
  const conn = s.connections[id];
  if (!conn) return null;
  const needsRefresh = conn.expires_at && conn.expires_at < Date.now() + 120_000;
  if (!needsRefresh) {
    return decryptToken(conn.access_token_encrypted);
  }
  if (!conn.refresh_token_encrypted) {
    return decryptToken(conn.access_token_encrypted);
  }
  const refreshToken = decryptToken(conn.refresh_token_encrypted);
  if (!refreshToken) return null;

  const provider = OAUTH_PROVIDERS[conn.provider_id];
  if (!provider) return null;

  const body = new URLSearchParams({
    client_id: provider.client_id || "",
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (provider.client_secret) body.set("client_secret", provider.client_secret);
  const r = await fetch(provider.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) {
    return decryptToken(conn.access_token_encrypted);
  }
  const data = await r.json();
  const newAccess = data.access_token as string;
  const newExpiresIn = (data.expires_in as number) || 3600;
  conn.access_token_encrypted = encryptToken(newAccess);
  conn.expires_at = Date.now() + newExpiresIn * 1000;
  conn.last_refreshed_at = Date.now();
  if (data.refresh_token) {
    conn.refresh_token_encrypted = encryptToken(data.refresh_token as string);
  }
  s.connections[id] = conn;
  await _writeStore(s);
  return newAccess;
}

// Re-exports pour compat avec les routes existantes
export { listConnections, getConnection, deleteConnection } from "./oauth-storage";
