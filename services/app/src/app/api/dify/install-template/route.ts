/**
 * POST /api/dify/install-template — installe un template Dify dans le
 * workspace + persiste l'agent dans /data/installed-agents.json.
 *
 * Admin only.
 *
 * Body : { template_id: string, name?: string, description?: string,
 *          allowed_roles?: ("admin"|"manager"|"employee")[] }
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { installTemplate } from "@/lib/dify-marketplace";
import { addInstalledAgent } from "@/lib/installed-agents";
import type { AgentRole } from "@/lib/installed-agents";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

const ROLES = new Set(["admin", "manager", "employee"]);

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    template_id?: string;
    name?: string;
    description?: string;
    allowed_roles?: string[];
    category?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  if (!body.template_id || typeof body.template_id !== "string") {
    return NextResponse.json({ error: "missing_template_id" }, { status: 400 });
  }

  const allowed_roles: AgentRole[] | undefined = Array.isArray(body.allowed_roles)
    ? body.allowed_roles.filter((r): r is AgentRole => typeof r === "string" && ROLES.has(r))
    : undefined;

  try {
    const installed = await installTemplate(body.template_id, {
      name: body.name,
      description: body.description,
    });

    const persisted = await addInstalledAgent({
      app_id: installed.app_id,
      api_key: installed.api_key,
      mode: installed.mode,
      name: installed.name,
      description: body.description || "",
      icon: installed.icon,
      icon_background: installed.icon_background,
      category: body.category,
      source_template_id: body.template_id,
      allowed_roles: allowed_roles && allowed_roles.length > 0 ? allowed_roles : undefined,
    });

    await logAction(
      "agent.install_template",
      session.user.email,
      {
        slug: persisted.slug,
        template_id: body.template_id,
        app_id: installed.app_id,
        mode: installed.mode,
      },
      ipFromHeaders(req),
    );

    return NextResponse.json({ ok: true, agent: persisted });
  } catch (e) {
    return NextResponse.json(
      { error: "install_failed", detail: String(e).slice(0, 500) },
      { status: 502 },
    );
  }
}
