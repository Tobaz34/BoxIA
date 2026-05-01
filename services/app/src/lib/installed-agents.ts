/**
 * Persistance des agents installés dynamiquement par l'admin client
 * via la page /agents/marketplace.
 *
 * Stockage : JSON simple dans le volume monté `/data` (déjà utilisé par
 * d'autres parties de l'app — cf. compose `/srv/ai-stack/data:/data`).
 * Pas de DB dédiée volontairement : les agents sont de la config, leur
 * volume est faible (max ~50 agents par client), et un fichier JSON est
 * trivial à backup / migrer.
 */
import fs from "fs/promises";
import path from "path";

const DATA_DIR = process.env.AIBOX_DATA_DIR || "/data";
const STORE_FILE = path.join(DATA_DIR, "installed-agents.json");

export type AgentRole = "admin" | "manager" | "employee";

export type DifyAppMode = "chat" | "advanced-chat" | "workflow" | "agent-chat" | "completion";

export interface InstalledAgent {
  /** Slug URL-safe (auto-généré depuis le nom). */
  slug: string;
  /** UUID de l'app Dify côté workspace (utilisable côté console). */
  app_id: string;
  /** Bearer token "app-..." pour /v1/chat-messages. */
  api_key: string;
  /** Mode de l'app. */
  mode: DifyAppMode;
  /** Nom affiché dans le picker. */
  name: string;
  /** Description courte. */
  description: string;
  /** Emoji. */
  icon: string;
  /** Couleur de fond hex. */
  icon_background: string;
  /** Catégorie de la marketplace d'origine. */
  category?: string;
  /** Date d'installation ISO. */
  installed_at: string;
  /** UUID du template marketplace d'origine (traçabilité). */
  source_template_id?: string;
  /** Rôles autorisés à utiliser cet agent. Undefined = tous. */
  allowed_roles?: AgentRole[];
}

interface Store {
  version: 1;
  agents: InstalledAgent[];
}

const EMPTY: Store = { version: 1, agents: [] };

async function ensureFile(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.access(STORE_FILE);
  } catch {
    await fs.writeFile(STORE_FILE, JSON.stringify(EMPTY, null, 2), "utf-8");
  }
}

async function readStore(): Promise<Store> {
  await ensureFile();
  try {
    const raw = await fs.readFile(STORE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Store;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.agents)) {
      return { ...EMPTY };
    }
    return parsed;
  } catch {
    return { ...EMPTY };
  }
}

async function writeStore(store: Store): Promise<void> {
  await ensureFile();
  await fs.writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf-8");
}

/** Slugify un nom pour un identifiant URL-safe. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60) || "agent";
}

/** Garantit l'unicité du slug (suffixe -2, -3 si conflit). */
async function uniqueSlug(base: string, excludingSlug?: string): Promise<string> {
  const existing = await listInstalledAgents();
  const taken = new Set(existing.filter((a) => a.slug !== excludingSlug).map((a) => a.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** Liste tous les agents installés. */
export async function listInstalledAgents(): Promise<InstalledAgent[]> {
  const store = await readStore();
  return store.agents;
}

/** Ajoute un agent installé (génère un slug unique automatiquement). */
export async function addInstalledAgent(input: Omit<InstalledAgent, "slug" | "installed_at">): Promise<InstalledAgent> {
  const store = await readStore();
  const slug = await uniqueSlug(slugify(input.name));
  const agent: InstalledAgent = {
    ...input,
    slug,
    installed_at: new Date().toISOString(),
  };
  store.agents.push(agent);
  await writeStore(store);
  return agent;
}

/** Supprime un agent installé par slug. */
export async function removeInstalledAgent(slug: string): Promise<boolean> {
  const store = await readStore();
  const before = store.agents.length;
  store.agents = store.agents.filter((a) => a.slug !== slug);
  if (store.agents.length === before) return false;
  await writeStore(store);
  return true;
}

/** Récupère un agent par slug. */
export async function getInstalledAgent(slug: string): Promise<InstalledAgent | null> {
  const store = await readStore();
  return store.agents.find((a) => a.slug === slug) || null;
}

/** Met à jour les rôles autorisés d'un agent. */
export async function updateInstalledAgentRoles(slug: string, roles: AgentRole[] | undefined): Promise<boolean> {
  const store = await readStore();
  const a = store.agents.find((a) => a.slug === slug);
  if (!a) return false;
  a.allowed_roles = roles && roles.length > 0 ? roles : undefined;
  await writeStore(store);
  return true;
}
