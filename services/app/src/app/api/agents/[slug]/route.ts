/**
 * GET   /api/agents/[slug]   — config détaillée d'un agent (admin only)
 * PATCH /api/agents/[slug]   — update pre_prompt, opening, suggestions
 *
 * body PATCH : { pre_prompt?, opening_statement?, suggested_questions? }
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AGENTS } from "@/lib/agents";
import {
  findDifyAppIdByName, getDifyApp, updateDifyAppConfig,
} from "@/lib/dify-console";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

async function requireAdminCheck() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const err = await requireAdminCheck();
  if (err) return err;
  const { slug } = await params;

  const meta = AGENTS[slug];
  if (!meta) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 404 });
  }

  const appId = await findDifyAppIdByName(meta.name);
  if (!appId) {
    return NextResponse.json(
      { error: "app_not_found", message: `Aucune app Dify nommée "${meta.name}"` },
      { status: 404 },
    );
  }
  const detail = await getDifyApp(appId);
  if (!detail) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }

  return NextResponse.json({
    slug: meta.slug,
    name: meta.name,
    icon: meta.icon,
    description: meta.description,
    allowedRoles: meta.allowedRoles || [],
    isDefault: meta.isDefault || false,
    available: !!process.env[meta.envVar],
    app_id: appId,
    pre_prompt: detail.model_config?.pre_prompt || "",
    opening_statement: detail.model_config?.opening_statement || "",
    suggested_questions: detail.model_config?.suggested_questions || [],
    model: detail.model_config?.model || null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const err = await requireAdminCheck();
  if (err) return err;
  const { slug } = await params;

  const meta = AGENTS[slug];
  if (!meta) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 404 });
  }

  let body: {
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  const appId = await findDifyAppIdByName(meta.name);
  if (!appId) {
    return NextResponse.json({ error: "app_not_found" }, { status: 404 });
  }

  const result = await updateDifyAppConfig(appId, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: "update_failed", details: result.error },
      { status: 502 },
    );
  }

  await logAction("settings.update", `agent:${slug}`, {
    fields: Object.keys(body),
  }, ipFromHeaders(req));

  return NextResponse.json({ ok: true });
}
