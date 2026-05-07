/**
 * Tests unitaires — lib/strip-think.ts (P2 #11).
 *
 * Couvre :
 * - Strip simple <think>...</think>
 * - Strip <thinking>...</thinking>
 * - Multi-tags : internal_reasoning, reasoning, reflection, scratchpad
 * - Depth counter (nested tags)
 * - Cross-chunk safety (TAIL_GUARD)
 * - Stream non-fermé → drop dans flush
 * - stripReactArtifacts : préfixes Action/Thought/Observation
 */
import { describe, expect, it } from "vitest";
import { ThinkStripper, stripReactArtifacts } from "./strip-think";

describe("ThinkStripper — strip simple", () => {
  it("retire <think>...</think> en un seul push", () => {
    const s = new ThinkStripper();
    const out = s.push("Bonjour <think>réflexion</think> monde");
    expect(out).toBe("Bonjour  monde");
  });

  it("retire <thinking>...</thinking>", () => {
    const s = new ThinkStripper();
    const out = s.push("A <thinking>x</thinking> B");
    expect(out).toBe("A  B");
  });

  it("préserve le texte hors think", () => {
    const s = new ThinkStripper();
    const out = s.push("Réponse complète sans think");
    expect(out).toBe("Réponse complète sans think");
  });
});

describe("ThinkStripper — multi-tags variants", () => {
  it("strip <internal_reasoning>", () => {
    const s = new ThinkStripper();
    const out = s.push("a <internal_reasoning>foo</internal_reasoning> b");
    expect(out).toBe("a  b");
  });

  it("strip <reasoning>", () => {
    const s = new ThinkStripper();
    const out = s.push("a <reasoning>foo</reasoning> b");
    expect(out).toBe("a  b");
  });

  it("strip <reflection>", () => {
    const s = new ThinkStripper();
    const out = s.push("a <reflection>foo</reflection> b");
    expect(out).toBe("a  b");
  });

  it("strip <scratchpad>", () => {
    const s = new ThinkStripper();
    const out = s.push("a <scratchpad>foo</scratchpad> b");
    expect(out).toBe("a  b");
  });

  it("strip <scratch_pad> (snake_case variante)", () => {
    const s = new ThinkStripper();
    const out = s.push("a <scratch_pad>foo</scratch_pad> b");
    expect(out).toBe("a  b");
  });
});

describe("ThinkStripper — depth counter (nesting)", () => {
  it("nested <think><think>...</think></think> entièrement strippé", () => {
    const s = new ThinkStripper();
    const out = s.push("A <think>outer<think>inner</think>still_outer</think> B");
    expect(out).toBe("A  B");
    expect(s.inThink).toBe(false);
  });

  it("close partielle ne quitte pas le think si depth > 1", () => {
    const s = new ThinkStripper();
    s.push("<think><think>");
    expect(s.inThink).toBe(true);
    s.push("inner</think>");
    expect(s.inThink).toBe(true); // depth = 1 still
    const out = s.push("more</think>");
    expect(s.inThink).toBe(false);
    expect(out).toBe("");
  });
});

describe("ThinkStripper — cross-chunk", () => {
  it("tag coupé en 2 chunks détecté correctement", () => {
    const s = new ThinkStripper();
    s.push("Avant <thi");
    const out = s.push("nk>foo</think> Après");
    // Le "Avant " a déjà été émis (potentiellement en partie),
    // on attend "Avant " (et le reste) à la fin
    const o2 = s.flush();
    expect((out + o2).replace(/\s+/g, " ").trim()).toBe("Avant Après");
  });

  it("close </internal_reasoning> long correctement détecté cross-chunk", () => {
    const s = new ThinkStripper();
    const out1 = s.push("X <internal_reasoning>foo</internal_re");
    const out2 = s.push("asoning> Y");
    expect((out1 + out2).replace(/\s+/g, " ").trim()).toBe("X Y");
  });
});

describe("ThinkStripper — stream non-fermé", () => {
  it("<think> sans </think> → drop dans flush", () => {
    const s = new ThinkStripper();
    s.push("Avant <think>raisonnement coupé...");
    expect(s.inThink).toBe(true);
    const tail = s.flush();
    expect(tail).toBe("");
    expect(s.inThink).toBe(false);
  });
});

describe("stripReactArtifacts", () => {
  it("retire 'Action: ...' en début de ligne", () => {
    expect(stripReactArtifacts("Action: clic")).toBe("clic");
  });

  it("retire 'Thought: ...' en début de ligne", () => {
    expect(stripReactArtifacts("Thought: je pense que")).toBe("je pense que");
  });

  it("retire 'Action Input: ...' en début de ligne", () => {
    expect(stripReactArtifacts("Action Input: {x:1}")).toBe("{x:1}");
  });

  it("ne touche pas un texte FR sans préfixe ReAct", () => {
    expect(stripReactArtifacts("Mon action est claire")).toBe("Mon action est claire");
  });

  it("retire sur multi-lignes", () => {
    const out = stripReactArtifacts("Thought: A\nAction: B\nObservation: C");
    expect(out).toContain("A\n");
    expect(out).toContain("B\n");
    expect(out).toContain("C");
    expect(out).not.toContain("Thought:");
    expect(out).not.toContain("Action:");
    expect(out).not.toContain("Observation:");
  });
});
