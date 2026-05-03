/**
 * GET /api/system/github-status — état de la connexion GitHub.
 *
 * Pas d'auth requise (info légère, le token n'est jamais retourné).
 * Réponse :
 *   { connected: bool,
 *     source: "env" | "file" | null,
 *     login?: string,
 *     scopes?: string[],
 *     last_validated_at?: string,
 *     rate_limit?: { remaining: number, limit: number, reset_at: string },
 *     saved_at?: string,
 *     saved_by?: string }
 *
 * Si ?revalidate=1, on force un appel /user (révèle un mauvais token au
 * lieu de servir un cache obsolète).
 */
import { NextResponse } from "next/server";
import {
  getActiveGitHubToken,
  getStoredMetadata,
  validateToken,
  updateValidationCache,
} from "@/lib/github-token";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const revalidate = url.searchParams.get("revalidate") === "1";

  const active = await getActiveGitHubToken();
  if (!active) {
    return NextResponse.json({
      connected: false,
      source: null as null,
    });
  }

  const meta = await getStoredMetadata();
  const baseResp = {
    connected: true as const,
    source: active.source,
    saved_at: meta?.saved_at,
    saved_by: meta?.saved_by,
    last_validated_at: meta?.last_validated_at,
    login: meta?.login,
    scopes: meta?.scopes,
  };

  if (!revalidate && meta?.last_validated_at) {
    const age = Date.now() - Date.parse(meta.last_validated_at);
    if (age < 5 * 60_000) {
      // Cache valide <5 min → on rend tout de suite sans appel GitHub
      return NextResponse.json(baseResp);
    }
  }

  // Live validation (ping /user + lecture rate_limit)
  try {
    const { login, scopes } = await validateToken(active.token);
    if (active.source === "file") {
      await updateValidationCache(login, scopes);
    }

    let rateLimit: { remaining: number; limit: number; reset_at: string } | undefined;
    try {
      const rl = await fetch("https://api.github.com/rate_limit", {
        headers: { "Authorization": `Bearer ${active.token}`, "User-Agent": "aibox-app/github-status" },
      });
      if (rl.ok) {
        const j = await rl.json();
        const core = j.resources?.core;
        if (core) {
          rateLimit = {
            remaining: core.remaining,
            limit: core.limit,
            reset_at: new Date(core.reset * 1000).toISOString(),
          };
        }
      }
    } catch { /* tolère */ }

    return NextResponse.json({
      ...baseResp,
      login,
      scopes,
      last_validated_at: new Date().toISOString(),
      rate_limit: rateLimit,
    });
  } catch (e) {
    return NextResponse.json({
      ...baseResp,
      validation_error: String(e instanceof Error ? e.message : e),
    });
  }
}
