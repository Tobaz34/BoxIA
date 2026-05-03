/**
 * Catalogue des connecteurs disponibles dans l'AI Box.
 *
 * Source unique de vérité côté serveur. La page /connectors le combine
 * avec l'état persistant (lib/connectors-state.ts) pour produire la
 * vue enrichie envoyée au client.
 */

export type ConnectorCategory =
  | "storage"
  | "email"
  | "social"
  | "erp_crm"
  | "helpdesk"
  | "comms"
  | "project"
  | "finance"
  | "calendar"
  | "telephony"
  | "bi";

/**
 * Hub = regroupement métier exposé en grande tuile dans /connectors.
 * Un hub agrège plusieurs `ConnectorCategory` techniques.
 * Le client ne pense pas en termes de "erp_crm" vs "helpdesk", il pense
 * "Logiciels métier".
 */
export type ConnectorHub =
  | "email"
  | "social"
  | "business"
  | "documents"
  | "finance"
  | "calendar"
  | "telephony"
  | "team_chat";

export type ConnectorImplStatus = "implemented" | "beta" | "coming_soon";

export interface ConnectorField {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "select";
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  /** Pour `type: select`. */
  options?: { value: string; label: string }[];
  /** Si true, jamais renvoyé dans GET — seulement à la création/update. */
  secret?: boolean;
}

export interface ConnectorSpec {
  slug: string;
  name: string;
  icon: string;          // emoji
  description: string;
  category: ConnectorCategory;
  /** État de l'implémentation côté backend (worker connectors/<slug>/). */
  implStatus: ConnectorImplStatus;
  /** Si la techno se branche en OAuth (le user clique « se connecter ») plutôt
   *  qu'avec login/mdp — UI différente, on ouvre une popup. */
  authMethod?: "form" | "oauth2" | "azure_ad" | "google_oauth";
  /** Champs à demander pour activer le connecteur. */
  fields: ConnectorField[];
  /** Lien doc / aide en ligne (optionnel). */
  docUrl?: string;
}

export const CATEGORIES: Record<ConnectorCategory, { label: string; icon: string }> = {
  storage:    { label: "Stockage de fichiers", icon: "📁" },
  email:      { label: "Messagerie",            icon: "📧" },
  social:     { label: "Réseaux sociaux",       icon: "📱" },
  erp_crm:    { label: "ERP / CRM",             icon: "💼" },
  helpdesk:   { label: "Support clients",       icon: "🎧" },
  comms:      { label: "Messagerie d'équipe",   icon: "💬" },
  project:    { label: "Gestion de projet",     icon: "📋" },
  finance:    { label: "Comptabilité / Paie",   icon: "💰" },
  calendar:   { label: "Agenda",                icon: "🗓️" },
  telephony:  { label: "Téléphonie",            icon: "📞" },
  bi:         { label: "Business Intelligence", icon: "📊" },
};

export const HUBS: Record<ConnectorHub, {
  label: string;
  icon: string;
  description: string;
  /** Catégories techniques agrégées dans ce hub. */
  categories: ConnectorCategory[];
  /** Ordre d'affichage dans la grille (plus petit = plus haut). */
  order: number;
}> = {
  email: {
    label: "Emails",
    icon: "📧",
    description: "Outlook, Gmail, IMAP — tri intelligent, résumés, suggestions de réponse.",
    categories: ["email"],
    order: 10,
  },
  social: {
    label: "Réseaux sociaux",
    icon: "📱",
    description: "Facebook, Instagram, LinkedIn — publication assistée et planning éditorial.",
    categories: ["social"],
    order: 20,
  },
  business: {
    label: "Logiciels métier",
    icon: "💼",
    description: "ERP, CRM, support, gestion de projet, BI — Odoo, HubSpot, GLPI, Jira…",
    categories: ["erp_crm", "helpdesk", "project", "bi"],
    order: 30,
  },
  documents: {
    label: "Documents",
    icon: "📁",
    description: "NAS, SharePoint, Drive, Dropbox — RAG sur tous vos fichiers.",
    categories: ["storage"],
    order: 40,
  },
  finance: {
    label: "Comptabilité & finance",
    icon: "💰",
    description: "Pennylane, FEC universel, Sage, Cegid — factures, impayés, reporting.",
    categories: ["finance"],
    order: 50,
  },
  calendar: {
    label: "Agenda",
    icon: "🗓️",
    description: "Outlook, Google Calendar, CalDAV — préparation RDV, résumé de semaine.",
    categories: ["calendar"],
    order: 60,
  },
  telephony: {
    label: "Téléphonie",
    icon: "📞",
    description: "3CX, Ringover, Aircall — transcription et résumé d'appels.",
    categories: ["telephony"],
    order: 70,
  },
  team_chat: {
    label: "Messagerie d'équipe",
    icon: "💬",
    description: "Slack, Teams, Mattermost — agent IA dans vos canaux internes.",
    categories: ["comms"],
    order: 80,
  },
};

