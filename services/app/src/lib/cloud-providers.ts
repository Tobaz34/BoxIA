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
import crypto from "node:crypto";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const STATE_FILE = path.join(STATE_DIR, "cloud-providers.json");

export type CloudProviderId = "openai" | "anthropic" | "google" | "mistral";

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
    // Modèles 2026 (rebrand Claude 4.x). Les "*-latest" alias n'existent
    // plus pour les versions récentes — il faut un id complet.
    default_models: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-7"],
    api_keys_url: "https://console.anthropic.com/settings/keys",
    key_format_hint: "sk-ant-api03-... (95+ caractères)",
  },
  {
    id: "google",
    name: "Google AI (Gemini)",
    dify_provider: "langgenius/google/google",
    // Gemini 2.5 Flash : quota gratuit généreux (15 req/min, 1500 req/jour)
    // Gemini 2.5 Pro : payant mais context 2M tokens
    default_models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    api_keys_url: "https://aistudio.google.com/apikey",
    key_format_hint: "AIza... (39 caractères)",
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
  /** Clé API chiffrée AES-256-GCM avec NEXTAUTH_SECRET (ou DIFY_SECRET_KEY
   *  en fallback). Stockée localement uniquement pour permettre les
   *  appels directs aux providers cloud quand les plugins Dify ne sont
   *  pas installés (cas BoxIA self-hosted sans accès marketplace.dify.ai).
   *  Format : `iv_hex:tag_hex:ciphertext_hex`. */
  api_key_local_encrypted?: string;
  /** Dernier appel cloud réussi (ms epoch). Sert au calcul du badge UI :
   *  si pas de succès récent + last_error → status=error (rouge). */
  last_success_at?: number;
  /** Dernière erreur cloud rencontrée (HTTP 4xx/5xx, timeout, auth fail).
   *  Si timestamp < 5 min → badge orange "warning" (ou rouge si critical
   *  comme HTTP 401 invalid_api_key, 402 insufficient_credits). */
  last_error?: {
    at: number;
    status: number;          // HTTP status (0 si network/timeout)
    code: string;            // "invalid_api_key" | "insufficient_credits" | "rate_limit" | "network" | "unknown"
    message: string;         // Message court (≤ 200 chars)
  };
  /** Compteur de requêtes ce mois (pour stats UI). */
  requests_this_month?: number;
}

export type ProviderHealth = "ok" | "warning" | "error" | "idle";

/** Calcule l'état santé d'un provider à partir de son state.
 *  - "idle"    : pas configuré OU jamais utilisé
 *  - "ok"      : configuré + dernier appel < 5 min OK
 *  - "warning" : budget > 80% OU dernière erreur 5-30 min OU success il y a > 24h
 *  - "error"   : budget dépassé OU dernière erreur < 5 min critique (auth/credits)
 */
