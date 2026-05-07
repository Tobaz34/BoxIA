/**
 * Tests unitaires — lib/tool-meta.ts (Sprint 1 P0 #2 — D7).
 *
 * Garde-fous : si un dev ajoute un nouveau tool sans le déclarer dans
 * TOOL_META, ce test casse au CI. C'est le but : forcer la classification
 * is_sensitive_action explicite (cf D7 décision validée).
 */
import { describe, expect, it } from "vitest";
import { TOOL_META, getToolMeta, isToolSensitive, listToolsByCategory } from "./tool-meta";

describe("TOOL_META — couverture des 20 tools attendus", () => {
  // Liste source de vérité 2026-05-05 — synchroniser avec le filesystem
  // services/app/src/app/api/agents-tools/<slug>/. Si un slug est ajouté
  // ou supprimé : update aussi TOOL_META.
  const expectedTools = [
    "web_search",
    "rag_search",
    "gmail_search",
    "gmail_read_inbox",
    "gmail_get_thread",
    "outlook_search",
    "outlook_read_inbox",
    "outlook_get_message",
    "calendar_today",
    "calendar_find_free_slot",
    "system_health",
    "list_connectors",
    "list_marketplace_agents_fr",
    "list_marketplace_workflows",
    "deep_link",
    "install_workflow",
    "install_agent_fr",
    "bash_exec",
    "delegate_to_specialist",
  ];

  for (const t of expectedTools) {
    it(`tool '${t}' déclaré dans TOOL_META`, () => {
      expect(TOOL_META[t]).toBeDefined();
      expect(TOOL_META[t].description.length).toBeGreaterThan(5);
      expect(TOOL_META[t].category).toBeDefined();
    });
  }
});

describe("TOOL_META — classification D7 (is_sensitive_action)", () => {
  it("install_workflow est sensitive=true", () => {
    expect(isToolSensitive("install_workflow")).toBe(true);
  });

  it("install_agent_fr est sensitive=true", () => {
    expect(isToolSensitive("install_agent_fr")).toBe(true);
  });

  it("bash_exec est sensitive=true (P0 #1 future)", () => {
    expect(isToolSensitive("bash_exec")).toBe(true);
  });

  it("delegate_to_specialist NOT sensitive (lecture seule, le specialist est lui-même gaté)", () => {
    expect(isToolSensitive("delegate_to_specialist")).toBe(false);
  });

  it("tools de lecture pure NOT sensitive", () => {
    expect(isToolSensitive("web_search")).toBe(false);
    expect(isToolSensitive("rag_search")).toBe(false);
    expect(isToolSensitive("gmail_search")).toBe(false);
    expect(isToolSensitive("calendar_today")).toBe(false);
    expect(isToolSensitive("system_health")).toBe(false);
  });
});

describe("TOOL_META — outputReinjected (active SafetyAuditor P0 #3)", () => {
  it("gmail_* outputReinjected=true (vecteur injection email malveillant)", () => {
    expect(TOOL_META.gmail_search.outputReinjected).toBe(true);
    expect(TOOL_META.gmail_read_inbox.outputReinjected).toBe(true);
    expect(TOOL_META.gmail_get_thread.outputReinjected).toBe(true);
  });

  it("outlook_* outputReinjected=true (idem Gmail)", () => {
    expect(TOOL_META.outlook_search.outputReinjected).toBe(true);
    expect(TOOL_META.outlook_read_inbox.outputReinjected).toBe(true);
  });

  it("rag_search outputReinjected=true (docs internes potentiellement malveillants)", () => {
    expect(TOOL_META.rag_search.outputReinjected).toBe(true);
  });

  it("system_health outputReinjected=false (status structuré, peu de risque)", () => {
    expect(TOOL_META.system_health.outputReinjected).toBe(false);
  });

  it("deep_link outputReinjected=false (génère un lien)", () => {
    expect(TOOL_META.deep_link.outputReinjected).toBe(false);
  });
});

describe("TOOL_META — riskTier", () => {
  it("email tools = high (vecteur injection émail malveillant fort)", () => {
    expect(TOOL_META.gmail_search.riskTier).toBe("high");
    expect(TOOL_META.outlook_search.riskTier).toBe("high");
  });

  it("install_* + bash_exec = high (mutation système)", () => {
    expect(TOOL_META.install_workflow.riskTier).toBe("high");
    expect(TOOL_META.install_agent_fr.riskTier).toBe("high");
    expect(TOOL_META.bash_exec.riskTier).toBe("high");
  });

  it("system tools = low", () => {
    expect(TOOL_META.system_health.riskTier).toBe("low");
    expect(TOOL_META.calendar_today.riskTier).toBe("low");
  });
});

describe("getToolMeta", () => {
  it("retourne null pour tool inconnu", () => {
    expect(getToolMeta("nonexistent_tool")).toBeNull();
  });

  it("retourne meta pour tool connu", () => {
    expect(getToolMeta("web_search")).not.toBeNull();
  });
});

describe("listToolsByCategory", () => {
  it("category 'email' contient gmail + outlook", () => {
    const tools = listToolsByCategory("email");
    expect(tools).toContain("gmail_search");
    expect(tools).toContain("outlook_search");
  });

  it("category 'marketplace' contient les install_*", () => {
    const tools = listToolsByCategory("marketplace");
    expect(tools).toContain("install_workflow");
    expect(tools).toContain("install_agent_fr");
  });

  it("category 'exec' contient bash_exec", () => {
    expect(listToolsByCategory("exec")).toContain("bash_exec");
  });

  it("category 'delegate' contient delegate_to_specialist", () => {
    expect(listToolsByCategory("delegate")).toContain("delegate_to_specialist");
  });
});
