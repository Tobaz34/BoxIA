/**
 * OAuth 2.0 Device Authorization Grant (RFC 8628) — flow approprié pour
 * une appliance LAN sans URL publique de callback.
 *
 * Le pattern : la box demande un code à un provider OAuth, l'admin entre
 * ce code sur n'importe quel device (téléphone, autre PC), autorise, et
 * la box poll le provider jusqu'à recevoir un access_token + refresh_token.
 *
 * Providers supportés (registry dans lib/oauth-providers.ts) :
 *   - Google (TVs and Limited Input devices) — Drive, Gmail, Calendar
 *   - Microsoft (Azure AD avec public client flow activé) — Graph API
 *   - GitHub (déjà géré séparément en lib/github-token.ts pour le compte master)
 *
 * Token storage chiffré AES-256-GCM (mêmes pattern que cloud-providers et
 * github-token), persisté dans /data/oauth-connections.json. Refresh
 * automatique dans getAccessToken() si proche de l'expiration.
 */
import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import { OAUTH_PROVIDERS, type OAuthProviderId } from "./oauth-providers";

const STORE_PATH = "/data/oauth-connections.json";

export interface OAuthConnection {
  /** Identifiant unique : `${providerId}:${connectorSlug}` (ex: google:google-drive). */
  id: string;
  provider_id: OAuthProviderId;
  connector_slug: string;
  scopes: string[];
  /** Token chiffré (cf encryptToken). */
  access_token_encrypted: string;
  refresh_token_encrypted?: string;
  expires_at?: number;     // ms epoch
  /** Métadonnées /userinfo pour afficher "Connecté en tant que X". */
  account_email?: string;
  account_name?: string;
  connected_at: number;
  connected_by?: string;
  last_refreshed_at?: number;
}

interface DeviceCodePending {
  /** Identifiant du flux en cours côté boîte. UUID. */
  request_id: string;
  provider_id: OAuthProviderId;
  connector_slug: string;
  scopes: string[];
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_at: number;        // ms epoch
  interval: number;          // poll interval seconds
  initiated_at: number;
  initiated_by?: string;
}

interface OAuthStore {
  connections: Record<string, OAuthConnection>;
  /** Demandes device-flow en cours (purgées après expires_at + 1 min). */
  pending: Record<string, DeviceCodePending>;
}

// =========================================================================
// Encryption
// =========================================================================

function getEncryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
    || process.env.DIFY_SECRET_KEY
    || "boxia-default-secret-CHANGE-ME-IN-ENV";
  return crypto.createHash("sha256")
    .update(secret + "oauth-tokens-v1")
    .digest();
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptToken(blob: string): string | null {
  try {
    const [ivHex, tagHex, ctHex] = blob.split(":");
    if (!ivHex || !tagHex || !ctHex) return null;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctHex, "hex")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

// =========================================================================
// Storage
// =========================================================================

async function readStore(): Promise<OAuthStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as OAuthStore;
    return {
      connections: parsed.connections || {},
      pending: parsed.pending || {},
    };
  } catch {
    return { connections: {}, pending: {} };
  }
}

async function writeStore(s: OAuthStore): Promise<void> {
  // Purge des pending expirés (>5 min après expires_at)
  const now = Date.now();
  for (const [k, p] of Object.entries(s.pending)) {
    if (p.expires_at + 5 * 60_000 < now) delete s.pending[k];
  }
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, STORE_PATH);
}

export async function listConnections(): Promise<OAuthConnection[]> {
  const s = await readStore();
  return Object.values(s.connections);
}

export async function getConnection(id: string): Promise<OAuthConnection | null> {
  const s = await readStore();
  return s.connections[id] || null;
}

export async function deleteConnection(id: string): Promise<void> {
  const s = await readStore();
  delete s.connections[id];
  await writeStore(s);
}

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
  const s = await readStore();
  s.pending[requestId] = pending;
  await writeStore(s);
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
  const s = await readStore();
  const pending = s.pending[requestId];
  if (!pending) return { state: "error", error: "unknown_or_expired_request" };
  if (pending.expires_at < Date.now()) {
    delete s.pending[requestId];
    await writeStore(s);
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

  // Cas pending standard RFC 8628
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
      // Le provider demande de ralentir — on bump l'interval
      pending.interval = pending.interval + 5;
      await writeStore(s);
      return { state: "slow_down", interval: pending.interval };
    }
    delete s.pending[requestId];
    await writeStore(s);
    return { state: "error", error: err || `token_endpoint_${r.status}` };
  }

  // Succès
  const accessToken = data.access_token as string;
  const refreshToken = data.refresh_token as string | undefined;
  const expiresIn = (data.expires_in as number) || 3600;

  // Optionnel : récupérer email + name pour l'affichage
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
  await writeStore(s);
  return { state: "success", connection: conn };
}

// =========================================================================
// Refresh — utilisé par les workers connecteurs avant un appel API
// =========================================================================

export async function getAccessToken(id: string): Promise<string | null> {
  const s = await readStore();
  const conn = s.connections[id];
  if (!conn) return null;
  // Si expire dans <2 min ET on a un refresh_token → refresh
  const needsRefresh = conn.expires_at && conn.expires_at < Date.now() + 120_000;
  if (!needsRefresh) {
    return decryptToken(conn.access_token_encrypted);
  }
  if (!conn.refresh_token_encrypted) {
    // Pas de refresh possible, on renvoie l'existant — le caller verra 401
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
    // Refresh failed — laisse l'access_token périmé, le caller décidera
    return decryptToken(conn.access_token_encrypted);
  }
  const data = await r.json();
  const newAccess = data.access_token as string;
  const newExpiresIn = (data.expires_in as number) || 3600;
  conn.access_token_encrypted = encryptToken(newAccess);
  conn.expires_at = Date.now() + newExpiresIn * 1000;
  conn.last_refreshed_at = Date.now();
  // Google peut renvoyer un nouveau refresh_token (rare)
  if (data.refresh_token) {
    conn.refresh_token_encrypted = encryptToken(data.refresh_token as string);
  }
  s.connections[id] = conn;
  await writeStore(s);
  return newAccess;
}
