/**
 * Contrat standardisé pour les erreurs renvoyées par les routes
 * `/api/agents-tools/*`.
 *
 * Pourquoi : avant Sprint 0 S0.2, chaque route renvoyait sa propre forme
 * d'erreur (`{error}`, `{error, hint}`, `{ok:false, error, hint}`,
 * `{error, status, body}`…). Le Concierge Dify et le futur replan-helper
 * (P0 #5) doivent pouvoir distinguer une erreur **retryable** (réseau
 * transient, rate-limit, upstream 503) d'une erreur **fatale** (config
 * absente, auth refusée, validation input). Sans cette distinction, le
 * replan loop tourne en rond ou abandonne trop vite.
 *
 * Forme attendue (JSON body, status HTTP cohérent) :
 * ```ts
 * {
 *   ok: false,
 *   error: string,         // code court machine-friendly (snake_case)
 *   hint: string,          // message FR pour l'agent / l'humain
 *   retryable: boolean,    // true si re-essayer plus tard a une chance
 *   retry_after_ms?: number, // si retryable, délai conseillé avant retry
 *   detail?: string,       // contexte technique optionnel (status upstream, msg court)
 * }
 * ```
 *
 * Règle générale :
 * - 4xx (sauf 408/425/429) → retryable=false (input/config/auth — re-essayer
 *   avec les mêmes params ne changera rien)
 * - 408 timeout / 425 too early / 429 rate limit → retryable=true
 * - 5xx upstream / réseau → retryable=true
 * - Validation input (zod, "missing_*", "bad_json") → retryable=false
 *
 * Les réponses **succès** restent libres (chaque tool a son shape métier),
 * mais doivent par convention inclure `ok: true` au top-level.
 */
import { NextResponse } from "next/server";

export interface ToolErrorBody {
  ok: false;
  error: string;
  hint: string;
  retryable: boolean;
  retry_after_ms?: number;
  detail?: string;
}

export interface ToolErrorOptions {
  /** Code court machine-friendly (snake_case). Ex: "missing_query", "upstream_5xx". */
  error: string;
  /** Message FR pour l'agent / l'humain. */
  hint: string;
  /** HTTP status code (default 400). */
  status?: number;
  /** True si re-essayer plus tard a une chance (network blip, rate limit, 5xx). */
  retryable?: boolean;
  /** Si retryable, délai conseillé avant le retry (ms). */
  retryAfterMs?: number;
  /** Contexte technique optionnel (status upstream, msg court). */
  detail?: string;
}

/**
 * Construit une NextResponse erreur conforme au contrat ToolErrorBody.
 *
 * Si `retryable` n'est pas fourni, déduit automatiquement depuis le status :
 * - 408/425/429/5xx → true
 * - reste → false
 */
export function toolError(opts: ToolErrorOptions): NextResponse<ToolErrorBody> {
  const status = opts.status ?? 400;
  const retryable = opts.retryable ?? defaultRetryable(status);
  const body: ToolErrorBody = {
    ok: false,
    error: opts.error,
    hint: opts.hint,
    retryable,
  };
  if (retryable && typeof opts.retryAfterMs === "number") {
    body.retry_after_ms = Math.max(0, Math.floor(opts.retryAfterMs));
  }
  if (opts.detail) {
    body.detail = opts.detail.slice(0, 500);
  }
  return NextResponse.json(body, { status });
}

function defaultRetryable(status: number): boolean {
  if (status === 408 || status === 425 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Helper pour les erreurs de validation input (forme la plus fréquente).
 * Retourne un 400 retryable=false avec un code et un hint.
 */
export function toolValidationError(
  error: string,
  hint: string,
): NextResponse<ToolErrorBody> {
  return toolError({ error, hint, status: 400, retryable: false });
}

/**
 * Helper pour les erreurs upstream (Dify, SearXNG, Gmail, Outlook,
 * Microsoft Graph, Pennylane, etc.).
 * Par défaut 502 retryable=true. retry_after_ms exposé si on a la valeur
 * du header `Retry-After`.
 */
export function toolUpstreamError(opts: {
  error: string;
  hint: string;
  upstreamStatus?: number;
  detail?: string;
  retryAfterMs?: number;
}): NextResponse<ToolErrorBody> {
  return toolError({
    error: opts.error,
    hint: opts.hint,
    status: 502,
    retryable: true,
    retryAfterMs: opts.retryAfterMs,
    detail: opts.upstreamStatus
      ? `upstream_status=${opts.upstreamStatus}${opts.detail ? `; ${opts.detail}` : ""}`
      : opts.detail,
  });
}

/**
 * Helper pour les erreurs de configuration (env var manquante, service
 * désactivé). Retourne un 503 retryable=false (re-déploiement requis).
 */
export function toolConfigError(
  error: string,
  hint: string,
): NextResponse<ToolErrorBody> {
  return toolError({ error, hint, status: 503, retryable: false });
}