export function computeProviderHealth(
  p: CloudProviderState | undefined,
  budgetMonthly: number,
  totalUsage: number,
): ProviderHealth {
  if (!p?.configured) return "idle";
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;

  // Erreur critique récente → rouge
  if (p.last_error) {
    const ageMs = now - p.last_error.at;
    const isCritical = ["invalid_api_key", "insufficient_credits"].includes(p.last_error.code);
    if (ageMs < FIVE_MIN && isCritical) return "error";
    if (ageMs < FIVE_MIN) return "warning";
    if (ageMs < THIRTY_MIN) return "warning";
  }
  // Budget dépassé / proche → rouge / orange
  if (budgetMonthly > 0) {
    const usagePct = totalUsage / budgetMonthly;
    if (usagePct >= 1) return "error";
    if (usagePct >= 0.8) return "warning";
  }
  // Pas de succès récent (ou jamais) → idle plutôt que ok pour rester neutre
  if (!p.last_success_at) return "idle";
  return "ok";
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

// =========================================================================
// Encryption locale des clés API (BUG-022 cloud fallback bypass Dify)
// =========================================================================
// Permet à /api/chat-cloud d'appeler directement le provider cloud sans
// dépendre du plugin Dify (qui peut être absent : marketplace.dify.ai
// inaccessible depuis xefia, ou plugin non installé). Clé chiffrée
// AES-256-GCM avec une dérivation HKDF de NEXTAUTH_SECRET.
//
// At-rest : la clé en clair n'est JAMAIS écrite. Le ciphertext est dans
// `api_key_local_encrypted` (CloudProviderState). Si NEXTAUTH_SECRET
// change, les clés deviennent illisibles → l'admin doit les ressaisir.

function getEncryptionKey(): Buffer {
  const secret = process.env.NEXTAUTH_SECRET
    || process.env.DIFY_SECRET_KEY
    || "boxia-default-secret-CHANGE-ME-IN-ENV";
  // HKDF simple : sha256(secret + "cloud-providers-v1") → 32 bytes
  return crypto.createHash("sha256")
    .update(secret + "cloud-providers-v1")
    .digest();
}

export function encryptApiKey(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);  // GCM standard 96-bit IV
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${ct.toString("hex")}`;
}

export function decryptApiKey(blob: string): string | null {
  try {
    const [ivHex, tagHex, ctHex] = blob.split(":");
    if (!ivHex || !tagHex || !ctHex) return null;
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm", key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const pt = Buffer.concat([
      decipher.update(Buffer.from(ctHex, "hex")),
      decipher.final(),
    ]);
    return pt.toString("utf8");
  } catch {
    return null;
  }
}

/** Stocke la clé chiffrée localement (en plus du push à Dify côté caller). */
export async function setProviderApiKeyLocal(
  id: CloudProviderId, plaintextKey: string,
): Promise<void> {
  const s = await readCloudProvidersState();
  const existing = s.providers[id] || {
    id, configured: false, enabled_models: [],
  };
  s.providers[id] = {
    ...existing,
    api_key_local_encrypted: encryptApiKey(plaintextKey),
    configured: true,
    key_prefix: plaintextKey.slice(0, 12),
    configured_at: existing.configured_at ?? Date.now(),
  };
  await writeCloudProvidersState(s);
}

/** Lit la clé en clair depuis le state (déchiffre AES-GCM). null si absent
 *  ou déchiffrement impossible (NEXTAUTH_SECRET changé). */
export async function getProviderApiKeyLocal(
  id: CloudProviderId,
): Promise<string | null> {
  const s = await readCloudProvidersState();
  const blob = s.providers[id]?.api_key_local_encrypted;
  if (!blob) return null;
  return decryptApiKey(blob);
}

/** Marque un appel cloud comme réussi : met à jour last_success_at,
 *  incrémente requests_this_month, clear last_error. */
export async function recordCloudSuccess(
  id: CloudProviderId,
  estimatedCostEur: number,
): Promise<void> {
  const s = await readCloudProvidersState();
  const cur = s.providers[id];
  if (!cur) return;
  s.providers[id] = {
    ...cur,
    last_success_at: Date.now(),
    last_error: undefined,
    requests_this_month: (cur.requests_this_month || 0) + 1,
    cost_eur_this_month: (cur.cost_eur_this_month || 0) + estimatedCostEur,
    last_used_at: Date.now(),
  };
  await writeCloudProvidersState(s);
}

/** Marque un appel cloud comme échoué : stocke last_error avec code/HTTP. */
export async function recordCloudError(
  id: CloudProviderId,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  const s = await readCloudProvidersState();
  const cur = s.providers[id];
  if (!cur) return;
  s.providers[id] = {
    ...cur,
    last_error: {
      at: Date.now(),
      status,
      code,
      message: message.slice(0, 200),
    },
    last_used_at: Date.now(),
  };
  await writeCloudProvidersState(s);
}

/** Classifie un message d'erreur HTTP du provider en code stable utilisable
 *  par computeProviderHealth (et par l'UI pour message localisé). */
export function classifyCloudError(
  status: number, body: string,
): { code: string; message: string } {
  const txt = (body || "").toLowerCase();
  if (status === 401 || txt.includes("invalid api key") || txt.includes("authentication")) {
    return { code: "invalid_api_key", message: "Clé API refusée par le provider" };
  }
  if (status === 402 || txt.includes("insufficient") || txt.includes("billing") || txt.includes("credit")) {
    return { code: "insufficient_credits", message: "Plus de crédit / quota dépassé sur le provider" };
  }
  if (status === 429 || txt.includes("rate limit") || txt.includes("quota")) {
    return { code: "rate_limit", message: "Rate limit provider — patienter quelques minutes" };
  }
  if (status === 0 || status >= 500) {
    return { code: "upstream_error", message: `Erreur provider HTTP ${status}` };
  }
  if (status === 404 || txt.includes("model") && txt.includes("not")) {
    return { code: "model_not_found", message: "Modèle introuvable chez le provider" };
  }
  return { code: "unknown", message: body.slice(0, 200) || `HTTP ${status}` };
}
