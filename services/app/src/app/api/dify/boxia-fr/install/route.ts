/**
 * POST /api/dify/boxia-fr/install — installe un template BoxIA-FR + persiste
 * dans /data/installed-agents.json (pareil que install-template Dify Explorer).
 *
 * Body : { slug: string, name?: string, description?: string,
 *          allowed_roles?: ("admin"|"manager"|"employee")[] }
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  installBoxiaFrTemplate,
  readBoxiaFrCatalog,
} from "@/lib/boxia-fr-templates";
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
    slug?: unknown;
    name?: unknown;
    description?: unknown;
    allowed_roles?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  // Vérifie que le slug appartient au catalogue
  const catalog = await readBoxiaFrCatalog().catch(() => null);
  const tpl = catalog?.templates.find((t) => t.slug === slug);
  if (!tpl) {
    return NextResponse.json({ error: "not_in_catalog", slug }, { status: 404 });
  }

  const allowed_roles: AgentRole[] | undefined = Array.isArray(body.allowed_roles)
    ? (body.allowed_roles as unknown[]).filter(
        (r): r is AgentRole => typeof r === "string" && ROLES.has(r),
      )
    : undefined;

  try {
    const installed = await installBoxiaFrTemplate(slug, {
      name: typeof body.name === "string" ? body.name : undefined,
      description: typeof body.description === "string" ? body.description : undefined,
    });

    const persisted = await addInstalledAgent({
      app_id: installed.app_id,
      api_key: installed.api_key,
      mode: installed.mode as "chat" | "agent-chat",
      name: installed.name,
      description: tpl.description,
      icon: installed.icon,
      icon_background: installed.icon_background,
      category: tpl.category,
      source_template_id: `boxia-fr:${slug}`,
      allowed_roles: allowed_roles && allowed_roles.length > 0 ? allowed_roles : undefined,
    });

    await logAction(
      "agent.install_template",
      session.user.email,
      {
        slug: persisted.slug,
        boxia_fr_slug: slug,
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
