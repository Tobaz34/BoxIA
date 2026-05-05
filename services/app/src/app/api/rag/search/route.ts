/**
 * POST /api/rag/search
 * body: { collection: "rag_gdrive_CLIKINFO", query: "facture 2024", limit?: 5 }
 *
 * Test interactif de la recherche sémantique sur une collection RAG :
 * embed la query avec bge-m3 (Ollama) puis Qdrant /points/search avec
 * cosine distance. Renvoie les N meilleurs hits avec score.
 *
 * Utile pour répondre à la question "le RAG trouve-t-il bien le doc X
 * quand je cherche Y ?" sans passer par un agent IA.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { embedText, searchPoints } from "@/lib/qdrant-client";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    collection?: string;
    query?: string;
    limit?: number;
  };
  const collection = String(body.collection || "");
  const query = String(body.query || "").trim();
  const limit = Math.min(Math.max(body.limit || 5, 1), 20);

  if (!collection.startsWith("rag_")) {
    return NextResponse.json(
      { error: "invalid_collection", hint: "Doit commencer par rag_" },
      { status: 400 },
    );
  }
  if (!query) {
    return NextResponse.json({ error: "missing_query" }, { status: 400 });
  }

  // 1. Embed
  const t0 = Date.now();
  let vector: number[];
  try {
    vector = await embedText(query);
  } catch (e) {
    return NextResponse.json(
      { error: "embed_failed", hint: (e as Error).message },
      { status: 503 },
    );
  }
  const embedMs = Date.now() - t0;

  // 2. Search
  const t1 = Date.now();
  let hits;
  try {
    hits = await searchPoints(collection, vector, limit);
  } catch (e) {
    return NextResponse.json(
      { error: "search_failed", hint: (e as Error).message },
      { status: 503 },
    );
  }
  const searchMs = Date.now() - t1;

  return NextResponse.json({
    collection,
    query,
    embed_ms: embedMs,
    search_ms: searchMs,
    vector_dim: vector.length,
    count: hits.length,
    hits: hits.map((h) => {
      const pl = (h.payload || {}) as Record<string, unknown>;
      return {
        id: h.id,
        score: h.score,
        name: pl.name || pl.title || pl.filename || null,
        source: pl.source || null,
        file_id: pl.file_id || null,
        chunk_idx: pl.chunk_idx ?? null,
        web_url: pl.web_url || null,
        text_preview: pl.text ? String(pl.text).slice(0, 400) : null,
      };
    }),
  });
}
