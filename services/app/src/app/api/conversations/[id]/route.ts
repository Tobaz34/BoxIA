/**
 * DELETE /api/conversations/[id]?agent=<slug>
 * PATCH  /api/conversations/[id]?agent=<slug> body: { name } | { auto_generate: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const ctx = await requireDifyContext(searchParams.get("agent") || undefined);
  if (ctx instanceof NextResponse) return ctx;

  const r = await difyFetch(`/v1/conversations/${id}`, {
    method: "DELETE",
    key: ctx.key,
    body: JSON.stringify({ user: ctx.user }),
  });
  if (!r.ok && r.status !== 204) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "dify_error", status: r.status, body: text.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { searchParams } = new URL(req.url);
  const ctx = await requireDifyContext(searchParams.get("agent") || undefined);
  if (ctx instanceof NextResponse) return ctx;

  let body: { name?: string; auto_generate?: boolean };
  try {
    body = await req.json();
  } catch {
    body = { auto_generate: true };
  }

  const r = await difyFetch(`/v1/conversations/${id}/name`, {
    method: "POST",
    key: ctx.key,
    body: JSON.stringify({ user: ctx.user, ...body }),
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
