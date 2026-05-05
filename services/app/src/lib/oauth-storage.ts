/**
 * Storage commun pour OIDC (oauth-oidc.ts) ET Device Flow (oauth-device-flow.ts).
 *
 * Tokens chiffrés AES-256-GCM, persistés dans /data/oauth-connections.json
 * (perms 0600). HKDF de NEXTAUTH_SECRET avec suffix "oauth-tokens-v1" — si
 * NEXTAUTH_SECRET change, les tokens deviennent illisibles (révocation
 * automatique côté boîte).
 */
import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";
import type { OAuthProviderId } from "./oauth-providers";

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
  expires_at?: number;
  account_email?: string;
  account_name?: string;
  connected_at: number;
  connected_by?: string;
  last_refreshed_at?: number;
}

export interface DeviceCodePending {
  request_id: string;
  provider_id: OAuthProviderId;
  connector_slug: string;
  scopes: string[];
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_at: number;
  interval: number;
  initiated_at: number;
  initiated_by?: string;
}

export interface OAuthStore {
  connections: Record<string, OAuthConnection>;
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
// Storage IO
// =========================================================================

export async function _readStore(): Promise<OAuthStore> {
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

export async function _writeStore(s: OAuthStore): Promise<void> {
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
  const s = await _readStore();
  return Object.values(s.connections);
}

export async function getConnection(id: string): Promise<OAuthConnection | null> {
  const s = await _readStore();
  return s.connections[id] || null;
}

export async function deleteConnection(id: string): Promise<void> {
  const s = await _readStore();
  delete s.connections[id];
  await _writeStore(s);
}
