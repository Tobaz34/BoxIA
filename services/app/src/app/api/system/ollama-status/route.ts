/**
 * GET /api/system/ollama-status
 *
 * Wrapper sur Ollama /api/ps qui expose la liste des modèles actuellement
 * loaded en VRAM. Utilisé par le widget LocalAiBadge dans le header pour
 * afficher en temps réel quel modèle est prêt à répondre.
 *
 * Auth : pas requis (info pas sensible). Polling toutes les 10 s.
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

export async function GET() {
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/ps`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) {
      return NextResponse.json(
        { ok: false, loaded: [], error: `HTTP ${r.status}` },
        { status: 200 },  // 200 même si Ollama down — frontend gère "Aucun modèle"
      );
    }
    const j = (await r.json()) as OllamaPsResponse;
    const loaded = (j.models || []).map((m) => {
      const sizeBytes = m.size_vram || m.size || 0;
      const sizeMb = Math.round(sizeBytes / (1024 * 1024));
      // Ollama /api/ps n'expose pas le ratio CPU/GPU directement, mais
      // si size_vram < size c'est un partial offload. Heuristique :
      const isPartial = !!(m.size_vram && m.size && m.size_vram < m.size);
      const processor = isPartial
        ? `${Math.round((m.size_vram! / m.size) * 100)}% GPU`
        : "100% GPU";
      return {
        name: m.name,
        size_mb: sizeMb,
        parameter_size: m.details?.parameter_size,
        processor,
        expires_at: m.expires_at,
      };
    });
    return NextResponse.json({ ok: true, loaded, ollama_url: OLLAMA_BASE_URL });
  } catch (e) {
    return NextResponse.json(
      { ok: false, loaded: [], error: String(e).slice(0, 100) },
      { status: 200 },
    );
  }
}
