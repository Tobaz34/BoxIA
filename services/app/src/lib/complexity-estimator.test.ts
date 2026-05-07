/**
 * Tests unitaires — lib/complexity-estimator.ts (P0 #5).
 *
 * Couvre :
 * - LOW override sur salutations / questions triviales
 * - Détection HIGH sur verbes chaînés (puis, ensuite, et après)
 * - Détection HIGH sur mentions multi-connecteurs
 * - Détection HIGH sur verbes mutatifs
 * - Zone grise → LOW par défaut
 * - signals retournés correctement (debug + observabilité)
 */
import { describe, expect, it } from "vitest";
import { estimateComplexity } from "./complexity-estimator";

describe("estimateComplexity — LOW overrides", () => {
  it("salutations courtes → low score 0", () => {
    expect(estimateComplexity("Bonjour").complexity).toBe("low");
    expect(estimateComplexity("Bonjour").score).toBe(0);
    expect(estimateComplexity("Hello").complexity).toBe("low");
    expect(estimateComplexity("Salut").complexity).toBe("low");
    expect(estimateComplexity("Merci").complexity).toBe("low");
  });

  it("questions triviales → low", () => {
    expect(estimateComplexity("Quelle heure est-il ?").complexity).toBe("low");
    expect(estimateComplexity("Comment ça va").complexity).toBe("low");
  });

  it("question vide → low score 0", () => {
    expect(estimateComplexity("").complexity).toBe("low");
    expect(estimateComplexity("   ").complexity).toBe("low");
  });
});

describe("estimateComplexity — HIGH triggers", () => {
  it("verbe chaîné 'puis' → HIGH", () => {
    const r = estimateComplexity(
      "Cherche la facture 2024 dans Pennylane puis envoie-la par mail"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals).toContain("chain_puis");
  });

  it("verbe chaîné 'ensuite' → HIGH", () => {
    const r = estimateComplexity(
      "Lis mes 10 derniers emails Outlook ensuite résume-les"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals).toContain("chain_puis");
  });

  it("plusieurs connecteurs mentionnés → HIGH", () => {
    const r = estimateComplexity(
      "Compare mes factures Pennylane avec mes virements Outlook et Drive"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals.some((s) => s.startsWith("mention_"))).toBe(true);
  });

  it("verbe mutatif 'envoie' → HIGH", () => {
    const r = estimateComplexity(
      "Envoie un mail de relance à mes clients impayés"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals).toContain("verb_send");
  });

  it("verbe mutatif 'installe' → HIGH", () => {
    const r = estimateComplexity(
      "Installe le workflow de tri des factures fournisseurs"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals).toContain("verb_install");
  });

  it("conditionnel 'si ... alors' → score boosté", () => {
    const r = estimateComplexity(
      "Si la facture est impayée depuis 30 jours alors envoie une relance"
    );
    expect(r.complexity).toBe("high");
    expect(r.signals).toContain("conditional");
  });
});

describe("estimateComplexity — zone grise", () => {
  it("question sémantique simple sans mots-clés → low", () => {
    const r = estimateComplexity(
      "Explique-moi la différence entre TVA collectée et déductible"
    );
    expect(r.complexity).toBe("low");
  });

  it("résumé doc seul → low", () => {
    expect(estimateComplexity("Résume ce document").complexity).toBe("low");
  });
});

describe("estimateComplexity — signals retournés", () => {
  it("expose tous les signals matchés pour debug", () => {
    const r = estimateComplexity(
      "Cherche les factures impayées dans Pennylane puis envoie un mail Outlook"
    );
    expect(r.signals.length).toBeGreaterThan(2);
    expect(r.score).toBeGreaterThan(25);
  });
});
