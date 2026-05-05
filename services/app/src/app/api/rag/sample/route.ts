/**
 * GET /api/rag/sample?collection=rag_gdrive_CLIKINFO&limit=10&group_by_file=1
 *
 * Échantillonne des points pour vérifier ce qui est indexé.
 *
 * Sans group_by_file : renvoie les N premiers points (scroll).
 * Avec group_by_file=1 : agrège par file_id, renvoie les N fichiers
 *   distincts les plus récents (scroll + dédup côté Node) — utile pour
 *   répondre à la question "quels documents sont dans le RAG ?".
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { scrollPoints, type QdrantPoint } from "@/lib/qdrant-client";

export const dynamic = "force-dynamic";

interface FileSummary {
  file_id: string;
  name: string;
  source?: string;
  web_url?: string;
  modified_at?: string;
  chunks: number;
  sample_text?: string;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const collection = url.searchParams.get("collection");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10) || 10, 200);
  const groupByFile = url.searchParams.get("group_by_file") === "1";

  if (!collection || !collection.startsWith("rag_")) {
    return NextResponse.json(
      { error: "invalid_collection", hint: "Doit commencer par rag_" },
      { status: 400 },
    );
  }

  if (!groupByFile) {
    // Mode "raw" : N premiers points, payload + extrait text.
    let result;
    try {
      result = await scrollPoints(collection, limit);
    } catch (e) {
      return NextResponse.json(
        { error: "qdrant_error", hint: (e as Error).message },
        { status: 503 },
      );
    }
    const points = result.points.map((p) => sanitizePoint(p));
    return NextResponse.json({
      mode: "raw",
      collection,
      count: points.length,
      points,
    });
  }

  // Mode "group_by_file" : on scroll jusqu'à avoir `limit` files distincts
  // (cap à 1000 points pour éviter d'aspirer la collection entière).
  const files = new Map<string, FileSummary>();
  let offset: string | number | undefined = undefined;
  let scanned = 0;
  const MAX_SCAN = 1000;
  while (files.size < limit && scanned < MAX_SCAN) {
    let batch;
    try {
      batch = await scrollPoints(collection, 100, offset);
    } catch (e) {
      return NextResponse.json(
        { error: "qdrant_error", hint: (e as Error).message },
        { status: 503 },
      );
    }
    for (const p of batch.points) {
      scanned++;
      const pl = (p.payload || {}) as Record<string, unknown>;
      const fileId = String(pl.file_id || pl.id || p.id);
      if (!files.has(fileId)) {
        files.set(fileId, {
          file_id: fileId,
          name: String(pl.name || pl.title || pl.filename || "(sans nom)"),
          source: pl.source ? String(pl.source) : undefined,
          web_url: pl.web_url ? String(pl.web_url) : undefined,
          modified_at: pl.modified_at ? String(pl.modified_at) : undefined,
          chunks: 1,
          sample_text: pl.text ? String(pl.text).slice(0, 280) : undefined,
        });
      } else {
        files.get(fileId)!.chunks += 1;
      }
      if (files.size >= limit) break;
    }
    if (!batch.next_offset) break;
    offset = batch.next_offset;
  }

  return NextResponse.json({
    mode: "group_by_file",
    collection,
    count: files.size,
    scanned_points: scanned,
    files: Array.from(files.values()).sort((a, b) =>
      (b.modified_at || "").localeCompare(a.modified_at || ""),
    ),
  });
}

function sanitizePoint(p: QdrantPoint) {
  const pl = (p.payload || {}) as Record<string, unknown>;
  return {
    id: p.id,
    name: pl.name || pl.title || pl.filename || null,
    source: pl.source || null,
    file_id: pl.file_id || null,
    chunk_idx: pl.chunk_idx ?? null,
    web_url: pl.web_url || null,
    modified_at: pl.modified_at || null,
    text_preview: pl.text ? String(pl.text).slice(0, 280) : null,
    text_length: pl.text ? String(pl.text).length : 0,
  };
}
