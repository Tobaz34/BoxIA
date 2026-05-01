/**
 * GET /api/agents-tools/list_marketplace_agents_fr
 * Templates agents BoxIA-FR pour le concierge.
 */
import { NextResponse } from "next/server";
import { readBoxiaFrCatalog } from "@/lib/boxia-fr-templates";
import { listInstalledAgents } from "@/lib/installed-agents";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  try {
    const catalog = await readBoxiaFrCatalog();
    const installed = await listInstalledAgents().catch(() => []);
    const installedSlugs = new Set(
      installed
        .map((a) => a.source_template_id)
        .filter((s): s is string => !!s)
        .map((s) => s.replace("boxia-fr:", "")),
    );

    return NextResponse.json({
      summary: {
        total: catalog.templates.length,
        installed: catalog.templates.filter((t) => installedSlugs.has(t.slug)).length,
      },
      templates: catalog.templates.map((t) => ({
        slug: t.slug,
        name: t.name,
        icon: t.icon,
        category: t.category,
        description: t.description,
        installed: installedSlugs.has(t.slug),
      })),
      deep_link: "/agents/marketplace",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "catalog_unreadable", detail: String(e).slice(0, 200) },
      { status: 500 },
    );
  }
}
