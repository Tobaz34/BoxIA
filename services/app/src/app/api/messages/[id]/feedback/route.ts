/**
 * POST /api/messages/[id]/feedback — thumbs up / down sur une réponse.
 *
 * Body: { rating: "like" | "dislike" | null, content?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireDifyContext();
  if (ctx instanceof NextResponse) return ctx;

  let body: { rating?: "like" | "dislike" | null; content?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const r = await difyFetch(`/v1/messages/${id}/feedbacks`, {
    method: "POST",
    key: ctx.key,
    body: JSON.stringify({
      user: ctx.user,
      rating: body.rating ?? null,
      content: body.content || "",
    }),
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
