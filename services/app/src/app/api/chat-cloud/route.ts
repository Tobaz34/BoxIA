/**
 * POST /api/chat-cloud — appel direct provider cloud (bypass Dify) après
 * autorisation explicite de l'utilisateur via CloudFallbackModal.
 *
 * Pourquoi bypass Dify : sur cette instance les plugins
 * langgenius/anthropic, langgenius/openai, langgenius/mistral peuvent
 * être absents (marketplace.dify.ai inaccessible depuis xefia LAN). On
 * appelle donc l'API du provider directement avec la clé stockée
 * chiffrée localement (cf. lib/cloud-providers.ts setProviderApiKeyLocal).
 *
 * Body :
 *   {
 *     agent: slug,           // pour audit + pre_prompt éventuel
 *     query: string,         // peut inclure data URL d'image (vision)
 *     conversation_id?: string,
 *     provider: "openai" | "anthropic" | "mistral",
 *     model: string,
 *     pii_scrub_enabled?: boolean,
 *   }
 *
 * Response : SSE stream Dify-like
 *   data: {"event":"cloud_response_meta","provider":"anthropic","model":"claude-..."}
 *   data: {"event":"message","answer":"chunk1"}
 *   data: {"event":"message","answer":"chunk2"}
 *   ...
 *   data: {"event":"message_end","metadata":{"provider":...,"model":...,"usage":...}}
 *
 * Chat.tsx intercepte cloud_response_meta pour afficher le badge ☁️ sur
 * le message (couleur cyan).
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  readCloudProvidersState,
  getProviderApiKeyLocal,
  recordCloudSuccess,
  recordCloudError,
  classifyCloudError,
  estimateCallCostEur,
  type CloudProviderId,
} from "@/lib/cloud-providers";
import { scrubPII, summarizeScrub } from "@/lib/pii-scrub";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

interface CloudChatBody {
  agent?: string;
  query?: string;
  conversation_id?: string;
  provider?: CloudProviderId;
  model?: string;
  pii_scrub_enabled?: boolean;
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: CloudChatBody;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  const provider = body.provider;
  const model = body.model;
  const query = (body.query || "").trim();
  if (!provider || !model || !query) {
    return NextResponse.json(
      { error: "missing_params", message: "provider, model et query requis" },
      { status: 400 });
  }

  // 1. Récupère la clé locale chiffrée + déchiffre
  const apiKey = await getProviderApiKeyLocal(provider);
  if (!apiKey) {
    return NextResponse.json(
      { error: "no_local_key",
        message: `Aucune clé locale pour ${provider}. Configurez-la dans /settings (la clé sera stockée chiffrée localement, pas seulement dans Dify).` },
      { status: 400 });
  }

  // 2. Cost cap
  const state = await readCloudProvidersState();
  const monthlyBudget = state.budget_monthly_eur || 50;
  const usage = Object.values(state.providers || {}).reduce(
    (a, p) => a + (p.cost_eur_this_month || 0), 0,
  );
  if (usage >= monthlyBudget) {
    return NextResponse.json(
      { error: "budget_exceeded",
        message: `Budget mensuel cloud dépassé (${usage.toFixed(2)}€ / ${monthlyBudget}€).` },
      { status: 429 });
  }

  // 3. PII scrub (default ON, peut être désactivé par body OU par paramètre global)
  const piiEnabled =
    body.pii_scrub_enabled !== false && state.pii_scrub_enabled !== false;
  let queryToSend = query;
  let scrubSummary = "";
  if (piiEnabled) {
    const result = scrubPII(query);
    queryToSend = result.redacted;
    scrubSummary = summarizeScrub(result);
  }

  // 4. Audit log AVANT le call (en cas de timeout, on garde la trace)
  await logAction("settings.update", `cloud-call:${provider}:${model}`, {
    agent: body.agent,
    pii_scrub: piiEnabled,
    pii_summary: scrubSummary,
    query_chars: query.length,
  }, ipFromHeaders(req));

  // 5. Appel direct provider
  let upstreamResponse: Response;
  try {
    if (provider === "anthropic") {
      upstreamResponse = await callAnthropic(apiKey, model, queryToSend);
    } else if (provider === "openai") {
      upstreamResponse = await callOpenAi(apiKey, model, queryToSend);
    } else if (provider === "google") {
      upstreamResponse = await callGoogle(apiKey, model, queryToSend);
    } else if (provider === "mistral") {
      upstreamResponse = await callMistral(apiKey, model, queryToSend);
    } else {
      return NextResponse.json(
        { error: "unsupported_provider" }, { status: 400 });
    }
  } catch (e) {
    // Network / DNS / timeout — pas de status HTTP. On enregistre l'erreur
    // dans le state pour que le badge UI passe en orange/rouge.
    await recordCloudError(provider, 0, "network", String(e).slice(0, 200));
    return NextResponse.json(
      { error: "cloud_call_failed", message: String(e).slice(0, 300) },
      { status: 502 });
  }

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => "");
    // Classifie l'erreur pour le badge UI : 401 → invalid_api_key (rouge),
    // 402/insufficient → insufficient_credits (rouge), 429 → rate_limit (orange).
    const cls = classifyCloudError(upstreamResponse.status, text);
    await recordCloudError(provider, upstreamResponse.status, cls.code, cls.message);
    return NextResponse.json(
      { error: "cloud_upstream_error",
        provider, model,
        status: upstreamResponse.status,
        code: cls.code,
        body: text.slice(0, 500) },
      { status: 502 });
  }

  // 6. Convert le stream provider en SSE format Dify-like.
  //    On passe la query (pour estimer les input tokens) afin de calculer
  //    un coût approximatif quand le stream se termine, qui sera persisté
  //    via recordCloudSuccess (alimente le badge "vert/orange/rouge" UI).
  const sseStream = convertProviderStreamToDifySSE(
    upstreamResponse.body, provider, body.conversation_id, model, query,
  );

  return new Response(sseStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Cloud-Provider": provider,
      "X-Cloud-Model": model,
    },
  });
}

// =========================================================================
// Provider-specific helpers
// =========================================================================
//
// Pour Anthropic vision : la query peut contenir des data: URLs au format
// markdown ![alt](data:image/png;base64,XXX). Anthropic API ne lit pas ces
// data URLs en mode messages.content=string ; il faut passer un array
// content avec type:"image". On parse donc la query pour extraire les
// data URLs et les transformer en blocks images séparés.

interface AnthropicContentBlock {
  type: "text" | "image";
  text?: string;
  source?: { type: "base64"; media_type: string; data: string };
}

function parseQueryForAnthropic(query: string): AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];
  // Match ![alt](data:image/png;base64,XXX)
  const re = /!\[([^\]]*)\]\(data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)\)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    if (m.index > lastIdx) {
      const text = query.slice(lastIdx, m.index).trim();
      if (text) blocks.push({ type: "text", text });
    }
    blocks.push({
      type: "image",
      source: {
        type: "base64",
        media_type: m[2],
        data: m[3],
      },
    });
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < query.length) {
    const text = query.slice(lastIdx).trim();
    if (text) blocks.push({ type: "text", text });
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: query });
  return blocks;
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<Response> {
  const content = parseQueryForAnthropic(prompt);
  return fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      stream: true,
      max_tokens: 4096,
    }),
  });
}

async function callOpenAi(apiKey: string, model: string, prompt: string): Promise<Response> {
  // GPT-4o vision : si data URL dans le prompt, on le passe en
  // content array avec type:image_url. Sinon string simple.
  const dataUrlMatch = prompt.match(/!\[[^\]]*\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/);
  let messages;
  if (dataUrlMatch) {
    messages = [{
      role: "user",
      content: [
        { type: "text", text: prompt.replace(dataUrlMatch[0], "").trim() || "Analyze this image" },
        { type: "image_url", image_url: { url: dataUrlMatch[1] } },
      ],
    }];
  } else {
    messages = [{ role: "user", content: prompt }];
  }
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model, messages, stream: true, max_tokens: 4096,
    }),
  });
}

/** Google Gemini API — Generative Language API.
 *
 * Endpoint streaming :
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={apiKey}
 *
 * Format vision : si data URL dans prompt → parts[].inline_data{mime_type, data}
 * Format text : parts[].text
 */
