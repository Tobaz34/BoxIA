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
import { FileDetector } from "@/lib/chat-stream-files";

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

  const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.key}`,
    },
    body: JSON.stringify({
      inputs: {},
      query,
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

  // Transforme le stream SSE pour intercepter les blocs [FILE:...] dans
  // chaque event de type `message`/`agent_message`. On parse SSE
  // ligne-par-ligne et on n'altère que la valeur `answer` des events JSON.
  const detector = new FileDetector({
    ownerEmail: ctx.user,
    conversationId: body.conversation_id || undefined,
  });

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      lineBuffer += decoder.decode(chunk, { stream: true });
      // SSE : événements séparés par \n\n, chaque ligne `data: {json}`.
      // On boucle sur les lignes complètes.
      let nlIdx: number;
      while ((nlIdx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, nlIdx);
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        const out = await processLine(line, detector);
        if (out !== null) {
          controller.enqueue(encoder.encode(out + "\n"));
        }
      }
    },
    async flush(controller) {
      // Reste à traiter
      if (lineBuffer.length > 0) {
        const out = await processLine(lineBuffer, detector);
        if (out !== null) controller.enqueue(encoder.encode(out));
        lineBuffer = "";
      }
      // Flush du file detector (cas d'un [FILE:...] non fermé en fin de stream)
      const tail = await detector.flush();
      if (tail) {
        // Émet un event spécial avec le marker comme `answer`
        const evt = {
          event: "message",
          answer: tail,
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
      }
    },
  });

  upstream.body.pipeTo(transform.writable).catch((e) => {
    console.warn("[/api/chat] transform pipe error:", e);
  });

  return new Response(transform.readable, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** Traite une ligne SSE :
 *  - "data: {json}" avec event message/agent_message → réécrit `answer`
 *  - autres lignes → passthrough
 *  Retourne la ligne à émettre (peut être identique à l'entrée) ou null
 *  pour drop.
 */
async function processLine(line: string, detector: FileDetector): Promise<string | null> {
  // Lignes vides (séparateurs SSE) → passthrough
  if (!line || !line.startsWith("data:")) return line;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return line;

  try {
    const evt = JSON.parse(payload);
    if (
      (evt.event === "message" || evt.event === "agent_message")
      && typeof evt.answer === "string" && evt.answer.length > 0
    ) {
      const replaced = await detector.push(evt.answer);
      if (replaced === evt.answer) return line;  // pas de modif → passthrough
      // Sinon on réémet l'event avec answer modifié.
      // Si replaced est vide, on émet quand même un event vide (les events
      // sans answer ne brisent rien côté client) — ça maintient le rythme
      // SSE et permet aux keep-alive de fonctionner.
      const newEvt = { ...evt, answer: replaced };
      return `data: ${JSON.stringify(newEvt)}`;
    }
    return line;
  } catch {
    // JSON invalide : passthrough silencieux
    return line;
  }
}

// Reference imports to satisfy the linter (difyFetch isn't used here but
// is part of the public lib API used elsewhere).
void difyFetch;
