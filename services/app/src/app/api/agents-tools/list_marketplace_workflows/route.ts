/**
 * GET /api/agents-tools/list_marketplace_workflows
 * Liste les workflows marketplace (BoxIA + communauté) pour le concierge.
 */
import { NextResponse } from "next/server";
import { readCatalog } from "@/lib/n8n-marketplace";
import { listWorkflows } from "@/lib/n8n";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  try {
    const catalog = await readCatalog();
    const installed = await listWorkflows().catch(() => []);
    const installedNames = new Set(installed.map((w) => w.name));

    const workflows = catalog.workflows.map((w) => ({
      file: w.file,
      name: w.name,
      icon: w.icon,
      category: w.category,
      description: w.description,
      source: w.source || "boxia",
      total_views: w.total_views,
      // Approximation de "installé" via le name catalog (peut différer du
      // name interne du JSON pour les officiels, mais OK comme indication)
      installed: installedNames.has(w.name),
      credentials_required: w.credentials_required,
    }));

    return NextResponse.json({
      summary: {
        total: workflows.length,
        boxia: workflows.filter((w) => w.source === "boxia").length,
        community: workflows.filter((w) => w.source === "community").length,
        installed: workflows.filter((w) => w.installed).length,
      },
      // Limite à 20 par groupe pour éviter explosion JSON
      boxia: workflows.filter((w) => w.source === "boxia").slice(0, 20),
      community: workflows
        .filter((w) => w.source === "community")
        .sort((a, b) => (b.total_views || 0) - (a.total_views || 0))
        .slice(0, 20),
      deep_link: "/workflows/marketplace",
    });
  } catch (e) {
    return NextResponse.json(
      { error: "marketplace_unreadable", detail: String(e).slice(0, 200) },
      { status: 500 },
    );
  }
}
