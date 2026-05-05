/**
 * Tests unitaires — lib/bm25-reranker.ts (P2 #12).
 *
 * Couvre :
 * - tokenize : lowercase, retire stopwords FR, retire accents, split sur ponctuation
 * - bm25Rerank : ordering correct (correspondance exacte > vague)
 * - Combinaison alpha (vector vs BM25)
 * - Edge cases : query vide, candidates vide, alpha 0/1
 */
import { describe, expect, it } from "vitest";
import { tokenize, bm25Rerank, type ScorableDoc } from "./bm25-reranker";

describe("tokenize", () => {
  it("lowercase + split simple", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  it("retire stopwords FR", () => {
    const t = tokenize("Le contrat de Pinacle est dans le tiroir");
    expect(t).not.toContain("le");
    expect(t).not.toContain("de");
    expect(t).not.toContain("est");
    expect(t).not.toContain("dans");
    expect(t).toContain("contrat");
    expect(t).toContain("pinacle");
    expect(t).toContain("tiroir");
  });

  it("retire les tokens courts <2 chars", () => {
    const t = tokenize("a b cd ef");
    expect(t).toEqual(["cd", "ef"]);
  });

  it("normalise les accents (é → e)", () => {
    expect(tokenize("réponse")).toEqual(["reponse"]);
    expect(tokenize("événement")).toEqual(["evenement"]);
    expect(tokenize("à propos")).not.toContain("à");
  });

  it("split sur ponctuation", () => {
    expect(tokenize("ABC-123, FAC-2026")).toEqual([
      "abc-123",
      "fac-2026",
    ]);
  });

  it("retourne [] sur input vide", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("bm25Rerank", () => {
  const docs: ScorableDoc[] = [
    {
      id: "a",
      text: "Cette facture concerne le client SIRET 123 456 789 pour 2026",
      vector_score: 0.6,
    },
    {
      id: "b",
      text: "Procédure de comptabilité française et auto-liquidation TVA",
      vector_score: 0.8,
    },
    {
      id: "c",
      text: "Le SIRET est l'identifiant unique des entreprises françaises",
      vector_score: 0.5,
    },
  ];

  it("query exacte 'SIRET' boost les docs qui le contiennent", () => {
    const r = bm25Rerank("SIRET", docs);
    // Les docs A et C contiennent SIRET, B non. Donc A ou C en premier.
    expect(["a", "c"]).toContain(r[0].id);
    expect(r[r.length - 1].id).toBe("b");
  });

  it("alpha=1.0 → fallback pure vector (B en premier car score 0.8)", () => {
    const r = bm25Rerank("SIRET", docs, undefined, 1.0);
    expect(r[0].id).toBe("b");
  });

  it("alpha=0.0 → pure BM25 (les docs avec SIRET en premier)", () => {
    const r = bm25Rerank("SIRET", docs, undefined, 0.0);
    expect(["a", "c"]).toContain(r[0].id);
  });

  it("query stopwords-only → fallback vector", () => {
    const r = bm25Rerank("le et de la", docs);
    // Pas de tokens utiles → bm25_norm = 0 sur tous → tri par vector_score
    expect(r[0].id).toBe("b"); // 0.8
    expect(r[r.length - 1].id).toBe("c"); // 0.5
  });

  it("topK limite la sortie", () => {
    const r = bm25Rerank("facture", docs, 2);
    expect(r.length).toBeLessThanOrEqual(2);
  });

  it("expose bm25_raw, bm25_norm, vector_norm, hybrid_score", () => {
    const r = bm25Rerank("SIRET", docs);
    for (const d of r) {
      expect(d.bm25_raw).toBeGreaterThanOrEqual(0);
      expect(d.bm25_norm).toBeGreaterThanOrEqual(0);
      expect(d.bm25_norm).toBeLessThanOrEqual(1);
      expect(d.vector_norm).toBeGreaterThanOrEqual(0);
      expect(d.vector_norm).toBeLessThanOrEqual(1);
      expect(d.hybrid_score).toBeGreaterThanOrEqual(0);
      expect(d.hybrid_score).toBeLessThanOrEqual(1);
    }
  });

  it("candidates vide → []", () => {
    expect(bm25Rerank("anything", [])).toEqual([]);
  });
});
