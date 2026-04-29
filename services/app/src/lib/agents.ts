/**
 * Registre des agents disponibles dans l'AI Box.
 *
 * Chaque agent correspond à une "App" Dify créée par le provisioning et
 * possède sa propre clé API (lue depuis une variable d'env). Si la clé
 * n'est pas définie au runtime, l'agent est considéré comme indisponible
 * (filtré côté UI). Cela rend la liste pilotable par .env sans modifier
 * le code : on peut désactiver un agent en supprimant sa clé.
 *
 * Pour ajouter un agent :
 *   1. Créer une AgentConfig ici
 *   2. Ajouter le pre_prompt + opening_statement côté provisioning
 *      (services/setup/app/sso_provisioning.py → DEFAULT_AGENTS)
 *   3. Ajouter ${DIFY_AGENT_<SLUG>_API_KEY:-} dans
 *      services/app/docker-compose.yml
 */
export interface AgentConfig {
  /** Identifiant URL-safe utilisé dans les API et le state. */
  slug: string;
  /** Nom affiché dans le picker. */
  name: string;
  /** Emoji ou caractère affiché à côté du nom. */
  icon: string;
  /** Sous-titre court (1 ligne) affiché dans le picker. */
  description: string;
  /** Variable d'env qui contient la clé API Dify de cet agent. */
  envVar: string;
  /** Si vrai, agent sélectionné par défaut au 1er chargement. */
  isDefault?: boolean;
}

export const AGENTS: Record<string, AgentConfig> = {
  general: {
    slug: "general",
    name: "Assistant général",
    icon: "🤖",
    description: "Pour toutes vos questions du quotidien",
    envVar: "DIFY_DEFAULT_APP_API_KEY",
    isDefault: true,
  },
  accountant: {
    slug: "accountant",
    name: "Assistant comptable",
    icon: "📊",
    description: "Devis, factures, TVA, comptabilité",
    envVar: "DIFY_AGENT_ACCOUNTANT_API_KEY",
  },
  hr: {
    slug: "hr",
    name: "Assistant RH",
    icon: "👥",
    description: "Congés, contrats, droit du travail",
    envVar: "DIFY_AGENT_HR_API_KEY",
  },
  support: {
    slug: "support",
    name: "Support clients",
    icon: "🎧",
    description: "Réponses commerciales, ton client",
    envVar: "DIFY_AGENT_SUPPORT_API_KEY",
  },
};

/** Métadonnées publiques (sans clé API) — sûr à exposer côté client. */
export type PublicAgentMeta = Omit<AgentConfig, "envVar"> & { available: boolean };

/** Liste les agents disponibles (clé env définie) pour exposition au client. */
export function listAvailableAgents(): PublicAgentMeta[] {
  const items: PublicAgentMeta[] = [];
  for (const a of Object.values(AGENTS)) {
    const available = !!process.env[a.envVar];
    if (available) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { envVar: _envVar, ...meta } = a;
      items.push({ ...meta, available });
    }
  }
  // Met le default en tête, puis ordre d'insertion
  items.sort((x, y) => (x.isDefault ? -1 : 0) - (y.isDefault ? -1 : 0));
  return items;
}

/** Récupère la clé API d'un agent par slug. Retourne null si indisponible. */
export function getAgentKey(slug: string): string | null {
  const a = AGENTS[slug];
  if (!a) return null;
  return process.env[a.envVar] || null;
}

/** Retourne le slug par défaut (le 1er disponible avec isDefault=true,
 *  sinon le 1er disponible tout court). */
export function defaultAgentSlug(): string | null {
  const list = listAvailableAgents();
  const def = list.find((a) => a.isDefault);
  return def?.slug || list[0]?.slug || null;
}
