/**
 * Tags de conversations — couche locale BoxIA par-dessus Dify.
 *
 * Pourquoi c'est local et pas dans Dify : Dify n'a pas de modèle de
 * tags exposé via son API REST publique. Plutôt que de patcher Dify,
 * on garde un mapping local /data/conversation-tags.json :
 *   {
 *     "<user_email>": {
 *       "<dify_conversation_id>": ["clientX", "urgent", "compta-2026"],
 *       ...
 *     }
 *   }
 *
 * Avantages :
 *   - Aucune dépendance Dify (les tags survivent aux migrations Dify)
 *   - RGPD : suppression user via /api/me → on purge ses tags
 *   - Multi-user clean : pas de collision entre utilisateurs
 *
 * Limites V1 :
 *   - Pas de tag global "favori" partagé entre users (V2 si besoin)
 *   - Pas de hiérarchie / folders (cf. backlog OWUI : RecursiveFolder)
 *   - Pas de tag color management (juste hash pour stabilité visuelle)
 *
 * Top-1 priorité OWUI 2026-05-01 : sans rangement des conversations,
 * un cabinet comptable abandonne l'outil après 2 semaines (50 conv/mois).
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const TAGS_FILE = process.env.CONVERSATION_TAGS_FILE
  || "/data/conversation-tags.json";

interface TagsState {
  version: 1;
  /** user_email → { conversation_id → tags[] }. */
  users: Record<string, Record<string, string[]>>;
}

const EMPTY: TagsState = { version: 1, users: {} };

async function read(): Promise<TagsState> {
  try {
    const txt = await fs.readFile(TAGS_FILE, "utf-8");
    const parsed = JSON.parse(txt) as TagsState;
    if (parsed.version === 1 && parsed.users) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      console.warn("[conversation-tags] read error:", e);
    }
  }
  return { ...EMPTY, users: {} };
}

async function write(s: TagsState): Promise<void> {
  await fs.mkdir(path.dirname(TAGS_FILE), { recursive: true });
  const tmp = TAGS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, TAGS_FILE);
}

/** Normalise un tag : trim, lowercase, max 30 chars, alphanum + tiret. */
export function normalizeTag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9À-ſ-]+/g, "-") // accents FR autorisés
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

/** Liste les tags d'une conversation pour un user. */
export async function getTags(userEmail: string, convId: string): Promise<string[]> {
  if (!userEmail || !convId) return [];
  const s = await read();
  return s.users[userEmail]?.[convId] || [];
}

/** Liste tous les tags d'un user (toutes conversations confondues),
 *  utile pour suggester l'autocomplete et bâtir le filter sidebar. */
export async function listAllUserTags(userEmail: string): Promise<{ tag: string; count: number }[]> {
  if (!userEmail) return [];
  const s = await read();
  const userMap = s.users[userEmail] || {};
  const counts = new Map<string, number>();
  for (const tags of Object.values(userMap)) {
    for (const t of tags) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/** Map convId → tags pour TOUTES les conversations d'un user (efficace
 *  pour rendre les badges en sidebar sans N requêtes). */
export async function getUserTagsMap(userEmail: string): Promise<Record<string, string[]>> {
  if (!userEmail) return {};
  const s = await read();
  return s.users[userEmail] || {};
}

/** Set tags pour une conversation (remplace l'existant). Limité à 8
 *  tags par conv pour éviter les abus. */
export async function setTags(
  userEmail: string,
  convId: string,
  tags: string[],
): Promise<string[]> {
  if (!userEmail || !convId) return [];
  const cleaned = Array.from(
    new Set(tags.map(normalizeTag).filter(Boolean)),
  ).slice(0, 8);
  const s = await read();
  if (!s.users[userEmail]) s.users[userEmail] = {};
  if (cleaned.length === 0) {
    delete s.users[userEmail][convId];
  } else {
    s.users[userEmail][convId] = cleaned;
  }
  await write(s);
  return cleaned;
}

/** RGPD : purge tous les tags d'un user (à appeler depuis /api/me/delete-*). */
export async function purgeUser(userEmail: string): Promise<void> {
  if (!userEmail) return;
  const s = await read();
  delete s.users[userEmail];
  await write(s);
}

/** Couleur stable basée sur un hash du tag (pour rendre les badges
 *  visuellement distincts sans configurer de palette). */
export function tagColorClasses(tag: string): { bg: string; text: string } {
  // Palette Tailwind 8 couleurs avec contraste lisible
  const palette = [
    { bg: "bg-blue-500/15",    text: "text-blue-300" },
    { bg: "bg-emerald-500/15", text: "text-emerald-300" },
    { bg: "bg-purple-500/15",  text: "text-purple-300" },
    { bg: "bg-amber-500/15",   text: "text-amber-300" },
    { bg: "bg-pink-500/15",    text: "text-pink-300" },
    { bg: "bg-cyan-500/15",    text: "text-cyan-300" },
    { bg: "bg-rose-500/15",    text: "text-rose-300" },
    { bg: "bg-teal-500/15",    text: "text-teal-300" },
  ];
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
