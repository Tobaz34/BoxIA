/**
 * GET /api/integrations/mcp/catalog — liste les serveurs MCP du catalogue.
 *
 * Admin only. Lit `templates/mcp/_catalog.json` (bind-mounté).
 * Pas de cross-check avec un état "installé" pour V1 — l'install se fait
 * côté Dify et n'a pas d'API simple pour lister les MCP attachés.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readMcpCatalog } from "@/lib/mcp-marketplace";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const catalog = await readMcpCatalog();
    return NextResponse.json(catalog);
  } catch (e) {
    return NextResponse.json(
      {
        error: "catalog_unreadable",
        detail: String(e).slice(0, 300),
        hint: "Vérifier que /templates/mcp/_catalog.json est lisible (bind mount).",
      },
      { status: 500 },
    );
  }
}
