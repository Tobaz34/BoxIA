/**
 * GET /api/connectors/sharepoint/sites/[siteId]/drives
 *
 * Liste les drives (= bibliothèques de documents) d'un site SharePoint
 * donné. Le siteId est l'identifiant Graph "tenant.sharepoint.com,site-guid,
 * web-guid" reçu via /api/connectors/sharepoint/sites.
 *
 * Admin only.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getToolToken } from "@/lib/connector-tool-helpers";

export const dynamic = "force-dynamic";

const GRAPH = "https://graph.microsoft.com/v1.0";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { siteId } = await params;
  if (!siteId) {
    return NextResponse.json({ error: "missing_siteId" }, { status: 400 });
  }

  let tok = await getToolToken("microsoft", "sharepoint");
  if (!tok.ok) tok = await getToolToken("microsoft", "onedrive");
  if (!tok.ok) {
    return NextResponse.json(tok.body, { status: tok.status });
  }

  try {
    const r = await fetch(
      `${GRAPH}/sites/${encodeURIComponent(siteId)}/drives?$select=id,name,driveType,description,webUrl,quota`,
      {
        headers: { Authorization: `Bearer ${tok.token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `graph_${r.status}`, hint: txt.slice(0, 300) },
        { status: r.status === 401 ? 401 : 502 },
      );
    }
    const j = await r.json();
    return NextResponse.json({ drives: j.value || [], site_id: siteId });
  } catch (e) {
    return NextResponse.json(
      { error: "graph_unreachable", hint: (e as Error).message },
      { status: 503 },
    );
  }
}
