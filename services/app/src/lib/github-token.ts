/**
 * Helper pour le token GitHub utilisé par /api/system/check-updates et par
 * le watcher hôte pour git fetch.
 *
 * Lecture en cascade :
 *   1. process.env.GITHUB_TOKEN (provisioning via /srv/ai-stack/.env)
 *   2. /data/github-token.json (admin paste depuis l'UI, AES-256-GCM)
 *
 * Pas de PAT en clair sur disque : on chiffre avec la même dérivation HKDF
 * que cloud-providers (sha256(NEXTAUTH_SECRET + "github-token-v1")). Si
 * NEXTAUTH_SECRET change, le token devient illisible et l'admin doit le
 * resaisir — comportement intentionnel (révocation côté boîte).
 *
 * Le watcher hôte (update-watcher.sh) NE DÉCHIFFRE PAS lui-même : il lit
 * GITHUB_TOKEN dans .env, et on offre une commande optionnelle
 *   docker exec aibox-app node -e '...' pour récupérer le clair quand
 * le token vient de l'UI plutôt que de .env. Cf tools/deploy-to-xefia.sh.
 */
import { promises as fs } from "node:fs";
import * as crypto from "node:crypto";

const STORE_PATH = "/data/github-token.json";
// Fichier plain text pour le watcher hôte (update-watcher.sh) qui ne peut
// pas déchiffrer AES-GCM en bash. Mêmes garanties qu'.env :
//   - perms 0640 (root + group lecture)
//   - dans /data qui est volume host monté seulement là
//   - supprimé par deleteStoredToken() pour cohérence avec révocation UI
const RUNTIME_PATH = "/data/.github-token-runtime";

interface StoredToken {
  encrypted: string;
  saved_at: string;
  saved_by?: string;
  // Cache de validation léger pour éviter de re-pinger /user à chaque
  // /api/system/check-updates. Refresh forcé via /api/system/github-status.
  last_validated_at?: string;
  login?: string;
  scopes?: string[];
}

function getEncryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
    || process.env.DIFY_SECRET_KEY
    || "boxia-default-secret-CHANGE-ME-IN-ENV";
  return crypto.createHash("sha256")
    .update(secret + "github-token-v1")
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

async function readStored(): Promise<StoredToken | null> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf-8");
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

async function writeStored(s: StoredToken | null, runtimePlain?: string | null): Promise<void> {
  if (s === null) {
    await fs.unlink(STORE_PATH).catch(() => {});
    await fs.unlink(RUNTIME_PATH).catch(() => {});
    return;
  }
  const tmp = STORE_PATH + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tmp, STORE_PATH);
  if (runtimePlain !== undefined) {
    if (runtimePlain) {
      const tmpr = RUNTIME_PATH + ".tmp";
      await fs.writeFile(tmpr, runtimePlain, { encoding: "utf-8", mode: 0o640 });
      await fs.rename(tmpr, RUNTIME_PATH);
    } else {
      await fs.unlink(RUNTIME_PATH).catch(() => {});
    }
  }
}

/** Retourne le token actif (env > stored) ou null si non configuré. */
export async function getActiveGitHubToken(): Promise<{ token: string; source: "env" | "file" } | null> {
  const envTok = process.env.GITHUB_TOKEN;
  if (envTok && envTok.trim()) {
    return { token: envTok.trim(), source: "env" };
  }
  const stored = await readStored();
  if (!stored) return null;
  const dec = decryptToken(stored.encrypted);
  if (!dec) return null;
  return { token: dec, source: "file" };
}

export async function getStoredMetadata(): Promise<Omit<StoredToken, "encrypted"> | null> {
  const stored = await readStored();
  if (!stored) return null;
  const { encrypted: _e, ...meta } = stored;
  return meta;
}

export async function saveToken(plaintext: string, savedBy?: string): Promise<void> {
  await writeStored({
    encrypted: encryptToken(plaintext),
    saved_at: new Date().toISOString(),
    saved_by: savedBy,
  }, plaintext);
}

export async function deleteStoredToken(): Promise<void> {
  await writeStored(null);
}

/** Sauvegarde le résultat de /user dans le metadata stored (login, scopes).
 *  Ne touche pas au RUNTIME_PATH (undefined → on laisse l'existant). */
export async function updateValidationCache(login: string, scopes: string[]): Promise<void> {
  const stored = await readStored();
  if (!stored) return;
  await writeStored({
    ...stored,
    last_validated_at: new Date().toISOString(),
    login,
    scopes,
  });
}

/** Test live : ping GET /user avec le token. Retourne login + scopes ou throw. */
export async function validateToken(token: string): Promise<{ login: string; scopes: string[] }> {
  const r = await fetch("https://api.github.com/user", {
    headers: {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "aibox-app/github-token",
    },
  });
  if (!r.ok) {
    throw new Error(`GitHub /user ${r.status}: ${await r.text().catch(() => "")}`);
  }
  const body = await r.json();
  // X-OAuth-Scopes pour les classic tokens, vide pour les fine-grained.
  const scopesHeader = r.headers.get("x-oauth-scopes") || "";
  const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
  return { login: body.login || "?", scopes };
}
