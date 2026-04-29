/**
 * GET /api/conversations?agent=<slug>&limit=&last_id=
 *
 * Liste les conversations de l'utilisateur courant pour l'agent demandé.
 * Chaque agent (= app Dify) a son propre historique.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const agent = searchParams.get("agent") || undefined;

  const ctx = await requireDifyContext(agent);
  if (ctx instanceof NextResponse) return ctx;

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
