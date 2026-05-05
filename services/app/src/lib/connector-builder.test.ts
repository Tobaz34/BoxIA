/**
 * Tests unitaires — lib/connector-builder.ts (P1 #14).
 *
 * Couvre :
 * - Build minimal valide
 * - Throw sur fields obligatoires manquants
 * - Helpers withApiKey / withUsernamePassword / withInstanceUrl / withOAuth
 * - Helpers pré-fabriqués defineFrenchAccountingConnector / defineSelfHostedBusinessConnector
 */
import { describe, expect, it } from "vitest";
import {
  defineConnector,
  defineFrenchAccountingConnector,
  defineSelfHostedBusinessConnector,
} from "./connector-builder";

describe("defineConnector — build minimal", () => {
  it("build avec tous les champs obligatoires", () => {
    const spec = defineConnector("test")
      .withName("Test")
      .withIcon("🧪")
      .withDescription("Test")
      .withCategory("storage")
      .build();
    expect(spec.slug).toBe("test");
    expect(spec.name).toBe("Test");
    expect(spec.implStatus).toBe("coming_soon"); // default
    expect(spec.fields).toEqual([]);
  });

  it("throw si name manquant", () => {
    expect(() =>
      defineConnector("test")
        .withIcon("🧪")
        .withDescription("d")
        .withCategory("storage")
        .build(),
    ).toThrow(/missing fields.*name/);
  });

  it("throw si description manquante", () => {
    expect(() =>
      defineConnector("test")
        .withName("Test")
        .withIcon("🧪")
        .withCategory("storage")
        .build(),
    ).toThrow(/missing fields.*description/);
  });

  it("liste tous les champs manquants dans l'erreur", () => {
    expect(() => defineConnector("test").build()).toThrow(
      /missing fields:.*name.*icon.*description.*category/,
    );
  });
});

describe("defineConnector — helpers fluent", () => {
  it("withApiKey ajoute un field 'api_key' secret type password", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withApiKey()
      .build();
    expect(spec.fields).toHaveLength(1);
    expect(spec.fields[0].key).toBe("api_key");
    expect(spec.fields[0].secret).toBe(true);
    expect(spec.fields[0].type).toBe("password");
  });

  it("withApiKey override key/label/placeholder", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withApiKey({ key: "token", label: "Mon token" })
      .build();
    expect(spec.fields[0].key).toBe("token");
    expect(spec.fields[0].label).toBe("Mon token");
  });

  it("withUsernamePassword ajoute 2 fields", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withUsernamePassword()
      .build();
    expect(spec.fields).toHaveLength(2);
    expect(spec.fields[0].key).toBe("username");
    expect(spec.fields[1].key).toBe("password");
    expect(spec.fields[1].secret).toBe(true);
  });

  it("withInstanceUrl ajoute un field type url required", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withInstanceUrl()
      .build();
    expect(spec.fields[0].key).toBe("instance_url");
    expect(spec.fields[0].type).toBe("url");
    expect(spec.fields[0].required).toBe(true);
  });

  it("withOAuth('google') set authMethod=google_oauth + oauthProvider", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withOAuth("google")
      .build();
    expect(spec.authMethod).toBe("google_oauth");
    expect(spec.oauthProvider).toBe("google");
  });

  it("withOAuth('microsoft') set authMethod=azure_ad", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withOAuth("microsoft")
      .build();
    expect(spec.authMethod).toBe("azure_ad");
    expect(spec.oauthProvider).toBe("microsoft");
  });

  it("chainable : multiple withField empilés", () => {
    const spec = defineConnector("t")
      .withName("T")
      .withIcon("x")
      .withDescription("d")
      .withCategory("storage")
      .withField({ key: "a", label: "A", type: "text" })
      .withField({ key: "b", label: "B", type: "url" })
      .withApiKey()
      .build();
    expect(spec.fields).toHaveLength(3);
    expect(spec.fields[0].key).toBe("a");
    expect(spec.fields[2].key).toBe("api_key");
  });
});

describe("defineFrenchAccountingConnector", () => {
  it("template prêt avec api_key + client_number", () => {
    const spec = defineFrenchAccountingConnector("acme")
      .withName("Acme Compta")
      .withIcon("📊")
      .withDescription("Compta Acme")
      .build();
    expect(spec.category).toBe("finance");
    expect(spec.fields.find((f) => f.key === "api_key")).toBeDefined();
    expect(spec.fields.find((f) => f.key === "client_number")).toBeDefined();
  });
});

describe("defineSelfHostedBusinessConnector", () => {
  it("template avec instance_url + api_key", () => {
    const spec = defineSelfHostedBusinessConnector("acme-crm")
      .withName("Acme CRM")
      .withIcon("🏢")
      .withDescription("CRM auto-hébergé")
      .build();
    expect(spec.category).toBe("erp_crm");
    expect(spec.fields.find((f) => f.key === "instance_url")).toBeDefined();
    expect(spec.fields.find((f) => f.key === "api_key")).toBeDefined();
  });
});
