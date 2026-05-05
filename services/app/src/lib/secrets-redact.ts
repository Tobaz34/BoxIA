/**
 * StreamingSecretsFilter — anti-fuite de secrets dans les streams SSE chat.
 *
 * Pourquoi (P2 #13 du plan v2 OSS-inspired) : nos filtres existants
 * (`strip-think`, `pii-scrub`) sont **outbound-only** et n'attrapent pas :
 * 1. Les credentials que le LLM régurgite par accident (clé API, token
 *    OAuth, mot de passe BDD) lus depuis un email RAG ou un .env exposé
 * 2. Les secrets dans les **outputs des tools** (ex: `gmail_get_thread`
 *    qui retourne un email avec `password: xxx` dedans, ou
 *    `rag_search` qui matche un fichier `credentials.txt`)
 *
 * Ce filtre se branche en INBOUND (avant que le content reach le LLM)
 * et en OUTBOUND (avant que le content reach le client) et redacte
 * tous les patterns dangereux par `[REDACTED:<type>]`.
 *
 * Inspiration : Agent Zero `extensions/python/.../streaming_secrets_filter.py`
 * (license MIT, pattern réimplémenté en TS).
 */

export interface SecretPattern {
  /** Identifiant du type de secret (apparait dans le marker REDACTED). */
  type: string;
  /** Regex globale qui matche le secret. Doit avoir le flag `g` pour replace_all. */
  pattern: RegExp;
  /** Description FR. */
  description: string;
}

/**
 * Catalogue de patterns. Ordre : du plus SPÉCIFIQUE au plus GÉNÉRIQUE
 * pour éviter qu'un pattern générique mange un specifique (ex: "OpenAI key"
 * doit matcher AVANT "alphanumeric long string").
 *
 * Important : tous les patterns doivent avoir le flag `g` pour
 * `replaceAll` fonctionne.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  // ===== API Keys (très spécifiques, rarement faux positifs) =====
  {
    type: "openai_key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    description: "Clé API OpenAI (sk-...)",
  },
  {
    type: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9-]{30,}\b/g,
    description: "Clé API Anthropic (sk-ant-...)",
  },
  {
    type: "stripe_key",
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    description: "Clé Stripe (sk_/pk_/rk_)",
  },
  {
    type: "github_token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    description: "Token GitHub (ghp_/gho_/ghu_/ghs_/ghr_)",
  },
  {
    type: "github_pat_fine_grained",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,
    description: "Token GitHub fine-grained PAT",
  },
  {
    type: "google_oauth_refresh_token",
    pattern: /\b1\/\/0[A-Za-z0-9_-]{30,}\b/g,
    description: "Refresh token Google OAuth (1//0...)",
  },
  {
    type: "google_api_key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    description: "Clé Google API (AIza...)",
  },
  {
    type: "slack_token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    description: "Token Slack (xoxb-/xoxa-/...)",
  },
  {
    type: "aws_access_key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    description: "AWS Access Key ID (AKIA...)",
  },
  {
    type: "aws_secret_key",
    // Heuristique : 40 chars b64-style après "aws_secret_access_key"
    pattern: /aws_secret_access_key[\s=:"']+([A-Za-z0-9/+=]{40})/gi,
    description: "AWS Secret Access Key (40 chars après identifier)",
  },

  // ===== JWTs =====
  {
    type: "jwt",
    // 3 segments base64url séparés par dots, header commence par eyJ
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    description: "JWT (eyJ...)",
  },

  // ===== Generic API key patterns =====
  {
    type: "bearer_long",
    pattern: /\bBearer\s+[A-Za-z0-9_\-./+=]{32,}\b/g,
    description: "Bearer token long",
  },
  {
    type: "api_key_assignment",
    // Capture "api_key" ou "apikey" suivi de = " : et la valeur 20+ chars
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token)\s*[=:]\s*["']?([A-Za-z0-9_\-./+=]{20,})["']?/gi,
    description: "Assignation api_key/access_token=...",
  },
  {
    type: "password_assignment",
    // Capture password=... mais pas password est obligatoire (faux pos FR)
    pattern: /\bpassword\s*[=:]\s*["']([^"'\n]{6,})["']/gi,
    description: "Assignation password=\"...\"",
  },

  // ===== Private keys =====
  {
    type: "private_key_pem",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PRIVATE KEY).*?-----END [^-]+-----/gs,
    description: "PEM private key (-----BEGIN...-----)",
  },

  // ===== App-specific (BoxIA / Dify / n8n) =====
  {
    type: "dify_app_key",
    pattern: /\bapp-[A-Za-z0-9]{20,}\b/g,
    description: "Clé d'app Dify (app-...)",
  },
];

/** Format `§§secret(KEY)` utilisé pour les références aux secrets BoxIA
 *  (similaire au pattern Agent Zero). NE PAS redacter ces tokens — ce sont
 *  des références par nom, pas le secret lui-même. */
