/**
 * Persistance des agents custom créés via le wizard /agents.
 *
 * Stockés dans `/data/custom-agents.json` (single-writer pattern, idem
 * que connectors-state.ts). Chaque agent est lié à une app Dify
 * existante (app_id) et a sa propre clé API (api_key) — symétrie totale
 * avec les agents builtin du registre AGENTS.
 *
 * Les agents builtin (general/accountant/hr/support) restent codés en
 * dur dans /lib/agents.ts ; les custom sont une couche additionnelle.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentRole } from "@/lib/agents";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "custom-agents.json");

export interface CustomAgent {
  slug: string;          // url-safe, unique parmi builtin + custom
  name: string;
  icon: string;          // emoji
  description: string;
  domain: string;        // catégorie wizard (comptabilité, RH, support, ...)
  tone: string;          // formal / friendly / direct
  language: string;      // fr-FR par défaut
  allowedRoles: AgentRole[]; // [] = ouvert à tous
  /** ID de l'app Dify créée. */
  app_id: string;
  /** Clé d'app Dify (Bearer app-...) — secret, ne jamais sortir vers le client. */
  api_key: string;
  /** Si vrai, l'agent utilise un modèle vision (les uploads d'images sont
   *  alors visibles). Le wizard peut activer ça en V1.5. */
  vision: boolean;
  pre_prompt: string;
  opening_statement: string;
  suggested_questions: string[];
  created_by: string;     // email de l'admin créateur
  created_at: number;     // ms epoch
}

interface StateFile {
  version: 1;
  updated_at: number;
  agents: Record<string, CustomAgent>;
}

const EMPTY_STATE: StateFile = { version: 1, updated_at: 0, agents: {} };

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
    if (parsed?.version === 1 && parsed.agents) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      console.warn("[custom-agents] read error:", e);
    }
  }
  return { ...EMPTY_STATE, agents: {} };
}

async function writeStateUnsafe(s: StateFile): Promise<void> {
  await ensureDir();
  s.updated_at = Date.now();
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, STATE_FILE);
}

async function mutate(
  fn: (s: StateFile) => Promise<StateFile> | StateFile,
): Promise<StateFile> {
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => { resolveNext = r; });
  const prev = writeLock;
  writeLock = prev.then(() => next).catch(() => next);
  try { await prev; } catch { /* ignore */ }
  try {
    const cur = await readState();
    const updated = await fn(cur);
    await writeStateUnsafe(updated);
    return updated;
  } finally {
    resolveNext();
  }
}

export async function listCustomAgents(): Promise<CustomAgent[]> {
  const s = await readState();
  return Object.values(s.agents).sort((a, b) => a.created_at - b.created_at);
}

export async function getCustomAgent(slug: string): Promise<CustomAgent | null> {
  const s = await readState();
  return s.agents[slug] || null;
}

export async function saveCustomAgent(agent: CustomAgent): Promise<void> {
  await mutate((s) => {
    s.agents[agent.slug] = agent;
    return s;
  });
}

export async function updateCustomAgent(
  slug: string,
  patch: Partial<CustomAgent>,
): Promise<CustomAgent | null> {
  let updated: CustomAgent | null = null;
  await mutate((s) => {
    const existing = s.agents[slug];
    if (!existing) return s;
    updated = { ...existing, ...patch, slug, app_id: existing.app_id };
    s.agents[slug] = updated;
    return s;
  });
  return updated;
}

export async function deleteCustomAgent(slug: string): Promise<boolean> {
  let deleted = false;
  await mutate((s) => {
    if (s.agents[slug]) {
      delete s.agents[slug];
      deleted = true;
    }
    return s;
  });
  return deleted;
}

/** Génère un slug à partir d'un nom : "Mon Assistant Légal" → "mon-assistant-legal". */
export function slugifyAgentName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `agent-${Date.now().toString(36)}`;
}
