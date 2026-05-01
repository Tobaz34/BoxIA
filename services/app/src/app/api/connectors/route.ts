/**
 * GET /api/connectors — liste enrichie : catalogue + état persistant.
 *
 * ?status=active|inactive|hidden  → filtre
 * ?category=storage|email|...     → filtre
 * ?include_restricted=1 (admin)   → renvoie aussi les connecteurs où le
 *                                   user n'a pas accès (sinon filtrés)
 *
 * RBAC Phase 1 : si l'utilisateur n'est pas admin, les connecteurs avec
 * `allowed_roles` qui excluent son rôle sont masqués (sauf si
 * include_restricted). Le sidebar (ConnectorsStatus) et la recherche
 * RAG passent ici, et ne doivent pas voir les connecteurs interdits.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { publicCatalog, CATEGORIES } from "@/lib/connectors";
import {
  listStates,
  publicState,
  userCanAccessConnector,
  type ConnectorStatus,
  type ConnectorRole,
} from "@/lib/connectors-state";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Récupère le rôle pour filtrer (RBAC Phase 1).
  const userRole: ConnectorRole = (() => {
    const u = session.user as { isAdmin?: boolean; role?: string };
    if (u.isAdmin) return "admin";
    if (u.role === "manager") return "manager";
    return "employee";
  })();
  const userEmail = session.user.email;

  const { searchParams } = new URL(req.url);
  const filterStatus = searchParams.get("status") as ConnectorStatus | null;
  const filterCategory = searchParams.get("category");
  // ?include_restricted=1 : admin only — ramène TOUS les connecteurs même
  // ceux où le user n'a pas accès (utile pour l'écran admin /connectors
  // qui doit montrer toutes les permissions).
  const includeRestricted =
    userRole === "admin" && searchParams.get("include_restricted") === "1";

  const states = await listStates();
  const catalog = publicCatalog();

  const items = catalog.map((spec) => {
    const st = states[spec.slug];
    const status: ConnectorStatus = st?.status || "inactive";
    const accessible = st
      ? userCanAccessConnector(st, { role: userRole, email: userEmail })
      : true; // Pas d'état → connecteur jamais activé → visible pour activation potentielle
    return {
      ...spec,
      status,
      // Public state (jamais les valeurs secrètes, mais inclut les permissions)
      state: st ? publicState(spec.slug, st) : null,
      accessible,
    };
  });

  let filtered = items;
  if (filterStatus) {
    filtered = filtered.filter((i) => i.status === filterStatus);
  }
  if (filterCategory) {
    filtered = filtered.filter((i) => i.category === filterCategory);
  }

  // RBAC : si non-admin (ou admin sans include_restricted), masque les
  // connecteurs auxquels le user n'a pas accès. La sidebar et les
  // recherches RAG passent par cet endpoint et ne doivent pas voir les
  // connecteurs interdits. Les admins voient TOUT par défaut (mais avec
  // un flag `accessible: false` que l'UI peut utiliser pour griser).
  if (!includeRestricted && userRole !== "admin") {
    filtered = filtered.filter((i) => i.accessible);
  }

  return NextResponse.json({
    connectors: filtered,
    categories: CATEGORIES,
    summary: {
      total: items.length,
      active: items.filter((i) => i.status === "active").length,
      hidden: items.filter((i) => i.status === "hidden").length,
      // Les admins voient combien sont restrictés (pour info)
      restricted: userRole === "admin"
        ? items.filter((i) => !i.accessible).length
        : undefined,
    },
    user_role: userRole,
  });
}