const BOXIA_SECRET_REF_RE = /§§secret\([A-Z_][A-Z0-9_]*\)/g;

/**
 * Redacte les secrets dans une string. Retourne la string avec les
 * matches remplacés par `[REDACTED:<type>]`.
 *
 * @param input texte brut (peut contenir des secrets)
 * @returns texte redacté
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;

  // Préserve d'abord les références §§secret(KEY) en les remplaçant par
  // un placeholder neutre, puis on restore à la fin (évite que la regex
  // bearer/api_key les mange).
  const refMap = new Map<string, string>();
  let refIdx = 0;
  out = out.replace(BOXIA_SECRET_REF_RE, (match) => {
    const ph = `__BOXIASECRETREF_${refIdx++}__`;
    refMap.set(ph, match);
    return ph;
  });

  for (const sp of SECRET_PATTERNS) {
    out = out.replace(sp.pattern, `[REDACTED:${sp.type}]`);
  }

  // Restore les références
  for (const [ph, orig] of refMap.entries()) {
    out = out.split(ph).join(orig);
  }

  return out;
}

/**
 * Streaming filter pour SSE. Buffer tail-safe pour ne pas couper un secret
 * à cheval sur 2 chunks.
 *
 * Limite : un secret > MAX_BUFFER chars sera laissé tel quel (très rare
 * pour les API keys typiques < 100 chars). Les PEM private keys (multi-line
 * et longues) sont mieux redactées en mode "blocking" (cf redactSecrets).
 */
export class StreamingSecretsFilter {
  private buffer = "";
  private static readonly TAIL_GUARD = 256; // assez pour les longest pattern (PEM keys)
  private static readonly MAX_BUFFER = 4096;

  /** Push un chunk, retourne le filtré. */
  push(chunk: string): string {
    this.buffer += chunk;

    // Si le buffer est gros, force redaction + flush (sauf le tail guard)
    if (this.buffer.length > StreamingSecretsFilter.MAX_BUFFER) {
      const safe = this.buffer.length - StreamingSecretsFilter.TAIL_GUARD;
      const head = redactSecrets(this.buffer.slice(0, safe));
      this.buffer = this.buffer.slice(safe);
      return head;
    }

    // Sinon, redacte ce qu'on peut sans toucher au tail guard.
    if (this.buffer.length > StreamingSecretsFilter.TAIL_GUARD) {
      const safe = this.buffer.length - StreamingSecretsFilter.TAIL_GUARD;
      const head = redactSecrets(this.buffer.slice(0, safe));
      this.buffer = this.buffer.slice(safe);
      return head;
    }

    return ""; // attend plus de chunks
  }

  flush(): string {
    const rest = redactSecrets(this.buffer);
    this.buffer = "";
    return rest;
  }
}

/**
 * Wrap un ReadableStream<Uint8Array> SSE pour redacter les secrets dans
 * les `answer` des events `message` / `agent_message`. À utiliser après
 * stripThinkFromSSE (les secrets dans les `<think>` sont déjà strippés).
 *
 * Usage typique dans `/api/chat/route.ts` :
 *   const stripped = stripThinkFromSSE(upstream.body);
 *   const redacted = redactSecretsFromSSE(stripped);
 *   return new Response(redacted, ...);
 */
export function redactSecretsFromSSE(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const filter = new StreamingSecretsFilter();
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
          const events = buf.split("\n\n");
          buf = events.pop() || "";
          for (const ev of events) {
            const filtered = filterSSEEvent(ev, filter);
            if (filtered !== null) {
              controller.enqueue(encoder.encode(filtered + "\n\n"));
            }
          }
        }
        if (buf) {
          const filtered = filterSSEEvent(buf, filter);
          if (filtered !== null) {
            controller.enqueue(encoder.encode(filtered));
          }
        }
        const tail = filter.flush();
        if (tail) {
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

function filterSSEEvent(
  rawEvent: string,
  filter: StreamingSecretsFilter,
): string | null {
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
        const filtered = filter.push(evt.answer);
        if (filtered) {
          evt.answer = filtered;
          out.push("data: " + JSON.stringify(evt));
        }
        // Si filtered est vide → on ne push pas (chunk en buffer interne)
        touched = true;
      } else if (evt.event === "agent_thought" && typeof evt.thought === "string") {
        // agent_thought peut aussi contenir des secrets (qwen recopie
        // des bouts de tool result dans son thought).
        evt.thought = redactSecrets(evt.thought);
        out.push("data: " + JSON.stringify(evt));
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
