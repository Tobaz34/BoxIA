/**
 * POST /api/agents-tools/web_search
 *
 * Body : { query: string, max_results?: number, lang?: string }
 *
 * Cherche sur le web via SearXNG (métamoteur self-hosted, agrège
 * Google/Bing/DDG/Qwant/Wikipedia, 0 clé API). Retourne les top-K
 * résultats au format JSON consommable par l'agent Concierge.
 *
 * Auth : Bearer AGENTS_API_KEY (comme les autres tools).
 *
 * Action READ-ONLY → pas d'approval gate (cf. lib/approval-gate.ts —
 * réservé aux mutatifs install_*).
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { logAction } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const SEARXNG_URL = process.env.SEARXNG_URL || "";
const TIMEOUT_MS = Number(process.env.SEARXNG_TIMEOUT_MS || 8000);
const DEFAULT_MAX = Number(process.env.SEARXNG_DEFAULT_MAX || 5);
const HARD_MAX = 15;

interface PostBody {
  query?: unknown;
  max_results?: unknown;
  lang?: unknown;
}

interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  score?: number;
  publishedDate?: string;
}

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  if (!SEARXNG_URL) {
    return NextResponse.json(
      {
        ok: false,
        error: "search_disabled",
        hint: "SEARXNG_URL not configured (déploie services/search/docker-compose.yml puis ajoute SEARXNG_URL=http://127.0.0.1:8888 dans .env)",
      },
      { status: 503 },
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query || query.length < 2) {
    return NextResponse.json(
      { error: "missing_or_short_query", hint: "min 2 chars" },
      { status: 400 },
    );
  }
  const maxResults = Math.min(
    HARD_MAX,
    Math.max(1, Number(body.max_results) || DEFAULT_MAX),
  );
  const lang = typeof body.lang === "string" ? body.lang : "fr";

  // Appel SearXNG JSON API. Le endpoint `/search` accepte les mêmes
  // params que l'UI : q, format=json, language, safesearch, etc.
  const params = new URLSearchParams({
    q: query,
    format: "json",
    language: lang,
    safesearch: "1",
    // Limite les engines aux plus pertinents pour FR + privacy
    // (overridable via settings.yml côté SearXNG si besoin métier).
    engines: "duckduckgo,wikipedia,qwant",
  });

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const r = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: ctrl.signal,
      headers: {
        // SearXNG bloque les requêtes sans User-Agent navigateur valide
        "User-Agent": "Mozilla/5.0 BoxIA-Concierge/1.0",
        Accept: "application/json",
      },
    });
    clearTimeout(timer);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          error: "searxng_upstream_error",
          status: r.status,
          body: text.slice(0, 200),
        },
        { status: 502 },
      );
    }
    const data = (await r.json()) as { results?: SearxngResult[] };
    const results = (data.results || [])
      .slice(0, maxResults)
      .map((r) => ({
        title: (r.title || "").slice(0, 200),
        url: r.url || "",
        snippet: (r.content || "").slice(0, 400),
        engine: r.engine,
        published: r.publishedDate,
      }))
      .filter((r) => r.url && r.title);

    await logAction(
      "agent.chat",
      "concierge-agent",
      {
        tool: "web_search",
        query: query.slice(0, 200),
        results_count: results.length,
        lang,
      },
      null,
    );

    return NextResponse.json({
      ok: true,
      query,
      lang,
      count: results.length,
      results,
      hint: results.length === 0
        ? "Aucun résultat. Reformule la requête (mots-clés différents, langue ?)."
        : `Top ${results.length} résultats. Cite les URLs dans ta réponse.`,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: "search_failed", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }
}
