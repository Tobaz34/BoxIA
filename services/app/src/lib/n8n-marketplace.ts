/**
 * n8n marketplace — lecture du catalogue local + installation dans n8n.
 *
 * Pendant n8n de `dify-marketplace.ts` côté Dify : ici on s'appuie sur
 * un dossier `templates/n8n/marketplace/` versionné dans le repo, qui
 * contient :
 *
 *   - `_catalog.json`     → métadonnées (name, icon, category, …)
 *   - `*.json`            → workflows n8n exportés (1 fichier = 1 workflow)
 *
 * Le dossier est bind-mounté en `/templates:ro` dans le container aibox-app
 * (cf. services/app/docker-compose.yml). Cf. aussi
 * `services/app/src/app/api/workflows/import-templates/route.ts` qui partage
 * le même chemin.
 *
 * L'installation = POST vers `/rest/workflows` côté n8n via `createWorkflow`
 * (cf. lib/n8n.ts), avec `active: false` forcé. L'admin doit ensuite activer
 * le workflow manuellement dans /workflows (idem Dify : install ≠ activate).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createWorkflow, listWorkflows } from "@/lib/n8n";
import type { N8nWorkflow } from "@/lib/n8n";

const MARKETPLACE_DIR =
  process.env.N8N_MARKETPLACE_DIR || "/templates/n8n/marketplace";

export type MarketplaceCategory =
  | "finance"
  | "email"
  | "rag"
  | "helpdesk"
  | "backup"
  | "monitoring"
  | "sales"
  | "misc";

export type MarketplaceDifficulty = "facile" | "moyen" | "avance";

export interface MarketplaceCategoryDef {
  id: MarketplaceCategory;
  label: string;
  icon: string;
}

export interface MarketplaceWorkflow {
  /** Nom du fichier JSON (clé canonique). */
  file: string;
  /** Nom affiché côté UI. */
  name: string;
  /** Emoji. */
  icon: string;
  /** Catégorie de regroupement. */
  category: MarketplaceCategory;
  /** Description en français (1-2 phrases). */
  description: string;
  /** Niveau de complexité. */
  difficulty: MarketplaceDifficulty;
  /** Liste de credentials externes à configurer dans n8n après import. */
  credentials_required: string[];
  /** Services BoxIA requis (filtrage côté UI selon la config client). */
  boxia_services: string[];
  /** Si true, importé + activé automatiquement au first-run. */
  default_active: boolean;
  /**
   * Origine du template :
   *   - "boxia"     : workflow officiel BoxIA (taillé pour notre stack,
   *                   credentials_required minimal, prêt à activer)
   *   - "community" : importé depuis n8n.io community (top par totalViews,
   *                   demande config manuelle des creds avant activation)
   */
  source?: "boxia" | "community";
  /** URL n8n.io originale (community uniquement). */
  source_url?: string;
  /** Nb de vues n8n.io (community uniquement, pour tri par popularité). */
  total_views?: number;
  /** Auteur n8n.io (community uniquement). */
  author?: string;
}

export interface MarketplaceCatalog {
  version: number;
  categories: MarketplaceCategoryDef[];
  workflows: MarketplaceWorkflow[];
}

interface RawCatalog {
  version?: number;
  categories?: unknown;
  workflows?: unknown;
}

