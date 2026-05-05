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

  // 2. Search en parallèle sur toutes les collections, merge + sort par score desc
  const allHits: Array<{
    score: number;
    name: string | null;
    source: string | null;
    web_url: string | null;
    text: string | null;
    file_id: string | null;
    chunk_idx: number | null;
    collection: string;
  }> = [];

  await Promise.all(collections.map(async (col) => {
    try {
      const hits = await searchPoints(col, vector, limit);
      for (const h of hits) {
        const pl = (h.payload || {}) as Record<string, unknown>;
        allHits.push({
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

  // Sort + cap
  allHits.sort((a, b) => b.score - a.score);
  const top = allHits.slice(0, limit);

  tracer.success(
    { count: top.length },
    { source: sourceParam, collections, limit },
  );
  return NextResponse.json({
    query,
    source: sourceParam,
    count: top.length,
    hits: top,
  });
}
