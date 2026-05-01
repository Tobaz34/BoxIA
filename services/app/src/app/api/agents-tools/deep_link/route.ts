/**
 * GET /api/agents-tools/deep_link?target=<slug>
 *
 * Génère un lien profond vers une page admin de la BoxIA. L'agent
 * Concierge utilise ça quand il faut une action manuelle de l'admin
 * (configurer un connecteur avec credentials externes, par exemple).
 *
 * Targets supportés : connectors, workflows, marketplace_n8n,
 * marketplace_agents, mcp, settings, audit, system.
 */
import { NextResponse } from "next/server";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

const TARGETS: Record<string, { url: string; description: string }> = {
  connectors: { url: "/connectors", description: "Page de gestion des connecteurs (activer SharePoint, Pennylane, NAS, etc.)" },
  workflows: { url: "/workflows", description: "Liste des workflows n8n installés (activer, exécuter, voir les exécutions)" },
  marketplace_n8n: { url: "/workflows/marketplace", description: "Marketplace de workflows n8n (BoxIA officiels + 39 communautaires)" },
  marketplace_agents: { url: "/agents/marketplace", description: "Marketplace d'assistants IA (6 BoxIA-FR + Dify Explorer)" },
  mcp: { url: "/integrations/mcp", description: "Catalogue de serveurs MCP (filesystem, GitHub, Postgres, Slack, etc.)" },
  settings: { url: "/settings", description: "Paramètres généraux (langue, instructions personnalisées, version, branding)" },
  audit: { url: "/audit", description: "Journal d'audit (toutes les actions admin)" },
  system: { url: "/system", description: "État des services et métriques" },
  agents: { url: "/agents", description: "Liste des assistants IA disponibles" },
};

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();
  const url = new URL(req.url);
  const target = url.searchParams.get("target") || "";

  if (target && TARGETS[target]) {
    return NextResponse.json({
      target,
      url: TARGETS[target].url,
      description: TARGETS[target].description,
      message: `Pour faire cela, l'admin doit ouvrir ${TARGETS[target].url} dans la BoxIA.`,
    });
  }

  // Pas de target spécifié → retourne la liste
  return NextResponse.json({
    available_targets: Object.entries(TARGETS).map(([slug, info]) => ({
      slug,
      url: info.url,
      description: info.description,
    })),
  });
}
