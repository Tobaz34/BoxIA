/**
 * PATCH  /api/users/[id]   — modifie un user (rôle, statut actif)
 *                            body: { role?, is_active? }
 * DELETE /api/users/[id]   — désactive (we never hard-delete users)
 */
import { NextRequest, NextResponse } from "next/server";
import {
  requireAdmin, akFetch, ADMIN_GROUP_NAME, MANAGER_GROUP_NAME,
  EMPLOYEE_GROUP_NAME, type AkGroup, type AkUser,
} from "@/lib/authentik";

export const dynamic = "force-dynamic";

const ROLE_GROUPS = [ADMIN_GROUP_NAME, MANAGER_GROUP_NAME, EMPLOYEE_GROUP_NAME];

async function resolveGroupPk(name: string): Promise<string | null> {
  const r = await akFetch(`/core/groups/?page_size=200`);
  if (!r.ok) return null;
  const j = await r.json();
  return (j.results || []).find((g: AkGroup) => g.name === name)?.pk || null;
}

async function listGroupsByName(): Promise<Record<string, string>> {
  const r = await akFetch(`/core/groups/?page_size=200`);
  if (!r.ok) return {};
  const j = await r.json();
  const out: Record<string, string> = {};
  for (const g of (j.results || []) as AkGroup[]) out[g.name] = g.pk;
  return out;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  let body: { role?: string; is_active?: boolean; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof body.is_active === "boolean") updates.is_active = body.is_active;
  if (typeof body.name === "string" && body.name.trim()) {
    updates.name = body.name.trim();
  }

  // Changement de rôle = retire les groupes role précédents et ajoute le nouveau
  if (body.role) {
    if (!["admin", "manager", "employee"].includes(body.role)) {
      return NextResponse.json({ error: "bad_role" }, { status: 400 });
    }
    // Récupère le user pour son state actuel
    const ur = await akFetch(`/core/users/${id}/`);
    if (!ur.ok) {
      return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    }
    const u = (await ur.json()) as AkUser;
    const groupsByName = await listGroupsByName();

    // Retire tous les groupes role connus
    const rolePks = ROLE_GROUPS.map((n) => groupsByName[n]).filter(Boolean);
    const filtered = (u.groups || []).filter((pk) => !rolePks.includes(pk));

    const targetName =
      body.role === "admin" ? ADMIN_GROUP_NAME :
      body.role === "manager" ? MANAGER_GROUP_NAME :
      EMPLOYEE_GROUP_NAME;
    const targetPk = groupsByName[targetName];
    if (!targetPk) {
      return NextResponse.json(
        { error: "group_not_found", group: targetName }, { status: 500 },
      );
    }
    updates.groups = [...filtered, targetPk];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: true, updated: false });
  }

  const r = await akFetch(`/core/users/${id}/`, {
    method: "PATCH",
    body: JSON.stringify(updates),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: r.status, body: txt.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, updated: true });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Soft-delete : désactive plutôt que supprimer (préserve l'historique
  // des conversations Dify, les logs Authentik, etc.).
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;
  const { id } = await params;

  const r = await akFetch(`/core/users/${id}/`, {
    method: "PATCH",
    body: JSON.stringify({ is_active: false }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: r.status, body: txt.slice(0, 200) },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}

// Garde resolveGroupPk en référence pour future utilisation
void resolveGroupPk;
