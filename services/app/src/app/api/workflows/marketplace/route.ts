/**
 * GET /api/workflows/marketplace — liste les workflows marketplace n8n.
 *
 * Admin only. Lit `templates/n8n/marketplace/_catalog.json` (bind-mounté
 * dans le container) + croise avec la liste des workflows déjà installés
 * côté n8n pour indiquer `installed: true|false` et `workflow_id` quand
 * dispo (utilisé par l'UI pour afficher un bouton "Voir dans n8n" plutôt
 * que "Installer").
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  readCatalog,
  readWorkflowTemplateName,
} from "@/lib/n8n-marketplace";
import { listWorkflows } from "@/lib/n8n";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const catalog = await readCatalog();
    const installed = await listWorkflows().catch(() => []);
    const installedByName = new Map(installed.map((w) => [w.name, w]));

    // Pour chaque entrée catalogue, on récupère le `name` réellement écrit
    // dans n8n (= valeur du champ "name" du JSON template) pour faire le
    // cross-check avec `installed`. Le nom affiché côté UI (catalog.name)
    // est volontairement plus lisible et peut différer.
    const workflows = await Promise.all(
      catalog.workflows.map(async (w) => {
        const n8nName = (await readWorkflowTemplateName(w.file)) || w.name;
        const inst = installedByName.get(n8nName);
        return {
          ...w,
          installed: !!inst,
          workflow_id: inst?.id || null,
          active: inst?.active || false,
        };
      }),
    );

    return NextResponse.json({
      version: catalog.version,
      categories: catalog.categories,
      workflows,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "marketplace_unreadable",
        detail: String(e).slice(0, 300),
        hint: "Vérifier que /templates/n8n/marketplace/_catalog.json est lisible (bind mount).",
      },
      { status: 500 },
    );
  }
}
