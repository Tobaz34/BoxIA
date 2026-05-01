/**
 * GET /api/agents-tools/list_connectors
 * Tool pour l'agent Concierge BoxIA : liste les connecteurs avec statut.
 */
import { NextResponse } from "next/server";
import { publicCatalog } from "@/lib/connectors";
import { listStates, publicState } from "@/lib/connectors-state";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const states = await listStates();
  const catalog = publicCatalog();
  const connectors = catalog.map((spec) => {
    const st = states[spec.slug];
    return {
      slug: spec.slug,
      name: spec.name,
      icon: spec.icon,
      category: spec.category,
      description: spec.description,
      status: st?.status || "inactive",
      last_sync_at: st?.last_sync_at || null,
      restricted:
        !!(st?.allowed_roles && st.allowed_roles.length > 0) ||
        !!(st?.allowed_users && st.allowed_users.length > 0),
      // Public state filtré
      state: st ? publicState(spec.slug, st) : null,
    };
  });

  // Compact summary que l'agent peut lire facilement
  const active = connectors.filter((c) => c.status === "active");
  const available = connectors.filter((c) => c.status === "inactive");

  return NextResponse.json({
    summary: {
      total: connectors.length,
      active: active.length,
      available: available.length,
    },
    active: active.map((c) => ({
      slug: c.slug, name: c.name, icon: c.icon, category: c.category,
      last_sync_at: c.last_sync_at,
    })),
    available: available.map((c) => ({
      slug: c.slug, name: c.name, icon: c.icon, category: c.category,
      description: c.description,
    })),
    deep_link: "/connectors",
  });
}
