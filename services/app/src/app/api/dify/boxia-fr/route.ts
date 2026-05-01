/**
 * GET /api/dify/boxia-fr — liste les templates BoxIA-FR.
 * POST /api/dify/boxia-fr/install — installe un template (admin only).
 *
 * À la différence de /api/dify/templates qui consomme l'Explorer Dify
 * (anglais, génériques), ces templates sont en français et adaptés au
 * marché TPE/PME français.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { readBoxiaFrCatalog } from "@/lib/boxia-fr-templates";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const catalog = await readBoxiaFrCatalog();
    return NextResponse.json(catalog);
  } catch (e) {
    return NextResponse.json(
      {
        error: "catalog_unreadable",
        detail: String(e).slice(0, 300),
        hint: "Vérifier que /templates/dify/boxia-fr/_catalog.json est lisible.",
      },
      { status: 500 },
    );
  }
}
