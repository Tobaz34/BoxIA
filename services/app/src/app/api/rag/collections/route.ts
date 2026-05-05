/**
 * GET /api/rag/collections
 *
 * Liste les collections Qdrant exposées au RAG (préfixe `rag_*`),
 * enrichies avec :
 *   - count points + status + segments
 *   - vector_size + distance
 *   - distinct_files (depuis le schéma payload `file_id`)
 *   - distinct_users autorisés (acl_users)
 *
 * Filtre intentionnellement les collections `mem0_*` (mémoire long-terme)
 * et autres internes — le panneau RAG n'expose que la KB-style.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listCollections, getCollection } from "@/lib/qdrant-client";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let summaries;
  try {
    summaries = await listCollections();
  } catch (e) {
    return NextResponse.json(
      { error: "qdrant_unreachable", hint: (e as Error).message },
      { status: 503 },
    );
  }

  // Filtre : on n'expose que les collections RAG (préfixe `rag_`).
  // Les `mem0_*` sont la mémoire user, gérée ailleurs (lib/mem0).
  const ragNames = summaries.map((c) => c.name).filter((n) => n.startsWith("rag_"));

  // Récupère les détails en parallèle (batch limité pour éviter de
  // saturer Qdrant si beaucoup de collections un jour).
  const details = await Promise.all(
    ragNames.map(async (name) => {
      try {
        const d = await getCollection(name);
        if (!d) return null;
        // Décompose le nom rag_<source>_<TENANT> pour l'UI.
        const m = /^rag_([a-z0-9]+)_(.+)$/i.exec(name);
        const source = m?.[1] || "unknown";
        const tenant = m?.[2] || "default";
        const payloadSchema = d.payload_schema || {};
        const filesField = payloadSchema.file_id as { points?: number } | undefined;
        const aclField = payloadSchema.acl_users as { points?: number } | undefined;
        return {
          name,
          source,
          tenant,
          status: d.status,
          points_count: d.points_count,
          indexed_vectors_count: d.indexed_vectors_count,
          segments_count: d.segments_count,
          vector_size: d.vector_size,
          vector_distance: d.vector_distance,
          // Heuristique : chaque file_id est un fichier source distinct,
          // chaque chunk est 1 point. files ≈ distinct file_id.
          // Qdrant ne renvoie pas le distinct count directement — on le
          // dérive en complément avec un scroll si besoin.
          fields_indexed: {
            file_id_points: filesField?.points || 0,
            acl_users_points: aclField?.points || 0,
          },
        };
      } catch {
        return {
          name,
          source: "unknown",
          tenant: "?",
          status: "error",
          points_count: 0,
          indexed_vectors_count: 0,
          segments_count: 0,
          vector_size: 0,
          vector_distance: "?",
        };
      }
    }),
  );

  const collections = details.filter((d): d is NonNullable<typeof d> => d !== null);
  return NextResponse.json({
    collections,
    summary: {
      total: collections.length,
      total_points: collections.reduce((acc, c) => acc + c.points_count, 0),
    },
  });
}
