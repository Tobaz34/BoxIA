/**
 * Filtre stream qui retire les balises `<think>...</think>` (et
 * `<thinking>...</thinking>`) des réponses LLM.
 *
 * Pourquoi : qwen3 a un mode chain-of-thought activé par défaut qui
 * expose son raisonnement intermédiaire en anglais entre `<think>...
 * </think>`. Le slash command `/no_think` est censé le désactiver
 * dans le prompt mais Ollama ne le respecte pas systématiquement
 * (ignoré au runtime selon la version).
 *
 * Solution defense-in-depth : on filtre côté proxy `/api/chat`. Le
 * stream SSE Dify émet des events `data: {event: "message", answer:
 * "<chunk>"}`. On accumule, détecte les sections think, et on émet
 * uniquement les chunks hors think.
 *
 * Cas streaming : le tag peut être coupé entre 2 chunks (ex. chunk1
 * = "<thi", chunk2 = "nk>...</think>"). On bufferise donc le texte
 * tant qu'on est dans une zone "incertaine" (potentiel début de tag).
 *
 * Format des messages SSE Dify :
 *   data: {"event": "message", "answer": "...", "conversation_id": ..., "message_id": ...}
 *   data: {"event": "message_end", ...}
 */

// Sprint 0 P2 #11 — Stripper robuste avec depth counter (AutoGPT pattern).
// Tags supportés (chacun en open + close) :
//  - <think>...</think>            qwen3 mode CoT par défaut
//  - <thinking>...</thinking>      Claude / Anthropic extended thinking
//  - <internal_reasoning>...        GPT o1-style
//  - <reasoning>...</reasoning>     deepseek-r1, autres reasoning models
//  - <reflection>...</reflection>   variations
//  - <scratchpad>...</scratchpad>   variations multi-step
//  - <scratch_pad>...</scratch_pad> idem (snake case)
const THINK_TAGS = [
  "think",
  "thinking",
  "internal_reasoning",
  "reasoning",
  "reflection",
  "scratchpad",
  "scratch_pad",
];
// Construit dynamiquement les regex pour matcher n'importe lequel des tags.
const OPEN_RE = new RegExp(`<(?:${THINK_TAGS.join("|")})>`, "gi");
const CLOSE_RE = new RegExp(`</(?:${THINK_TAGS.join("|")})>`, "gi");
// Buffer guard — assez large pour matcher n'importe quel tag ouvrant
// max ("<internal_reasoning>" = 20 chars) + marge pour gérer les chunks
// SSE coupés au milieu d'un tag.
const MAX_TAG_LEN = Math.max(
  ...THINK_TAGS.map((t) => `</${t}>`.length),
);
const TAIL_GUARD = MAX_TAG_LEN + 4; // +4 marge pour être safe
const MAX_BUFFER = 256; // plafond avant rotation aggressive

// Format ReAct interne (qwen function calling). On strip les préfixes
// "Action:", "Thought:", "Observation:", "Action Input:" qui fuient
// parfois côté user quand l'agent est en mode tool-use et que le LLM
// recopie le format brut au lieu d'émettre un appel structuré.
// Match seulement en début de ligne pour éviter les faux positifs en FR.
const REACT_PREFIX_RE = /^(?:Action(?:\s+Input)?|Thought|Observation)\s*:\s*/gim;

/** Retire les préfixes ReAct fuités. Sûr car appliqué uniquement en
 *  début de ligne, et ces mots-clés sont en anglais — peu de risque
 *  de faux positif sur du contenu utilisateur français. */
export function stripReactArtifacts(text: string): string {
  return text.replace(REACT_PREFIX_RE, "");
}

/**
 * Crée un transformer qui prend en entrée des chunks de texte (= les
 * `answer` Dify, accumulés tels quels), et qui émet les chunks filtrés
 * sans les contenus think.
 *
 * Améliorations P2 #11 vs version initiale :
 * - **Depth counter** : gère les balises imbriquées
 *   `<think>outer<think>inner</think>still_outer</think>` correctement.
 *   Une seule balise close ne sort pas du mode think si depth > 1.
 * - **Multi-variants** : think / thinking / internal_reasoning / reasoning
 *   / reflection / scratchpad / scratch_pad (vs uniquement think+thinking
 *   précédemment).
 * - **Cross-chunk safe** : TAIL_GUARD calculé dynamiquement depuis le tag
 *   le plus long pour ne JAMAIS rater un tag coupé en 2 chunks (avant 16
 *   chars en dur — risque de manquer "</internal_reasoning>" 22 chars).
 * - **Buffer overflow protection** : MAX_BUFFER 256 char (vs 64) pour les
 *   très gros raisonnement Qwen3 — sinon rotation tronque l'analyse.
 *
 * État interne : `depth` (compteur de nesting), `buffer` (string en cours).
 */
export class ThinkStripper {
  private depth = 0;
  private buffer = "";

  /** True si on est dans une zone think (au moins 1 ouverture sans close
   *  matching). Exposé pour debug + tests. */
  get inThink(): boolean {
    return this.depth > 0;
  }

  /** Ingère un chunk text, retourne le texte filtré à émettre. */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";

