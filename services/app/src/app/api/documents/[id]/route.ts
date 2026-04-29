/**
 * DELETE /api/documents/[id] — retire un document de la KB.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireKbContext, kbFetch } from "@/lib/dify-kb";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireKbContext();
  if (ctx instanceof NextResponse) return ctx;

  const r = await kbFetch(`/v1/datasets/${ctx.datasetId}/documents/${id}`, {
    method: "DELETE",
    key: ctx.key,
  });
  if (!r.ok && r.status !== 204) {
    const text = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "kb_error", status: r.status, body: text.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
