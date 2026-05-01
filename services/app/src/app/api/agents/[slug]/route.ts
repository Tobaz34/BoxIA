/**
 * GET    /api/agents/[slug]   — config détaillée d'un agent (admin only)
 * PATCH  /api/agents/[slug]   — update pre_prompt, opening, suggestions, model, tokens
 * DELETE /api/agents/[slug]   — supprime un agent custom (404 sur builtin)
 *
 * body PATCH : { pre_prompt?, opening_statement?, suggested_questions?,
 *                model_name?, max_tokens? }
 *
 * Les agents builtin (general/accountant/hr/support) sont mappés via
 * AGENTS + lookup par nom dans Dify. Les agents custom sont dans
 * /data/custom-agents.json avec app_id stocké directement.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { AGENTS } from "@/lib/agents";
import {
  findDifyAppIdByName, getDifyApp, updateDifyAppConfig, deleteDifyApp,
} from "@/lib/dify-console";
import {
  getCustomAgent, deleteCustomAgent, updateCustomAgent,
} from "@/lib/custom-agents";
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

/** Résout le mapping slug → { app_id, source: builtin|custom, meta }. */
async function resolveAgentAppId(slug: string): Promise<
  | { kind: "builtin"; meta: typeof AGENTS[string]; app_id: string }
  | { kind: "custom"; meta: NonNullable<Awaited<ReturnType<typeof getCustomAgent>>> }
  | { kind: "not_found" }
> {
  const builtin = AGENTS[slug];
  if (builtin) {
    const appId = await findDifyAppIdByName(builtin.name);
    if (!appId) return { kind: "not_found" };
    return { kind: "builtin", meta: builtin, app_id: appId };
  }
  const custom = await getCustomAgent(slug);
  if (custom) return { kind: "custom", meta: custom };
  return { kind: "not_found" };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const err = await requireAdminCheck();
  if (err) return err;
  const { slug } = await params;

  const resolved = await resolveAgentAppId(slug);
  if (resolved.kind === "not_found") {
    return NextResponse.json({ error: "unknown_agent" }, { status: 404 });
  }

  const appId = resolved.kind === "builtin" ? resolved.app_id : resolved.meta.app_id;
  const detail = await getDifyApp(appId);
  if (!detail) {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }

  if (resolved.kind === "builtin") {
    const meta = resolved.meta;
    return NextResponse.json({
      slug: meta.slug,
      name: meta.name,
      icon: meta.icon,
      description: meta.description,
      allowedRoles: meta.allowedRoles || [],
      isDefault: meta.isDefault || false,
      available: !!process.env[meta.envVar],
      custom: false,
      app_id: appId,
      pre_prompt: detail.model_config?.pre_prompt || "",
      opening_statement: detail.model_config?.opening_statement || "",
      suggested_questions: detail.model_config?.suggested_questions || [],
      model: detail.model_config?.model || null,
      max_tokens: detail.model_config?.model?.completion_params?.max_tokens ?? null,
    });
  }
  // custom
  const c = resolved.meta;
  return NextResponse.json({
    slug: c.slug,
    name: c.name,
    icon: c.icon,
    description: c.description,
    allowedRoles: c.allowedRoles,
    isDefault: false,
    available: true,
    custom: true,
    app_id: c.app_id,
    pre_prompt: detail.model_config?.pre_prompt || c.pre_prompt,
    opening_statement: detail.model_config?.opening_statement || c.opening_statement,
    suggested_questions: detail.model_config?.suggested_questions || c.suggested_questions,
    model: detail.model_config?.model || null,
    max_tokens: detail.model_config?.model?.completion_params?.max_tokens ?? null,
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const err = await requireAdminCheck();
  if (err) return err;
  const { slug } = await params;

  const resolved = await resolveAgentAppId(slug);
  if (resolved.kind === "not_found") {
    return NextResponse.json({ error: "unknown_agent" }, { status: 404 });
  }

  let body: {
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
    model_name?: string;
    max_tokens?: number;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  if (body.model_name !== undefined) {
    if (typeof body.model_name !== "string"
      || !/^[a-zA-Z0-9._:\-/]{1,80}$/.test(body.model_name)) {
      return NextResponse.json(
        { error: "bad_model_name", message: "Nom de modèle invalide" },
        { status: 400 });
    }
  }
  if (body.max_tokens !== undefined) {
    const mt = Number(body.max_tokens);
    if (!Number.isFinite(mt) || mt < 256 || mt > 32768) {
      return NextResponse.json(
        { error: "bad_max_tokens", message: "max_tokens doit être 256–32768" },
        { status: 400 });
    }
    body.max_tokens = Math.round(mt);
  }

  const appId = resolved.kind === "builtin" ? resolved.app_id : resolved.meta.app_id;
  const result = await updateDifyAppConfig(appId, body);
  if (!result.ok) {
    return NextResponse.json(
      { error: "update_failed", details: result.error },
      { status: 502 });
  }

  // Pour les agents custom, on synchronise aussi le state local
  if (resolved.kind === "custom") {
    await updateCustomAgent(slug, {
      pre_prompt: body.pre_prompt ?? resolved.meta.pre_prompt,
      opening_statement: body.opening_statement ?? resolved.meta.opening_statement,
      suggested_questions: body.suggested_questions ?? resolved.meta.suggested_questions,
    });
  }

  await logAction("settings.update", `agent:${slug}`, {
    fields: Object.keys(body),
    custom: resolved.kind === "custom",
  }, ipFromHeaders(req));

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const err = await requireAdminCheck();
  if (err) return err;
  const { slug } = await params;

  // Les agents builtin ne sont pas supprimables (ils sont en dur dans le code)
  if (AGENTS[slug]) {
    return NextResponse.json(
      { error: "builtin_agent",
        message: "Les agents par défaut ne peuvent pas être supprimés." },
      { status: 400 });
  }
  const c = await getCustomAgent(slug);
  if (!c) {
    return NextResponse.json({ error: "unknown_agent" }, { status: 404 });
  }

  // Best-effort : supprimer l'app Dify d'abord (si elle existe encore)
  await deleteDifyApp(c.app_id).catch(() => false);
  await deleteCustomAgent(slug);

  await logAction("settings.update", `agent_delete:${slug}`, {
    name: c.name, app_id: c.app_id,
  }, ipFromHeaders(req));

  return NextResponse.json({ ok: true });
}
