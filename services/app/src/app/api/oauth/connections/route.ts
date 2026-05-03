/**
 * GET    /api/oauth/connections      — liste des connexions OAuth (sans tokens)
 * DELETE /api/oauth/connections?id=X — révoque une connexion (admin only)
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { listConnections, deleteConnection } from "@/lib/oauth-device-flow";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const conns = await listConnections();
  // Strip les tokens chiffrés — on ne renvoie que les métadonnées.
  return NextResponse.json({
    connections: conns.map((c) => ({
      id: c.id,
      provider_id: c.provider_id,
      connector_slug: c.connector_slug,
      account_email: c.account_email,
      account_name: c.account_name,
      scopes: c.scopes,
      connected_at: c.connected_at,
      connected_by: c.connected_by,
      expires_at: c.expires_at,
      last_refreshed_at: c.last_refreshed_at,
    })),
  });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });

  await deleteConnection(id);
  await logAction("settings.update", `oauth_connection_revoked:${id}`, {
    actor: session.user.email,
    ip: ipFromHeaders(req),
  });
  return NextResponse.json({ ok: true });
}
