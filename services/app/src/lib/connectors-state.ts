/**
 * Persistance de l'état des connecteurs : actif / inactif / masqué + config.
 *
 * Pour cette V1 on persiste dans un fichier JSON sur le volume
 * `/data/connectors.json` (monté depuis `/srv/ai-stack/data/`).
 *
 * Concurrent writes : verrouillage simple via promesse (single-writer
 * pattern) — suffisant tant qu'on a 1 seul process Next.js.
 *
 * IMPORTANT : Les valeurs de champs marqués `secret: true` ne sortent
 * jamais de cette couche vers le client, et sont chiffrées at-rest
 * (AES-256-GCM, préfixe `enc:v1:`, même dérivation de clé que
 * oauth-storage). Les valeurs en clair héritées d'avant ce durcissement
 * sont migrées automatiquement à la première écriture du fichier.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CONNECTORS, getConnector } from "@/lib/connectors";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "connectors.json");

export type ConnectorStatus = "active" | "inactive" | "hidden";

/** Rôles BoxIA (alignés avec Authentik groups + installed-agents.ts). */
export type ConnectorRole = "admin" | "manager" | "employee";

export interface ConnectorState {
  /** Slug du connecteur (clé). */
  slug: string;
  status: ConnectorStatus;
  /** Champs renseignés à l'activation, indexés par key. */
  config: Record<string, string>;
  /** Timestamp dernier sync réussi (ms epoch) ou null. */
  last_sync_at: number | null;
  /** Dernière erreur (1 ligne) ou null. */
  last_error: string | null;
  /** Timestamp activation initiale. */
  activated_at: number | null;
  /** Stats d'indexation. */
  stats?: {
    objects_indexed?: number;
    last_objects_added?: number;
    last_objects_removed?: number;
  };
  /**
   * RBAC Phase 1 : restriction d'accès par rôle BoxIA.
   *
   * - `undefined` ou `[]`  → accès ouvert à tous les rôles (default)
   * - `["admin"]`          → admin only
   * - `["admin","manager"]` → admin + manager (pas employee)
   * - `["admin","manager","employee"]` → équivalent à ouvert
   *
   * Filtré côté API GET /api/connectors et appliqué au retrieval RAG :
   * un agent qui interroge la KB ne récupère que les chunks issus des
   * connecteurs où le rôle de l'utilisateur courant est autorisé.
   */
  allowed_roles?: ConnectorRole[];
  /**
   * RBAC Phase 1 : permissions individuelles par email (override fin
   * sur le filtre `allowed_roles`). Vide = pas de surrestrictions.
   */
  allowed_users?: string[];
  /** Timestamp dernière modification des permissions (audit). */
  permissions_updated_at?: number | null;
}

interface StateFile {
  version: 1;
  updated_at: number;
  states: Record<string, ConnectorState>;
}

const EMPTY_STATE: StateFile = { version: 1, updated_at: 0, states: {} };

// =========================================================================
// Chiffrement at-rest des champs secret:true
// =========================================================================

const ENC_PREFIX = "enc:v1:";

function getEncryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET || process.env.DIFY_SECRET_KEY;
  if (!secret) {
    // Fail-hard plutôt que de stocker des credentials en clair ou de les
    // chiffrer avec une clé de repli connue.
    throw new Error(
      "NEXTAUTH_SECRET (ou DIFY_SECRET_KEY) manquant : impossible de "
      + "chiffrer/déchiffrer les secrets connecteurs.");
  }
  return crypto.createHash("sha256")
    .update(secret + "connectors-state-v1")
    .digest();
}

function isEncrypted(value: string): boolean {
  return value.startsWith(ENC_PREFIX);
}

