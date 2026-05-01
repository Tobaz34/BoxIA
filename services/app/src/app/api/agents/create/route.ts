/**
 * POST /api/agents/create
 *
 * Crée un nouvel agent custom :
 *  1. Génère pre_prompt si non fourni (sinon utilise body.pre_prompt édité)
 *  2. Crée l'app Dify (mode chat)
 *  3. Configure model + pre_prompt + suggestions
 *  4. Génère une App API key
 *  5. Persiste les méta dans /data/custom-agents.json
 *
 * Body :
 *   {
 *     name, icon, description, domain, tone, allowedRoles?, language?,
 *     pre_prompt?, opening_statement?, suggested_questions?,
 *     model_name?, max_tokens?,
 *   }
 *
 * Réservé aux admins.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import {
  createDifyChatApp, setDifyAppInitialConfig,
  createDifyAppApiKey, deleteDifyApp,
} from "@/lib/dify-console";
import {
  saveCustomAgent, slugifyAgentName, getCustomAgent,
} from "@/lib/custom-agents";
import { AGENTS, type AgentRole } from "@/lib/agents";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { draftAgentPrompt } from "@/lib/ollama-prompt-gen";

export const dynamic = "force-dynamic";

const VALID_ROLES = new Set<AgentRole>(["admin", "manager", "employee"]);

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: {
    name?: string;
    icon?: string;
    description?: string;
    domain?: string;
    tone?: string;
    language?: string;
    allowedRoles?: string[];
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
    model_name?: string;
    max_tokens?: number;
    expertise_keywords?: string;
  };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "bad_json" }, { status: 400 }); }

  // Validation entrée
  const name = (body.name || "").trim();
  if (!name || name.length < 2 || name.length > 80) {
    return NextResponse.json(
      { error: "bad_name", message: "Le nom doit faire 2-80 caractères" },
      { status: 400 });
  }
  const icon = (body.icon || "🤖").trim().slice(0, 4);
  const description = (body.description || "").trim().slice(0, 200);
  const domain = (body.domain || "autre").trim();
  const tone = (body.tone || "friendly").trim();
  const language = (body.language || "fr-FR").trim();

  // Slug unique : on vérifie collision avec builtin + custom existants
  let slug = slugifyAgentName(name);
  if (AGENTS[slug]) slug = `${slug}-2`;
  if (await getCustomAgent(slug)) {
    let i = 2;
    while (await getCustomAgent(`${slug}-${i}`)) i++;
    slug = `${slug}-${i}`;
  }

  const allowedRoles: AgentRole[] = (body.allowedRoles || [])
    .filter((r): r is AgentRole => VALID_ROLES.has(r as AgentRole));

  const modelName = (body.model_name || "qwen2.5:7b").trim();
  if (!/^[a-zA-Z0-9._:\-/]{1,80}$/.test(modelName)) {
    return NextResponse.json({ error: "bad_model_name" }, { status: 400 });
  }
  const maxTokens = Math.max(256, Math.min(32768,
    Math.round(Number(body.max_tokens || 2048))));

  // Si l'admin n'a pas validé un pre-prompt, on en génère un en backup.
  let prePrompt = (body.pre_prompt || "").trim();
  let openingStatement = (body.opening_statement || "").trim();
  let suggested = Array.isArray(body.suggested_questions)
    ? body.suggested_questions.filter((q) => typeof q === "string" && q.trim()).slice(0, 4)
    : [];
  if (!prePrompt) {
    const draft = await draftAgentPrompt({
      name, description, domain, tone, language,
      expertise_keywords: body.expertise_keywords,
    });
    prePrompt = draft.pre_prompt;
    if (!openingStatement) openingStatement = draft.opening_statement;
    if (suggested.length === 0) suggested = draft.suggested_questions;
  }
  if (!openingStatement) {
    openingStatement = `Bonjour ! Je suis ${name}. Comment puis-je vous aider ?`;
  }

  // Étape 1 : créer l'app Dify
  const created = await createDifyChatApp(name, description || domain, icon);
  if (!created) {
    return NextResponse.json(
      { error: "dify_app_create_failed",
        message: "Impossible de créer l'app dans Dify" },
      { status: 502 });
  }

  // Étape 2 : configurer model + pre_prompt
  const cfg = await setDifyAppInitialConfig(created.id, {
    model_name: modelName,
    pre_prompt: prePrompt,
    opening_statement: openingStatement,
    suggested_questions: suggested,
    max_tokens: maxTokens,
  });
  if (!cfg.ok) {
    // Best-effort : tenter la suppression de l'app orpheline
    await deleteDifyApp(created.id);
    return NextResponse.json(
      { error: "dify_config_failed", details: cfg.error,
        message: "L'app Dify a été créée mais sa configuration a échoué" },
      { status: 502 });
  }

  // Étape 3 : générer la clé API d'app
  const key = await createDifyAppApiKey(created.id);
  if (!key) {
    await deleteDifyApp(created.id);
    return NextResponse.json(
      { error: "dify_apikey_failed",
        message: "Échec de génération de la clé API" },
      { status: 502 });
  }

  // Étape 4 : persister la méta locale
  await saveCustomAgent({
    slug, name, icon, description,
    domain, tone, language,
    allowedRoles,
    app_id: created.id,
    api_key: key.token,
    vision: false,
    pre_prompt: prePrompt,
    opening_statement: openingStatement,
    suggested_questions: suggested,
    created_by: session.user.email,
    created_at: Date.now(),
  });

  await logAction(
    "settings.update",
    `agent_create:${slug}`,
    { name, domain, tone, model: modelName, max_tokens: maxTokens },
    ipFromHeaders(req),
  );

  return NextResponse.json({
    ok: true,
    slug, app_id: created.id,
    name, icon, description,
  });
}
