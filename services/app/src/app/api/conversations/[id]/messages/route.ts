/**
 * GET /api/conversations/[id]/messages — historique des messages.
 *
 * Dify renvoie chaque "message" comme une paire (query, answer). Côté client
 * on les éclate en 2 messages UI distincts.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireDifyContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") || "50";
  const firstId = searchParams.get("first_id") || "";

  const params2 = new URLSearchParams({
    user: ctx.user,
    conversation_id: id,
    limit,
  });
  if (firstId) params2.set("first_id", firstId);

  const r = await difyFetch(`/v1/messages?${params2.toString()}`, {
    key: ctx.key,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_error", status: r.status, body: text.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json(await r.json());
}
