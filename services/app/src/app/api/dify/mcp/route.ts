/**
 * GET /api/dify/mcp — admin only
 *
 * Liste les MCP servers attachés à Dify (workspace courant).
 * Proxy authentifié vers /console/api/workspaces/current/tools/mcp.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { consoleFetch } from "@/lib/dify-console";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  try {
    const r = await consoleFetch("/console/api/workspaces/current/tools/mcp");
    if (!r.ok) {
      return NextResponse.json(
        { error: "dify_unreachable", status: r.status },
        { status: 502 },
      );
    }
    const data = await r.json();
    const servers = Array.isArray(data) ? data : (data.providers || data.data || []);
    return NextResponse.json({ servers });
  } catch (e) {
    return NextResponse.json(
      { error: "dify_unreachable", detail: String(e).slice(0, 200) },
      { status: 502 },
    );
  }
}
