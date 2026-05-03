/**
 * GET /api/system/gpu-capabilities
 *
 * Expose la VRAM disponible + le tier dérivé. Utilisé par :
 *  - Settings page (affichage info "Cette box tourne sur RTX 4070 Super
 *    12 GB, tier mid")
 *  - Chat.tsx (décision automatique fallback cloud quand le tier ne
 *    permet pas la requête : ex. vision sur tier-low/mid)
 *  - install.sh (futur : sélection des modèles par défaut au reset cycle)
 *
 * Pas d'auth — info hardware non sensible. (NB : on n'expose PAS le
 * driver_version sensible ni la liste précise des modèles loaded à des
 * non-admins, juste les capabilities agrégées.)
 */
import { NextResponse } from "next/server";
import { detectGpuCapabilities } from "@/lib/gpu-capabilities";

export const dynamic = "force-dynamic";

export async function GET() {
  const caps = await detectGpuCapabilities();
  return NextResponse.json({
    tier: caps.tier,
    vram_total_mb: caps.vram_total_mb,
    vram_free_mb: caps.vram_free_mb,
    gpu_name: caps.gpu_name,
    can_run_14b: caps.can_run_14b,
    can_run_32b: caps.can_run_32b,
    can_run_vision_concurrent: caps.can_run_vision_concurrent,
    detection_source: caps.detection_source,
  });
}
