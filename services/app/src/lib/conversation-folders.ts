/**
 * Folders de conversations — extension du système Tags pour grouper
 * visuellement les conversations dans la sidebar.
 *
 * MVP V1 : 1 seul niveau de folders (pas d'arborescence récursive
 * comme OWUI `RecursiveFolder.svelte`). Suffisant pour TPE/PME (un
 * cabinet comptable groupe par client : « ACME », « Dupont SARL »...).
 * V2 = nesting parent_id quand on aura demande client.
 *
 * Storage local /data/conversation-folders.json :
 *   {
 *     "<user_email>": {
 *       "folders": [{ "id": "f-...", "name": "ACME", "color": "#3b82f6", "created_at": ... }, ...],
 *       "assignments": { "<dify_conversation_id>": "<folder_id>" | null, ... }
 *     }
 *   }
 *
 * Une conversation appartient à AU PLUS un folder (pas de multi-folder
 * — qui serait redondant avec les tags). Pas dans un folder = visible
 * dans la racine « Sans dossier ».
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const FOLDERS_FILE = process.env.CONVERSATION_FOLDERS_FILE
  || "/data/conversation-folders.json";

export interface Folder {
  id: string;
  name: string;
  /** Couleur hex (#3b82f6) pour l'icone folder dans sidebar. */
  color: string;
  created_at: number;
}

interface UserFoldersState {
  folders: Folder[];
  /** conv_id → folder_id (ou null si retiré). */
  assignments: Record<string, string | null>;
}

interface FoldersState {
  version: 1;
  users: Record<string, UserFoldersState>;
}

const EMPTY: FoldersState = { version: 1, users: {} };

const PALETTE = [
  "#3b82f6", "#10b981", "#a855f7", "#f59e0b",
  "#ec4899", "#06b6d4", "#f43f5e", "#14b8a6",
];

async function read(): Promise<FoldersState> {
  try {
    const txt = await fs.readFile(FOLDERS_FILE, "utf-8");
    const parsed = JSON.parse(txt) as FoldersState;
    if (parsed.version === 1 && parsed.users) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      console.warn("[conversation-folders] read error:", e);
    }
  }
  return { ...EMPTY, users: {} };
}

async function write(s: FoldersState): Promise<void> {
  await fs.mkdir(path.dirname(FOLDERS_FILE), { recursive: true });
  const tmp = FOLDERS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, FOLDERS_FILE);
}

function ensureUser(s: FoldersState, email: string): UserFoldersState {
  if (!s.users[email]) {
    s.users[email] = { folders: [], assignments: {} };
  }
  return s.users[email];
}

function normalizeName(raw: string): string {
  return raw.trim().slice(0, 40);
}

/** Liste les folders d'un user (triés par nom). */
export async function listFolders(email: string): Promise<Folder[]> {
  if (!email) return [];
  const s = await read();
  const fs_ = s.users[email]?.folders || [];
  return [...fs_].sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

/** Map convId → folderId pour cet user (sidebar rendering). */
export async function getAssignments(email: string): Promise<Record<string, string | null>> {
  if (!email) return {};
  const s = await read();
  return s.users[email]?.assignments || {};
}

/** Crée un nouveau folder. Renvoie le folder créé. */
export async function createFolder(
  email: string,
  name: string,
  color?: string,
): Promise<Folder | null> {
  const cleanName = normalizeName(name);
  if (!email || !cleanName) return null;
  const s = await read();
  const u = ensureUser(s, email);
  // Empêche les doublons (même nom)
  if (u.folders.some((f) => f.name.toLowerCase() === cleanName.toLowerCase())) {
    return u.folders.find((f) => f.name.toLowerCase() === cleanName.toLowerCase()) || null;
  }
  const f: Folder = {
    id: "f-" + crypto.randomBytes(6).toString("hex"),
    name: cleanName,
    color: color || PALETTE[u.folders.length % PALETTE.length],
    created_at: Date.now(),
  };
  u.folders.push(f);
  await write(s);
  return f;
}

/** Renomme / change la couleur d'un folder. */
export async function updateFolder(
  email: string,
  folderId: string,
  patch: { name?: string; color?: string },
): Promise<Folder | null> {
  const s = await read();
  const u = ensureUser(s, email);
  const f = u.folders.find((x) => x.id === folderId);
  if (!f) return null;
  if (patch.name !== undefined) f.name = normalizeName(patch.name);
  if (patch.color !== undefined) f.color = patch.color;
  await write(s);
  return f;
}

/** Supprime un folder. Les conversations assignées repassent en racine. */
export async function deleteFolder(email: string, folderId: string): Promise<void> {
  const s = await read();
  const u = ensureUser(s, email);
  u.folders = u.folders.filter((f) => f.id !== folderId);
  // Désassigne les convs qui pointaient sur ce folder
  for (const [cid, fid] of Object.entries(u.assignments)) {
    if (fid === folderId) u.assignments[cid] = null;
  }
  await write(s);
}

/** Assigne (ou désassigne avec folderId=null) une conversation. */
export async function assignConversation(
  email: string,
  conversationId: string,
  folderId: string | null,
): Promise<void> {
  if (!email || !conversationId) return;
  const s = await read();
  const u = ensureUser(s, email);
  if (folderId === null) {
    delete u.assignments[conversationId];
  } else {
    // Vérifie que le folder existe
    if (!u.folders.some((f) => f.id === folderId)) return;
    u.assignments[conversationId] = folderId;
  }
  await write(s);
}

/** RGPD : purge tous les folders + assignments d'un user. */
export async function purgeUser(email: string): Promise<void> {
  if (!email) return;
  const s = await read();
  delete s.users[email];
  await write(s);
}
