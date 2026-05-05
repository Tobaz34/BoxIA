/**
 * Petit client Qdrant côté server-side, partagé entre les routes
 * /api/rag/* et /api/connectors/sync-status. Pas de dep externe — on
 * tape directement le REST.
 *
 * QDRANT_URL : URL HTTP. En aibox-app (network_mode:host) =
 * http://localhost:6333. Pour les workers Python (réseau aibox_net) =
 * http://aibox-qdrant:6333.
 *
 * QDRANT_API_KEY : clé d'auth (header `api-key`). Sans elle on récupère
 * 401 sur tous les endpoints — vérifié 2026-05-04 sur xefia.
 */

const BASE = process.env.QDRANT_URL || "http://localhost:6333";
const KEY = process.env.QDRANT_API_KEY || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (KEY) h["api-key"] = KEY;
  return h;
}

export interface QdrantCollectionSummary {
  name: string;
}

export interface QdrantCollectionDetails {
  name: string;
  status: string;
  optimizer_status: unknown;
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  vector_size: number;
  vector_distance: string;
  payload_schema?: Record<string, unknown>;
}

export interface QdrantPoint {
  id: string | number;
  payload?: Record<string, unknown>;
  // vector volontairement omis (1024 floats par point = bruit pour l'UI)
}

export interface QdrantScoredPoint extends QdrantPoint {
  score: number;
}

export async function listCollections(): Promise<QdrantCollectionSummary[]> {
  const r = await fetch(`${BASE}/collections`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`qdrant_${r.status}`);
  const j = await r.json();
  return j.result?.collections || [];
}

export async function getCollection(name: string): Promise<QdrantCollectionDetails | null> {
  const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`qdrant_${r.status}`);
  const j = await r.json();
  const res = j.result || {};
  const params = res.config?.params || {};
  const vectors = params.vectors || {};
  return {
    name,
    status: res.status,
    optimizer_status: res.optimizer_status,
    points_count: res.points_count || 0,
    indexed_vectors_count: res.indexed_vectors_count || 0,
    segments_count: res.segments_count || 0,
    vector_size: vectors.size || 0,
    vector_distance: vectors.distance || "Cosine",
    payload_schema: res.payload_schema,
  };
}

/** Scroll = pagination par batch ; pas de tri sémantique. */
export async function scrollPoints(
  name: string,
  limit: number = 10,
  offset?: string | number,
): Promise<{ points: QdrantPoint[]; next_offset: string | number | null }> {
  const body: Record<string, unknown> = {
    limit,
    with_payload: true,
    with_vector: false,
  };
  if (offset !== undefined) body.offset = offset;
  const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}/points/scroll`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok) throw new Error(`qdrant_scroll_${r.status}`);
  const j = await r.json();
  return {
    points: j.result?.points || [],
    next_offset: j.result?.next_page_offset || null,
  };
}

export async function searchPoints(
  name: string,
  vector: number[],
  limit: number = 5,
): Promise<QdrantScoredPoint[]> {
  const r = await fetch(`${BASE}/collections/${encodeURIComponent(name)}/points/search`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      vector,
      limit,
      with_payload: true,
      with_vector: false,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`qdrant_search_${r.status}`);
  const j = await r.json();
  return j.result || [];
}

/**
 * Embed un texte avec Ollama bge-m3 (le modèle utilisé par les workers).
 * Renvoie un vecteur 1024-d pour Qdrant search. Endpoint :
 * `POST {OLLAMA_BASE_URL}/api/embeddings { model: "bge-m3", prompt }`.
 */
export async function embedText(text: string): Promise<number[]> {
  const ollama = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const model = process.env.LLM_EMBED || "bge-m3";
  const r = await fetch(`${ollama}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`ollama_embed_${r.status}`);
  const j = await r.json();
  if (!j.embedding || !Array.isArray(j.embedding)) {
    throw new Error("ollama_embed_no_vector");
  }
  return j.embedding;
}
