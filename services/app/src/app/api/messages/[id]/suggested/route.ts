/** GET /api/messages/[id]/suggested?agent=<slug> — questions suggérées. */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const ctx = await requireDifyContext(searchParams.get("agent") || undefined);
  if (ctx instanceof NextResponse) return ctx;

  const r = await difyFetch(
    `/v1/messages/${id}/suggested?user=${encodeURIComponent(ctx.user)}`,
    { key: ctx.key },
  );
  if (!r.ok) {
    return NextResponse.json({ data: [] });
  }
  return NextResponse.json(await r.json());
}