/** Retourne le hub auquel appartient une catégorie (premier match). */
export function hubForCategory(cat: ConnectorCategory): ConnectorHub | null {
  for (const [hub, def] of Object.entries(HUBS)) {
    if (def.categories.includes(cat)) return hub as ConnectorHub;
  }
  return null;
}

const SMB_FIELDS: ConnectorField[] = [
  { key: "host",     label: "Serveur (IP ou DNS)", type: "text",
    required: true, placeholder: "192.168.1.10" },
  { key: "share",    label: "Nom du partage", type: "text",
    required: true, placeholder: "Documents" },
  { key: "username", label: "Identifiant", type: "text", required: true },
  { key: "password", label: "Mot de passe", type: "password",
    required: true, secret: true },
  { key: "domain",   label: "Domaine (optionnel)", type: "text",
    placeholder: "WORKGROUP" },
];

export const CONNECTORS: ConnectorSpec[] = [
  // ---------- Stockage ----------
  {
    slug: "nas-smb",
    name: "NAS / Partage SMB",
    icon: "🗄️",
    description: "Indexer un partage Windows (SMB/CIFS) ou un NAS Synology/QNAP.",
    category: "storage",
    implStatus: "implemented",
    authMethod: "form",
    fields: SMB_FIELDS,
  },
  {
    slug: "sharepoint",
    name: "SharePoint Online",
    icon: "🔵",
    description: "Indexer une bibliothèque SharePoint Microsoft 365.",
    category: "storage",
    implStatus: "beta",
    authMethod: "azure_ad",
    fields: [
      { key: "tenant_id", label: "Tenant Azure AD", type: "text", required: true,
        placeholder: "12345678-...-...-..." },
      { key: "client_id", label: "App ID (Azure registration)", type: "text", required: true },
      { key: "client_secret", label: "App secret", type: "password", required: true, secret: true },
      { key: "site_url", label: "URL du site", type: "url", required: true,
        placeholder: "https://contoso.sharepoint.com/sites/intranet" },
    ],
    docUrl: "https://learn.microsoft.com/en-us/graph/auth-v2-service",
  },
  {
    slug: "onedrive",
    name: "OneDrive",
    icon: "☁️",
    description: "Indexer le OneDrive personnel ou business des utilisateurs.",
    category: "storage",
    implStatus: "coming_soon",
    authMethod: "azure_ad",
    fields: [
      { key: "tenant_id", label: "Tenant Azure AD", type: "text", required: true },
      { key: "client_id", label: "App ID", type: "text", required: true },
      { key: "client_secret", label: "App secret", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "google-drive",
    name: "Google Drive",
    icon: "📂",
    description: "Indexer un Drive partagé ou les Drive utilisateurs.",
    category: "storage",
    implStatus: "beta",
    authMethod: "google_oauth",
    fields: [
      { key: "service_account_json", label: "Clé service account (JSON)", type: "text",
        required: true, secret: true,
        helpText: "Compte de service Google Cloud avec accès au Drive." },
      { key: "shared_drive_id", label: "Drive partagé ID (optionnel)", type: "text",
        placeholder: "0ANxxx..." },
    ],
  },
  {
    slug: "nextcloud",
    name: "Nextcloud / ownCloud",
    icon: "☁️",
    description: "Auto-hébergé : indexer un serveur Nextcloud sur site.",
    category: "storage",
    implStatus: "beta",
    authMethod: "form",
    fields: [
      { key: "url",      label: "URL Nextcloud", type: "url", required: true,
        placeholder: "https://cloud.entreprise.fr" },
      { key: "username", label: "Identifiant", type: "text", required: true },
      { key: "app_password", label: "Mot de passe d'application", type: "password",
        required: true, secret: true,
        helpText: "Préférez un mot de passe d'application (Paramètres → Sécurité)." },
    ],
  },
  {
    slug: "dropbox",
    name: "Dropbox",
    icon: "📦",
    description: "Indexer un compte Dropbox Business ou personnel.",
    category: "storage",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "access_token", label: "Access token Dropbox", type: "password",
        required: true, secret: true },
    ],
  },
  {
    slug: "box",
    name: "Box",
    icon: "📦",
    description: "Indexer un compte Box Enterprise.",
    category: "storage",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "client_id",     label: "Client ID", type: "text", required: true },
      { key: "client_secret", label: "Client secret", type: "password", required: true, secret: true },
    ],
  },

  // ---------- Messagerie ----------
  {
    slug: "outlook-graph",
    name: "Outlook / Exchange (Microsoft Graph)",
    icon: "📧",
    description: "Indexer la boîte mail des utilisateurs via Microsoft Graph.",
    category: "email",
    implStatus: "beta",
    authMethod: "azure_ad",
    fields: [
      { key: "tenant_id", label: "Tenant Azure AD", type: "text", required: true },
      { key: "client_id", label: "App ID", type: "text", required: true },
      { key: "client_secret", label: "App secret", type: "password", required: true, secret: true },
      { key: "scope", label: "Scope", type: "select",
        options: [
          { value: "users", label: "Tous les utilisateurs" },
          { value: "shared_mailbox", label: "Boîte partagée uniquement" },
        ],
        required: true },
    ],
  },
  {
    slug: "gmail",
    name: "Gmail / Workspace",
    icon: "📨",
    description: "Indexer les emails Google Workspace.",
    category: "email",
    implStatus: "coming_soon",
    authMethod: "google_oauth",
    fields: [
      { key: "service_account_json", label: "Clé service account (JSON)",
        type: "text", required: true, secret: true },
      { key: "delegated_user", label: "Utilisateur délégué",
        type: "text", placeholder: "admin@entreprise.fr",
        helpText: "Pour le domain-wide delegation Workspace." },
    ],
  },
  {
    slug: "imap-generic",
    name: "Email IMAP générique",
    icon: "✉️",
    description: "N'importe quelle messagerie compatible IMAP (OVH, Infomaniak, etc.).",
    category: "email",
    implStatus: "implemented",
    authMethod: "form",
    fields: [
      { key: "host",     label: "Serveur IMAP", type: "text", required: true,
        placeholder: "imap.ovh.net" },
      { key: "port",     label: "Port", type: "text", placeholder: "993" },
      { key: "username", label: "Identifiant", type: "text", required: true },
      { key: "password", label: "Mot de passe", type: "password", required: true, secret: true },
      { key: "tls",      label: "Chiffrement", type: "select",
        options: [
          { value: "ssl",      label: "SSL/TLS (port 993)" },
          { value: "starttls", label: "STARTTLS (port 143)" },
          { value: "none",     label: "Aucun (déconseillé)" },
        ] },
    ],
  },

  // ---------- ERP / CRM ----------
  {
    slug: "odoo",
    name: "Odoo (ERP)",
    icon: "💼",
    description: "Lecture des modules CRM, Comptabilité, Stock, Ventes, RH.",
    category: "erp_crm",
    implStatus: "beta",
    authMethod: "form",
    fields: [
      { key: "url", label: "URL Odoo", type: "url", required: true,
        placeholder: "https://odoo.entreprise.fr" },
      { key: "database", label: "Nom de la base", type: "text", required: true },
      { key: "username", label: "Identifiant", type: "text", required: true },
      { key: "api_key",  label: "Clé API ou mot de passe", type: "password",
        required: true, secret: true },
    ],
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    icon: "🎯",
    description: "Contacts, deals, tickets HubSpot CRM.",
    category: "erp_crm",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "private_app_token", label: "Token Private App",
        type: "password", required: true, secret: true,
        helpText: "Réglages → Intégrations → Applications privées." },
    ],
  },
  {
    slug: "salesforce",
    name: "Salesforce",
    icon: "☁️",
    description: "Comptes, opportunités, leads Salesforce.",
    category: "erp_crm",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "instance_url", label: "Instance URL", type: "url", required: true,
        placeholder: "https://entreprise.my.salesforce.com" },
      { key: "client_id",     label: "Consumer Key", type: "text", required: true },
      { key: "client_secret", label: "Consumer Secret", type: "password",
        required: true, secret: true },
    ],
  },

  // ---------- Comptabilité / Paie ----------
  {
    slug: "pennylane",
    name: "Pennylane",
    icon: "🪙",
    description: "Factures clients/fournisseurs, devis, suivi impayés depuis Pennylane.",
    category: "finance",
    implStatus: "implemented",
    authMethod: "form",
    fields: [
      { key: "api_token", label: "Token API Pennylane",
        type: "password", required: true, secret: true,
        helpText: "Pennylane → Paramètres → API & Webhooks → Nouvelle application. Coller le Bearer token ici." },
    ],
    docUrl: "https://pennylane.readme.io/",
  },
  {
    slug: "import-fec",
    name: "Import FEC (universel)",
    icon: "📑",
    description: "Import du Fichier des Écritures Comptables (FEC) légal français — couvre Sage, EBP, Cegid, Quadra, Ciel, etc.",
    category: "finance",
    implStatus: "implemented",
    // Pas de credentials externes : le client uploade son fichier FEC
    // mensuel (ou via cron Duplicati / partage SMB déjà connecté).
    authMethod: "form",
    fields: [
      { key: "default_period", label: "Période par défaut (mois)",
        type: "select", required: false,
        options: [
          { value: "current", label: "Mois en cours" },
          { value: "previous", label: "Mois précédent" },
          { value: "quarter", label: "Trimestre en cours" },
        ] },
    ],
    docUrl: "https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000027798003/",
  },
  {
    slug: "sage",
    name: "Sage 100 / 50",
    icon: "🧾",
    description: "ETL exports CSV/XML de Sage on-premise. Recommandé : utiliser plutôt l'import FEC universel.",
    category: "finance",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "watch_folder", label: "Dossier surveillé (exports Sage)",
        type: "text", required: true,
        placeholder: "/srv/sage/exports/" },
    ],
  },
  {
    slug: "cegid",
    name: "Cegid",
    icon: "📒",
    description: "Cegid Loop / Cegid Quadra (API Cegid Cloud).",
    category: "finance",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "client_id",     label: "Client ID", type: "text", required: true },
      { key: "client_secret", label: "Client Secret", type: "password",
        required: true, secret: true },
    ],
  },

  // ---------- Helpdesk ----------
  {
    slug: "glpi",
    name: "GLPI",
    icon: "🧰",
    description: "Tickets, parc et inventaire GLPI.",
    category: "helpdesk",
    implStatus: "beta",
    authMethod: "form",
    fields: [
      { key: "url",       label: "URL GLPI", type: "url", required: true,
        placeholder: "https://helpdesk.entreprise.fr" },
      { key: "app_token", label: "App token", type: "password",
        required: true, secret: true },
      { key: "user_token", label: "User token", type: "password",
        required: true, secret: true },
    ],
  },
  {
    slug: "zammad",
    name: "Zammad",
    icon: "🆘",
    description: "Tickets et base de connaissances Zammad.",
    category: "helpdesk",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "url",   label: "URL Zammad", type: "url", required: true },
      { key: "token", label: "Token API", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "freshdesk",
    name: "Freshdesk",
    icon: "🎫",
    description: "Tickets et FAQ Freshdesk.",
    category: "helpdesk",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "domain", label: "Sous-domaine", type: "text", required: true,
        placeholder: "entreprise.freshdesk.com" },
      { key: "api_key", label: "Clé API", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "zendesk",
    name: "Zendesk",
    icon: "🎫",
    description: "Tickets et help center Zendesk.",
    category: "helpdesk",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "subdomain", label: "Sous-domaine", type: "text", required: true,
        placeholder: "entreprise" },
      { key: "email",     label: "Email admin", type: "text", required: true },
      { key: "api_token", label: "Token API", type: "password", required: true, secret: true },
    ],
  },

  // ---------- Communication ----------
  {
    slug: "slack",
    name: "Slack",
    icon: "💬",
    description: "Canaux publics + DM (avec consentement).",
    category: "comms",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "bot_token", label: "Bot User OAuth Token",
        type: "password", required: true, secret: true,
        placeholder: "xoxb-..." },
    ],
  },
  {
    slug: "teams",
    name: "Microsoft Teams",
    icon: "🟣",
    description: "Conversations équipes et canaux Teams.",
    category: "comms",
    implStatus: "coming_soon",
    authMethod: "azure_ad",
    fields: [
      { key: "tenant_id", label: "Tenant", type: "text", required: true },
      { key: "client_id", label: "App ID", type: "text", required: true },
      { key: "client_secret", label: "Secret", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "discord",
    name: "Discord",
    icon: "🎮",
    description: "Indexer les serveurs Discord (communauté / interne).",
    category: "comms",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "bot_token", label: "Bot token", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "mattermost",
    name: "Mattermost",
    icon: "💬",
    description: "Auto-hébergé : alternative open-source à Slack.",
    category: "comms",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "url",   label: "URL Mattermost", type: "url", required: true },
      { key: "token", label: "Personal Access Token", type: "password",
        required: true, secret: true },
    ],
  },

  // ---------- Gestion de projet ----------
  {
    slug: "notion",
    name: "Notion",
    icon: "📝",
    description: "Indexer un workspace Notion (pages + bases).",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "integration_token", label: "Token d'intégration interne",
        type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "asana",
    name: "Asana",
    icon: "✅",
    description: "Tâches et projets Asana.",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "personal_access_token", label: "Personal Access Token",
        type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "trello",
    name: "Trello",
    icon: "📌",
    description: "Cartes et boards Trello.",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "api_key",   label: "API key", type: "text", required: true },
      { key: "api_token", label: "API token", type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "clickup",
    name: "ClickUp",
    icon: "🚀",
    description: "Tâches multi-vues ClickUp.",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "api_token", label: "API token", type: "password",
        required: true, secret: true },
    ],
  },
  {
    slug: "linear",
    name: "Linear",
    icon: "📐",
    description: "Issues et projets Linear (équipes produit / dev).",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "api_key", label: "API key (lin_api_...)",
        type: "password", required: true, secret: true },
    ],
  },
  {
    slug: "jira",
    name: "Jira",
    icon: "🪲",
    description: "Tickets Jira Cloud ou Server.",
    category: "project",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "url",       label: "URL Jira", type: "url", required: true,
        placeholder: "https://entreprise.atlassian.net" },
      { key: "email",     label: "Email du user API", type: "text", required: true },
      { key: "api_token", label: "API token", type: "password",
        required: true, secret: true },
    ],
  },

  // ---------- Réseaux sociaux ----------
  // Scope Phase 1 : publication / community management.
  // Pas de scraping, uniquement APIs officielles (Meta Graph + LinkedIn Marketing).
  {
    slug: "facebook-pages",
    name: "Facebook (Pages)",
    icon: "📘",
    description: "Publier sur les Pages Facebook, lire les statistiques, modérer les commentaires.",
    category: "social",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "page_id", label: "Page ID", type: "text", required: true,
        placeholder: "123456789012345" },
      { key: "page_access_token", label: "Page Access Token (long-lived)",
        type: "password", required: true, secret: true,
        helpText: "Meta for Developers → My Apps → Graph API Explorer → token longue durée." },
    ],
    docUrl: "https://developers.facebook.com/docs/pages-api",
  },
  {
    slug: "instagram-business",
    name: "Instagram (Business)",
    icon: "📸",
    description: "Publier des posts/stories, lire insights, répondre aux DM et commentaires.",
    category: "social",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "ig_user_id", label: "Instagram Business Account ID",
        type: "text", required: true },
      { key: "page_access_token", label: "Page Access Token Facebook lié",
        type: "password", required: true, secret: true,
        helpText: "Le compte Instagram doit être lié à une Page Facebook." },
    ],
    docUrl: "https://developers.facebook.com/docs/instagram-api",
  },
  {
    slug: "linkedin-pages",
    name: "LinkedIn (Pages entreprise)",
    icon: "💼",
    description: "Publier sur la page entreprise, programmer, lire les analytics.",
    category: "social",
    implStatus: "coming_soon",
    authMethod: "oauth2",
    fields: [
      { key: "organization_urn", label: "Organization URN",
        type: "text", required: true,
        placeholder: "urn:li:organization:1234567" },
      { key: "access_token", label: "Access Token (3-legged OAuth)",
        type: "password", required: true, secret: true,
        helpText: "Scopes requis : w_organization_social, r_organization_social, rw_organization_admin." },
    ],
    docUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/",
  },

  // ---------- Agenda ----------
  {
    slug: "outlook-calendar",
    name: "Outlook Calendar (M365)",
    icon: "🗓️",
    description: "Préparation RDV avec contexte client, résumé de la semaine, suggestions de créneaux.",
    category: "calendar",
    implStatus: "coming_soon",
    authMethod: "azure_ad",
    fields: [
      { key: "tenant_id", label: "Tenant Azure AD", type: "text", required: true },
      { key: "client_id", label: "App ID", type: "text", required: true },
      { key: "client_secret", label: "App secret", type: "password",
        required: true, secret: true },
      { key: "scope", label: "Scope", type: "select",
        options: [
          { value: "users", label: "Tous les utilisateurs" },
          { value: "shared_calendar", label: "Calendrier partagé uniquement" },
        ],
        required: true },
    ],
  },
  {
    slug: "google-calendar",
    name: "Google Calendar",
    icon: "📅",
    description: "Calendrier Google Workspace ou perso — préparation et résumé d'agenda.",
    category: "calendar",
    implStatus: "coming_soon",
    authMethod: "google_oauth",
    fields: [
      { key: "service_account_json", label: "Clé service account (JSON)",
        type: "text", required: true, secret: true },
      { key: "delegated_user", label: "Utilisateur délégué",
        type: "text", placeholder: "admin@entreprise.fr",
        helpText: "Pour le domain-wide delegation Workspace." },
    ],
  },
  {
    slug: "caldav",
    name: "CalDAV générique",
    icon: "📆",
    description: "N'importe quel serveur CalDAV (Nextcloud, Baïkal, iCloud, OVH…).",
    category: "calendar",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "url",      label: "URL CalDAV", type: "url", required: true,
        placeholder: "https://cloud.entreprise.fr/remote.php/dav/calendars/user/" },
      { key: "username", label: "Identifiant", type: "text", required: true },
      { key: "password", label: "Mot de passe (ou app password)",
        type: "password", required: true, secret: true },
    ],
  },

  // ---------- Téléphonie ----------
  // Pipeline : webhook fin d'appel → faster-whisper → LLM (résumé + actions)
  // → push vers CRM / email.
  {
    slug: "3cx",
    name: "3CX",
    icon: "☎️",
    description: "Transcription et résumé automatique des appels 3CX.",
    category: "telephony",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "pbx_url", label: "URL du PBX 3CX", type: "url", required: true,
        placeholder: "https://pbx.entreprise.fr:5001" },
      { key: "api_key", label: "Clé API REST", type: "password",
        required: true, secret: true },
      { key: "recording_path", label: "Dossier enregistrements (UNC ou local)",
        type: "text", placeholder: "/var/lib/3cxpbx/Instance1/Data/Recordings/" },
    ],
  },
  {
    slug: "ringover",
    name: "Ringover",
    icon: "📞",
    description: "Récupération auto enregistrements, transcription, push CRM.",
    category: "telephony",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "api_key", label: "Clé API Ringover", type: "password",
        required: true, secret: true,
        helpText: "Compte Admin Ringover → Développeur → Clés API." },
    ],
    docUrl: "https://developers.ringover.com/",
  },
  {
    slug: "aircall",
    name: "Aircall",
    icon: "📲",
    description: "Webhooks d'appel → transcription Whisper → résumé + action items.",
    category: "telephony",
    implStatus: "coming_soon",
    authMethod: "form",
    fields: [
      { key: "api_id",    label: "API ID", type: "text", required: true },
      { key: "api_token", label: "API Token", type: "password",
        required: true, secret: true },
    ],
    docUrl: "https://developer.aircall.io/",
  },
];

/** Retourne le spec d'un connecteur. */
export function getConnector(slug: string): ConnectorSpec | undefined {
  return CONNECTORS.find((c) => c.slug === slug);
}

/** Métadonnées publiques (sans champs `secret`) — sûr à exposer au client. */
export type PublicConnectorSpec = Omit<ConnectorSpec, "fields"> & {
  fields: Omit<ConnectorField, "secret">[];
};

export function publicCatalog(): PublicConnectorSpec[] {
  return CONNECTORS.map((c) => ({
    ...c,
    fields: c.fields.map((f) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { secret: _secret, ...rest } = f;
      return rest;
    }),
  }));
}
