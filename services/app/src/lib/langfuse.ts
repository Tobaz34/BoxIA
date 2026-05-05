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

// ===== Sprint 0 S0.3 — instrumentation tool-call =====

export interface ToolCallLogOpts {
  /** Nom du tool (ex: "web_search", "rag_search"). */
  toolName: string;
  /** Email user (NextAuth) si connu — best-effort. */
  userId?: string;
  /** Conversation Dify si propagée (header X-Conversation-Id ou body). */
  conversationId?: string;
  /** Slug agent appelant (ex: "concierge", "general"). Défaut: "concierge". */
  agentSlug?: string;
  /** Input du tool (args body). Tronqué 4 KB. */
  input?: unknown;
  /** Output du tool. Tronqué 8 KB. */
  output?: unknown;
  /** True si le tool a réussi (ok: true côté payload). */
  success: boolean;
  /** Code erreur si échec (toolError.error). */
  errorCode?: string;
  /** True si l'erreur était retryable (toolError.retryable). */
  retryable?: boolean;
  /** Timestamps pour calculer la durée. */
  startTime: Date;
  endTime: Date;
  /** HTTP status final renvoyé au caller. */
  httpStatus?: number;
  /** Metadata libre. */
  metadata?: Record<string, unknown>;
  /** Trace racine à laquelle rattacher (si propagée par caller). Sinon
   *  une trace standalone est créée pour ce tool-call. */
  traceId?: string;
}

/**
 * Trace l'exécution d'un tool agents-tools dans Langfuse.
 *
 * Si `traceId` est fourni → un span `tool:<name>` est créé sous cette trace.
 * Sinon → une trace racine standalone `tool:<name>` est créée (utile pour
 * les tools appelés directement par Dify Custom Tool sans propagation
 * de trace context).
 *
 * Le sessionId Langfuse = conversationId Dify → groupe les traces par
 * conversation dans l'UI Langfuse.
 *
 * Tags posés (filtres UI Langfuse) :
 *  - tool:<toolName>
 *  - agent:<agentSlug>
 *  - status:success | status:failure
 *  - retryable (si erreur retryable)
 */
export function logToolCall(opts: ToolCallLogOpts): void {
  if (!isLangfuseEnabled()) return;

  const tags: string[] = [
    `tool:${opts.toolName}`,
    `agent:${opts.agentSlug || "concierge"}`,
    opts.success ? "status:success" : "status:failure",
  ];
  if (!opts.success && opts.errorCode) tags.push(`error:${opts.errorCode}`);
  if (!opts.success && opts.retryable) tags.push("retryable");

  const metadata: Record<string, unknown> = {
    duration_ms: opts.endTime.getTime() - opts.startTime.getTime(),
    http_status: opts.httpStatus,
    error_code: opts.errorCode,
    retryable: opts.retryable,
    ...(opts.metadata || {}),
  };

  // Si pas de traceId fourni → trace standalone (pas de parent).
  // Si traceId fourni → on crée un span enfant.
  if (opts.traceId) {
    const ev: IngestionEvent = {
      id: newId(),
      type: "span-create",
      timestamp: new Date().toISOString(),
      body: {
        id: newId(),
        traceId: opts.traceId,
        name: `tool:${opts.toolName}`,
        startTime: opts.startTime.toISOString(),
        endTime: opts.endTime.toISOString(),
        input: typeof opts.input === "string"
          ? opts.input.slice(0, 4000)
          : opts.input,
        output: typeof opts.output === "string"
          ? opts.output.slice(0, 8000)
          : opts.output,
        level: opts.success ? "DEFAULT" : "ERROR",
        statusMessage: opts.errorCode,
        metadata,
      },
    };
    void sendBatch([ev]);
    return;
  }

  // Trace standalone
  const traceId = newId();
  const events: IngestionEvent[] = [
    {
      id: newId(),
      type: "trace-create",
      timestamp: opts.endTime.toISOString(),
      body: {
        id: traceId,
        timestamp: opts.endTime.toISOString(),
        name: `tool:${opts.toolName}`,
        userId: opts.userId,
        sessionId: opts.conversationId,
        input: typeof opts.input === "string"
          ? opts.input.slice(0, 4000)
          : opts.input,
        output: typeof opts.output === "string"
          ? opts.output.slice(0, 8000)
          : opts.output,
        tags,
        metadata,
      },
    },
  ];
  void sendBatch(events);
}

/**
 * Wrapper de tracing pour une route agents-tools. Capture start/end
 * automatiquement et appelle logToolCall avec les bons paramètres.
 *
 * Usage typique dans une route :
 * ```ts
 * export async function POST(req: Request) {
 *   if (!checkAgentsToolsAuth(req)) return unauthorized();
 *   const tracer = startToolTrace({ toolName: "web_search", req });
 *   try {
 *     // ... business logic ...
 *     const result = { ok: true, count: 5 };
 *     tracer.success(result);
 *     return NextResponse.json(result);
 *   } catch (e) {
 *     tracer.failure({ errorCode: "search_failed", retryable: true });
 *     return toolUpstreamError({ error: "search_failed", hint: "..." });
 *   }
 * }
 * ```
 */
export function startToolTrace(opts: {
  toolName: string;
  req?: Request;
  agentSlug?: string;
  /** User et conversation si extraits depuis le body. */
  userId?: string;
  conversationId?: string;
}): {
  success: (output?: unknown, metadata?: Record<string, unknown>) => void;
  failure: (info: {
    errorCode: string;
    retryable: boolean;
    httpStatus?: number;
    output?: unknown;
    metadata?: Record<string, unknown>;
  }) => void;
} {
  const startTime = new Date();

  // Trace propagée par header (cas idéal : Dify forwarde X-Langfuse-Trace-Id)
  const traceId = opts.req?.headers.get("x-langfuse-trace-id") || undefined;
  const conversationId = opts.conversationId
    || opts.req?.headers.get("x-conversation-id")
    || undefined;
  const userId = opts.userId
    || opts.req?.headers.get("x-user-id")
    || undefined;

  let inputCapture: unknown = undefined;
  // On peut clone request body si besoin, mais pour rester non-blocking
  // et compatible avec NextRequest, on laisse le caller passer l'input
  // explicitement via success/failure metadata.

  return {
    success(output, metadata) {
      logToolCall({
        toolName: opts.toolName,
        agentSlug: opts.agentSlug,
        userId,
        conversationId,
        traceId,
        input: inputCapture,
        output,
        success: true,
        startTime,
        endTime: new Date(),
        httpStatus: 200,
        metadata,
      });
    },
    failure(info) {
      logToolCall({
        toolName: opts.toolName,
        agentSlug: opts.agentSlug,
        userId,
        conversationId,
        traceId,
        input: inputCapture,
        output: info.output,
        success: false,
        errorCode: info.errorCode,
        retryable: info.retryable,
        httpStatus: info.httpStatus,
        startTime,
        endTime: new Date(),
        metadata: info.metadata,
      });
    },
  };
}
