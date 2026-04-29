/**
 * GET /api/messages/[id]/suggested — questions suggérées après une réponse.
 *
 * Dify retourne 3 questions suggérées si la feature est activée sur l'app
 * (suggested_questions_after_answer.enabled = true → on l'a mis dans le
 * model-config par défaut).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireDifyContext, difyFetch } from "@/lib/dify";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ctx = await requireDifyContext();
  if (ctx instanceof NextResponse) return ctx;

  const r = await difyFetch(
    `/v1/messages/${id}/suggested?user=${encodeURIComponent(ctx.user)}`,
    { key: ctx.key },
  );
  if (!r.ok) {
    // 404 si la feature n'est pas activée — pas grave, on renvoie []
    return NextResponse.json({ data: [] });
  }
  return NextResponse.json(await r.json());
}