async function callGoogle(apiKey: string, model: string, prompt: string): Promise<Response> {
  const dataUrlMatch = prompt.match(/!\[[^\]]*\]\(data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)\)/);
  const parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }> = [];
  if (dataUrlMatch) {
    const textOnly = prompt.replace(dataUrlMatch[0], "").trim() || "Décris cette image";
    parts.push({ text: textOnly });
    parts.push({
      inline_data: { mime_type: dataUrlMatch[1], data: dataUrlMatch[2] },
    });
  } else {
    parts.push({ text: prompt });
  }
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`
    + `?alt=sse&key=${encodeURIComponent(apiKey)}`;
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });
}

async function callMistral(apiKey: string, model: string, prompt: string): Promise<Response> {
  return fetch("https://api.mistral.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: true,
      max_tokens: 4096,
    }),
  });
}

/** Convertit le SSE provider en format SSE Dify-like que Chat.tsx connaît
 *  déjà. Premier event = cloud_response_meta pour badge UI.
 *
 *  Quand le stream se termine SANS exception, on appelle recordCloudSuccess()
 *  avec un coût estimé (input_chars + output_chars / 4 tokens × tarif modèle)
 *  pour que le badge passe en vert et que cost_eur_this_month soit incrémenté.
 *  En cas d'exception côté stream (timeout, parse fail, etc.), on enregistre
 *  une erreur "stream_error" pour basculer le badge en orange.
 */
function convertProviderStreamToDifySSE(
  upstream: ReadableStream<Uint8Array>,
  provider: CloudProviderId,
  conversationId: string | undefined,
  model: string,
  inputQuery: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const messageId = `cloud-${Date.now().toString(36)}`;
  let lineBuffer = "";
  let totalAnswer = "";
  let streamFailed = false;
  let streamError = "";

  return new ReadableStream({
    async start(controller) {
      // Premier event : meta (provider/model pour badge UI)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        event: "cloud_response_meta",
        provider, model, message_id: messageId,
        conversation_id: conversationId,
      })}\n\n`));

      const reader = upstream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          lineBuffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = lineBuffer.indexOf("\n")) >= 0) {
            const line = lineBuffer.slice(0, idx).trim();
            lineBuffer = lineBuffer.slice(idx + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const evt = JSON.parse(payload);
              const chunk = extractAnswerChunk(provider, evt);
              if (chunk) {
                totalAnswer += chunk;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  event: "message",
                  conversation_id: conversationId,
                  message_id: messageId,
                  answer: chunk,
                  created_at: Math.floor(Date.now() / 1000),
                })}\n\n`));
              }
            } catch {
              // Anthropic envoie aussi des events `event:` non-data → ignore
            }
          }
        }
      } catch (e) {
        console.warn("[chat-cloud] stream error:", e);
        streamFailed = true;
        streamError = String(e).slice(0, 200);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          event: "error",
          message: `Cloud stream error: ${streamError}`,
        })}\n\n`));
      } finally {
        // Estimation tokens : ~4 chars/token (heuristique standard).
        const inputTokens = Math.ceil(inputQuery.length / 4);
        const outputTokens = Math.ceil(totalAnswer.length / 4);
        const costEur = estimateCallCostEur(model, inputTokens, outputTokens);

        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          event: "message_end",
          conversation_id: conversationId,
          message_id: messageId,
          metadata: {
            provider, model,
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              cost_eur: costEur,
            },
          },
        })}\n\n`));
        controller.close();

        // Persiste le résultat dans cloud-providers.json (alimente les badges).
        // Important : APRES controller.close() pour ne pas bloquer le flush.
        // Si totalAnswer est vide ET pas de streamFailed → quand même OK
        // (provider a juste répondu vide, pas une erreur).
        try {
          if (streamFailed) {
            await recordCloudError(provider, 0, "stream_error", streamError);
          } else {
            await recordCloudSuccess(provider, costEur);
          }
        } catch (persistErr) {
          console.warn("[chat-cloud] state persist failed:", persistErr);
        }
      }
    },
  });
}

// Pricing : centralisé dans @/lib/cloud-providers (estimateCallCostEur)
// pour rester DRY avec l'UI /settings qui affiche les tarifs par modèle.

function extractAnswerChunk(provider: CloudProviderId, evt: unknown): string {
  const e = evt as Record<string, unknown>;
  if (provider === "openai" || provider === "mistral") {
    const choices = e.choices as Array<{ delta?: { content?: string } }> | undefined;
    return choices?.[0]?.delta?.content || "";
  }
  if (provider === "anthropic") {
    if (e.type === "content_block_delta") {
      const delta = e.delta as { text?: string } | undefined;
      return delta?.text || "";
    }
    return "";
  }
  if (provider === "google") {
    // Format Gemini : { candidates: [{ content: { parts: [{ text: "..." }] } }] }
    const candidates = e.candidates as Array<{
      content?: { parts?: Array<{ text?: string }> };
    }> | undefined;
    const parts = candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").join("");
  }
  return "";
}
