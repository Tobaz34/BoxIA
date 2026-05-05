/**
 * POST /api/agents-tools/delegate_to_specialist
 *
 * Tool agents-tools utilisé par le Concierge pour déléguer une question
 * à un agent spécialisé (general, vision, accountant, hr, support).
 *
 * Pourquoi : nos 6 agents Dify sont aujourd'hui isolés sans inter-comm.
 * Quand le user pose une question hybride au Concierge (ex: "analyse cette
 * facture jointe et compare aux taux TVA 2026"), le Concierge ne peut pas
 * utiliser les compétences de l'Assistant comptable ni de l'Assistant
 * vision sans demander à l'user de changer manuellement d'agent.
 *
 * Ce tool transforme le Concierge en chef d'orchestre : il décide qu'il
 * délègue, appelle le specialist en blocking via Dify, intègre la réponse
 * dans son propre raisonnement, puis répond au user en synthèse.
 *
 * Référence : tools/research/audit_P0_04_delegate.md +
 * tools/research/DECISIONS-P0.md §D5 (option A blocking, conv isolée).
 *
 * Body : {
 *   slug: string,        // agent cible : "general"|"vision"|"accountant"|"hr"|"support"
 *   prompt: string,      // question/instruction enrichie pour le specialist
 *   conversation_id?: string, // si fourni, continue une conversation existante avec ce specialist
 * }
 *
 * Garde-fous (D5) :
 * - MAX_DEPTH=2 via header X-Delegation-Depth (refus si >2)
 * - Refus self-delegation (slug==="concierge" → 400)
 * - Slug doit exister dans AGENTS ou installed-agents
 * - Timeout 60s
 *
 * Auth : Bearer AGENTS_API_KEY (cf lib/agents-tools-auth.ts).
 *
 * Action READ-ONLY (pas de mutation) → pas d'approval gate.
 * Le specialist appelé peut lui-même avoir des tools mutatifs gatés —
 * dans ce cas son retour contiendra requires_approval=true que le
 * Concierge devra propager à l'user.
 */
import { NextResponse } from "next/server";
import {
  AGENTS,
  canUseAgentStatic,
  canUseAgent,
  getAgentKey,
  getAgentKeyAny,
  roleFromGroups,
} from "@/lib/agents";
import { getInstalledAgent } from "@/lib/installed-agents";
import { checkAgentsToolsAuth, unauthorized } from "@/lib/agents-tools-auth";
import { difyChatBlocking } from "@/lib/dify";
import { logAction } from "@/lib/audit-helper";
import {
  toolError,
  toolValidationError,
  toolUpstreamError,
} from "@/lib/tool-errors";
import { logToolCall } from "@/lib/langfuse";

export const dynamic = "force-dynamic";

const MAX_DEPTH = Number(process.env.AGENTS_DELEGATE_MAX_DEPTH || 2);
const TIMEOUT_MS = Number(process.env.AGENTS_DELEGATE_TIMEOUT_MS || 60_000);
/** Liste des agents-cibles autorisés via délégation. Le Concierge n'est
 *  pas dans la liste pour éviter la récursion (un specialist ne peut pas
 *  re-déléguer au Concierge — sinon boucle infinie facile). */
const SELF_SLUG = "concierge";

interface DelegateBody {
  slug?: unknown;
  prompt?: unknown;
  conversation_id?: unknown;
  /** Forwarded depuis l'agent appelant si propagé, sinon header
   *  X-Delegation-Depth est lu. Évite de se reposer sur 1 seule source. */
  depth?: unknown;
  /** Email user — propagé par le Concierge pour audit + Dify user param. */
  user?: unknown;
  /** Slug agent appelant (pour audit + détection self-delegation). */
  caller?: unknown;
}

