/**
 * GET /api/connectors/sharepoint/sites
 *   ?q=marketing             — recherche SharePoint
 *   ?include_drives=1        — pour chaque site, ramène les drives (lent)
 *
 * Liste les sites SharePoint accessibles à l'utilisateur Microsoft 365
 * connecté (token OAuth slug `sharepoint`). Pour chaque site, optionnellement,
 * liste les drives (= bibliothèques de documents) disponibles.
 *
 * L'admin choisit visuellement quelles bibliothèques indexer dans la
 * modale d'activation, au lieu de devoir entrer un MS_SITE_ID Graph
 * (impossible à connaître par cœur).
 *
 * Endpoints Graph utilisés :
 *   GET /sites?search={q}&$top=20
 *   GET /sites/{site-id}/drives
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getToolToken } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphSite {
  id: string;            // "tenant.sharepoint.com,site-guid,web-guid"
  name?: string;
  displayName?: string;
  webUrl?: string;
  description?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
}

interface GraphDrive {
  id: string;
  name?: string;
  driveType?: string;    // documentLibrary | personal | business
  description?: string;
  webUrl?: string;
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // On accepte le token SharePoint OU OneDrive (tous les sibling slugs MS
  // ont les scopes Sites.Read.All grâce à l'union scopes du flow OAuth).
  // En pratique on cherche d'abord sharepoint, fallback onedrive.
  let tok = await getToolToken("microsoft", "sharepoint");
  if (!tok.ok) {
    tok = await getToolToken("microsoft", "onedrive");
  }
  if (!tok.ok) {
    return NextResponse.json(tok.body, { status: tok.status });
  }
  const headers = { Authorization: `Bearer ${tok.token}` };

  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "*";
  const includeDrives = url.searchParams.get("include_drives") === "1";

  // 1. Recherche sites
  // /sites?search=* ne renvoie pas tout par défaut — on demande explicitement
  // les principaux champs et on cap à 50.
  const searchUrl = `${GRAPH}/sites?search=${encodeURIComponent(q)}&$top=50&$select=id,name,displayName,webUrl,description,lastModifiedDateTime`;
  let sites: GraphSite[] = [];
  try {
    const r = await fetch(searchUrl, { headers, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json(
        {
          error: `graph_sites_${r.status}`,
          hint: txt.slice(0, 300),
        },
        { status: r.status === 401 ? 401 : 502 },
      );
    }
    const j = await r.json();
    sites = (j.value || []) as GraphSite[];
  } catch (e) {
    return NextResponse.json(
      { error: "graph_unreachable", hint: (e as Error).message },
      { status: 503 },
    );
  }

  // 2. Optionnel : pour chaque site, lister les drives. Limité à 10 sites
  // (pour éviter une explosion d'appels Graph). L'UI peut demander les
  // drives d'un site spécifique via un autre call si l'admin clique dessus.
  if (!includeDrives) {
    return NextResponse.json({ sites, account: tok.account_email });
  }

  const enriched = await Promise.all(
    sites.slice(0, 10).map(async (s) => {
      try {
        const r = await fetch(
          `${GRAPH}/sites/${encodeURIComponent(s.id)}/drives?$select=id,name,driveType,description,webUrl`,
          { headers, signal: AbortSignal.timeout(5_000) },
        );
        if (!r.ok) return { ...s, drives: [], drives_error: `graph_${r.status}` };
        const j = await r.json();
        const drives = (j.value || []) as GraphDrive[];
        return { ...s, drives };
      } catch (e) {
        return { ...s, drives: [], drives_error: (e as Error).message };
      }
    }),
  );

  return NextResponse.json({
    sites: enriched,
    truncated: sites.length > 10,
    total_sites: sites.length,
    account: tok.account_email,
  });
}
