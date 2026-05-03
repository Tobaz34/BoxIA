/**
 * Détection des "défaillances locales" qui justifient un fallback cloud.
 *
 * Quand Dify/Ollama renvoie une erreur dans le SSE stream (event=error),
 * on extrait les signatures connues qui indiquent un manque de capacité
 * locale (vs une erreur applicative côté agent). Pour ces cas, l'UI doit
 * proposer un fallback cloud BYOK avec autorisation explicite.
 *
 * Signatures détectées (catégorie OOM/résource) :
 *   - "model failed to load" — VRAM insuffisante au load Ollama
 *   - "model runner has unexpectedly stopped" — runner GPU OOM en cours
 *     d'inférence
 *   - "resource limitations" — message générique Ollama
 *   - "out of memory", "OOM", "CUDA error" — variantes
 *   - "context length" — context overflow (32k+ tokens dépassés)
 *
 * Si le message correspond, on retourne un objet `{kind, reason,
 * suggested_provider, suggested_model, estimated_cost_eur}` que `/api/chat`
 * réémet dans un event SSE custom `cloud_fallback_needed` que l'UI
 * intercepte pour afficher la modale d'autorisation.
 */

export type LocalFailureKind = "oom" | "context_overflow" | "model_unavailable" | "unknown";

export interface LocalFailure {
  kind: LocalFailureKind;
  /** Message technique court (pour audit/debug). */
  reason: string;
  /** Provider cloud suggéré (configurable, default openai). */
  suggested_provider: "openai" | "anthropic" | "mistral";
  /** Modèle cloud suggéré pour le tier de la tâche. */
  suggested_model: string;
  /** Estimation de coût en € pour la requête en cours. */
  estimated_cost_eur: number;
}

/** Classifie un message d'erreur Dify/Ollama en LocalFailureKind. Si rien
 *  ne match → null (l'erreur est applicative, pas une défaillance local). */
export function classifyDifyError(rawMessage: string): LocalFailure | null {
  const msg = (rawMessage || "").toLowerCase();
  const isOom =
    msg.includes("model failed to load") ||
    msg.includes("model runner has unexpectedly stopped") ||
    msg.includes("resource limitations") ||
    msg.includes("out of memory") ||
    msg.includes("cuda error: out") ||
    msg.includes("oom");
  const isContext =
    msg.includes("context length") ||
    msg.includes("context window") ||
    msg.includes("token limit");
  const isUnavailable =
    msg.includes("model not found") ||
    msg.includes("connection refused") ||
    msg.includes("ollama") && msg.includes("unreachable");

  if (!isOom && !isContext && !isUnavailable) return null;

  // Default suggestion : OpenAI gpt-4o-mini (équilibre coût/qualité, vision-capable).
  // En cas de vision : on garde gpt-4o (vision-capable). Le caller (route.ts)
  // peut surcharger en fonction du contexte (slug agent vision → gpt-4o).
  const provider: LocalFailure["suggested_provider"] = "openai";
  const model = "gpt-4o-mini";
  // Estimation grossière : 0.005 € pour une requête typique (1k input tokens
  // + 500 output tokens à 0.15$/M input + 0.6$/M output, conv 1$≈0.95€).
  const estimated_cost_eur = 0.005;

  return {
    kind: isOom ? "oom" : isContext ? "context_overflow" : "model_unavailable",
    reason: rawMessage.slice(0, 200),
    suggested_provider: provider,
    suggested_model: model,
    estimated_cost_eur,
  };
}

/** Pour les agents vision (slug commence par "vision" ou contient
 *  "qwen2.5vl"), on suggère gpt-4o (vision-capable) au lieu de
 *  gpt-4o-mini. */
export function pickCloudModelForAgent(
  agentSlug: string | null | undefined,
  base: LocalFailure,
): LocalFailure {
  if (!agentSlug) return base;
  const isVision = agentSlug.includes("vision");
  if (isVision) {
    return {
      ...base,
      suggested_model: "gpt-4o",
      // gpt-4o est ~6× plus cher que gpt-4o-mini
      estimated_cost_eur: 0.03,
    };
  }
  return base;
}

/** TransformStream qui parse les events SSE Dify et émet en plus un
 *  event `cloud_fallback_needed` quand une erreur OOM/contexte/etc est
 *  détectée. L'event original `error` reste passthrough — l'UI peut
 *  choisir d'afficher l'erreur ET la modale de proposition cloud, OU
 *  d'auto-cacher l'erreur quand elle propose le cloud. */
export function wrapStreamWithCloudFallbackHint(
  upstream: ReadableStream<Uint8Array>,
  agentSlug: string | null,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let lineBuffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); // passthrough
      lineBuffer += decoder.decode(chunk, { stream: true });
      let nlIdx: number;
      while ((nlIdx = lineBuffer.indexOf("\n")) >= 0) {
        const line = lineBuffer.slice(0, nlIdx);
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.event === "error" && typeof evt.message === "string") {
            const failure = classifyDifyError(evt.message);
            if (failure) {
              const enriched = pickCloudModelForAgent(agentSlug, failure);
              const hint = {
                event: "cloud_fallback_needed",
                conversation_id: evt.conversation_id,
                message_id: evt.message_id,
                kind: enriched.kind,
                reason: enriched.reason,
                suggested_provider: enriched.suggested_provider,
                suggested_model: enriched.suggested_model,
                estimated_cost_eur: enriched.estimated_cost_eur,
                agent: agentSlug,
              };
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(hint)}\n\n`),
              );
            }
          }
        } catch {
          // JSON invalide → ignore (déjà passthrough côté chunk)
        }
      }
    },
  });

  upstream.pipeTo(transform.writable).catch((e) => {
    console.warn("[local-failure-detect] pipe error:", e);
  });
  return transform.readable;
}
