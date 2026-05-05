/**
 * ConnectorBuilder fluent SDK — déclare un ConnectorSpec en quelques lignes.
 *
 * Pourquoi (P1 #14) : aujourd'hui ajouter un connecteur FR (Cegid, Sage,
 * EBP, Quadratus, MyUnisoft) demande de toucher 6 endroits du code :
 * - lib/connectors.ts (CONNECTOR_CATALOG entry)
 * - lib/oauth-providers.ts (si OAuth)
 * - services/connectors/<slug>/ (worker Python)
 * - tools/migrations/ (parfois, pour register Dify tool)
 * - .env.example (vars d'env)
 * - docs/connectors-howto.md
 *
 * Ce builder factorise la déclaration côté Next.js dans 1 fichier de
 * 30 lignes. Les autres endroits (worker Python, migration) restent à
 * faire séparément mais en TS la duplication est éliminée.
 *
 * Source d'inspiration : AutoGPT `backend/sdk/builder.py +provider.py`
 * (Polyform Shield → réimplémenté depuis l'idée).
 *
 * Usage typique pour ajouter un nouveau connecteur :
 *
 *   // dans lib/connectors-fr.ts ou similaire
 *   export const cegidSpec = defineConnector("cegid")
 *     .withName("Cegid Loop")
 *     .withIcon("📊")
 *     .withCategory("finance")
 *     .withHub("finance")
 *     .withDescription("Comptabilité Cegid Loop — factures, écritures, exports FEC")
 *     .withImplStatus("beta")
 *     .withApiKey({
 *       label: "Clé API Cegid",
 *       helpText: "Settings → API → Generate key",
 *     })
 *     .withField({
 *       key: "tenant_id",
 *       label: "Identifiant tenant",
 *       type: "text",
 *       required: true,
 *     })
 *     .withDocUrl("https://help.cegid.com/api")
 *     .build();
 *
 * Le `.build()` retourne un ConnectorSpec compatible avec lib/connectors.ts.
 */

import type {
  ConnectorCategory,
  ConnectorField,
  ConnectorHub,
  ConnectorImplStatus,
  ConnectorSpec,
} from "@/lib/connectors";

class ConnectorBuilder {
  private spec: Partial<ConnectorSpec>;

  constructor(slug: string) {
    this.spec = {
      slug,
      fields: [],
      implStatus: "coming_soon",
    };
  }

  withName(name: string): this {
    this.spec.name = name;
    return this;
  }

  withIcon(icon: string): this {
    this.spec.icon = icon;
    return this;
  }

  withDescription(description: string): this {
    this.spec.description = description;
    return this;
  }

  withCategory(category: ConnectorCategory): this {
    this.spec.category = category;
    return this;
  }

  withHub(hub: ConnectorHub): this {
    (this.spec as ConnectorSpec & { hub: ConnectorHub }).hub = hub;
    return this;
  }

  withImplStatus(status: ConnectorImplStatus): this {
    this.spec.implStatus = status;
    return this;
  }

  withDocUrl(url: string): this {
    this.spec.docUrl = url;
    return this;
  }

  /**
   * Ajoute un champ form custom. Utiliser les helpers `withApiKey`,
   * `withUsernamePassword`, `withUrl` pour les patterns récurrents.
   */
  withField(field: ConnectorField): this {
    if (!this.spec.fields) this.spec.fields = [];
    this.spec.fields.push(field);
    return this;
  }

  /**
   * Helper : ajoute un champ "API key" classique. Marqué secret=true
   * (jamais retourné dans GET, uniquement à create/update).
   */
  withApiKey(opts?: {
    key?: string;
    label?: string;
    helpText?: string;
    placeholder?: string;
    required?: boolean;
  }): this {
    return this.withField({
      key: opts?.key || "api_key",
      label: opts?.label || "Clé API",
      type: "password",
      required: opts?.required !== false,
      secret: true,
      helpText: opts?.helpText,
      placeholder: opts?.placeholder || "sk-...",
    });
  }

