/**
 * Cloud Providers BYOK (Bring Your Own Key).
 *
 * L'admin client utilise SES propres abonnements ChatGPT Pro / Claude Pro
 * / Mistral La Plateforme pour bénéficier des modèles cloud haute capacité
 * SANS surcoût (les clés API sont à lui). BoxIA ne fait que pousser ces
 * clés à Dify côté serveur (chiffrement at-rest assuré par Dify).
 *
 * Règles strictes (cf. memory/product_appliance_principle.md) :
 *   1. **RGPD** : toute requête vers un provider cloud doit passer par un
 *      filtre PII basique (caviardage emails / noms en focal / SSN /
 *      téléphones FR) avant envoi. Implémenté côté `pii-scrub.ts`.
 *   2. **Cost cap** : compteur de tokens stocké dans
 *      /data/cloud-usage.json. Alerte à 80%, hard cap à 100% du budget
 *      mensuel défini par l'admin (default 50 €/mois).
 *   3. **Opt-in conscient** : le user choisit explicitement "Local" vs
 *      "Cloud" dans le sélecteur du chat. Le default reste Local pour
 *      maximum de privacy.
 *
 * Pas de stockage des clés en clair côté aibox-app : on les pousse à
 * Dify et on stocke uniquement le provider_id + model + statut. Si
 * l'admin veut révoquer, il le fait depuis /settings.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "cloud-providers.json");

export type CloudProviderId = "openai" | "anthropic" | "mistral";

export interface CloudProviderConfig {
  /** Id du provider (slug stable). */
  id: CloudProviderId;
  /** Nom affiché. */
  name: string;
  /** Endpoint Dify (langgenius/<provider>/<provider>). */
  dify_provider: string;
  /** Liste de modèles recommandés à activer dans Dify. */
  default_models: string[];
  /** Lien vers la page de génération de clé chez le provider. */
  api_keys_url: string;
  /** Format attendu de la clé (regex pour validation côté UI). */
  key_format_hint: string;
}

export const CLOUD_PROVIDERS: CloudProviderConfig[] = [
  {
    id: "openai",
    name: "OpenAI (ChatGPT Pro / Plus)",
    dify_provider: "langgenius/openai/openai",
    default_models: ["gpt-4o", "gpt-4o-mini"],
    api_keys_url: "https://platform.openai.com/api-keys",
    key_format_hint: "sk-proj-... (51+ caractères)",
  },
  {
    id: "anthropic",
    name: "Anthropic (Claude Pro / Team)",
    dify_provider: "langgenius/anthropic/anthropic",
    default_models: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
    api_keys_url: "https://console.anthropic.com/settings/keys",
    key_format_hint: "sk-ant-api03-... (95+ caractères)",
  },
  {
    id: "mistral",
    name: "Mistral AI (La Plateforme)",
    dify_provider: "langgenius/mistralai/mistralai",
    default_models: ["mistral-large-latest", "mistral-small-latest"],
    api_keys_url: "https://console.mistral.ai/api-keys/",
    key_format_hint: "32+ caractères alphanumériques",
  },
];

export interface CloudProviderState {
  /** Slug provider. */
  id: CloudProviderId;
  /** True si l'admin a configuré une clé (la clé est stockée côté Dify). */
  configured: boolean;
  /** Modèles activés dans Dify pour ce provider. */
  enabled_models: string[];
  /** Préfixe (8 char) de la clé pour identification UI (jamais la clé en clair). */
  key_prefix?: string;
  /** Date de configuration. */
  configured_at?: number;
  /** Date dernière utilisation (pour audit). */
  last_used_at?: number | null;
  /** Compteur tokens consommés ce mois (cost cap). */
  tokens_this_month?: number;
  /** Coût estimé ce mois (€). */
  cost_eur_this_month?: number;
}

interface StateFile {
  version: 1;
  budget_monthly_eur: number;
  pii_scrub_enabled: boolean;
  updated_at: number;
  providers: Record<CloudProviderId, CloudProviderState>;
}

const EMPTY_STATE: StateFile = {
  version: 1,
  budget_monthly_eur: 50,        // Default 50 €/mois total tous providers confondus
  pii_scrub_enabled: true,       // PII filter ON par défaut (sécu RGPD)
  updated_at: 0,
  providers: {} as Record<CloudProviderId, CloudProviderState>,
};

export async function readCloudProvidersState(): Promise<StateFile> {
  try {
    const txt = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(txt) as StateFile;
    if (parsed.version === 1) return parsed;
  } catch (e: unknown) {
    if ((e as { code?: string })?.code !== "ENOENT") {
      console.warn("[cloud-providers] read error:", e);
    }
  }
  return { ...EMPTY_STATE };
}

export async function writeCloudProvidersState(s: StateFile): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  s.updated_at = Date.now();
  const tmp = STATE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf-8");
  await fs.rename(tmp, STATE_FILE);
}

export async function setProviderConfigured(
  id: CloudProviderId,
  key_prefix: string,
  enabled_models: string[],
): Promise<CloudProviderState> {
  const s = await readCloudProvidersState();
  s.providers[id] = {
    ...(s.providers[id] || { id }),
    id,
    configured: true,
    enabled_models,
    key_prefix,
    configured_at: Date.now(),
    last_used_at: s.providers[id]?.last_used_at ?? null,
    tokens_this_month: s.providers[id]?.tokens_this_month ?? 0,
    cost_eur_this_month: s.providers[id]?.cost_eur_this_month ?? 0,
  };
  await writeCloudProvidersState(s);
  return s.providers[id];
}

export async function removeProviderConfig(id: CloudProviderId): Promise<void> {
  const s = await readCloudProvidersState();
  delete s.providers[id];
  await writeCloudProvidersState(s);
}

export async function setBudget(eur: number): Promise<void> {
  const s = await readCloudProvidersState();
  s.budget_monthly_eur = Math.max(0, eur);
  await writeCloudProvidersState(s);
}

export async function setPiiScrub(enabled: boolean): Promise<void> {
  const s = await readCloudProvidersState();
  s.pii_scrub_enabled = enabled;
  await writeCloudProvidersState(s);
}
