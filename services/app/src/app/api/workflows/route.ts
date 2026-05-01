/**
 * GET /api/workflows — liste les workflows n8n (admin only).
 *
 * Source : n8n REST API via login admin (cookies).
 *
 * Enrichissement marketplace : pour chaque workflow dont le `name` matche
 * un template du catalogue marketplace, on ajoute `credentials_required`
 * (extrait du catalogue). Permet à l'UI d'afficher un badge « creds à
 * configurer » et un lien direct vers les credentials n8n.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listWorkflows } from "@/lib/n8n";
import {
  readCatalog,
  readWorkflowTemplateName,
} from "@/lib/n8n-marketplace";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Pour l'instant, lecture pour tous (les workflows sont infos
  // utiles aux managers/employés). Toggle d'activation = admin only
  // dans /api/workflows/[id]/...
  const workflows = await listWorkflows();

  // Build une map name n8n → entrée catalogue, pour enrichir avec
  // `credentials_required` quand applicable.
  let catalogByN8nName = new Map<
    string,
    { credentials_required: string[]; file: string }
  >();
  try {
    const catalog = await readCatalog();
    const entries = await Promise.all(
      catalog.workflows.map(async (w) => ({
        n8nName: (await readWorkflowTemplateName(w.file)) || w.name,
        credentials_required: w.credentials_required,
        file: w.file,
      })),
    );
    catalogByN8nName = new Map(
      entries.map((e) => [e.n8nName, {
        credentials_required: e.credentials_required,
        file: e.file,
      }]),
    );
  } catch {
    // Si la marketplace est indispo (bind mount cassé, etc.), on retourne
    // juste les workflows nus — pas de blocage.
  }

  const enriched = workflows.map((w) => {
    const meta = catalogByN8nName.get(w.name);
    return {
      ...w,
      credentials_required: meta?.credentials_required || [],
      marketplace_file: meta?.file || null,
    };
  });

  return NextResponse.json({ workflows: enriched });
}