function encryptSecretValue(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

/** Déchiffre une valeur `enc:v1:` ; renvoie la valeur telle quelle si elle
 *  est en clair (legacy), null si le blob est corrompu/clé changée. */
export function decryptSecretValue(value: string): string | null {
  if (!isEncrypted(value)) return value;
  try {
    const [ivHex, tagHex, ctHex] = value.slice(ENC_PREFIX.length).split(":");
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

/** Clés des champs secret:true d'un connecteur (d'après son spec). */
function secretKeysFor(slug: string): Set<string> {
  const spec = getConnector(slug);
  return new Set(
    (spec?.fields || []).filter((f) => f.secret).map((f) => f.key));
}

/** Chiffre en place les secrets encore en clair d'un état (idempotent). */
function encryptStateSecrets(st: ConnectorState): void {
  const keys = secretKeysFor(st.slug);
  for (const k of Object.keys(st.config)) {
    const v = st.config[k];
    if (keys.has(k) && v && !isEncrypted(v)) {
      st.config[k] = encryptSecretValue(v);
    }
  }
}

/**
 * Config d'un connecteur avec les secrets déchiffrés — réservé aux
 * consommateurs server-side qui doivent transmettre les credentials à un
 * worker. Ne JAMAIS renvoyer ce résultat au client.
 */
export function getDecryptedConfig(st: ConnectorState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(st.config)) {
    out[k] = decryptSecretValue(v) ?? "";
  }
  return out;
}

let writeLock: Promise<unknown> = Promise.resolve();

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch { /* ignore */ }
}

async function readState(): Promise<StateFile> {
  try {
    const txt = await fs.readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(txt) as StateFile;
    if (parsed?.version === 1 && parsed.states) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      // Fichier corrompu : on log et on repart à vide (sera réécrit)
      console.warn("[connectors-state] read error, falling back to empty:", e);
    }
  }
  return { ...EMPTY_STATE };
}

async function writeStateUnsafe(s: StateFile): Promise<void> {
  await ensureDir();
  s.updated_at = Date.now();
  // Écrit dans un fichier temporaire puis rename (atomique sur la même partition)
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

/** Wrap les writes derrière un lock pour éviter les races read-modify-write. */
async function mutate(fn: (s: StateFile) => Promise<StateFile> | StateFile): Promise<StateFile> {
  // Chaîne sur la queue précédente pour sérialiser
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => { resolveNext = r; });
  const prev = writeLock;
  writeLock = prev.then(() => next).catch(() => next);
  try {
    await prev;
  } catch { /* ignore */ }
  try {
    const cur = await readState();
    const updated = await fn(cur);
    // Migration at-rest : chiffre tout secret encore en clair (valeurs
    // héritées d'avant le chiffrement, ou fraîchement saisies). Idempotent.
    for (const st of Object.values(updated.states)) {
      encryptStateSecrets(st);
    }
    await writeStateUnsafe(updated);
    return updated;
  } finally {
    resolveNext();
  }
}

export async function listStates(): Promise<Record<string, ConnectorState>> {
  const s = await readState();
  return s.states;
}

export async function getState(slug: string): Promise<ConnectorState | null> {
  const all = await listStates();
  return all[slug] || null;
}

function emptyStateFor(slug: string): ConnectorState {
  return {
    slug,
    status: "inactive",
    config: {},
    last_sync_at: null,
    last_error: null,
    activated_at: null,
  };
}

/** Active un connecteur en sauvant ses credentials. */
export async function activateConnector(
  slug: string, config: Record<string, string>,
): Promise<ConnectorState> {
  const spec = getConnector(slug);
  if (!spec) throw new Error(`Unknown connector: ${slug}`);

  // Si le connecteur supporte OAuth ET qu'une connexion OAuth existe pour
  // ce provider+slug, on bypasse la validation des champs `required` du
  // form (le worker récupérera le token via /api/oauth/internal/token).
  // Sinon validation classique.
  let oauthBypass = false;
  if (spec.oauthProvider) {
    try {
      const { getConnection } = await import("./oauth-storage");
      const conn = await getConnection(`${spec.oauthProvider}:${slug}`);
      if (conn) oauthBypass = true;
    } catch {
      // Si oauth-storage cassé, fallback sur validation classique
    }
  }

  if (!oauthBypass) {
    for (const f of spec.fields) {
      if (f.required && !config[f.key]) {
        throw new Error(`Champ requis manquant : ${f.label}`);
      }
    }
  }
  const next = await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = {
      ...existing,
      status: "active",
      config: { ...existing.config, ...config },
      activated_at: existing.activated_at ?? Date.now(),
      last_error: null,
    };
    return cur;
  });
  return next.states[slug];
}

export async function deactivateConnector(slug: string): Promise<void> {
  await mutate((cur) => {
    const existing = cur.states[slug];
    if (existing) {
      cur.states[slug] = { ...existing, status: "inactive" };
    }
    return cur;
  });
}

