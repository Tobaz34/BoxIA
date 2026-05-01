/**
 * Client Langfuse minimal (no-deps, fetch direct vers l'API publique).
 *
 * Pourquoi pas le SDK officiel `langfuse-node` ?
 *   - Évite +1 dep npm dans aibox-app (déjà gros bundle)
 *   - L'API ingestion REST est trivialement stable, on n'a besoin que
 *     de POST /api/public/ingestion avec un batch d'événements
 *   - Permet le no-op silencieux si env absent (feature flag friendly)
 *
 * Activation : .env doit contenir
 *   LANGFUSE_BASE_URL=http://aibox-langfuse-web:3000
 *   LANGFUSE_PUBLIC_KEY=pk-lf-...
 *   LANGFUSE_SECRET_KEY=sk-lf-...
 *
 * Sans ces 3 vars : tous les helpers sont des no-ops (return immédiat).
 *
 * Argument commercial : trace replay step-by-step de chaque conversation
 * agent (input, prompts intermédiaires, tool calls, latences, tokens,
 * coût estimé). « Voici la trace complète de ce que votre IA a fait,
 * qui peut la rejouer/auditer. » → RGPD friendly + débuggable.
 */
import crypto from "node:crypto";

const BASE_URL = process.env.LANGFUSE_BASE_URL || "";
const PUBLIC_KEY = process.env.LANGFUSE_PUBLIC_KEY || "";
const SECRET_KEY = process.env.LANGFUSE_SECRET_KEY || "";
const TIMEOUT_MS = Number(process.env.LANGFUSE_TIMEOUT_MS || 5000);

export function isLangfuseEnabled(): boolean {
  return Boolean(BASE_URL && PUBLIC_KEY && SECRET_KEY);
}

/** Génère un ID unique style Langfuse (UUID v4). */
export function newId(): string {
  return crypto.randomUUID();
}

interface IngestionEvent {
  id: string;
  type:
    | "trace-create"
    | "generation-create"
    | "generation-update"
    | "span-create"
    | "span-update"
    | "event-create"
    | "score-create";
  timestamp: string;
  body: Record<string, unknown>;
}

async function sendBatch(events: IngestionEvent[]): Promise<void> {
  if (!isLangfuseEnabled() || events.length === 0) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const auth =
      "Basic " +
      Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString("base64");
    await fetch(`${BASE_URL}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({ batch: events }),
      signal: ctrl.signal,
    });
  } catch {
    // Silencieux : observability ne doit JAMAIS casser le chat
  } finally {
    clearTimeout(timer);
  }
}

export interface TraceOpts {
  /** Identifiant logique stable pour cette conversation (Dify conversation_id idéal). */
  id?: string;
  /** Nom court (« chat-message », « concierge-call », « rag-search »…). */
  name: string;
  /** Email ou slug du user qui a déclenché. */
  userId?: string;
  /** Slug de l'agent (general / accountant / concierge…). */
  sessionId?: string;
  /** Input brut (le prompt user). Tronqué à 8 KB. */
  input?: unknown;
  /** Tags arbitraires pour filtrer dans l'UI Langfuse. */
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** Crée une trace racine. Renvoie son id (réutilisable pour update). */
export function startTrace(opts: TraceOpts): string {
  const id = opts.id || newId();
  if (!isLangfuseEnabled()) return id;
  const now = new Date().toISOString();
  const ev: IngestionEvent = {
    id: newId(),
    type: "trace-create",
    timestamp: now,
    body: {
      id,
      // body.timestamp est REQUIS par l'API Langfuse v2 — sinon HTTP 400
      // « invalid_request_error » sans message clair. À garder synchro
      // avec le timestamp de l'enveloppe.
      timestamp: now,
      name: opts.name,
      userId: opts.userId,
      sessionId: opts.sessionId,
      input: typeof opts.input === "string"
        ? opts.input.slice(0, 8000)
        : opts.input,
      tags: opts.tags,
      metadata: opts.metadata,
    },
  };
  // Fire-and-forget — pas d'await, jamais bloquant
  void sendBatch([ev]);
  return id;
}

export interface GenerationOpts {
  traceId: string;
  name: string;
  /** Modèle utilisé (« qwen3:14b », « gpt-4o »...). */
  model?: string;
  /** Prompt envoyé au LLM. */
  input?: unknown;
  /** Sortie du LLM. Tronquée 16 KB. */
  output?: unknown;
  /** Métriques d'usage (tokens, coût…). */
  usage?: {
    input?: number;
    output?: number;
    total?: number;
    unit?: "TOKENS" | "CHARACTERS";
  };
  startTime?: Date;
  endTime?: Date;
  metadata?: Record<string, unknown>;
}

/** Enregistre un appel LLM complet (start + end en un coup). */
export function logGeneration(opts: GenerationOpts): void {
  if (!isLangfuseEnabled()) return;
  const id = newId();
  const now = new Date();
  const end = opts.endTime || now;
  const start = opts.startTime || end;
  const ev: IngestionEvent = {
    id: newId(),
    type: "generation-create",
    timestamp: now.toISOString(),
    body: {
      id,
      traceId: opts.traceId,
      name: opts.name,
      model: opts.model,
      input: typeof opts.input === "string"
        ? opts.input.slice(0, 16000)
        : opts.input,
      output: typeof opts.output === "string"
        ? opts.output.slice(0, 16000)
        : opts.output,
      usage: opts.usage,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      metadata: opts.metadata,
    },
  };
  void sendBatch([ev]);
}

/** Met à jour une trace existante (par exemple pour ajouter l'output
 *  final une fois le streaming terminé). */
export function updateTrace(
  traceId: string,
  patch: { output?: unknown; metadata?: Record<string, unknown>; tags?: string[] },
): void {
  if (!isLangfuseEnabled()) return;
  const ev: IngestionEvent = {
    id: newId(),
    type: "trace-create", // Langfuse v3 : trace-create est upsert sur l'id
    timestamp: new Date().toISOString(),
    body: {
      id: traceId,
      output: typeof patch.output === "string"
        ? patch.output.slice(0, 16000)
        : patch.output,
      metadata: patch.metadata,
      tags: patch.tags,
    },
  };
  void sendBatch([ev]);
}
