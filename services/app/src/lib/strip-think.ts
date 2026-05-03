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

const OPEN_RE = /<think(?:ing)?>/gi;
const CLOSE_RE = /<\/think(?:ing)?>/gi;
// Quand on est dans la zone "potentielle" (vu un `<` mais pas la suite),
// on bufferise jusqu'à un nb max de chars puis on flush si rien match.
const MAX_BUFFER = 64;

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
 * sans les contenus `<think>...</think>`.
 *
 * État interne : `inThink` (booléen), `buffer` (string en cours
 * d'analyse car potentiellement à cheval sur un tag).
 */
export class ThinkStripper {
  private inThink = false;
  private buffer = "";

  /** Ingère un chunk text, retourne le texte filtré à émettre. */
  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";

    while (this.buffer.length > 0) {
      if (this.inThink) {
        // On cherche la fermeture
        CLOSE_RE.lastIndex = 0;
        const m = CLOSE_RE.exec(this.buffer);
        if (!m) {
          // Pas encore de fermeture, on jette tout ce qui est dans le
          // buffer SAUF les derniers chars qui pourraient être un début
          // de balise `</think>`
          if (this.buffer.length > MAX_BUFFER) {
            this.buffer = this.buffer.slice(-16); // garde 16 chars max
          }
          break;
        }
        // Trouvé : on saute jusqu'après la balise
        this.inThink = false;
        this.buffer = this.buffer.slice(m.index + m[0].length);
        continue;
      }

      // Pas en zone think : on cherche l'ouverture
      OPEN_RE.lastIndex = 0;
      const m = OPEN_RE.exec(this.buffer);
      if (!m) {
        // Pas d'ouverture détectée. Mais le buffer peut se terminer
        // par un fragment de balise (ex: "...du texte<thi"). On émet
        // tout sauf les 16 derniers chars (potentiel début de balise).
        if (this.buffer.length <= 16) {
          break; // attend plus de chunks
        }
        const safe = this.buffer.length - 16;
        out += this.buffer.slice(0, safe);
        this.buffer = this.buffer.slice(safe);
        break;
      }

      // Ouverture trouvée : émet ce qui précède, entre en mode think
      out += this.buffer.slice(0, m.index);
      this.inThink = true;
      this.buffer = this.buffer.slice(m.index + m[0].length);
    }

    return out;
  }

  /** Flush final : émet ce qui reste dans le buffer (sauf si on est
   *  encore dans un think — auquel cas qwen a probablement été coupé). */
  flush(): string {
    if (this.inThink) {
      this.buffer = "";
      this.inThink = false;
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
