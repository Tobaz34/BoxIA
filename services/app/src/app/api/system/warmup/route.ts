/**
 * POST /api/system/warmup — pre-charge les modèles Ollama en mémoire VRAM.
 *
 * Au démarrage de l'app (ou à la 1re visite d'un user), appelle Ollama
 * pour qu'il charge le modèle principal (LLM_MAIN, qwen3:14b par défaut)
 * et bge-m3 en GPU. Évite la latence de cold-start (~5-10 s) à la 1re
 * question du user.
 *
 * Le modèle vision (qwen2.5vl:7b) n'est PAS pre-warmé : sur un GPU 12 Go
 * il ne tient pas en VRAM en même temps que qwen3:14b — le warmer
 * évincerait le modèle principal, exactement l'inverse du but recherché.
 *
 * Ollama supporte ça via :
 *   POST /api/generate
 *   { "model": "qwen3:14b", "prompt": "", "keep_alive": "30m" }
 * → load only, no generation.
 *
 * Idempotent. Appelé en background (fire-and-forget) par le client.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

/** Modèles à pre-warm — alignés sur la stack courante via env, avec les
 *  défauts du provisioning (install.sh : LLM_MAIN=qwen3:14b). */
const MODELS_TO_WARM = [
  process.env.LLM_MAIN || "qwen3:14b",
  process.env.EMBEDDING_MODEL || "bge-m3",
];

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
  // Session requise : sans auth, n'importe qui sur le LAN pouvait
  // déclencher des loads répétés de modèles (éviction VRAM, charge GPU).
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
