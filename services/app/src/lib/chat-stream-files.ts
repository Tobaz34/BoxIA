/**
 * Détection en streaming des blocs [FILE:nom.ext]…[/FILE] dans la sortie
 * d'un agent Dify, et remplacement par un marker `{{file:UUID:nom:size}}`
 * que l'UI rend comme une chip téléchargeable.
 *
 * Algorithme — state machine sur les `answer` chunks SSE Dify :
 *
 *   IDLE        ─[FILE:─►  HEADER ─]\n──►  CONTENT ─[/FILE]──►  IDLE
 *
 * Les chunks LLM peuvent être très petits (quelques tokens), donc le marker
 * `[FILE:` peut arriver coupé en plusieurs morceaux. On garde un "tail" de
 * 8 caractères dans le buffer IDLE qui n'est pas émis avant qu'il soit
 * dépassé par la suite, pour pouvoir backtracker la détection sans avoir
 * déjà flushé.
 *
 * Pas de regex ici : la state machine fonctionne caractère par caractère
 * (suffisant : les chunks font ~5-50 chars, pas un bottleneck).
 */
import { storeFile } from "@/lib/file-storage";
import { generateFromContent, sanitizeFilename } from "@/lib/file-generators";

const FILE_OPEN = "[FILE:";
const FILE_CLOSE = "[/FILE]";
const TAIL_GUARD = FILE_OPEN.length;     // 6 chars — assez pour backtracker

type State = "IDLE" | "HEADER" | "CONTENT";

export interface FileDetectorContext {
  ownerEmail: string;
  conversationId?: string;
  messageIndex?: number;
}

export class FileDetector {
  private state: State = "IDLE";
  private buffer = "";        // texte non-encore-émis (IDLE) ou en train d'être analysé (HEADER/CONTENT)
  private currentFilename = "";
  private currentContent = "";

  constructor(private ctx: FileDetectorContext) {}

  /** Reçoit un nouveau chunk de texte (= `answer` d'un event Dify message)
   *  et retourne ce qu'il faut émettre vers le client. Peut être vide (si
   *  on bufferise un fichier en cours). */
  async push(chunk: string): Promise<string> {
    this.buffer += chunk;
    let out = "";

    while (this.buffer.length > 0) {
      if (this.state === "IDLE") {
        const idx = this.buffer.indexOf(FILE_OPEN);
        if (idx >= 0) {
          // Émet tout ce qui précède [FILE:
          out += this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + FILE_OPEN.length);
          this.state = "HEADER";
          this.currentFilename = "";
          this.currentContent = "";
          continue;  // re-loop pour traiter HEADER
        }
        // Pas de match. Émet tout sauf le tail de TAIL_GUARD chars
        // (au cas où la fin du buffer commence un `[FILE:` partiel).
        if (this.buffer.length > TAIL_GUARD) {
          out += this.buffer.slice(0, this.buffer.length - TAIL_GUARD);
          this.buffer = this.buffer.slice(this.buffer.length - TAIL_GUARD);
        }
        break;  // on attend plus de chunks pour pouvoir consommer le tail
      }

      if (this.state === "HEADER") {
        // On accumule jusqu'à `]` (le `\n` qui suit est optionnel — certains
        // LLM le mettent, d'autres non). Filename = ce qui précède `]`.
        const closeIdx = this.buffer.indexOf("]");
        if (closeIdx < 0) break;  // attend la suite

        this.currentFilename = sanitizeFilename(this.buffer.slice(0, closeIdx).trim());
        // Skip le `]` et un `\n` éventuel
        let after = closeIdx + 1;
        if (this.buffer[after] === "\n") after++;
        this.buffer = this.buffer.slice(after);
        this.state = "CONTENT";
        continue;
      }

      if (this.state === "CONTENT") {
        const idx = this.buffer.indexOf(FILE_CLOSE);
        if (idx >= 0) {
          // Fin de bloc trouvée
          this.currentContent += this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + FILE_CLOSE.length);
          // Skip un `\n` qui suit éventuellement
          if (this.buffer.startsWith("\n")) this.buffer = this.buffer.slice(1);

          // Génère et stocke le fichier
          const marker = await this.materializeFile();
          out += marker;
          this.state = "IDLE";
          this.currentFilename = "";
          this.currentContent = "";
          continue;
        }
        // Pas de close. Garde un tail au cas où `[/FILE]` arrive splitté
        if (this.buffer.length > FILE_CLOSE.length) {
          this.currentContent += this.buffer.slice(0, this.buffer.length - FILE_CLOSE.length);
          this.buffer = this.buffer.slice(this.buffer.length - FILE_CLOSE.length);
        }
        break;
      }
    }
    return out;
  }

  /** À appeler à la fin du stream pour flusher tout reste.
   *  - Si on est en CONTENT sans avoir vu `[/FILE]`, on traite quand même
   *    le bloc (l'agent a oublié de fermer). C'est mieux que de perdre les
   *    données.
   *  - Si on est en HEADER, on rétro-émet `[FILE:` + buffer (l'agent n'a
   *    pas terminé son header → juste afficher le texte brut).
   *  - Si on est IDLE, on flush le tail.
   */
  async flush(): Promise<string> {
    let out = "";
    if (this.state === "IDLE") {
      out += this.buffer;
      this.buffer = "";
    } else if (this.state === "HEADER") {
      // Pas de `]` reçu : on a probablement un faux positif ou un parsing
      // cassé. Rétro-émettre la balise + ce qu'on a vu.
      out += FILE_OPEN + this.buffer;
      this.buffer = "";
      this.state = "IDLE";
    } else if (this.state === "CONTENT") {
      this.currentContent += this.buffer;
      this.buffer = "";
      // Materialize même si pas de [/FILE] (mode tolérant)
      out += await this.materializeFile();
      this.state = "IDLE";
    }
    return out;
  }

  /** Génère un fichier depuis l'état courant (filename + content) et
   *  retourne le marker `{{file:UUID:name:size:mime}}`. */
  private async materializeFile(): Promise<string> {
    if (!this.currentFilename) return "";
    try {
      const gen = await generateFromContent(this.currentFilename, this.currentContent);
      const meta = await storeFile(
        gen.buffer, gen.filename, gen.mime,
        this.ctx.ownerEmail,
        {
          conversation_id: this.ctx.conversationId,
          message_index: this.ctx.messageIndex,
        },
      );
      return `{{file:${meta.id}:${meta.filename}:${meta.size}:${meta.mime}}}`;
    } catch (e) {
      console.warn("[chat-stream-files] generation error:", e);
      // En cas d'échec, retombe sur du texte visible côté UI
      return `\n\n⚠ Génération de **${this.currentFilename}** échouée : ` +
             `${(e as Error).message}\n`;
    }
  }
}
