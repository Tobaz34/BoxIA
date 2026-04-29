/**
 * GET /api/audit — log d'audit (proxy vers les events Authentik).
 *
 * Authentik trace automatiquement toutes les actions importantes :
 * login / logout / model_created / model_updated / configuration_error /
 * password_set / suspicious_request / user_write / etc.
 *
 * Réservé aux admins. Filtres : ?action=... &user=... &page=...
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, akFetch } from "@/lib/authentik";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const params = new URLSearchParams({
    page_size: searchParams.get("page_size") || "50",
    ordering: "-created",
  });
  // Filtres optionnels passés tel quel à Authentik
  for (const k of ["action", "client_ip", "username", "page"]) {
    const v = searchParams.get(k);
    if (v) params.set(k, v);
  }

  const r = await akFetch(`/events/events/?${params}`);
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: r.status, body: txt.slice(0, 200) },
      { status: 502 },
    );
  }
  const j = await r.json();
  return NextResponse.json(j);
}
