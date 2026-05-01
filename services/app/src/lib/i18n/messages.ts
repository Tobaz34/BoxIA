/**
 * Dictionnaire de traductions FR/EN.
 *
 * **FR = source de vérité.** Toute clé ajoutée ici en FR doit aussi exister
 * en EN (le typage `Messages` impose la complétude — TS échoue sinon).
 *
 * Pour ajouter une langue (ex: ES, DE) :
 *   1. Ajoute le code dans `LOCALES` (cf. types.ts)
 *   2. Ajoute la propriété correspondante dans MESSAGES
 *   3. TypeScript râle si une clé manque → boucler jusqu'à zéro erreur
 *
 * Pour les chaînes paramétrées : utiliser `{var}` côté valeur, puis appeler
 * `t("workflows.marketplace.toastInstalled", { name: w.name })`.
 */
import type { Locale } from "./types";

const FR = {
  common: {
    loading: "Chargement…",
    save: "Enregistrer",
    cancel: "Annuler",
    confirm: "Confirmer",
    close: "Fermer",
    delete: "Supprimer",
    edit: "Modifier",
    add: "Ajouter",
    refresh: "Rafraîchir",
    search: "Rechercher",
    yes: "Oui",
    no: "Non",
    accessReserved: "Accès réservé",
    accessReservedAdmin: "Cette page est accessible aux administrateurs uniquement.",
    error: "Erreur",
    errorGeneric: "Une erreur est survenue.",
  },
  sidebar: {
    nav: {
      chat: "Discuter",
      agents: "Mes assistants",
      workflows: "Automatisations",
      documents: "Documents",
    },
    admin: {
      header: "Administration",
      users: "Utilisateurs",
      connectors: "Connecteurs",
      marketplaceAi: "Marketplace IA",
      marketplaceN8n: "Marketplace n8n",
      mcp: "Intégrations MCP",
      audit: "Audit",
      system: "État serveur",
      settings: "Paramètres",
    },
    connectors: {
      header: "Connecteurs",
      seeAll: "Voir tout",
    },
    footer: {
      myData: "Mes données",
      help: "Aide",
      close: "Fermer",
    },
  },
  header: {
    menu: "Menu",
    toggleTheme: "Basculer le thème",
  },
  workflows: {
    title: "Automatisations",
    subtitle: "{count} workflow{plural} n8n · {active} actif{activePlural}",
    openN8n: "Ouvrir n8n",
    openN8nAdmin: "Ouvre n8n avec auto-login (vous êtes admin)",
    runNow: "Exécuter maintenant",
    activate: "Activer",
    deactivate: "Désactiver",
    seeExecutions: "Voir les exécutions",
    openInN8n: "Ouvrir dans n8n",
    empty: "Aucun workflow pour le moment.",
    importDefault: "Importer les templates par défaut",
    importing: "Import en cours…",
    credsBannerTitle: "Credentials à configurer.",
    credsBannerText: "{count} workflow{plural} actif{plural} attend{plural2} encore des credentials externes pour fonctionner : {list}.",
    configureInN8n: "Configurer dans n8n",
    marketplace: {
      title: "Marketplace workflows n8n",
      subtitle: "Workflows pré-écrits, prêts à importer en 1 clic. Idéal pour automatiser les tâches récurrentes (relances factures, alertes SLA, snapshots, healthcheck…).",
      searchPlaceholder: "Rechercher un workflow (impayés, GLPI, snapshot…)",
      countAvailable: "{count} disponibles",
      countInstalled: "{installed} installés · {active} actifs",
      install: "Installer",
      installing: "Installation…",
      installed: "Installé",
      active: "Actif",
      categoryAll: "Tout",
      empty: "Aucun workflow trouvé. Essaie un autre filtre.",
      credsRequired: "Credentials requis : {list}",
      footerNote: "Les workflows sont importés désactivés par sécurité — configurez les credentials nécessaires côté n8n puis activez-les depuis l'onglet Workflows.",
      toastInstalled: "« {name} » installé (désactivé). Activez-le depuis /workflows quand vous êtes prêt.",
      toastInstalledNeedsCreds: "« {name} » installé (désactivé). Configurez les credentials avant d'activer.",
      toastAlreadyInstalled: "« {name} » est déjà installé côté n8n.",
    },
  },
  agents: {
    marketplace: {
      title: "Marketplace d'assistants",
      subtitle: "Activez en 1 clic des assistants pré-configurés (résumé de PDF, traduction, compte-rendu de réunion…).",
      searchPlaceholder: "Rechercher un assistant…",
      install: "Activer",
      uninstall: "Désinstaller",
      installed: "Activé",
    },
  },
  connectors: {
    syncNow: "Synchroniser maintenant",
  },
  passwordBanner: {
    detected: "Mot de passe par défaut détecté.",
    cta: "Change-le dès maintenant pour sécuriser ton compte.",
    afterOpen: "Une fois changé dans la fenêtre Authentik, clique « J'ai changé ».",
    changeNow: "Changer maintenant",
    iChanged: "J'ai changé",
  },
  settings: {
    language: {
      header: "Langue de l'interface",
      help: "La langue est mémorisée dans un cookie. Le rechargement de la page est nécessaire pour que tous les composants soient retraduits.",
    },
  },
};

