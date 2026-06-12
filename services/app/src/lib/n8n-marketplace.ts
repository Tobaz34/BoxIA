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
import { getState } from "@/lib/connectors-state";
import { getConnector } from "@/lib/connectors";
import {
  pushCredentialFromConnector,
  getCredentialRefForSlug,
  bridgedConnectorSlugs,
  type N8nCredentialRef,
} from "@/lib/n8n-credentials";

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

/**
 * Mapping d'un node n8n du template vers un connecteur BoxIA.
 *
 * Au moment de l'install marketplace, on injecte dans le node nommé
 * `node_name` la credential n8n associée au connecteur BoxIA `connector_slug`
 * (poussée par lib/n8n-credentials.ts). La clé `n8n_credential_key` est
 * la propriété sous `node.credentials` attendue par n8n (ex. "imap" pour
 * `emailReadImap`, "smtp" pour `emailSend`, "slackApi" pour `slack`).
 */
export interface N8nCredentialsMapping {
  node_name: string;
  connector_slug: string;
  n8n_credential_key: string;
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
  /**
   * Liste de credentials externes à configurer dans n8n après import.
   * Préférer désormais `n8n_credentials_mapping` qui automatise.
   * Conservé pour rétro-compat sur les workflows community.
   */
  credentials_required: string[];
  /** Services BoxIA requis (filtrage côté UI selon la config client). */
  boxia_services: string[];
  /** Si true, importé + activé automatiquement au first-run. */
  default_active: boolean;
  /**
   * Mapping nodes ↔ connecteurs BoxIA pour résolution auto au moment de
   * l'install (cf. installMarketplaceWorkflow). Si vide, comportement
   * legacy (l'admin doit configurer les creds dans la console n8n).
   */
  n8n_credentials_mapping?: N8nCredentialsMapping[];
  /**
   * Liste de slugs de connecteurs BoxIA dont le statut doit être `active`
   * pour que ce workflow puisse fonctionner (vérifié au préflight install).
   * Couvre à la fois les connecteurs nécessaires pour les credentials n8n
   * ET les workers BoxIA appelés par le workflow (ex. Pennylane).
   */
  required_connectors?: string[];
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

/** Valide et parse le champ `n8n_credentials_mapping` du catalogue. */
function parseCredentialsMapping(raw: unknown): N8nCredentialsMapping[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: N8nCredentialsMapping[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    if (
      typeof m.node_name === "string" &&
      typeof m.connector_slug === "string" &&
      typeof m.n8n_credential_key === "string"
    ) {
      out.push({
        node_name: m.node_name,
        connector_slug: m.connector_slug,
        n8n_credential_key: m.n8n_credential_key,
      });
    }
  }
  return out.length > 0 ? out : undefined;
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
          n8n_credentials_mapping: parseCredentialsMapping(w.n8n_credentials_mapping),
          required_connectors: Array.isArray(w.required_connectors)
            ? (w.required_connectors as unknown[]).filter(
                (x): x is string => typeof x === "string",
              )
            : [],
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
  /** Slugs des connecteurs BoxIA dont les creds ont été poussées dans n8n. */
  credentials_pushed?: string[];
  /** Nodes du workflow qui ont été patchés avec une credential. */
  nodes_credentialed?: string[];
}

/**
 * Statut "prêt à installer" pour un workflow marketplace : indique si
 * tous les `required_connectors` sont actifs côté BoxIA. Calculé par
 * GET /api/workflows/marketplace pour permettre à l'UI d'afficher
 * "Installer en 1 clic" vs "Connecte d'abord X".
 */
export interface PrerequisitesStatus {
  ready: boolean;
  missing: string[]; // slugs manquants
  missing_labels: string[]; // noms lisibles
}

/**
 * Calcule le statut des connecteurs requis pour un workflow.
 * Retourne `ready: true` si pas de pré-requis (workflows community ou
 * BoxIA-aware sans dépendance).
 */
export async function checkPrerequisites(
  w: MarketplaceWorkflow,
): Promise<PrerequisitesStatus> {
  const required = w.required_connectors || [];
  if (required.length === 0) {
    return { ready: true, missing: [], missing_labels: [] };
  }
  const missing: string[] = [];
  const labels: string[] = [];
  for (const slug of required) {
    const st = await getState(slug);
    if (!st || st.status !== "active") {
      missing.push(slug);
      const spec = getConnector(slug);
      labels.push(spec ? spec.name : slug);
    }
  }
  return {
    ready: missing.length === 0,
    missing,
    missing_labels: labels,
  };
}

/**
 * Patche un template de workflow JSON pour injecter les credentials n8n
 * référencées par leur slug BoxIA. Mute une copie de `tpl`, ne touche pas
 * l'original.
 *
 * Pour chaque entrée du `mapping`, cherche le node par `node_name` et
 * pose `node.credentials[n8n_credential_key] = { id, name }`. Si le node
 * n'est pas trouvé ou si la credential n8n n'existe pas (push raté),
 * skippe silencieusement (on retourne le template tel quel ; l'install
 * réussit mais le node erre au runtime — l'admin verra dans les logs n8n).
 *
 * Retourne le template modifié et la liste des nodes effectivement patchés.
 */
async function patchTemplateWithCredentials(
  tpl: Record<string, unknown>,
  mapping: N8nCredentialsMapping[],
): Promise<{ patched: Record<string, unknown>; nodes_credentialed: string[] }> {
  const cloned = JSON.parse(JSON.stringify(tpl)) as Record<string, unknown>;
  const nodes = Array.isArray(cloned.nodes) ? (cloned.nodes as Record<string, unknown>[]) : [];
  const credentialed: string[] = [];

  // Cache local pour éviter de re-fetcher la même cred plusieurs fois.
  const refCache = new Map<string, N8nCredentialRef | null>();
  const getRef = async (slug: string): Promise<N8nCredentialRef | null> => {
    if (refCache.has(slug)) return refCache.get(slug) || null;
    let ref = await getCredentialRefForSlug(slug);
    // Cred pas encore créée ? Tente un push à la volée (le connecteur peut
    // avoir été activé avant que le bridge soit en place).
    if (!ref) ref = await pushCredentialFromConnector(slug);
    refCache.set(slug, ref);
    return ref;
  };

  for (const m of mapping) {
    const node = nodes.find((n) => n.name === m.node_name);
    if (!node) continue;
    const ref = await getRef(m.connector_slug);
    if (!ref) continue;
    const creds = (typeof node.credentials === "object" && node.credentials)
      ? (node.credentials as Record<string, unknown>)
      : {};
    creds[m.n8n_credential_key] = { id: ref.id, name: ref.name };
    node.credentials = creds;
    credentialed.push(m.node_name);
  }

  return { patched: cloned, nodes_credentialed: credentialed };
}

/**
 * Installe un workflow marketplace dans n8n.
 *
 * Pipeline :
 *   1. Lit le JSON depuis `templates/n8n/marketplace/<file>`
 *   2. Préflight : vérifie que les `required_connectors` sont actifs.
 *      Si non → throw avec la liste des manquants (l'API renvoie 422).
 *   3. Pour chaque entrée du `n8n_credentials_mapping`, push la
 *      credential n8n si pas déjà fait, puis patche le node correspondant
 *      du JSON pour injecter `node.credentials[key] = { id, name }`.
 *   4. POST `/rest/workflows` (toujours `active: false`).
 *
 * Idempotent : si un workflow du même nom existe déjà côté n8n, on
 * renvoie `already_installed` au lieu de dupliquer.
 */
export class PrerequisitesError extends Error {
  status: PrerequisitesStatus;
  constructor(status: PrerequisitesStatus) {
    super(`Connecteurs manquants : ${status.missing_labels.join(", ")}`);
    this.name = "PrerequisitesError";
    this.status = status;
  }
}

export async function installMarketplaceWorkflow(
  file: string,
): Promise<InstallMarketplaceResult | { already_installed: true; name: string }> {
  // 1. Lecture du JSON brut
  const tpl = await readWorkflowTemplate(file);
  const name = typeof tpl.name === "string" ? tpl.name : file.replace(/\.json$/, "");

  // 2. Idempotence : si déjà présent côté n8n on ne re-crée pas.
  const existing = await listWorkflows();
  const dup = existing.find((w) => w.name === name);
  if (dup) {
    return { already_installed: true, name };
  }

  // 3. Récupère la fiche catalogue pour le préflight et le mapping.
  // (Si pas dans le catalogue — appel direct par autre chemin — on skippe.)
  const catalog = await readCatalog();
  const entry = catalog.workflows.find((w) => w.file === file);

  // 4. Préflight : connecteurs requis actifs ?
  if (entry) {
    const status = await checkPrerequisites(entry);
    if (!status.ready) {
      throw new PrerequisitesError(status);
    }
  }

  // 5. Patch des credentials sur le JSON avant POST n8n
  let toCreate = tpl;
  const credentialed: string[] = [];
  const credsPushed: string[] = [];
  if (entry?.n8n_credentials_mapping?.length) {
    const r = await patchTemplateWithCredentials(tpl, entry.n8n_credentials_mapping);
    toCreate = r.patched;
    credentialed.push(...r.nodes_credentialed);
    // Liste les slugs effectivement résolus
    for (const m of entry.n8n_credentials_mapping) {
      if (
        bridgedConnectorSlugs().includes(m.connector_slug) &&
        r.nodes_credentialed.includes(m.node_name)
      ) {
        if (!credsPushed.includes(m.connector_slug)) {
          credsPushed.push(m.connector_slug);
        }
      }
    }
  }

  // 6. POST n8n
  const wf = await createWorkflow(toCreate);
  if (!wf) {
    throw new Error(`n8n createWorkflow a renvoyé null pour ${file}`);
  }
  return {
    file,
    name,
    workflow_id: wf.id,
    credentials_pushed: credsPushed,
    nodes_credentialed: credentialed,
  };
}

/**
 * Pour un workflow marketplace déjà installé, retrouve son ID n8n par nom.
 * Renvoie null si pas trouvé. Utile pour proposer un bouton "Voir dans n8n".
 */
export async function findInstalledByName(name: string): Promise<N8nWorkflow | null> {
  const existing = await listWorkflows();
  return existing.find((w) => w.name === name) || null;
}
