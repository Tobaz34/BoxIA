/**
 * PATCH /api/connectors/<slug>/permissions — admin only.
 *
 * Modifie les permissions RBAC d'un connecteur (allowed_roles + allowed_users).
 *
 * Body : {
 *   allowed_roles?: ("admin"|"manager"|"employee")[],   // [] ou null = ouvert à tous
 *   allowed_users?: string[],                            // [] = pas de whitelist email
 * }
 *
 * Audit : action `connector.permissions_change` (cf. lib/app-audit.ts).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { setConnectorPermissions, getState, type ConnectorRole } from "@/lib/connectors-state";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const VALID_ROLES = new Set<ConnectorRole>(["admin", "manager", "employee"]);

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { slug } = await params;
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  // Le connecteur doit exister à l'état (sinon pas la peine de poser des permissions)
  const existing = await getState(slug);
  if (!existing) {
    return NextResponse.json(
      { error: "not_found", hint: "Active le connecteur avant de définir ses permissions." },
      { status: 404 },
    );
  }

  let body: { allowed_roles?: unknown; allowed_users?: unknown };
  try {
    body = (await req.json()) as { allowed_roles?: unknown; allowed_users?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  // Valide allowed_roles
  let allowed_roles: ConnectorRole[] = [];
  if (Array.isArray(body.allowed_roles)) {
    allowed_roles = (body.allowed_roles as unknown[]).filter(
      (r): r is ConnectorRole => typeof r === "string" && VALID_ROLES.has(r as ConnectorRole),
    );
  }

  // Valide allowed_users (emails simples — pas de regex stricte)
  let allowed_users: string[] = [];
  if (Array.isArray(body.allowed_users)) {
    allowed_users = (body.allowed_users as unknown[])
      .filter((u): u is string => typeof u === "string")
      .map((u) => u.trim())
      .filter((u) => u.length > 0 && u.length < 200 && u.includes("@"));
  }

  try {
    const next = await setConnectorPermissions(slug, allowed_roles, allowed_users);

    await logAction(
      "connector.permissions_change",
      session.user.email,
      {
        slug,
        allowed_roles: next.allowed_roles || [],
        allowed_users_count: (next.allowed_users || []).length,
      },
      ipFromHeaders(req),
    );

    return NextResponse.json({
      ok: true,
      slug: next.slug,
      allowed_roles: next.allowed_roles || [],
      allowed_users: next.allowed_users || [],
      permissions_updated_at: next.permissions_updated_at,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "permissions_update_failed", detail: String(e).slice(0, 300) },
      { status: 500 },
    );
  }
}
