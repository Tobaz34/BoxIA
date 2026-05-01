/**
 * Audit log applicatif (en plus des events Authentik).
 *
 * Stocké dans `/data/audit.jsonl` (JSON Lines, une entrée par ligne) :
 * - facile à appender de façon atomique
 * - facile à grep / parser
 * - rotation simple (rename + nouveau fichier)
 *
 * Limite : 5000 entrées max (truncated en début si dépassé) → on
 * délègue les events système à Authentik et on ne trace ici que les
 * actions custom (activation connecteur, export RGPD, suppression conv,
 * upload doc, etc.)
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const AUDIT_FILE = path.join(STATE_DIR, "audit.jsonl");
const MAX_ENTRIES = 5000;

export type AuditAction =
  | "connector.activate"
  | "connector.deactivate"
  | "connector.hide"
  | "connector.unhide"
  | "connector.sync"
  | "connector.permissions_change"
  | "document.upload"
  | "document.delete"
  | "rgpd.export"
  | "rgpd.delete_conversations"
  | "rgpd.delete_memory"
  | "agent.install_template"
  | "agent.uninstall"
  | "workflow.run_manual"
  | "workflow.upload"
  | "workflow.install_template"
  | "user.invite"
  | "user.role_change"
  | "user.toggle_active"
  | "user.recovery_link"
  | "agent.chat"             // optionnel, peut spammer
  | "settings.update"
  | "audit.access"           // l'admin a consulté l'audit
  | "concierge.approval";    // l'admin a approuvé/refusé une action Concierge

export interface AuditEntry {
  ts: number;                              // ms epoch
  actor: string;                           // email du user qui a fait l'action
  actor_role?: "admin" | "manager" | "employee";
  action: AuditAction;
  target?: string;                         // slug, id, email, etc.
  details?: Record<string, unknown>;       // contexte additionnel
  client_ip?: string | null;
}

let writeQueue: Promise<unknown> = Promise.resolve();

async function ensureDir() {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
  } catch { /* noop */ }
}

/** Append une entrée d'audit. Best-effort : ne lève jamais d'exception. */
export async function logAudit(entry: AuditEntry): Promise<void> {
  // Sérialise tout pour éviter les races
  const next = writeQueue.then(async () => {
    try {
      await ensureDir();
      const line = JSON.stringify(entry) + "\n";
      await fs.appendFile(AUDIT_FILE, line, "utf8");
    } catch (e) {
      console.warn("[app-audit] write error:", e);
    }
  });
  writeQueue = next.catch(() => {/* keep chain healthy */});
  return next;
}

interface ReadOpts {
  /** Filtre par action (préfixe match — ex "connector." pour tout connecteur). */
  action?: string;
  /** Filtre par actor email. */
  actor?: string;
  /** Filtre depuis ms epoch. */
  since?: number;
  /** Pagination : nb d'entrées max retournées. */
  limit?: number;
}

/** Lit les N dernières entrées, plus récentes en premier. */
export async function readAudit(opts: ReadOpts = {}): Promise<AuditEntry[]> {
  try {
    const txt = await fs.readFile(AUDIT_FILE, "utf8");
    const lines = txt.split("\n").filter(Boolean);
    const result: AuditEntry[] = [];
    // On lit du plus récent au plus ancien (ligne fin → début)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]!) as AuditEntry;
        if (opts.action && !e.action.startsWith(opts.action)) continue;
        if (opts.actor && e.actor !== opts.actor) continue;
        if (opts.since && e.ts < opts.since) continue;
        result.push(e);
        if (opts.limit && result.length >= opts.limit) break;
      } catch { /* ligne corrompue, skip */ }
    }
    return result;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code === "ENOENT") return [];
    throw e;
  }
}

/** Tronque le fichier si plus de MAX_ENTRIES (fire-and-forget, à appeler
 *  périodiquement — pour cette V1 on le fait à chaque écriture rare). */
export async function maybeRotate(): Promise<void> {
  try {
    const txt = await fs.readFile(AUDIT_FILE, "utf8");
    const lines = txt.split("\n").filter(Boolean);
    if (lines.length <= MAX_ENTRIES) return;
    const kept = lines.slice(-MAX_ENTRIES).join("\n") + "\n";
    const tmp = AUDIT_FILE + ".tmp";
    await fs.writeFile(tmp, kept, "utf8");
    await fs.rename(tmp, AUDIT_FILE);
  } catch { /* noop */ }
}
