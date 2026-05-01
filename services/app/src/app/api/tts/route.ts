/**
 * POST /api/tts — synthèse vocale via Piper (OpenTTS HTTP wrapper).
 *
 * Body : { text: string, voice?: string }
 * Retour : audio/wav stream (binary)
 *
 * Si TTS_BACKEND_URL n'est pas défini ou le service est indisponible,
 * répond 503 avec { error: "tts_unavailable" } → le front fallback
 * sur Web Speech API natif (cf. lib/use-speech.ts).
 *
 * Auth : session NextAuth requise (pas de TTS anonyme — coût compute).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TTS_URL = process.env.TTS_BACKEND_URL || "";
const DEFAULT_VOICE =
  process.env.TTS_DEFAULT_VOICE || "larynx2:fr_FR/upmc-jessica-medium";
const TTS_TIMEOUT_MS = Number(process.env.TTS_TIMEOUT_MS || 20000);

interface PostBody {
  text?: string;
  voice?: string;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!TTS_URL) {
    return NextResponse.json(
      { error: "tts_unavailable", reason: "TTS_BACKEND_URL not configured" },
      { status: 503 },
    );
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const text = (body.text || "").trim();
  if (!text) {
    return NextResponse.json({ error: "empty_text" }, { status: 400 });
  }
  // Garde-fou : OpenTTS ralentit beaucoup au-delà de 2-3k chars. Le front
  // doit chunker les longs messages de toute façon (max ~30s d'audio
  // par requête est confortable).
  const safeText = text.slice(0, 4000);
  const voice = body.voice || DEFAULT_VOICE;

  const params = new URLSearchParams({
    voice,
    text: safeText,
  });
  const upstream = `${TTS_URL}/api/tts?${params}`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TTS_TIMEOUT_MS);
    const r = await fetch(upstream, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok || !r.body) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json(
        { error: "tts_upstream_error", status: r.status, body: txt.slice(0, 200) },
        { status: 502 },
      );
    }
    // Stream l'audio au client tel quel (audio/wav)
    return new Response(r.body, {
      status: 200,
      headers: {
        "Content-Type": r.headers.get("Content-Type") || "audio/wav",
        "Cache-Control": "no-store",
      },
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: "tts_fetch_failed", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }
}

/** GET pour exposer si le backend est dispo (utilisé par useTTS pour
 *  décider Piper vs Web Speech API). */
export async function GET() {
  return NextResponse.json({
    backend: TTS_URL ? "piper" : "web-speech",
    voice: DEFAULT_VOICE,
  });
}
