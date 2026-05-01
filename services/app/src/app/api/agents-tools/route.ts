/**
 * GET /api/agents-tools — index des tools disponibles pour l'agent
 * « Concierge BoxIA » (cf. /api/agents-tools/<tool>).
 *
 * Auth : Bearer AGENTS_API_KEY (le sidecar agents-autonomous l'utilise
 * déjà ; ici on l'étend à un nouveau "Custom Tool Dify" qui appelle
 * directement aibox-app pour orchestrer la box).
 *
 * Pattern : retourne juste le manifest. Les vrais endpoints sont sous
 * /api/agents-tools/<tool>.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TOOLS = [
  {
    slug: "list_connectors",
    method: "GET",
    description: "Liste tous les connecteurs disponibles avec leur statut (actif / inactif / masqué) et la catégorie.",
    confirmation_required: false,
  },
  {
    slug: "list_workflows",
    method: "GET",
    description: "Liste les workflows n8n installés (actifs ou non).",
    confirmation_required: false,
  },
  {
    slug: "list_marketplace_workflows",
    method: "GET",
    description: "Liste les workflows disponibles dans la marketplace (BoxIA officiels + communauté n8n.io).",
    confirmation_required: false,
  },
  {
    slug: "list_agents",
    method: "GET",
    description: "Liste les assistants IA installés dans la box.",
    confirmation_required: false,
  },
  {
    slug: "list_marketplace_agents_fr",
    method: "GET",
    description: "Liste les templates d'assistants BoxIA-FR (compta, RH, juridique, BTP, e-commerce, helpdesk).",
    confirmation_required: false,
  },
  {
    slug: "list_mcp_catalog",
    method: "GET",
    description: "Liste les serveurs MCP du catalogue (officiels Anthropic + communautaires).",
    confirmation_required: false,
  },
  {
    slug: "system_health",
    method: "GET",
    description: "État des services BoxIA (Authentik, Dify, n8n, Qdrant, agents, mem0, etc.) avec ping + métriques.",
    confirmation_required: false,
  },
  {
    slug: "install_workflow",
    method: "POST",
    description: "Installe un workflow marketplace dans n8n (toujours désactivé). Body: { file: string }.",
    confirmation_required: true,
  },
  {
    slug: "install_agent_fr",
    method: "POST",
    description: "Installe un template d'assistant BoxIA-FR. Body: { slug: string }.",
    confirmation_required: true,
  },
  {
    slug: "deep_link",
    method: "GET",
    description: "Génère un lien profond vers une page admin (connecteurs/workflows/marketplace). L'admin clique pour finaliser.",
    confirmation_required: false,
  },
];

import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export async function GET(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();
  return NextResponse.json({
    name: "BoxIA Concierge Tools",
    description: "Tools que l'agent IA Concierge utilise pour orchestrer l'admin BoxIA.",
    tools: TOOLS,
  });
}
