/**
 * GET /api/agents-tools/list_marketplace_agents_fr
 * Templates agents BoxIA-FR pour le concierge.
 */
import { NextResponse } from "next/server";
import { readBoxiaFrCatalog } from "@/lib/boxia-fr-templates";
import { listInstalledAgents } from "@/lib/installed-agents";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { toolError } from "@/lib/tool-errors";

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
    // Catalogue I/O failure (fichier corrompu/absent) — peut être transitoire.
    return toolError({
      error: "catalog_unreadable",
      hint: "Impossible de lire le catalogue des templates BoxIA-FR. Vérifier le fichier sur disque.",
      status: 500,
      retryable: true,
      detail: String(e).slice(0, 200),
    });
  }
}
