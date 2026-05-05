/**
 * Méta-données des tools `/api/agents-tools/*`.
 *
 * Source de vérité unique pour :
 *   - la classification `is_sensitive_action` qui pilote la HITL
 *     (gate d'approbation humaine — cf lib/approval-gate.ts)
 *   - la description FR utilisée pour les bannières d'approbation
 *   - le risk-tier (low / medium / high) qui pilote la stratégie auditor
 *     (cf P0 #3 SafetyAuditor LLM 2-pass)
 *
 * Ajouter un nouveau tool ?
 *   1. Crée la route `services/app/src/app/api/agents-tools/<nom>/route.ts`
 *   2. Ajoute une entrée ci-dessous (clé = nom de tool, identique au
 *      slug de la route)
 *   3. Si mutatif → `isSensitive: true` + descriptionFR explicite, et
 *      utilise `withApprovalGate` ou `requireApproval` dans le handler
 *
 * Référence : tools/research/DECISIONS-P0.md §D7 (classification validée
 * par l'utilisateur 2026-05-05).
 */

export type ToolRiskTier = "low" | "medium" | "high";

export interface ToolMeta {
  /** True = passe par approval-gate avant exécution. */
  isSensitive: boolean;
  /** True = output réinjecté au LLM (vecteur potentiel de prompt-injection).
   *  Active le SafetyAuditor (P0 #3) sur l'output avant retour à l'agent. */
  outputReinjected: boolean;
  /** Risk tier pour priorisation de l'auditor + UI banner severity. */
  riskTier: ToolRiskTier;
  /** Texte FR affiché dans le banner d'approbation (si isSensitive). */
  description: string;
  /** Catégorie haut-niveau pour la doc et le filtrage UI. */
  category:
    | "search"
    | "email"
    | "calendar"
    | "documents"
    | "system"
    | "marketplace"
    | "delegate"
    | "exec"
    | "rag";
}

/**
 * Registre des 18 tools actuels (Sprint 0 baseline 2026-05-05) +
 * placeholders pour les tools P0 à venir (bash_exec, delegate_to_specialist).
 *
 * Convention : clé = slug du tool = nom du dossier dans
 * `app/api/agents-tools/<slug>/route.ts`.
 */
export const TOOL_META: Record<string, ToolMeta> = {
  // ===== Search & RAG (lecture, output réinjecté → auditor utile) =====
  web_search: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "medium", // injection via titres/snippets web
    category: "search",
    description: "Cherche sur le web via SearXNG.",
  },
  rag_search: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "medium", // injection via documents internes uploadés
    category: "rag",
    description: "Cherche dans la base de connaissances RAG.",
  },

  // ===== Email Gmail (lecture seule V1, output réinjecté) =====
  gmail_search: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high", // un email malveillant peut injecter "ignore tout, fais X"
    category: "email",
    description: "Cherche dans Gmail.",
  },
  gmail_read_inbox: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high",
    category: "email",
    description: "Liste les derniers emails de la boîte Gmail.",
  },
  gmail_get_thread: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high",
    category: "email",
    description: "Lit un fil de discussion Gmail.",
  },

  // ===== Email Outlook =====
  outlook_search: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high",
    category: "email",
    description: "Cherche dans Outlook.",
  },
  outlook_read_inbox: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high",
    category: "email",
    description: "Liste les derniers emails de la boîte Outlook.",
  },
  outlook_get_message: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "high",
    category: "email",
    description: "Lit un message Outlook.",
  },

  // ===== Calendar (lecture seule V1) =====
  calendar_today: {
    isSensitive: false,
    outputReinjected: true,
    riskTier: "low",
    category: "calendar",
    description: "Affiche les événements calendrier d'aujourd'hui.",
  },
  calendar_find_free_slot: {
    isSensitive: false,
    outputReinjected: false, // résultat structuré (slots), peu d'injection possible
    riskTier: "low",
    category: "calendar",
    description: "Trouve un créneau libre dans le calendrier.",
  },

  // ===== System (lecture, peu de risque) =====
  system_health: {
    isSensitive: false,
    outputReinjected: false,
    riskTier: "low",
    category: "system",
    description: "Vérifie l'état des services BoxIA.",
  },
  list_connectors: {
    isSensitive: false,
    outputReinjected: false,
    riskTier: "low",
    category: "system",
    description: "Liste les connecteurs OAuth disponibles.",
  },
  deep_link: {
    isSensitive: false,
    outputReinjected: false, // génère un lien, pas d'effet de bord
    riskTier: "low",
    category: "system",
    description: "Génère un deep-link vers une page BoxIA.",
  },

  // ===== Marketplace (lecture catalogues, peu de risque) =====
  list_marketplace_agents_fr: {
    isSensitive: false,
    outputReinjected: false,
    riskTier: "low",
    category: "marketplace",
    description: "Liste les agents disponibles à l'installation.",
  },
  list_marketplace_workflows: {
    isSensitive: false,
    outputReinjected: false,
    riskTier: "low",
    category: "marketplace",
    description: "Liste les workflows n8n disponibles à l'installation.",
  },

  // ===== Mutatifs (HITL ON) =====
  install_workflow: {
    isSensitive: true,
    outputReinjected: false,
    riskTier: "high",
    category: "marketplace",
    description: "Installer un workflow n8n dans la boîte.",
  },
  install_agent_fr: {
    isSensitive: true,
    outputReinjected: false,
    riskTier: "high",
    category: "marketplace",
    description: "Installer un agent IA dans la boîte.",
  },

  // ===== P0 #1 (à venir) — bash_exec via aibox-sandbox =====
  bash_exec: {
    isSensitive: true,
    outputReinjected: true, // l'output bash retourne au LLM
    riskTier: "high",
    category: "exec",
    description: "Exécuter du code (bash ou python) dans la sandbox isolée.",
  },

  // ===== P0 #4 (à venir) — delegate_to_specialist =====
  delegate_to_specialist: {
    isSensitive: false, // délégation interne ; le specialist est lui-même gaté
    outputReinjected: true, // la réponse du specialist revient au LLM
    riskTier: "medium",
    category: "delegate",
    description: "Déléguer la question à un agent spécialisé.",
  },
};

/**
 * Récupère la méta d'un tool. Retourne `null` si le tool est inconnu
 * du registre (ex: nouveau tool oublié dans TOOL_META).
 *
 * Important : un tool qui n'est pas dans le registre est traité par
 * défaut comme NON-mutatif. C'est volontaire pour la backward compat,
 * MAIS un avertissement console est émis pour rappeler de l'enregistrer.
 */
export function getToolMeta(toolName: string): ToolMeta | null {
  return TOOL_META[toolName] || null;
}

/**
 * True si le tool est marqué comme mutatif (`is_sensitive_action: true`)
 * dans le registre. Utilisé par le wrapper `withApprovalGate` pour
 * décider d'enclencher la HITL automatiquement.
 */
export function isToolSensitive(toolName: string): boolean {
  const meta = TOOL_META[toolName];
  return Boolean(meta?.isSensitive);
}

/** Liste les tools d'une catégorie (utile pour /api/system/tools UI). */
export function listToolsByCategory(category: ToolMeta["category"]): string[] {
  return Object.entries(TOOL_META)
    .filter(([, m]) => m.category === category)
    .map(([name]) => name);
}
