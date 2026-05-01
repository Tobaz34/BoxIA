/**
 * POST /api/dify/run-workflow — exécute un workflow Dify.
 *
 * Body : { slug: string, inputs: Record<string,unknown>, query?: string }
 *
 * Pour les apps mode="workflow" → POST /v1/workflows/run (Dify App API)
 * Pour les apps mode="advanced-chat" → POST /v1/chat-messages (cas edge,
 * peut être lancé depuis cette page si le client le veut).
 *
 * Réponse : streaming SSE re-proxifié vers le client.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getInstalledAgent } from "@/lib/installed-agents";
import { roleFromGroups } from "@/lib/agents";
import { DIFY_BASE_URL } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: { slug?: string; inputs?: Record<string, unknown>; query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  const agent = await getInstalledAgent(body.slug);
  if (!agent) {
    return NextResponse.json({ error: "unknown_workflow" }, { status: 404 });
  }

  // Check rôle
  const groups = (session.user as { groups?: string[] }).groups || [];
  const role = roleFromGroups(groups);
  if (agent.allowed_roles && agent.allowed_roles.length > 0 && !agent.allowed_roles.includes(role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // Détermine la route Dify selon le mode
  const isWorkflow = agent.mode === "workflow";
  const path = isWorkflow ? "/v1/workflows/run" : "/v1/chat-messages";

  const payload: Record<string, unknown> = {
    inputs: body.inputs || {},
    response_mode: "streaming",
    user: session.user.email,
  };
  // Pour chat-messages on doit aussi avoir une `query`
  if (!isWorkflow) {
    payload.query = body.query || "(workflow exécuté depuis l'UX)";
    payload.conversation_id = "";
  }

  const upstream = await fetch(`${DIFY_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${agent.api_key}`,
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_upstream_error", status: upstream.status, body: text.slice(0, 500) },
      { status: 502 },
    );
  }

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