export async function setHidden(slug: string, hidden: boolean): Promise<void> {
  await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = {
      ...existing,
      status: hidden ? "hidden" : (existing.status === "hidden" ? "inactive" : existing.status),
    };
    return cur;
  });
}

export async function recordSyncStart(slug: string): Promise<void> {
  await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = { ...existing, last_error: null };
    return cur;
  });
}

export async function recordSyncSuccess(
  slug: string,
  stats?: ConnectorState["stats"],
): Promise<void> {
  await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = {
      ...existing,
      last_sync_at: Date.now(),
      last_error: null,
      stats: stats ? { ...existing.stats, ...stats } : existing.stats,
    };
    return cur;
  });
}

export async function recordSyncError(slug: string, error: string): Promise<void> {
  await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = {
      ...existing,
      last_error: error.slice(0, 250),
    };
    return cur;
  });
}

/**
 * Met à jour les permissions RBAC d'un connecteur (admin only — vérifié
 * côté API). Pas de validation des rôles côté lib (l'API check).
 */
export async function setConnectorPermissions(
  slug: string,
  allowed_roles: ConnectorRole[],
  allowed_users: string[] = [],
): Promise<ConnectorState> {
  const next = await mutate((cur) => {
    const existing = cur.states[slug] || emptyStateFor(slug);
    cur.states[slug] = {
      ...existing,
      allowed_roles: allowed_roles.length > 0 ? [...new Set(allowed_roles)] : undefined,
      allowed_users: allowed_users.length > 0 ? [...new Set(allowed_users)] : undefined,
      permissions_updated_at: Date.now(),
    };
    return cur;
  });
  return next.states[slug];
}

/**
 * Vérifie si un user (rôle + email) a accès à un connecteur.
 *
 * Règle : `allowed_users` (whitelist par email) > `allowed_roles` (par
 * rôle) > ouvert par défaut. Un user est admissible s'il :
 *   - figure dans `allowed_users` (cas où la liste existe)
 *   - SINON son rôle figure dans `allowed_roles` (cas où la liste existe)
 *   - SINON pas de restrictions => accessible.
 *
 * Les admins ont TOUJOURS accès (bypass). Évite qu'un admin se mette en
 * dehors d'un connecteur par accident et ne puisse plus le modifier.
 */
export function userCanAccessConnector(
  state: ConnectorState,
  user: { role: ConnectorRole; email?: string },
): boolean {
  // Bypass admin (jamais lock-out)
  if (user.role === "admin") return true;

  // Whitelist par email — prioritaire si définie
  if (state.allowed_users && state.allowed_users.length > 0) {
    if (user.email && state.allowed_users.includes(user.email)) return true;
    // Pas dans whitelist email → on tombe sur les rôles
  }

  // Restriction par rôles
  if (state.allowed_roles && state.allowed_roles.length > 0) {
    return state.allowed_roles.includes(user.role);
  }

  // Pas de restriction → accessible à tous
  return true;
}

/** Vue publique d'un état (sans les valeurs des champs marqués secret). */
export function publicState(slug: string, st: ConnectorState): {
  slug: string;
  status: ConnectorStatus;
  config_keys_present: string[];
  has_secrets: boolean;
  last_sync_at: number | null;
  last_error: string | null;
  activated_at: number | null;
  stats?: ConnectorState["stats"];
  allowed_roles?: ConnectorRole[];
  allowed_users?: string[];
  permissions_updated_at?: number | null;
} {
  const spec = getConnector(slug);
  const secretKeys = new Set(spec?.fields.filter((f) => f.secret).map((f) => f.key));
  return {
    slug: st.slug,
    status: st.status,
    config_keys_present: Object.keys(st.config).filter((k) => !!st.config[k]),
    has_secrets: Object.keys(st.config).some((k) => secretKeys.has(k) && !!st.config[k]),
    last_sync_at: st.last_sync_at,
    last_error: st.last_error,
    activated_at: st.activated_at,
    stats: st.stats,
    allowed_roles: st.allowed_roles,
    allowed_users: st.allowed_users,
    permissions_updated_at: st.permissions_updated_at,
  };
}

// Export des constantes pour les routes
export { CONNECTORS };
