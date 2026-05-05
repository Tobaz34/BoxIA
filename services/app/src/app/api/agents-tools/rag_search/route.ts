/**
 * GET /api/agents-tools/rag_search?q=…&limit=5&source=gdrive|msgraph|all
 *
 * Tool Dify pour les agents (Assistant général, Concierge, Tri emails…).
 * Recherche sémantique sur les collections Qdrant remplies par les workers
 * RAG (rag-gdrive, rag-msgraph) — c.-à-d. tous les documents Drive +
 * SharePoint + OneDrive de l'utilisateur connecté à AI Box.
 *
 * Réponse parseable par le LLM :
 *   { count, hits: [
 *       { score, name, source, web_url, text, file_id, chunk_idx }
 *     ]}
 *
 * Auth : Bearer AGENTS_API_KEY (cf lib/agents-tools-auth.ts).
 *
 * Pourquoi un tool plutôt qu'un dataset Dify natif :
 *   - Les workers indexent en delta dynamique (file changes), Dify
 *     n'a pas besoin de re-indexer
 *   - Pas de duplication d'embeddings
 *   - L'agent décide quand appeler — pas systématique sur chaque question
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { embedText, searchPoints } from "@/lib/qdrant-client";
import { toolValidationError, toolUpstreamError } from "@/lib/tool-errors";
import { startToolTrace } from "@/lib/langfuse";
import { bm25Rerank, qdrantPointsToCandidates } from "@/lib/bm25-reranker";

// P2 #12 — Hybrid search overfetch.
// On demande N=overFetch chunks à Qdrant (typique 3x le limit user)
// puis on rerank en BM25 et on garde top-K = limit. Améliore la
// pertinence sur termes métier rares (SIRET, codes APE, références
// client) où la pure similarité vectorielle peut manquer une
// correspondance exacte.
const HYBRID_OVERFETCH = Number(process.env.RAG_HYBRID_OVERFETCH || 3);
// alpha=0.5 : équilibre vector / BM25 (cf lib/bm25-reranker.ts).
// alpha=1.0 désactive BM25 (fallback pur vector). Configurable via env.
const HYBRID_ALPHA = Math.min(1, Math.max(0, Number(process.env.RAG_HYBRID_ALPHA || 0.5)));
const HYBRID_ENABLED = process.env.RAG_HYBRID_ENABLED !== "false";

export const dynamic = "force-dynamic";

const TENANT = (process.env.CLIENT_NAME || "default").toUpperCase();

// Mapping des sources logiques → noms de collection Qdrant.
// `all` cherche sur les 2 et merge.
const COLLECTIONS: Record<string, string[]> = {
  "gdrive": [`rag_gdrive_${TENANT}`],
  "msgraph": [`rag_msgraph_${TENANT}`],
  "sharepoint": [`rag_msgraph_${TENANT}`],   // alias humain
  "onedrive": [`rag_msgraph_${TENANT}`],     // alias humain
  "drive": [`rag_gdrive_${TENANT}`],          // alias humain
  "all": [`rag_gdrive_${TENANT}`, `rag_msgraph_${TENANT}`],
};

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const tracer = startToolTrace({ toolName: "rag_search", req });

  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    tracer.failure({ errorCode: "missing_query", retryable: false, httpStatus: 400 });
    return toolValidationError(
      "missing_query",
      "Paramètre `q` requis (la question/requête).",
    );
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "5", 10), 1), 15);
  const sourceParam = (url.searchParams.get("source") || "all").toLowerCase();
  const collections = COLLECTIONS[sourceParam] || COLLECTIONS["all"];

  // 1. Embed la query
  let vector: number[];
  try {
    vector = await embedText(query);
  } catch (e) {
    tracer.failure({
      errorCode: "embed_failed",
      retryable: true,
      httpStatus: 502,
      metadata: { reason: "ollama_embed" },
    });
    return toolUpstreamError({
      error: "embed_failed",
      hint: "Le service d'embedding (Ollama) est indisponible ou a échoué. Réessayable.",
      detail: (e as Error).message,
    });
  }

  // 2. Search en parallèle sur toutes les collections.
  //    Si hybrid activé → over-fetch (limit * HYBRID_OVERFETCH) candidats
  //    pour laisser de la matière à BM25 rerank.
  const fetchLimit = HYBRID_ENABLED ? limit * HYBRID_OVERFETCH : limit;

  interface RagHit {
    id: string | number;
    score: number;
    name: string | null;
    source: string | null;
    web_url: string | null;
    text: string | null;
    file_id: string | null;
    chunk_idx: number | null;
    collection: string;
  }
  const allHits: RagHit[] = [];

  await Promise.all(collections.map(async (col) => {
    try {
      const hits = await searchPoints(col, vector, fetchLimit);
      for (const h of hits) {
        const pl = (h.payload || {}) as Record<string, unknown>;
        allHits.push({
          id: h.id,
          score: h.score,
          name: (pl.name as string) || (pl.title as string) || null,
          source: (pl.source as string) || null,
          web_url: (pl.web_url as string) || null,
          text: pl.text ? String(pl.text).slice(0, 800) : null,
          file_id: (pl.file_id as string) || null,
          chunk_idx: typeof pl.chunk_idx === "number" ? pl.chunk_idx : null,
          collection: col,
        });
      }
    } catch (e) {
      // Une collection inaccessible (ex: vide, pas créée) ne casse pas la
      // recherche — on log et on continue.
      console.warn(`[rag_search] failed on ${col}:`, (e as Error).message);
    }
  }));

  // 3. Hybrid reranking (P2 #12).
  // Si HYBRID_ENABLED, on rerank les candidats par BM25 + vector pour
  // privilégier les correspondances exactes sur termes métier rares.
  // Sinon, fallback simple : sort par score vectoriel desc.
  let top: Array<RagHit & { hybrid_score?: number }>;
  if (HYBRID_ENABLED && allHits.length > 0) {
    // Map id → hit pour le restore après rerank (le BM25 reranker ne
    // sait que voir id/text/vector_score, on récupère le hit original
    // après le tri).
    const byId = new Map<string | number, RagHit>(
      allHits.filter((h) => h.text).map((h) => [h.id, h]),
    );
    const candidates = allHits
      .filter((h) => h.text && h.text.length > 0)
      .map((h) => ({
        id: h.id,
        text: h.text || "",
        vector_score: h.score,
      }));
    const reranked = bm25Rerank(query, candidates, limit, HYBRID_ALPHA);
    top = reranked
      .map((r) => {
        const orig = byId.get(r.id);
        if (!orig) return null;
        return {
          ...orig,
          score: r.hybrid_score,
          hybrid_score: r.hybrid_score,
        };
      })
      .filter((x): x is RagHit & { hybrid_score: number } => x !== null);
  } else {
    allHits.sort((a, b) => b.score - a.score);
    top = allHits.slice(0, limit);
  }

  tracer.success(
    { count: top.length },
    {
      source: sourceParam,
      collections,
      limit,
      hybrid: HYBRID_ENABLED,
      overfetch: HYBRID_ENABLED ? fetchLimit : undefined,
      alpha: HYBRID_ENABLED ? HYBRID_ALPHA : undefined,
    },
  );
  return NextResponse.json({
    query,
    source: sourceParam,
    count: top.length,
    hits: top,
    // Expose le mode hybrid dans la réponse pour debug et observability
    hybrid: HYBRID_ENABLED ? { enabled: true, alpha: HYBRID_ALPHA, overfetch: HYBRID_OVERFETCH } : { enabled: false },
  });
}