/** Lit `_catalog.json` et le valide a minima. */
export async function readCatalog(): Promise<MarketplaceCatalog> {
  const file = path.join(MARKETPLACE_DIR, "_catalog.json");
  let raw: RawCatalog;
  try {
    const content = await fs.readFile(file, "utf-8");
    raw = JSON.parse(content) as RawCatalog;
  } catch (e) {
    throw new Error(
      `n8n marketplace : impossible de lire ${file} : ${(e as Error).message}`,
    );
  }
  const categories: MarketplaceCategoryDef[] = Array.isArray(raw.categories)
    ? raw.categories
        .filter(
          (c): c is { id: string; label?: string; icon?: string } =>
            !!c && typeof c === "object" && typeof (c as { id?: unknown }).id === "string",
        )
        .map((c) => ({
          id: c.id as MarketplaceCategory,
          label: typeof c.label === "string" ? c.label : c.id,
          icon: typeof c.icon === "string" ? c.icon : "📦",
        }))
    : [];
  const officialWorkflows: MarketplaceWorkflow[] = Array.isArray(raw.workflows)
    ? raw.workflows
        .filter(
          (w): w is Record<string, unknown> =>
            !!w &&
            typeof w === "object" &&
            typeof (w as { file?: unknown }).file === "string",
        )
        .map((w) => ({
          file: String(w.file),
          name: typeof w.name === "string" ? w.name : String(w.file),
          icon: typeof w.icon === "string" ? w.icon : "⚙️",
          category: (typeof w.category === "string"
            ? w.category
            : "misc") as MarketplaceCategory,
          description: typeof w.description === "string" ? w.description : "",
          difficulty: (typeof w.difficulty === "string"
            ? w.difficulty
            : "facile") as MarketplaceDifficulty,
          credentials_required: Array.isArray(w.credentials_required)
            ? (w.credentials_required as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : [],
          boxia_services: Array.isArray(w.boxia_services)
            ? (w.boxia_services as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : [],
          default_active: w.default_active === true,
          source: "boxia" as const,
        }))
    : [];

  // Charge aussi le catalogue communautaire si présent (templates fetchés
  // depuis n8n.io via scripts/fetch_n8n_community_templates.py).
  const community = await readCommunityCatalog();

  return {
    version: raw.version || 1,
    categories,
    workflows: [...officialWorkflows, ...community],
  };
}

interface RawCommunityIndex {
  workflows?: unknown[];
}

/** Lit `community/_index.json` (catalogue n8n.io) si présent. */
async function readCommunityCatalog(): Promise<MarketplaceWorkflow[]> {
  const indexFile = path.join(MARKETPLACE_DIR, "community", "_index.json");
  try {
    const content = await fs.readFile(indexFile, "utf-8");
    const raw = JSON.parse(content) as RawCommunityIndex;
    if (!Array.isArray(raw.workflows)) return [];
    return raw.workflows
      .filter(
        (w): w is Record<string, unknown> =>
          !!w &&
          typeof w === "object" &&
          typeof (w as { file?: unknown }).file === "string",
      )
      .map((w) => ({
        file: String(w.file),
        name: typeof w.name === "string" ? w.name : "(community)",
        icon: typeof w.icon === "string" ? w.icon : "⚙️",
        category: (typeof w.category === "string"
          ? w.category
          : "misc") as MarketplaceCategory,
        description: typeof w.description === "string" ? w.description : "",
        difficulty: (typeof w.difficulty === "string"
          ? w.difficulty
          : "moyen") as MarketplaceDifficulty,
        credentials_required: Array.isArray(w.credentials_required)
          ? (w.credentials_required as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
          : [],
        boxia_services: [],
        default_active: false,
        source: "community" as const,
        source_url: typeof w.source_url === "string" ? w.source_url : undefined,
        total_views: typeof w.total_views === "number" ? w.total_views : 0,
        author: typeof w.author === "string" ? w.author : undefined,
      }));
  } catch {
    // Catalogue communautaire absent ou illisible → on retourne juste les officiels.
    return [];
  }
}

/** Charge le JSON complet d'un workflow marketplace, identifié par `file`. */
export async function readWorkflowTemplate(
  file: string,
): Promise<Record<string, unknown>> {
  // Garde-fou path traversal : on accepte un nom de fichier plat OU
  // `community/<id>.json` (catalogue communautaire). Pas de "../" ni
  // de chemin absolu autorisé.
  if (!/^(community\/)?[a-zA-Z0-9_\-.]+\.json$/.test(file) || file.includes("..")) {
    throw new Error(`Nom de fichier invalide : ${file}`);
  }
  const full = path.join(MARKETPLACE_DIR, file);
  const content = await fs.readFile(full, "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

/**
 * Lit juste le champ `name` d'un workflow JSON (sans charger le reste).
 * Renvoie `null` si fichier illisible. Utilisé pour matcher un template
 * marketplace avec un workflow déjà installé côté n8n (le `name` est ce
 * que n8n stocke après import).
 */
export async function readWorkflowTemplateName(
  file: string,
): Promise<string | null> {
  try {
    const tpl = await readWorkflowTemplate(file);
    return typeof tpl.name === "string" ? tpl.name : null;
  } catch {
    return null;
  }
}

export interface InstallMarketplaceResult {
  /** Slug du workflow marketplace installé. */
  file: string;
  /** Nom du workflow tel que créé dans n8n. */
  name: string;
  /** UUID du workflow n8n nouvellement créé. */
  workflow_id: string;
}

/**
 * Installe un workflow marketplace dans n8n.
 *
 * - Lit le JSON depuis `templates/n8n/marketplace/<file>`
 * - Strip les champs server-side (cf. createWorkflow) puis POST `/rest/workflows`
 * - Toujours créé avec `active: false` (l'admin doit configurer les
 *   credentials_required avant d'activer).
 *
 * Si un workflow du même nom existe déjà côté n8n, on renvoie
 * `already_installed` au lieu de dupliquer.
 */
export async function installMarketplaceWorkflow(
  file: string,
): Promise<InstallMarketplaceResult | { already_installed: true; name: string }> {
  const tpl = await readWorkflowTemplate(file);
  // C'est `tpl.name` (JSON interne du template) qui est utilisé par n8n
  // comme nom du workflow — pas le `name` user-friendly du catalogue.
  // L'idempotence et la détection « déjà installé » se font sur cette base.
  const name = typeof tpl.name === "string" ? tpl.name : file.replace(/\.json$/, "");

  // Idempotent : si déjà présent côté n8n on ne re-crée pas.
  const existing = await listWorkflows();
  const dup = existing.find((w) => w.name === name);
  if (dup) {
    return { already_installed: true, name };
  }

  const wf = await createWorkflow(tpl);
  if (!wf) {
    throw new Error(`n8n createWorkflow a renvoyé null pour ${file}`);
  }
  return { file, name, workflow_id: wf.id };
}

/**
 * Pour un workflow marketplace déjà installé, retrouve son ID n8n par nom.
 * Renvoie null si pas trouvé. Utile pour proposer un bouton "Voir dans n8n".
 */
export async function findInstalledByName(name: string): Promise<N8nWorkflow | null> {
  const existing = await listWorkflows();
  return existing.find((w) => w.name === name) || null;
}
