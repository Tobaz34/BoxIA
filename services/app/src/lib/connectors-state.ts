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
 * jamais de cette couche vers le client. Ils sont stockés en clair sur
 * le disque (à durcir avec une clé d'encryption dans une V2).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { CONNECTORS, getConnector } from "@/lib/connectors";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "connectors.json");

export type ConnectorStatus = "active" | "inactive" | "hidden";

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
}

interface StateFile {
  version: 1;
  updated_at: number;
  states: Record<string, ConnectorState>;
}

const EMPTY_STATE: StateFile = { version: 1, updated_at: 0, states: {} };

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
  // Validation minimale : champs required présents
  for (const f of spec.fields) {
    if (f.required && !config[f.key]) {
      throw new Error(`Champ requis manquant : ${f.label}`);
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
  };
}

// Export des constantes pour les routes
export { CONNECTORS };
