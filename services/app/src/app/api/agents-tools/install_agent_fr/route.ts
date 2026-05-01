/**
 * POST /api/agents-tools/install_agent_fr
 *
 * Body : { slug: string }
 *
 * Installe un template d'assistant BoxIA-FR (compta, RH, juridique, BTP,
 * e-commerce, helpdesk). Action sensible — confirmation utilisateur
 * gérée par l'agent.
 */
import { NextResponse } from "next/server";
import { installBoxiaFrTemplate, readBoxiaFrCatalog } from "@/lib/boxia-fr-templates";
import { addInstalledAgent } from "@/lib/installed-agents";
import { logAction } from "@/lib/audit-helper";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  let body: { slug?: unknown };
  try {
    body = (await req.json()) as { slug?: unknown };
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  const catalog = await readBoxiaFrCatalog().catch(() => null);
  const tpl = catalog?.templates.find((t) => t.slug === slug);
  if (!tpl) {
    return NextResponse.json({ error: "not_in_catalog", slug }, { status: 404 });
  }

  try {
    const installed = await installBoxiaFrTemplate(slug);
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
    });

    await logAction(
      "agent.install_template",
      "concierge-agent",
      { slug: persisted.slug, boxia_fr_slug: slug, app_id: installed.app_id },
      null,
    );

    return NextResponse.json({
      ok: true,
      app_id: installed.app_id,
      name: installed.name,
      message: `« ${installed.name} » installé. Tu le trouveras dans /agents et dans le sélecteur du chat.`,
      next_action_url: `/?agent=${persisted.slug}`,
    });
  } catch (e) {
    return NextResponse.json(
      { error: "install_failed", detail: String(e).slice(0, 300) },
      { status: 502 },
    );
  }
}
