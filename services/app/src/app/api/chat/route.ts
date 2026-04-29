/**
 * POST /api/chat — Proxy streaming vers Dify.
 *
 * Le front envoie { query, conversation_id? }. On relaie vers
 *   POST {DIFY_BASE_URL}/v1/chat-messages
 * avec response_mode=streaming et on pipe le flux SSE de Dify directement
 * au client. L'identifiant `user` Dify = email du user authentifié (NextAuth)
 * pour que Dify scope l'historique.
 *
 * Sécurité :
 *   - Auth NextAuth obligatoire (sinon 401)
 *   - DIFY_DEFAULT_APP_API_KEY requis (provisionné au wizard / install)
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const DIFY_BASE_URL = process.env.DIFY_BASE_URL || "http://localhost:8081";
const DIFY_API_KEY  = process.env.DIFY_DEFAULT_APP_API_KEY || "";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!DIFY_API_KEY) {
    return NextResponse.json(
      {
        error: "no_default_agent",
        message:
          "Aucun assistant par défaut n'est configuré. Allez dans « Mes assistants » pour en créer un.",
      },
      { status: 503 },
    );
  }

  let body: { query?: string; conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const query = (body.query || "").trim();
  if (!query) {
    return NextResponse.json({ error: "empty_query" }, { status: 400 });
  }

  const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DIFY_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: {},
      query,
      response_mode: "streaming",
      conversation_id: body.conversation_id || "",
      user: session.user.email,
    }),
    // signal pour annulation côté serveur si le client coupe
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_upstream_error", status: upstream.status, body: text.slice(0, 500) },
      { status: 502 },
    );
  }

  // Pipe direct du flux SSE de Dify vers le client. Pas de buffering.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