const EN: typeof FR = {
  common: {
    loading: "Loading…",
    save: "Save",
    cancel: "Cancel",
    confirm: "Confirm",
    close: "Close",
    delete: "Delete",
    edit: "Edit",
    add: "Add",
    refresh: "Refresh",
    search: "Search",
    yes: "Yes",
    no: "No",
    accessReserved: "Access denied",
    accessReservedAdmin: "This page is restricted to administrators.",
    error: "Error",
    errorGeneric: "An error occurred.",
  },
  sidebar: {
    nav: {
      chat: "Chat",
      agents: "My assistants",
      workflows: "Automations",
      documents: "Documents",
    },
    admin: {
      header: "Administration",
      users: "Users",
      connectors: "Connectors",
      marketplaceAi: "AI Marketplace",
      marketplaceN8n: "n8n Marketplace",
      mcp: "MCP Integrations",
      audit: "Audit log",
      system: "Server status",
      settings: "Settings",
    },
    connectors: {
      header: "Connectors",
      seeAll: "See all",
    },
    footer: {
      myData: "My data",
      help: "Help",
      close: "Close",
    },
  },
  header: {
    menu: "Menu",
    toggleTheme: "Toggle theme",
  },
  workflows: {
    title: "Automations",
    subtitle: "{count} n8n workflow{plural} · {active} active",
    openN8n: "Open n8n",
    openN8nAdmin: "Opens n8n with auto-login (admin)",
    runNow: "Run now",
    activate: "Activate",
    deactivate: "Deactivate",
    seeExecutions: "See executions",
    openInN8n: "Open in n8n",
    empty: "No workflows yet.",
    importDefault: "Import default templates",
    importing: "Importing…",
    credsBannerTitle: "Credentials to configure.",
    credsBannerText: "{count} active workflow{plural} still waiting for external credentials: {list}.",
    configureInN8n: "Configure in n8n",
    marketplace: {
      title: "n8n workflows marketplace",
      subtitle: "Pre-built workflows, ready to install in one click. Ideal to automate recurring tasks (invoice reminders, SLA alerts, snapshots, healthchecks…).",
      searchPlaceholder: "Search a workflow (unpaid, GLPI, snapshot…)",
      countAvailable: "{count} available",
      countInstalled: "{installed} installed · {active} active",
      install: "Install",
      installing: "Installing…",
      installed: "Installed",
      active: "Active",
      categoryAll: "All",
      empty: "No workflow matches. Try another filter.",
      credsRequired: "Credentials required: {list}",
      footerNote: "Workflows are installed disabled for safety — configure required credentials in n8n, then activate from the Workflows tab.",
      toastInstalled: "« {name} » installed (disabled). Activate it from /workflows when ready.",
      toastInstalledNeedsCreds: "« {name} » installed (disabled). Configure credentials before activating.",
      toastAlreadyInstalled: "« {name} » is already installed in n8n.",
    },
  },
  agents: {
    marketplace: {
      title: "Assistants marketplace",
      subtitle: "Install pre-configured assistants in one click (PDF summary, translation, meeting notes…).",
      searchPlaceholder: "Search an assistant…",
      install: "Install",
      uninstall: "Uninstall",
      installed: "Installed",
    },
  },
  connectors: {
    syncNow: "Sync now",
  },
  passwordBanner: {
    detected: "Default password detected.",
    cta: "Change it now to secure your account.",
    afterOpen: "Once changed in the Authentik window, click \"I've changed it\".",
    changeNow: "Change now",
    iChanged: "I've changed it",
  },
  settings: {
    language: {
      header: "Interface language",
      help: "The language is stored in a cookie. A page reload is required for every component to use the new language.",
    },
  },
};

export type Messages = typeof FR;

export const MESSAGES: Record<Locale, Messages> = {
  fr: FR,
  en: EN,
};
