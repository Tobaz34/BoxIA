/**
 * BM25 reranker — combine score vectoriel (Qdrant) + score lexical (BM25)
 * pour améliorer la pertinence du RAG.
 *
 * Pourquoi (P2 #12) : Qdrant donne du vector search cosine top-K,
 * excellent pour la similarité sémantique mais peut rater les correspondances
 * exactes sur termes métier rares (« SIRET », « code APE 6201Z », références
 * client style « FAC-2026-001 »). BM25 capture ces correspondances exactes
 * en pondérant par fréquence inverse.
 *
 * Stratégie hybride :
 *   1. Qdrant top-N candidates (N typique 20-30, vs limit 5 demandé par l'user)
 *   2. BM25 score sur les N candidats avec query tokenisée
 *   3. Combinaison : score_final = α * cos_norm + (1-α) * bm25_norm
 *      où cos_norm et bm25_norm sont normalisés [0,1]
 *   4. Top-K final selon score_final
 *
 * Source : AutoGPT `backend/api/features/store/hybrid_search.py:bm25_rerank`
 * (Polyform Shield → réimplémenté depuis l'idée).
 *
 * Pure-TS, zéro dep externe. Approprié pour tailles RAG TPE/PME (<10k
 * chunks par recherche).
 */

const BM25_K1 = 1.5; // saturation TF (1.2-2.0 typique)
const BM25_B = 0.75; // length normalization (0-1, 0.75 typique)

/**
 * Tokenize basique : lowercase, split sur whitespace + ponctuation,
 * retire tokens courts (<2 chars) et stopwords français très fréquents.
 */
const STOPWORDS_FR = new Set([
  "le", "la", "les", "un", "une", "des", "de", "du", "à", "au", "aux",
  "et", "ou", "pour", "par", "sur", "dans", "avec", "sans", "ce", "cette",
  "ces", "il", "elle", "ils", "elles", "on", "nous", "vous", "je", "tu",
  "que", "qui", "quoi", "où", "est", "sont", "était", "étaient", "a", "ai",
  "as", "ont", "avait", "avaient", "se", "sa", "son", "ses", "leur", "leurs",
  "en", "y", "ne", "pas", "plus", "moins", "très", "trop", "mais", "si",
  "alors", "comme", "aussi", "encore", "déjà", "tout", "tous", "toute",
  "toutes", "même", "mêmes", "autre", "autres",
]);

export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // retire accents pour matching robuste
    .split(/[^\w\d_-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS_FR.has(t));
}

export interface ScorableDoc {
  /** ID stable (typiquement UUID Qdrant). */
  id: string | number;
  /** Texte du chunk à scorer en BM25. */
  text: string;
  /** Score vectoriel original Qdrant (cosine 0..1, plus grand = plus pertinent). */
  vector_score: number;
  /** Payload optionnel à propager. */
  payload?: Record<string, unknown>;
}

export interface RerankedDoc extends ScorableDoc {
  /** Score BM25 brut (avant normalisation). */
  bm25_raw: number;
  /** Score BM25 normalisé [0..1]. */
  bm25_norm: number;
  /** Score vectoriel normalisé [0..1]. */
  vector_norm: number;
  /** Score combiné final, utilisé pour le tri. */
  hybrid_score: number;
}

/** Calcule l'IDF (Inverse Document Frequency) pour un terme.
 *  N = nb total docs, df = nb docs contenant le terme. */
function idf(N: number, df: number): number {
  return Math.log(1 + (N - df + 0.5) / (df + 0.5));
}

/**
 * Reranking BM25 sur une liste de candidats (typiquement issus d'une
 * recherche vectorielle Qdrant top-N).
 *
 * @param query  texte query brut user
 * @param candidates docs candidats avec leur score vectoriel
 * @param topK   nb docs à retourner après rerank (défaut = candidates.length)
 * @param alpha poids vectoriel dans la combinaison (0..1, défaut 0.5).
 *              alpha=1.0 → ignore BM25, alpha=0.0 → ignore vector.
 *              0.5 = équilibré. 0.7 = privilégie sémantique.
 */
export function bm25Rerank(
  query: string,
  candidates: ScorableDoc[],
  topK?: number,
  alpha: number = 0.5,
): RerankedDoc[] {
  if (candidates.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) {
    // Pas de tokens utiles → fallback sur vector score pur (pas de BM25)
    return candidates
      .map((c) => ({
        ...c,
        bm25_raw: 0,
        bm25_norm: 0,
        vector_norm: c.vector_score,
        hybrid_score: c.vector_score,
      }))
      .slice(0, topK ?? candidates.length);
  }

  // 1. Tokenize tous les docs et calcule TF par doc
  const docTokens: string[][] = candidates.map((c) => tokenize(c.text));
  const docLengths: number[] = docTokens.map((toks) => toks.length);
  const avgDocLen = docLengths.reduce((a, b) => a + b, 0) / Math.max(1, docLengths.length);

  // 2. Calcule DF (document frequency) cross-corpus
  const df = new Map<string, number>();
  for (const toks of docTokens) {
    const seen = new Set(toks);
    for (const t of seen) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const N = candidates.length;

  // 3. Score BM25 chaque doc
  const bm25Scores: number[] = candidates.map((_, i) => {
    const toks = docTokens[i];
    const docLen = docLengths[i];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);

    let score = 0;
    for (const qt of queryTokens) {
      const tfqt = tf.get(qt) || 0;
      if (tfqt === 0) continue;
      const docDf = df.get(qt) || 0;
      const idfqt = idf(N, docDf);
      const tfNorm =
        (tfqt * (BM25_K1 + 1)) /
        (tfqt + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / Math.max(1, avgDocLen))));
      score += idfqt * tfNorm;
    }
    return score;
  });

  // 4. Normalise BM25 et vector dans [0,1] pour la combinaison
  const bm25Max = Math.max(0, ...bm25Scores);
  const vecMax = Math.max(...candidates.map((c) => c.vector_score), 0);
  const bm25Norms = bm25Scores.map((s) => (bm25Max > 0 ? s / bm25Max : 0));
  const vecNorms = candidates.map((c) => (vecMax > 0 ? c.vector_score / vecMax : 0));

  // 5. Combine + sort + slice
  const reranked: RerankedDoc[] = candidates.map((c, i) => ({
    ...c,
    bm25_raw: bm25Scores[i],
    bm25_norm: bm25Norms[i],
    vector_norm: vecNorms[i],
    hybrid_score: alpha * vecNorms[i] + (1 - alpha) * bm25Norms[i],
  }));
  reranked.sort((a, b) => b.hybrid_score - a.hybrid_score);
  return reranked.slice(0, topK ?? candidates.length);
}

/**
 * Helper qui transforme une réponse Qdrant `searchPoints` en candidats
 * scorables. Extrait le texte depuis `payload.text` (convention BoxIA).
 */
export function qdrantPointsToCandidates(
  points: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>,
): ScorableDoc[] {
  return points
    .map((p) => {
      const text =
        typeof p.payload?.text === "string"
          ? p.payload.text
          : typeof p.payload?.content === "string"
            ? (p.payload.content as string)
            : "";
      return {
        id: p.id,
        text,
        vector_score: p.score,
        payload: p.payload,
      };
    })
    .filter((c) => c.text.length > 0);
}
