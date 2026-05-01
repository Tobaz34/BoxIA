/**
 * Stockage des fichiers générés par les agents IA.
 *
 * Persisté dans `/data/generated/` (UUID.ext) + un index JSON pour la méta
 * (filename original, mime, size, owner, created_at). Ainsi un download
 * peut rendre `Content-Disposition: attachment; filename=...` avec le
 * vrai nom choisi par l'agent, et on peut isoler par utilisateur.
 *
 * Auto-cleanup : les fichiers de plus de RETENTION_MS sont supprimés
 * paresseusement à chaque listOwn(). Pas de cron : un user qui n'utilise
 * jamais l'app n'aura pas son trash purgé, mais ça reste léger.
 *
 * Sécurité :
 *  - Les UUID sont uniformément aléatoires (crypto.randomUUID).
 *  - Le download exige que owner_email == session.user.email.
 *  - Aucune leak de path : on n'expose jamais le chemin disque côté client.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const FILES_DIR = path.join(STATE_DIR, "generated");
const INDEX_FILE = path.join(FILES_DIR, "_index.json");
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;  // 7 jours

export interface FileMeta {
  id: string;             // UUID
  filename: string;       // nom affiché à l'utilisateur, ex: "devis-client.xlsx"
  ext: string;            // "xlsx"
  mime: string;
  size: number;           // octets
  owner_email: string;
  conversation_id?: string;
  message_index?: number;
  created_at: number;     // ms epoch
}

interface IndexFile {
  version: 1;
  files: Record<string, FileMeta>;
}

let writeLock: Promise<unknown> = Promise.resolve();

async function ensureDir(): Promise<void> {
  try {
    await fs.mkdir(FILES_DIR, { recursive: true });
  } catch { /* ignore */ }
}

async function readIndex(): Promise<IndexFile> {
  try {
    const txt = await fs.readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(txt) as IndexFile;
    if (parsed?.version === 1 && parsed.files) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      console.warn("[file-storage] index read error:", e);
    }
  }
  return { version: 1, files: {} };
}

async function writeIndexUnsafe(idx: IndexFile): Promise<void> {
  await ensureDir();
  const tmp = INDEX_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(idx, null, 2), "utf8");
  await fs.rename(tmp, INDEX_FILE);
}

async function mutateIndex(
  fn: (idx: IndexFile) => Promise<IndexFile> | IndexFile,
): Promise<IndexFile> {
  let resolveNext!: () => void;
  const next = new Promise<void>((r) => { resolveNext = r; });
  const prev = writeLock;
  writeLock = prev.then(() => next).catch(() => next);
  try { await prev; } catch { /* ignore */ }
  try {
    const cur = await readIndex();
    const updated = await fn(cur);
    await writeIndexUnsafe(updated);
    return updated;
  } finally {
    resolveNext();
  }
}

/** Stocke un fichier. Retourne la méta. */
export async function storeFile(
  buffer: Buffer,
  filename: string,
  mime: string,
  ownerEmail: string,
  ctx?: { conversation_id?: string; message_index?: number },
): Promise<FileMeta> {
  await ensureDir();
  const id = crypto.randomUUID();
  const ext = filename.split(".").pop()?.toLowerCase() || "bin";
  const diskPath = path.join(FILES_DIR, `${id}.${ext}`);
  await fs.writeFile(diskPath, buffer);
  const meta: FileMeta = {
    id, filename, ext, mime,
    size: buffer.byteLength,
    owner_email: ownerEmail,
    conversation_id: ctx?.conversation_id,
    message_index: ctx?.message_index,
    created_at: Date.now(),
  };
  await mutateIndex((idx) => {
    idx.files[id] = meta;
    return idx;
  });
  return meta;
}

/** Récupère la méta + le buffer d'un fichier (vérifie le owner). */
export async function readFile(
  id: string, ownerEmail: string,
): Promise<{ meta: FileMeta; buffer: Buffer } | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return null;
  }
  const idx = await readIndex();
  const meta = idx.files[id];
  if (!meta) return null;
  if (meta.owner_email !== ownerEmail) return null;  // 403 implicite
  const diskPath = path.join(FILES_DIR, `${meta.id}.${meta.ext}`);
  try {
    const buffer = await fs.readFile(diskPath);
    return { meta, buffer };
  } catch {
    return null;
  }
}

/** Liste les fichiers du user (avec auto-cleanup paresseux). */
export async function listOwn(ownerEmail: string): Promise<FileMeta[]> {
  const cutoff = Date.now() - RETENTION_MS;
  const idx = await mutateIndex(async (cur) => {
    // Cleanup tout ce qui est trop vieux
    const toDelete: string[] = [];
    for (const [id, m] of Object.entries(cur.files)) {
      if (m.created_at < cutoff) toDelete.push(id);
    }
    for (const id of toDelete) {
      const m = cur.files[id];
      try {
        await fs.unlink(path.join(FILES_DIR, `${m.id}.${m.ext}`));
      } catch { /* ignore */ }
      delete cur.files[id];
    }
    return cur;
  });
  return Object.values(idx.files)
    .filter((m) => m.owner_email === ownerEmail)
    .sort((a, b) => b.created_at - a.created_at);
}

/** Supprime un fichier (ou no-op si pas owner). */
export async function deleteFile(id: string, ownerEmail: string): Promise<boolean> {
  let deleted = false;
  await mutateIndex(async (cur) => {
    const m = cur.files[id];
    if (m && m.owner_email === ownerEmail) {
      try {
        await fs.unlink(path.join(FILES_DIR, `${m.id}.${m.ext}`));
      } catch { /* ignore */ }
      delete cur.files[id];
      deleted = true;
    }
    return cur;
  });
  return deleted;
}

/** Format human-readable d'une taille (utilisé côté UI). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}
