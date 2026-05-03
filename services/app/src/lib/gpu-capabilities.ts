/**
 * Détection des capacités GPU NVIDIA + tier-mapping pour modèles locaux.
 *
 * BoxIA est packagé pour tourner sur des GPUs allant de la 1660 (6 GB) à
 * la H100 (80 GB). Au boot, on détecte la VRAM totale et on en déduit :
 *   - Tier-low (≤ 8 GB)  : qwen2.5:7b text seulement, pas de vision local
 *   - Tier-mid (12-16 GB) : qwen3:14b OU qwen2.5vl:7b (un à la fois)
 *   - Tier-high (24+ GB) : qwen3:14b + qwen2.5vl:7b en parallèle
 *   - Tier-pro (48+ GB)  : qwen3:32b + outils additionnels
 *
 * Quand la requête utilisateur dépasse les capacités du tier (typique :
 * image attachée à un agent vision sur tier-low/mid avec qwen3 chargé),
 * on propose un fallback cloud BYOK (lib/cloud-providers.ts) plutôt que
 * de planter en OOM Ollama.
 *
 * Stratégie de détection :
 *   1. `nvidia-smi` (Docker host networking permet d'appeler nvidia-smi
 *      depuis aibox-app même si le container n'a pas l'accès GPU direct,
 *      via le binaire monté ou via un endpoint Ollama)
 *   2. Fallback : appel à Ollama `/api/ps` qui expose le total mémoire
 *      ainsi que les modèles loaded (avec leur SIZE)
 *   3. Si rien ne marche : tier-low conservateur
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

export type GpuTier = "tier-low" | "tier-mid" | "tier-high" | "tier-pro" | "tier-cpu";

export interface GpuCapabilities {
  /** VRAM totale détectée en MB. 0 si pas de GPU NVIDIA. */
  vram_total_mb: number;
  /** VRAM libre estimée en MB (à l'instant). */
  vram_free_mb: number;
  /** Modèle GPU (ex: "NVIDIA GeForce RTX 4070 SUPER"). */
  gpu_name: string | null;
  /** Driver NVIDIA détecté. */
  driver_version: string | null;
  /** Tier dérivé de vram_total_mb. */
  tier: GpuTier;
  /** Le tier permet-il de faire tourner un modèle vision local (qwen2.5vl:7b)
   *  EN PLUS du modèle texte principal ? Sur tier-low/mid, NON → bascule
   *  cloud nécessaire pour les requêtes vision qui arrivent quand le
   *  modèle texte est déjà loadé. */
  can_run_vision_concurrent: boolean;
  /** Le tier permet-il un modèle 14B+ ? */
  can_run_14b: boolean;
  /** Le tier permet-il un modèle 32B+ ? */
  can_run_32b: boolean;
  /** Source de la détection (utile au debug). */
  detection_source: "nvidia-smi" | "ollama-ps" | "default-cpu";
  /** Timestamp de la détection (cache 60 s côté caller). */
  detected_at: number;
}

function classifyTier(vram_mb: number): GpuTier {
  if (vram_mb === 0) return "tier-cpu";
  if (vram_mb < 8 * 1024) return "tier-low";       // < 8 GB
  if (vram_mb < 16 * 1024) return "tier-mid";      // 8-16 GB (4070 Super = 12 GB)
  if (vram_mb < 32 * 1024) return "tier-high";     // 16-32 GB (4090, 5080)
  return "tier-pro";                                // 32+ GB (H100, A6000)
}

function deriveCapabilities(
  vram_total_mb: number,
  vram_free_mb: number,
  gpu_name: string | null,
  driver_version: string | null,
  detection_source: GpuCapabilities["detection_source"],
): GpuCapabilities {
  const tier = classifyTier(vram_total_mb);
  return {
    vram_total_mb,
    vram_free_mb,
    gpu_name,
    driver_version,
    tier,
    // Vision concurrent = peut charger qwen2.5vl:7b (≈14 GB partial GPU)
    // EN MÊME TEMPS que qwen3:14b (10 GB). Faisable sur tier-high (24 GB
    // = 4090) et tier-pro (32+ GB).
    can_run_vision_concurrent: vram_total_mb >= 24 * 1024,
    can_run_14b: vram_total_mb >= 10 * 1024,
    can_run_32b: vram_total_mb >= 24 * 1024,
    detection_source,
    detected_at: Date.now(),
  };
}

/** Tente nvidia-smi en CLI (le binaire est mounté dans aibox-app via
 *  Docker --gpus all si nvidia-container-toolkit est installé). */
async function detectViaNvidiaSmi(): Promise<GpuCapabilities | null> {
  try {
    const { stdout } = await execFileP(
      "nvidia-smi",
      [
        "--query-gpu=memory.total,memory.free,name,driver_version",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
    );
    const line = stdout.trim().split("\n")[0];
    if (!line) return null;
    const parts = line.split(",").map((p) => p.trim());
    const vram_total_mb = parseInt(parts[0] || "0", 10);
    const vram_free_mb = parseInt(parts[1] || "0", 10);
    const gpu_name = parts[2] || null;
    const driver_version = parts[3] || null;
    if (!vram_total_mb) return null;
    return deriveCapabilities(
      vram_total_mb,
      vram_free_mb,
      gpu_name,
      driver_version,
      "nvidia-smi",
    );
  } catch {
    return null;
  }
}

/** Fallback : interroge Ollama /api/ps qui expose les modèles loaded.
 *  Pas la VRAM totale exacte, mais on peut estimer via les SIZE des
 *  modèles loaded vs ce qui rentre. Si Ollama répond → on a au moins la
 *  preuve qu'un GPU est dispo, on classifie au tier-mid par défaut. */
async function detectViaOllamaPs(): Promise<GpuCapabilities | null> {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { models?: Array<{ size_vram?: number }> };
    const totalLoadedVram = (j.models || []).reduce(
      (a, m) => a + (m.size_vram || 0), 0,
    );
    // Heuristique : on ne sait pas la taille totale. On retourne tier-mid
    // (12 GB) en assumant une 4070 Super par défaut. La vraie détection
    // doit utiliser nvidia-smi.
    return deriveCapabilities(
      12 * 1024,
      Math.max(0, 12 * 1024 - Math.floor(totalLoadedVram / (1024 * 1024))),
      null,
      null,
      "ollama-ps",
    );
  } catch {
    return null;
  }
}

let cached: GpuCapabilities | null = null;
const CACHE_TTL_MS = 60_000;

/** Détecte les capacités GPU. Cache 60 s pour éviter de spawner
 *  nvidia-smi à chaque appel. */
export async function detectGpuCapabilities(): Promise<GpuCapabilities> {
  if (cached && Date.now() - cached.detected_at < CACHE_TTL_MS) {
    return cached;
  }
  const fromNvidia = await detectViaNvidiaSmi();
  if (fromNvidia) {
    cached = fromNvidia;
    return cached;
  }
  const fromOllama = await detectViaOllamaPs();
  if (fromOllama) {
    cached = fromOllama;
    return cached;
  }
  // Pas de GPU détecté → mode CPU pure (très lent, on devrait switcher
  // vers cloud BYOK par défaut).
  cached = deriveCapabilities(0, 0, null, null, "default-cpu");
  return cached;
}

/** Reset du cache (utile en test ou après reboot GPU). */
export function resetGpuCache(): void {
  cached = null;
}
