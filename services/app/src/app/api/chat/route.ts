/**
 * POST /api/chat — Proxy streaming vers Dify (multi-agent).
 *
 * Body : { agent?: slug, query, conversation_id? }
 * Si agent absent → agent par défaut.
 *
 * Le stream SSE Dify est intercepté pour détecter les blocs
 *   [FILE:nom.ext]…[/FILE]
 * que l'agent peut produire (cf. lib/chat-stream-files.ts). Quand un bloc
 * complet est reçu, le serveur génère le fichier (DOCX/XLSX/PDF/PS1/…),
 * le stocke dans /data/generated/UUID, et émet un marker
 *   {{file:UUID:nom:size:mime}}
 * à la place du bloc dans le `answer` retourné au client.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch, DIFY_BASE_URL } from "@/lib/dify";
import {
  addUserMemory,
  formatMemoryContext,
  isMemoryEnabled,
  searchUserMemory,
} from "@/lib/memory";
import {
  isLangfuseEnabled,
  startTrace,
  updateTrace,
} from "@/lib/langfuse";
import { stripThinkFromSSE } from "@/lib/strip-think";

export const dynamic = "force-dynamic";

interface ChatRequestBody {
  agent?: string;
  query?: string;
  conversation_id?: string;
  files?: Array<{
    type: "image" | "document";
    transfer_method: "local_file" | "remote_url";
    upload_file_id?: string;
    url?: string;
  }>;
}

export async function POST(req: NextRequest) {
  let body: ChatRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const ctx = await requireDifyContext(body.agent);
  if (ctx instanceof NextResponse) return ctx;

  const query = (body.query || "").trim();
  if (!query) {
    return NextResponse.json({ error: "empty_query" }, { status: 400 });
  }

  // ----- Mémoire long-terme (mem0) — best-effort, n'échoue jamais -----
  // Au 1er message d'une nouvelle conversation, on injecte les faits connus
  // sur le user. Sur les suivants, Dify a déjà le contexte conversationnel.
  let memoryPrefix = "";
  if (isMemoryEnabled() && ctx.user && !body.conversation_id) {
    const facts = await searchUserMemory(ctx.user, query, {
      agentId: body.agent || "default",
    });
    memoryPrefix = formatMemoryContext(facts);
  }
  const augmentedQuery = memoryPrefix ? `${memoryPrefix}---\n\n${query}` : query;

  // ----- Langfuse trace (best-effort, fire-and-forget) -----
  // Une trace par message user, groupée par sessionId = conversation_id
  // Dify (côté UI Langfuse → toutes les traces d'une conversation s'affichent
  // groupées). Si LANGFUSE_BASE_URL absent → no-op silencieux.
  const traceId = isLangfuseEnabled()
    ? startTrace({
        name: `chat:${body.agent || "default"}`,
        userId: ctx.user,
        sessionId: body.conversation_id || undefined,
        input: query,
        tags: [body.agent || "default", memoryPrefix ? "with-memory" : "no-memory"],
        metadata: {
          memory_prefix_chars: memoryPrefix.length,
          files_count: Array.isArray(body.files) ? body.files.length : 0,
        },
      })
    : "";

  const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.key}`,
    },
    body: JSON.stringify({
      inputs: {},
      query: augmentedQuery,
      response_mode: "streaming",
      conversation_id: body.conversation_id || "",
      user: ctx.user,
      // Fichiers attachés (images uploadées via /api/files/upload)
      files: Array.isArray(body.files) ? body.files : [],
    }),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_upstream_error", status: upstream.status,
        body: text.slice(0, 500) },
      { status: 502 },
    );
  }

  // Filtre proxy : strip <think>...</think> exposés par qwen3 (mode CoT
  // activé par défaut, le `/no_think` dans le pre_prompt est ignoré
  // par Ollama). Defense-in-depth : même si un agent n'a pas /no_think,
  // l'utilisateur ne verra jamais le raisonnement intermédiaire.
  const filteredUpstream = stripThinkFromSSE(upstream.body);

  // Tee le stream pour : (1) client SSE, (2) capture pour mémorisation
  // mem0 ET update de trace Langfuse avec l'output final. On utilise un
  // SEUL tee même si une seule des 2 features est active, pour ne pas
  // dupliquer le code.
  const needsCapture =
    (isMemoryEnabled() && ctx.user) || (isLangfuseEnabled() && traceId);
  if (needsCapture) {
    const [clientStream, captureStream] = filteredUpstream.tee();
    void captureAssistantReply(captureStream).then((assistantText) => {
      if (assistantText && isMemoryEnabled() && ctx.user) {
        addUserMemory(ctx.user, body.agent || "default", [
          { role: "user", content: query },
          { role: "assistant", content: assistantText },
        ], { conversation_id: body.conversation_id });
      }
      if (assistantText && isLangfuseEnabled() && traceId) {
        updateTrace(traceId, {
          output: assistantText,
          metadata: { output_chars: assistantText.length },
        });
      }
    });
    return new Response(clientStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  return new Response(filteredUpstream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * Lit le stream SSE Dify et reconstitue le texte de la réponse assistant
 * (concat des `event: message`).
 */
async function captureAssistantReply(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.event === "message" && typeof evt.answer === "string") {
            answer += evt.answer;
          }
        } catch {
          // ignore malformed
        }
      }
    }
  } catch {
    // best-effort
  }
  return answer.trim();
}

// Reference imports to satisfy the linter (difyFetch isn't used here but
// is part of the public lib API used elsewhere).
void difyFetch;
