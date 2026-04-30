/**
 * POST /api/system/warmup — pre-charge les modèles Ollama en mémoire VRAM.
 *
 * Au démarrage de l'app (ou à la 1re visite d'un user), appelle Ollama
 * pour qu'il charge les modèles principaux (qwen2.5:7b, qwen2.5vl:7b,
 * bge-m3) en GPU. Évite la latence de cold-start (~5-10 s) à la 1re
 * question du user.
 *
 * Ollama supporte ça via :
 *   POST /api/generate
 *   { "model": "qwen2.5:7b", "prompt": "", "keep_alive": "30m" }
 * → load only, no generation.
 *
 * Idempotent. Appelé en background (fire-and-forget) par le client.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

/** Modèles à pre-warm. La liste pourrait être configurable via env mais
 *  les 3 ci-dessous couvrent 99 % des cas (chat texte, vision, embeddings). */
const MODELS_TO_WARM = ["qwen2.5:7b", "qwen2.5vl:7b", "bge-m3"];

async function warmOne(model: string): Promise<{ model: string; ok: boolean; ms: number; error?: string }> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: "",
        keep_alive: "30m",   // garde le modèle 30 min en VRAM
      }),
      signal: AbortSignal.timeout(60_000),  // load peut prendre ~30s à froid
    });
    const ms = Date.now() - t0;
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { model, ok: false, ms, error: `HTTP ${r.status}: ${text.slice(0, 100)}` };
    }
    return { model, ok: true, ms };
  } catch (e: unknown) {
    const ms = Date.now() - t0;
    return { model, ok: false, ms, error: (e as Error).message };
  }
}

export async function POST() {
  // Aucune auth requise : l'effet est purement perf, et l'endpoint ne
  // donne accès à aucune donnée sensible.
  const results = await Promise.all(MODELS_TO_WARM.map(warmOne));
  return NextResponse.json({
    base: OLLAMA_BASE_URL,
    results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      total_ms: Math.max(...results.map((r) => r.ms)),
    },
  });
}

export async function GET() {
  // Permet à un health-check externe de juste savoir si Ollama répond.
  try {
    const r = await fetch(`${OLLAMA_BASE_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!r.ok) return NextResponse.json({ ok: false }, { status: 502 });
    const j = await r.json();
    return NextResponse.json({
      ok: true,
      models: (j.models || []).map((m: { name: string }) => m.name),
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