    while (this.buffer.length > 0) {
      if (this.depth > 0) {
        // En mode think : chercher SOIT la prochaine close (qui décrémente)
        // SOIT la prochaine ouverture (qui incrémente — nesting).
        // On prend le PLUS PROCHE des deux pour la depth correcte.
        OPEN_RE.lastIndex = 0;
        CLOSE_RE.lastIndex = 0;
        const open = OPEN_RE.exec(this.buffer);
        const close = CLOSE_RE.exec(this.buffer);

        // Cas 1 : aucun tag détecté → on est encore en zone think,
        // jeter tout ce qu'on peut sauf le tail guard.
        if (!open && !close) {
          if (this.buffer.length > MAX_BUFFER) {
            // Garde les TAIL_GUARD derniers chars en cas de tag coupé
            this.buffer = this.buffer.slice(-TAIL_GUARD);
          }
          break;
        }

        // Cas 2 : seulement open → nesting up
        if (open && !close) {
          this.depth++;
          this.buffer = this.buffer.slice(open.index + open[0].length);
          continue;
        }

        // Cas 3 : seulement close → nesting down
        if (close && !open) {
          this.depth--;
          this.buffer = this.buffer.slice(close.index + close[0].length);
          continue;
        }

        // Cas 4 : les deux présents → on prend le plus proche
        if (open && close) {
          if (open.index < close.index) {
            this.depth++;
            this.buffer = this.buffer.slice(open.index + open[0].length);
          } else {
            this.depth--;
            this.buffer = this.buffer.slice(close.index + close[0].length);
          }
          continue;
        }
      }

      // Pas en zone think : chercher la prochaine ouverture
      OPEN_RE.lastIndex = 0;
      const m = OPEN_RE.exec(this.buffer);
      if (!m) {
        // Pas d'ouverture détectée. Mais le buffer peut se terminer
        // par un fragment de balise (ex: "...du texte<inter"). On émet
        // tout sauf les TAIL_GUARD derniers chars.
        if (this.buffer.length <= TAIL_GUARD) {
          break; // attend plus de chunks
        }
        const safe = this.buffer.length - TAIL_GUARD;
        out += this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
        break;
      }

      // Ouverture trouvée : émet ce qui précède, entre en mode think
      out += this.buffer.slice(0, m.index);
      this.depth = 1;
      this.buffer = this.buffer.slice(m.index + m[0].length);
    }

    return out;
  }

  /** Flush final : émet ce qui reste dans le buffer (sauf si on est
   *  encore dans un think — auquel cas le LLM a probablement été coupé). */
  flush(): string {
    if (this.depth > 0) {
      // think non terminé — drop tout (ne polluons pas l'output)
      this.buffer = "";
      this.depth = 0;
      return "";
    }
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }
}

/**
 * Wrap une ReadableStream<Uint8Array> SSE Dify et retourne une nouvelle
 * stream qui filtre les `answer` des events `message` pour retirer les
 * sections `<think>...</think>`.
 *
 * Préserve TOUS les autres events tels quels (message_end, agent_thought,
 * conversation_id, etc.) — seul le contenu `answer` des `message` est
 * réécrit.
 */
export function stripThinkFromSSE(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const stripper = new ThinkStripper();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Découpe par paquets SSE séparés par "\n\n"
          const events = buf.split("\n\n");
          buf = events.pop() || "";
          for (const ev of events) {
            const filtered = filterEvent(ev, stripper);
            if (filtered !== null) {
              controller.enqueue(encoder.encode(filtered + "\n\n"));
            }
          }
        }
        // Flush le buffer SSE résiduel
        if (buf) {
          const filtered = filterEvent(buf, stripper);
          if (filtered !== null) {
            controller.enqueue(encoder.encode(filtered));
          }
        }
        // Flush le stripper (texte restant)
        const tail = stripper.flush();
        if (tail) {
          // On émet un event message synthétique avec le tail
          const tailEvt = `data: ${JSON.stringify({ event: "message", answer: tail })}`;
          controller.enqueue(encoder.encode(tailEvt + "\n\n"));
        }
      } catch (e) {
        controller.error(e);
        return;
      }
      controller.close();
    },
  });
}

/** Filtre un event SSE : si c'est un message avec answer, on strip les
 *  think. Sinon on retourne tel quel. Retourne null si l'event devient
 *  vide (answer entièrement absorbée par le filtre). */
function filterEvent(rawEvent: string, stripper: ThinkStripper): string | null {
  const lines = rawEvent.split("\n");
  const out: string[] = [];
  let touched = false;

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      out.push(line);
      continue;
    }
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      out.push(line);
      continue;
    }
    try {
      const evt = JSON.parse(payload);
      if (
        (evt.event === "message" || evt.event === "agent_message") &&
        typeof evt.answer === "string"
      ) {
        const filtered = stripReactArtifacts(stripper.push(evt.answer));
        if (filtered) {
          evt.answer = filtered;
          out.push("data: " + JSON.stringify(evt));
        } else {
          // Answer vide après filtrage → on skip cet event (pas la peine
          // de polluer le client avec des chunks vides)
        }
        touched = true;
      } else {
        out.push(line);
      }
    } catch {
      out.push(line);
    }
  }

  if (!touched && out.length === 0) return null;
  return out.join("\n");
}
