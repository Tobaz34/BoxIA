/**
 * Tests unitaires — lib/tool-errors.ts (Sprint 0 S0.2).
 *
 * Couvre :
 * - Forme du body retourné { ok, error, hint, retryable, retry_after_ms?, detail? }
 * - Status code par helper (400/502/503)
 * - Heuristique retryable par défaut (4xx vs 5xx vs 408/425/429)
 * - Truncation du detail à 500 chars
 * - retry_after_ms uniquement si retryable=true
 */
import { describe, expect, it } from "vitest";
import {
  toolError,
  toolValidationError,
  toolUpstreamError,
  toolConfigError,
} from "./tool-errors";

async function bodyOf<T>(r: Response): Promise<T> {
  return (await r.json()) as T;
}

interface ErrorBody {
  ok: false;
  error: string;
  hint: string;
  retryable: boolean;
  retry_after_ms?: number;
  detail?: string;
}

describe("toolValidationError", () => {
  it("renvoie 400 retryable=false avec error+hint", async () => {
    const r = toolValidationError("missing_field", "Champ X requis");
    expect(r.status).toBe(400);
    const b = await bodyOf<ErrorBody>(r);
    expect(b.ok).toBe(false);
    expect(b.error).toBe("missing_field");
    expect(b.hint).toBe("Champ X requis");
    expect(b.retryable).toBe(false);
    expect(b.retry_after_ms).toBeUndefined();
  });
});

describe("toolConfigError", () => {
  it("renvoie 503 retryable=false (re-deploy requis)", async () => {
    const r = toolConfigError("env_missing", "SEARXNG_URL manquant");
    expect(r.status).toBe(503);
    const b = await bodyOf<ErrorBody>(r);
    expect(b.error).toBe("env_missing");
    expect(b.retryable).toBe(false);
  });
});

describe("toolUpstreamError", () => {
  it("renvoie 502 retryable=true par défaut", async () => {
    const r = toolUpstreamError({
      error: "graph_500",
      hint: "Graph API down",
    });
    expect(r.status).toBe(502);
    const b = await bodyOf<ErrorBody>(r);
    expect(b.error).toBe("graph_500");
    expect(b.retryable).toBe(true);
  });

  it("expose retry_after_ms si fourni", async () => {
    const r = toolUpstreamError({
      error: "rate_limit",
      hint: "Rate limit hit",
      retryAfterMs: 5000,
    });
    const b = await bodyOf<ErrorBody>(r);
    expect(b.retry_after_ms).toBe(5000);
  });

  it("formate detail avec upstream_status préfixé", async () => {
    const r = toolUpstreamError({
      error: "x",
      hint: "y",
      upstreamStatus: 429,
      detail: "rate hit",
    });
    const b = await bodyOf<ErrorBody>(r);
    expect(b.detail).toContain("upstream_status=429");
    expect(b.detail).toContain("rate hit");
  });
});

describe("toolError", () => {
  it("retryable déduit du status — 4xx → false (sauf 408/425/429)", async () => {
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 400 }))).retryable).toBe(false);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 401 }))).retryable).toBe(false);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 403 }))).retryable).toBe(false);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 404 }))).retryable).toBe(false);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 408 }))).retryable).toBe(true);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 425 }))).retryable).toBe(true);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 429 }))).retryable).toBe(true);
  });

  it("retryable déduit — 5xx → true", async () => {
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 500 }))).retryable).toBe(true);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 502 }))).retryable).toBe(true);
    expect((await bodyOf<ErrorBody>(toolError({ error: "e", hint: "h", status: 503 }))).retryable).toBe(true);
  });

  it("retryable explicite override la déduction", async () => {
    const r = toolError({ error: "e", hint: "h", status: 500, retryable: false });
    expect((await bodyOf<ErrorBody>(r)).retryable).toBe(false);
  });

  it("retry_after_ms ignoré si retryable=false", async () => {
    const r = toolError({
      error: "e",
      hint: "h",
      status: 400,
      retryable: false,
      retryAfterMs: 1000,
    });
    expect((await bodyOf<ErrorBody>(r)).retry_after_ms).toBeUndefined();
  });

  it("detail tronqué à 500 chars", async () => {
    const longDetail = "x".repeat(2000);
    const r = toolError({ error: "e", hint: "h", detail: longDetail });
    const b = await bodyOf<ErrorBody>(r);
    expect(b.detail?.length).toBe(500);
  });

  it("retry_after_ms négatif clamped à 0", async () => {
    const r = toolError({
      error: "e",
      hint: "h",
      status: 502,
      retryable: true,
      retryAfterMs: -1000,
    });
    expect((await bodyOf<ErrorBody>(r)).retry_after_ms).toBe(0);
  });
});
