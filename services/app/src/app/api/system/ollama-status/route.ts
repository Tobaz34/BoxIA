/**
 * GET /api/system/ollama-status
 *
 * Wrapper sur Ollama /api/ps qui expose la liste des modèles actuellement
 * loaded en VRAM. Utilisé par le widget LocalAiBadge dans le header pour
 * afficher en temps réel quel modèle est prêt à répondre, avec un
 * indicateur GPU vs CPU clair.
 *
 * Auth : pas requis (info pas sensible). Polling toutes les 10 s.
 *
 * Bug 2026-05-07 fix : avant, le calcul `processor` traitait tout cas
 * `size_vram = 0` (mode CPU pur) comme "100% GPU" à tort (bug
 * `m.size_vram && ...` était false → fallback "100% GPU"). Corrigé pour
 * détecter CPU pur, GPU pur, ou mode hybride avec breakdown précis.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

interface OllamaPsResponse {
  models?: Array<{
    name: string;
    size: number;
    size_vram?: number;
    expires_at?: string;
    details?: { parameter_size?: string };
  }>;
}

export type ProcessorMode = "gpu" | "cpu" | "hybrid" | "unknown";

export interface LoadedModelInfo {
  name: string;
  size_mb: number;
  size_vram_mb: number;
  parameter_size?: string;
  processor: string;       // "100% GPU" | "100% CPU" | "75% GPU + 25% CPU"
  processor_mode: ProcessorMode;
  gpu_pct: number;         // 0-100
  expires_at?: string;
}

/**
 * Calcule le mode processor depuis size + size_vram.
 *
 * - size_vram = 0 ET size > 0 → CPU pur (alerte)
 * - size_vram >= size → GPU pur (idéal)
 * - 0 < size_vram < size → partial offload (warning)
 * - size = 0 → unknown (Ollama répond bizarre)
 */
function computeProcessor(size: number, sizeVram: number): {
  processor: string;
  mode: ProcessorMode;
  gpu_pct: number;
} {
  if (size <= 0) {
    return { processor: "unknown", mode: "unknown", gpu_pct: 0 };
  }
  if (sizeVram <= 0) {
    return { processor: "100% CPU", mode: "cpu", gpu_pct: 0 };
  }
  if (sizeVram >= size) {
    return { processor: "100% GPU", mode: "gpu", gpu_pct: 100 };
  }
  const pctGpu = Math.round((sizeVram / size) * 100);
  return {
    processor: `${pctGpu}% GPU + ${100 - pctGpu}% CPU`,
    mode: "hybrid",
    gpu_pct: pctGpu,
  };
}

export async function GET() {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) {
      return NextResponse.json(
        {
          ok: false,
          loaded: [],
          warning: null,
          error: `HTTP ${r.status}`,
        },
        { status: 200 },
      );
    }
    const j = (await r.json()) as OllamaPsResponse;
    const loaded: LoadedModelInfo[] = (j.models || []).map((m) => {
      const sizeBytes = m.size || 0;
      const sizeVramBytes = m.size_vram || 0;
      const sizeMb = Math.round(sizeBytes / (1024 * 1024));
      const sizeVramMb = Math.round(sizeVramBytes / (1024 * 1024));
      const proc = computeProcessor(sizeBytes, sizeVramBytes);
      return {
        name: m.name,
        size_mb: sizeMb,
        size_vram_mb: sizeVramMb,
        parameter_size: m.details?.parameter_size,
        processor: proc.processor,
        processor_mode: proc.mode,
        gpu_pct: proc.gpu_pct,
        expires_at: m.expires_at,
      };
    });

    // Calcule un état global pour l'UI top bar.
    // Priorité d'affichage : CPU > hybrid > GPU > unknown.
    // Si N'IMPORTE QUEL modèle tourne en CPU pur ou hybride → on alerte
    // (l'admin doit savoir que les inférences sont lentes).
    let global_mode: ProcessorMode = "gpu";
    let warning: string | null = null;
    if (loaded.length === 0) {
      global_mode = "unknown";
    } else if (loaded.some((m) => m.processor_mode === "cpu")) {
      global_mode = "cpu";
      const cpuModels = loaded
        .filter((m) => m.processor_mode === "cpu")
        .map((m) => m.name)
        .join(", ");
      warning =
        `⚠️ Modèle(s) en CPU pur : ${cpuModels}. Inférence ~10-50× plus lente. ` +
        `Vérifier que le container Ollama a accès au GPU (--gpus all + nvidia-container-toolkit).`;
    } else if (loaded.some((m) => m.processor_mode === "hybrid")) {
      global_mode = "hybrid";
      const hybridModels = loaded
        .filter((m) => m.processor_mode === "hybrid")
        .map((m) => `${m.name} (${m.gpu_pct}% GPU)`)
        .join(", ");
      warning =
        `⚠️ Offload partiel CPU : ${hybridModels}. Le modèle dépasse la VRAM ` +
        `disponible et déborde sur la RAM CPU. Inférence dégradée.`;
    } else if (loaded.every((m) => m.processor_mode === "unknown")) {
      global_mode = "unknown";
    }

    return NextResponse.json({
      ok: true,
      loaded,
      global_mode,
      warning,
      ollama_url: OLLAMA_BASE_URL,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        loaded: [],
        global_mode: "unknown" as ProcessorMode,
        warning: null,
        error: String(e).slice(0, 100),
      },
      { status: 200 },
    );
  }
}