export async function POST(req: Request) {
  if (!checkAgentsToolsAuth(req)) return unauthorized();

  const startTime = new Date();

  // Profondeur de délégation : header > body.depth > 0
  const headerDepth = Number(req.headers.get("x-delegation-depth") || 0);
  let body: DelegateBody;
  try {
    body = (await req.json()) as DelegateBody;
  } catch {
    return toolValidationError("bad_json", "Body JSON invalide.");
  }
  const bodyDepth = Number(body.depth) || 0;
  const depth = Math.max(headerDepth, bodyDepth);

  if (depth >= MAX_DEPTH) {
    return toolError({
      error: "max_delegation_depth",
      hint: `Profondeur de délégation max atteinte (${MAX_DEPTH}). ` +
            `Ne pas re-déléguer depuis un specialist délégué — réponds directement.`,
      status: 400,
      retryable: false,
      detail: `current_depth=${depth}`,
    });
  }

  const slug = typeof body.slug === "string" ? body.slug.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const callerSlug = typeof body.caller === "string" ? body.caller.trim() : "";
  const userEmail = typeof body.user === "string" && body.user.includes("@")
    ? body.user.trim()
    : null;

  if (!slug) {
    return toolValidationError(
      "missing_slug",
      "Champ 'slug' requis (ex: 'accountant', 'vision', 'general').",
    );
  }
  if (!prompt || prompt.length < 5) {
    return toolValidationError(
      "missing_prompt",
      "Champ 'prompt' requis (min 5 chars).",
    );
  }
  if (slug === SELF_SLUG || (callerSlug && slug === callerSlug)) {
    return toolValidationError(
      "self_delegation_refused",
      "Self-delegation interdite (anti-récursion). Réponds directement à l'user.",
    );
  }

  // Résolution agent : statique ou installé
  const isStatic = !!AGENTS[slug];
  let dynamicAgent: Awaited<ReturnType<typeof getInstalledAgent>> = null;
  let agentName = slug;
  let agentIcon = "";
  let allowedRoles: string[] | undefined;

  if (isStatic) {
    agentName = AGENTS[slug].name;
    agentIcon = AGENTS[slug].icon;
    allowedRoles = AGENTS[slug].allowedRoles;
  } else {
    dynamicAgent = await getInstalledAgent(slug);
    if (!dynamicAgent) {
      return toolValidationError(
        "unknown_agent",
        `Agent '${slug}' inconnu. Slugs disponibles : ${Object.keys(AGENTS).filter(s => s !== SELF_SLUG).join(", ")}.`,
      );
    }
    agentName = dynamicAgent.name || slug;
    allowedRoles = dynamicAgent.allowed_roles;
  }

  // Récupère la clé API de l'agent cible
  const key = isStatic ? getAgentKey(slug) : await getAgentKeyAny(slug);
  if (!key) {
    return toolError({
      error: "agent_unavailable",
      hint: `L'agent '${agentName}' n'est pas configuré (clé API manquante).`,
      status: 503,
      retryable: false,
    });
  }

  // RBAC light : si le user appelant a un rôle (propagé par X-User-Groups
  // header optionnel — Dify ne le forwarde pas par défaut), on le vérifie.
  // Sinon best-effort : le Concierge est lui-même admin-only, donc l'user
  // est admin par construction quand il appelle ce tool via Concierge.
  const userGroupsHeader = req.headers.get("x-user-groups");
  if (userGroupsHeader && allowedRoles?.length) {
    const groups = userGroupsHeader.split(",").map(g => g.trim());
    const role = roleFromGroups(groups);
    const allowed = isStatic ? canUseAgentStatic(slug, role) : await canUseAgent(slug, role);
    if (!allowed) {
      return toolError({
        error: "agent_forbidden",
        hint: `L'agent '${agentName}' est réservé à : ${allowedRoles.join(" / ")}.`,
        status: 403,
        retryable: false,
      });
    }
  }

  // Conversation isolée (D5 option A) : on n'utilise PAS le conversation_id
  // de l'agent appelant côté Dify — Dify ne supporte pas le partage de
  // conversation cross-app. Si le caller passe conversation_id, on l'utilise
  // pour continuer une conversation EXISTANT déjà avec CE specialist (rare).
  const conversationId = typeof body.conversation_id === "string"
    ? body.conversation_id.trim()
    : "";

  // Append metadata sur la délégation au prompt (le specialist sait qu'il
  // est appelé par un agent, peut adapter son ton). Format minimal pour
  // ne pas saturer le contexte.
  const enrichedPrompt =
    `[Délégation depuis ${callerSlug || "concierge"} — depth=${depth + 1}]\n\n` +
    prompt;

  // Logique métier
  const result = await difyChatBlocking({
    user: userEmail || `delegate:${callerSlug || "concierge"}`,
    key,
    query: enrichedPrompt,
    conversationId,
    timeoutMs: TIMEOUT_MS,
    signal: req.signal,
  });

  if (!result.ok) {
    // Audit + Langfuse
    await logAction(
      "agent.chat",
      callerSlug || "concierge",
      {
        tool: "delegate_to_specialist",
        target_slug: slug,
        depth,
        error: "dify_upstream_error",
        upstream_status: result.status,
      },
      null,
    );
    logToolCall({
      toolName: "delegate_to_specialist",
      agentSlug: callerSlug || "concierge",
      userId: userEmail || undefined,
      success: false,
      errorCode: "dify_upstream_error",
      retryable: result.status >= 500 || result.status === 429,
      httpStatus: 502,
      startTime,
      endTime: new Date(),
      metadata: { target_slug: slug, depth, upstream_status: result.status },
    });
    return toolUpstreamError({
      error: "delegate_failed",
      hint: `L'agent '${agentName}' n'a pas pu répondre (status ${result.status}).`,
      upstreamStatus: result.status,
      detail: result.bodyPreview,
    });
  }

  // Succès
  await logAction(
    "agent.chat",
    callerSlug || "concierge",
    {
      tool: "delegate_to_specialist",
      target_slug: slug,
      depth,
      answer_chars: result.answer.length,
    },
    null,
  );
  logToolCall({
    toolName: "delegate_to_specialist",
    agentSlug: callerSlug || "concierge",
    userId: userEmail || undefined,
    conversationId,
    success: true,
    httpStatus: 200,
    startTime,
    endTime: new Date(),
    metadata: {
      target_slug: slug,
      depth,
      answer_chars: result.answer.length,
      message_id: result.messageId,
    },
  });

  return NextResponse.json({
    ok: true,
    agent: {
      slug,
      name: agentName,
      icon: agentIcon,
    },
    answer: result.answer,
    conversation_id: result.conversationId,
    depth: depth + 1,
    hint:
      `Réponse de l'agent '${agentName}'. Synthétise-la pour l'utilisateur en gardant ` +
      `tes propres conclusions ; ne te contente pas de la copier-coller. Tu peux re-déléguer ` +
      `à un autre specialist si besoin (max profondeur = ${MAX_DEPTH}).`,
  });
}
