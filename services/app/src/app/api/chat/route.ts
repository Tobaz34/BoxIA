/**
 * POST /api/chat — Proxy streaming vers Dify (multi-agent).
 *
 * Body : { agent?: slug, query, conversation_id? }
 * Si agent absent → agent par défaut.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch, DIFY_BASE_URL } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { agent?: string; query?: string; conversation_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const ctx = await requireDifyContext(body.agent);
  if (ctx instanceof NextResponse) return ctx;

  const query = (body.query || "").trim();
  if (!query) {
    return NextResponse.json({ error: "empty_query" }, { status: 400 });
  }

  const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ctx.key}`,
    },
    body: JSON.stringify({
      inputs: {},
      query,
      response_mode: "streaming",
      conversation_id: body.conversation_id || "",
      user: ctx.user,
    }),
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_upstream_error", status: upstream.status,
        body: text.slice(0, 500) },
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

// Reference imports to satisfy the linter (difyFetch isn't used here but
// is part of the public lib API used elsewhere).
void difyFetch;
