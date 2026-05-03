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
export type AgentRole = "admin" | "manager" | "employee";

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
  /** Rôles autorisés à utiliser cet agent.
   *  undefined ou liste vide = ouvert à tous les utilisateurs authentifiés. */
  allowedRoles?: AgentRole[];
  /** Si vrai, l'agent utilise un modèle multimodal (vision). L'UI affiche
   *  alors le bouton "joindre image". Sur un modèle non-vision, Dify
   *  remplace silencieusement l'image par un placeholder texte ce qui
   *  donne une UX cassée — d'où ce flag. */
  vision?: boolean;
  /** Phrase d'accroche affichée quand l'utilisateur ouvre une nouvelle
   *  conversation avec cet agent. Si absent, le `description` est utilisé. */
  openingStatement?: string;
  /** Suggestions de questions affichées en grille au-dessus de la zone
   *  d'input pour une nouvelle conversation. Doivent être adaptées au
   *  domaine fonctionnel de l'agent. 4 max recommandé pour l'UX. */
  suggestedQuestions?: string[];
}

export const AGENTS: Record<string, AgentConfig> = {
  general: {
    slug: "general",
    name: "Assistant général",
    icon: "🤖",
    description: "Pour toutes vos questions du quotidien",
    envVar: "DIFY_DEFAULT_APP_API_KEY",
    isDefault: true,
    // CHANGÉ 2026-05-01 : passé sur qwen3:14b text-only (vs qwen2.5vl
    // historique). qwen2.5vl répond ultra-sec sur prompts factuels
    // simples ("Capitale FR ?" → "Paris" en 5 chars). Pour l'analyse
    // d'images, utiliser l'« Assistant vision » dédié ci-dessous.
    vision: false,
    openingStatement:
      "Bonjour ! Je suis votre assistant général. Posez-moi une question, " +
      "joignez un document texte (PDF, DOCX), ou utilisez le micro pour me dicter. " +
      "Pour analyser une image, choisissez plutôt l'Assistant vision.",
    suggestedQuestions: [
      "Résume-moi les derniers documents ajoutés",
      "Aide-moi à rédiger un email professionnel",
      "Explique-moi le bilan d'une entreprise en 5 points",
      "Quelle est la procédure de demande de congés ?",
    ],
  },
  vision: {
    slug: "vision",
    name: "Assistant vision",
    icon: "👁",
    description: "Analyse d'images, captures, schémas",
    envVar: "DIFY_AGENT_VISION_API_KEY",
    vision: true,  // qwen2.5vl:7b — comprend les images
    openingStatement:
      "👁 Salut ! Je suis spécialisé dans l'analyse d'images et de documents " +
      "visuels. Joins une capture d'écran (Ctrl+V), une photo, ou un PDF avec " +
      "schémas, et je l'analyse pour toi.",
    suggestedQuestions: [
      "Décris cette image et ses éléments clés",
      "Extrais le texte de cette capture (OCR)",
      "Convertis ce tableau visuel en données structurées",
      "Analyse ce schéma d'architecture",
    ],
  },
  accountant: {
    slug: "accountant",
    name: "Assistant comptable",
    icon: "📊",
    description: "Devis, factures, TVA, comptabilité",
    envVar: "DIFY_AGENT_ACCOUNTANT_API_KEY",
    allowedRoles: ["admin", "manager"],
    openingStatement:
      "Bonjour ! Je suis spécialisé en comptabilité française : TVA, " +
      "devis, factures, déclarations. Que puis-je faire pour vous ?",
    suggestedQuestions: [
      "Quel taux de TVA pour la restauration sur place ?",
      "Génère-moi un modèle de devis pour un client SARL",
      "Comment gérer l'auto-liquidation TVA pour un achat US ?",
      "Quels sont les seuils du régime simplifié 2026 ?",
    ],
  },
  hr: {
    slug: "hr",
    name: "Assistant RH",
    icon: "👥",
    description: "Congés, contrats, droit du travail",
    envVar: "DIFY_AGENT_HR_API_KEY",
    allowedRoles: ["admin", "manager"],
    openingStatement:
      "Bonjour ! Je suis votre référent RH : congés, contrats, droit " +
      "du travail français. Comment puis-je vous aider ?",
    suggestedQuestions: [
      "Quelle est la procédure pour poser des congés ?",
      "Modèle de contrat CDI cadre, période d'essai 4 mois",
      "Calcule l'indemnité de licenciement pour 5 ans d'ancienneté",
      "Combien de jours de congés payés pour un mi-temps ?",
    ],
  },
  support: {
    slug: "support",
    name: "Support clients",
    icon: "🎧",
    description: "Réponses commerciales, ton client",
    envVar: "DIFY_AGENT_SUPPORT_API_KEY",
    openingStatement:
      "Bonjour ! Je vous aide à rédiger des réponses clients : ton " +
      "professionnel, empathique, structuré.",
    suggestedQuestions: [
      "Réponds à un client qui se plaint d'un retard de livraison",
      "Rédige un mail de relance après devis sans réponse depuis 15 jours",
      "Comment annoncer une augmentation de tarif à un client fidèle ?",
      "Réponds à un avis Google négatif (3 étoiles, livraison)",
    ],
  },
  // Concierge BoxIA — agent IA orchestrateur qui pilote l'admin (active
  // connecteurs, installe workflows/agents, vérifie healthcheck) via le
  // Custom Tool « BoxIA Concierge Tools » attaché côté Dify. Le client
  // utilise ce concierge pour configurer SA box en langage naturel,
  // sans avoir à naviguer dans /connectors, /workflows, /integrations/mcp.
  concierge: {
    slug: "concierge",
    name: "Concierge AI Box",
    icon: "🛎️",
    description: "Configure votre AI Box en langage naturel — connecteurs, workflows, MCP, sans paramétrage manuel",
    envVar: "DIFY_AGENT_CONCIERGE_API_KEY",
    openingStatement:
      "🛎️ Bonjour ! Je suis votre Concierge AI Box. Je peux configurer votre " +
      "box pour vous : connecter vos données (Outlook, Drive, Pennylane…), " +
      "installer des workflows d'automatisation, ajouter des assistants " +
      "spécialisés. Dites-moi ce que vous voulez faire en français naturel.",
    suggestedQuestions: [
      "Tu peux automatiser ma comptabilité ?",
      "Quels assistants français sont disponibles ?",
      "Connecte mon NAS pour indexer les documents partagés",
      "Tout fonctionne bien dans la box ?",
    ],
    // Concierge réservé aux admins — il peut INSTALLER des workflows et
    // des agents, donc seul l'admin doit pouvoir l'utiliser.
    allowedRoles: ["admin"],
  },
};

