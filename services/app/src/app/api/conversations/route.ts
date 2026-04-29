/**
 * GET /api/conversations — liste les conversations de l'utilisateur courant.
 *
 * Proxy vers Dify /v1/conversations?user=<email>&limit=N.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await requireDifyContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const limit = searchParams.get("limit") || "50";
  const lastId = searchParams.get("last_id") || "";

  const params = new URLSearchParams({ user: ctx.user, limit });
  if (lastId) params.set("last_id", lastId);

  const r = await difyFetch(`/v1/conversations?${params.toString()}`, {
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
