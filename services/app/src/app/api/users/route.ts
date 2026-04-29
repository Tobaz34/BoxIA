/**
 * GET  /api/users        — liste les utilisateurs (admin only)
 * POST /api/users        — invite un nouvel utilisateur
 *
 * body POST: { name, email, role: 'admin' | 'manager' | 'employee', send_invite?: boolean }
 */
import { NextRequest, NextResponse } from "next/server";
import {
  requireAdmin, akFetch, ADMIN_GROUP_NAME, MANAGER_GROUP_NAME,
  EMPLOYEE_GROUP_NAME, toPublicUser, type AkUser, type AkGroup,
} from "@/lib/authentik";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search") || "";
  const params = new URLSearchParams({ ordering: "-date_joined", page_size: "100" });
  if (search) params.set("search", search);

  const r = await akFetch(`/core/users/?${params}`);
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_error", status: r.status, body: body.slice(0, 200) },
      { status: 502 },
    );
  }
  const j = await r.json();
  const raw = (j.results || []) as AkUser[];

  // Authentik renvoie groups (PKs UUID) mais pas leurs noms — on doit
  // résoudre. On charge tous les groupes une fois et on map.
  const gr = await akFetch(`/core/groups/?page_size=200`);
  let groupsByPk: Record<string, string> = {};
  if (gr.ok) {
    const gj = await gr.json();
    for (const g of (gj.results || []) as AkGroup[]) {
      groupsByPk[g.pk] = g.name;
    }
  }

  const users = raw.map((u) => {
    const groupNames = (u.groups || []).map((pk) => groupsByPk[pk] || "");
    return toPublicUser({
      ...u,
      groups_obj: groupNames.map((name, i) => ({
        pk: u.groups![i] as string,
        name,
      })),
    });
  });
  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;

  let body: { name?: string; email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const name = (body.name || "").trim();
  const email = (body.email || "").trim().toLowerCase();
  const role = (body.role || "employee").toLowerCase();
  if (!name || !email || !email.includes("@")) {
    return NextResponse.json({ error: "name_email_required" }, { status: 400 });
  }
  if (!["admin", "manager", "employee"].includes(role)) {
    return NextResponse.json({ error: "bad_role" }, { status: 400 });
  }

  // Username = partie locale de l'email (Authentik n'autorise pas les @)
  const username = email.split("@")[0]
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .toLowerCase();

  // Cherche le groupe cible (admin = "authentik Admins", manager / employee = nos groupes)
  const targetGroup =
    role === "admin" ? ADMIN_GROUP_NAME :
    role === "manager" ? MANAGER_GROUP_NAME :
    EMPLOYEE_GROUP_NAME;

  const gr = await akFetch(`/core/groups/?page_size=200`);
  if (!gr.ok) {
    return NextResponse.json(
      { error: "groups_unreachable" }, { status: 502 },
    );
  }
  const gj = await gr.json();
  const groupPk = (gj.results || []).find(
    (g: AkGroup) => g.name === targetGroup,
  )?.pk;
  if (!groupPk) {
    return NextResponse.json(
      { error: "group_not_found", group: targetGroup }, { status: 500 },
    );
  }

  // Crée l'utilisateur (sans password — sera défini via le lien de
  // récupération que l'admin partagera).
  const create = await akFetch(`/core/users/`, {
    method: "POST",
    body: JSON.stringify({
      username,
      name,
      email,
      is_active: true,
      groups: [groupPk],
      attributes: {},
      path: "users",
      type: "internal",
    }),
  });
  if (!create.ok) {
    const txt = await create.text().catch(() => "");
    return NextResponse.json(
      { error: "ak_create_failed", status: create.status, body: txt.slice(0, 300) },
      { status: 502 },
    );
  }
  const u = (await create.json()) as AkUser;

  // Génère un lien de définition de mot de passe (recovery link).
  // POST /core/users/{pk}/recovery/  → { link: "..." }
  let recoveryLink: string | null = null;
  try {
    const rec = await akFetch(`/core/users/${u.pk}/recovery/`, {
      method: "POST",
    });
    if (rec.ok) {
      const rj = await rec.json();
      recoveryLink = rj.link || null;
    }
  } catch { /* noop */ }

  return NextResponse.json({
    user: toPublicUser({
      ...u,
      groups_obj: [{ pk: groupPk, name: targetGroup }],
    }),
    recovery_link: recoveryLink,
  });
}
