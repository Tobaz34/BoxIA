/**
 * GET    /api/dify/installed-agents          — liste les agents installés
 * DELETE /api/dify/installed-agents?slug=X    — désinstalle un agent
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  listInstalledAgents,
  removeInstalledAgent,
  getInstalledAgent,
} from "@/lib/installed-agents";
import { uninstallApp } from "@/lib/dify-marketplace";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Visible aux non-admins (pour qu'ils sachent quels agents existent),
  // mais on filtre par allowed_roles côté caller s'ils veulent juste
  // les agents accessibles à eux.
  const agents = await listInstalledAgents();
  return NextResponse.json({ agents });
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }
  const existing = await getInstalledAgent(slug);
  if (!existing) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  // Best-effort : on supprime côté Dify aussi. Si Dify ne répond pas, on
  // supprime quand même côté local pour ne pas garder un agent orphelin.
  let dify_deleted = true;
  try {
    await uninstallApp(existing.app_id);
  } catch {
    dify_deleted = false;
  }
  await removeInstalledAgent(slug);
  await logAction(
    "agent.uninstall",
    session.user.email,
    { slug, app_id: existing.app_id, dify_deleted },
    ipFromHeaders(req),
  );
  return NextResponse.json({ ok: true, dify_deleted });
}
