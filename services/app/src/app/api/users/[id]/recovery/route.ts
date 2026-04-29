/**
 * POST /api/users/[id]/recovery — génère un nouveau lien de définition
 * de mot de passe pour le user (à transmettre par l'admin par email/SMS).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, akFetch } from "@/lib/authentik";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  const r = await akFetch(`/core/users/${id}/recovery/`, { method: "POST" });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: r.status, body: txt.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json(await r.json());
}