  /**
   * Helper : ajoute username + password (pattern legacy connecteurs FR).
   */
  withUsernamePassword(opts?: {
    usernameLabel?: string;
    passwordLabel?: string;
    helpText?: string;
  }): this {
    this.withField({
      key: "username",
      label: opts?.usernameLabel || "Identifiant",
      type: "text",
      required: true,
      helpText: opts?.helpText,
    });
    this.withField({
      key: "password",
      label: opts?.passwordLabel || "Mot de passe",
      type: "password",
      required: true,
      secret: true,
    });
    return this;
  }

  /**
   * Helper : ajoute une URL d'instance (pour les connecteurs SaaS auto-hébergés).
   */
  withInstanceUrl(opts?: {
    label?: string;
    placeholder?: string;
    helpText?: string;
    required?: boolean;
  }): this {
    return this.withField({
      key: "instance_url",
      label: opts?.label || "URL d'instance",
      type: "url",
      required: opts?.required !== false,
      placeholder: opts?.placeholder || "https://votre-instance.example.com",
      helpText: opts?.helpText,
    });
  }

  /**
   * Helper : marque le connecteur comme OAuth-based, skip les champs
   * required pendant activation, le worker récupère le token via
   * /api/oauth/internal/token.
   */
  withOAuth(provider: "google" | "microsoft"): this {
    this.spec.authMethod =
      provider === "google" ? "google_oauth" : "azure_ad";
    this.spec.oauthProvider = provider;
    return this;
  }

  /**
   * Build final — valide les champs obligatoires et retourne le ConnectorSpec.
   *
   * Throws si un champ critique manque (slug, name, icon, description,
   * category) — détecté au build time, pas au runtime UI.
   */
  build(): ConnectorSpec {
    const errors: string[] = [];
    if (!this.spec.slug) errors.push("slug");
    if (!this.spec.name) errors.push("name");
    if (!this.spec.icon) errors.push("icon");
    if (!this.spec.description) errors.push("description");
    if (!this.spec.category) errors.push("category");
    if (errors.length > 0) {
      throw new Error(
        `ConnectorBuilder(${this.spec.slug || "?"}): missing fields: ${errors.join(", ")}`,
      );
    }
    return this.spec as ConnectorSpec;
  }
}

/**
 * Entrée principale du fluent builder. Retourne un ConnectorBuilder
 * que tu chainable jusqu'à `.build()`.
 *
 * @param slug identifiant URL-safe unique du connecteur (ex: "cegid", "sage-100")
 */
export function defineConnector(slug: string): ConnectorBuilder {
  return new ConnectorBuilder(slug);
}

/**
 * Helpers pré-fabriqués pour les patterns FR récurrents.
 */

/** Pattern logiciel comptable FR avec API key + numéro client. */
export function defineFrenchAccountingConnector(slug: string) {
  return defineConnector(slug)
    .withCategory("finance")
    .withHub("finance")
    .withImplStatus("coming_soon")
    .withApiKey({
      label: "Clé API",
      helpText: "À récupérer dans les paramètres de votre logiciel comptable",
    })
    .withField({
      key: "client_number",
      label: "Numéro client",
      type: "text",
      required: true,
      placeholder: "ABC1234",
      helpText: "Identifiant fourni par l'éditeur lors de l'abonnement",
    });
}

/** Pattern CRM/ERP self-hosted avec URL + token. */
export function defineSelfHostedBusinessConnector(slug: string) {
  return defineConnector(slug)
    .withCategory("erp_crm")
    .withHub("business")
    .withImplStatus("coming_soon")
    .withInstanceUrl({
      label: "URL de votre instance",
      placeholder: "https://crm.votre-entreprise.fr",
    })
    .withApiKey({
      label: "Token API",
      helpText: "Profile → API → Generate token",
    });
}