/** Métadonnées publiques (sans clé API) — sûr à exposer côté client. */
export type PublicAgentMeta = Omit<AgentConfig, "envVar"> & {
  available: boolean;
  /** True si l'agent provient de la marketplace (installé dynamiquement). */
  installed?: boolean;
};

/** Liste les agents STATIQUES (hardcodés) — synchrone, sans IO. */
export function listAvailableAgents(role?: AgentRole | null): PublicAgentMeta[] {
  const items: PublicAgentMeta[] = [];
  for (const a of Object.values(AGENTS)) {
    const available = !!process.env[a.envVar];
    if (!available) continue;
    if (a.allowedRoles && a.allowedRoles.length && role &&
        !a.allowedRoles.includes(role)) {
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { envVar: _envVar, ...meta } = a;
    items.push({ ...meta, available });
  }
  items.sort((x, y) => (x.isDefault ? -1 : 0) - (y.isDefault ? -1 : 0));
  return items;
}

/** Liste TOUS les agents disponibles : statiques + installés via marketplace.
 *  Async car lit le fichier JSON. À utiliser dans les API routes. */
export async function listAllAvailableAgents(role?: AgentRole | null): Promise<PublicAgentMeta[]> {
  const staticAgents = listAvailableAgents(role);
  // Lazy import — installed-agents lit le filesystem
  const { listInstalledAgents } = await import("@/lib/installed-agents");
  const installed = await listInstalledAgents();
  const dyn: PublicAgentMeta[] = installed
    .filter((a) => {
      if (!a.allowed_roles || a.allowed_roles.length === 0) return true;
      if (!role) return true;
      return a.allowed_roles.includes(role);
    })
    .map((a) => ({
      slug: a.slug,
      name: a.name,
      icon: a.icon,
      description: a.description || "Agent installé depuis la marketplace",
      isDefault: false,
      vision: false,
      allowedRoles: a.allowed_roles,
      installed: true,
      available: true,
    }));
  return [...staticAgents, ...dyn];
}

/** Vérifie qu'un rôle a le droit d'utiliser un agent (statique ou dynamique). */
export async function canUseAgent(slug: string, role: AgentRole): Promise<boolean> {
  const a = AGENTS[slug];
  if (a) {
    if (!a.allowedRoles || a.allowedRoles.length === 0) return true;
    return a.allowedRoles.includes(role);
  }
  const { getInstalledAgent } = await import("@/lib/installed-agents");
  const dyn = await getInstalledAgent(slug);
  if (!dyn) return false;
  if (!dyn.allowed_roles || dyn.allowed_roles.length === 0) return true;
  return dyn.allowed_roles.includes(role);
}

/** Synchrone : check rôle pour agents statiques uniquement (compat). */
export function canUseAgentStatic(slug: string, role: AgentRole): boolean {
  const a = AGENTS[slug];
  if (!a) return false;
  if (!a.allowedRoles || a.allowedRoles.length === 0) return true;
  return a.allowedRoles.includes(role);
}

/** Calcule le rôle AI Box depuis la liste de groupes Authentik d'un user. */
export function roleFromGroups(groups: string[]): AgentRole {
  // Tout groupe contenant "Admin" (insensible à la casse) → admin
  if (groups.some((g) => /admin/i.test(g))) return "admin";
  // Groupe Managers
  if (groups.includes("AI Box — Managers")) return "manager";
  // Sinon employé (default safe)
  return "employee";
}

/** Récupère la clé API d'un agent statique par slug (synchrone). */
export function getAgentKey(slug: string): string | null {
  const a = AGENTS[slug];
  if (!a) return null;
  return process.env[a.envVar] || null;
}

/** Récupère la clé API d'un agent — statique OU installé via marketplace. */
export async function getAgentKeyAny(slug: string): Promise<string | null> {
  const staticKey = getAgentKey(slug);
  if (staticKey) return staticKey;
  const { getInstalledAgent } = await import("@/lib/installed-agents");
  const dyn = await getInstalledAgent(slug);
  return dyn?.api_key || null;
}

/** Retourne le slug par défaut (le 1er disponible avec isDefault=true,
 *  sinon le 1er disponible tout court). */
export function defaultAgentSlug(): string | null {
  const list = listAvailableAgents();
  const def = list.find((a) => a.isDefault);
  return def?.slug || list[0]?.slug || null;
}
