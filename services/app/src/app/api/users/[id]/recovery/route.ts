/**
 * POST /api/users/[id]/recovery — génère un nouveau lien de définition
 * de mot de passe ou, en fallback, un mot de passe temporaire.
 *
 * Authentik a besoin d'un "recovery flow" configuré pour générer un
 * lien (qui vit aussi côté backend Authentik). Si ce flow n'est pas
 * disponible dans le tenant, on tombe sur un mdp aléatoire 12c qu'on
 * set directement via /set_password/.
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

  // 1. Tentative recovery link officiel
  try {
    const r = await akFetch(`/core/users/${id}/recovery/`, { method: "POST" });
    if (r.ok) {
      const j = await r.json();
      if (j.link) {
        return NextResponse.json({ link: j.link, temp_password: null });
      }
    }
  } catch { /* fallthrough */ }

  // 2. Fallback : génère un mdp temporaire et le set
  const tempPassword = generateTempPassword();
  const set = await akFetch(`/core/users/${id}/set_password/`, {
    method: "POST",
    body: JSON.stringify({ password: tempPassword }),
  });
  if (!set.ok) {
    const txt = await set.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: set.status, body: txt.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ link: null, temp_password: tempPassword });
}

function generateTempPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let out = "";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < 12; i++) out += chars[bytes[i]! % chars.length];
  return out;
}
