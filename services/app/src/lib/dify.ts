/**
 * Helpers serveur pour l'API Dify v1 (App API).
 *
 * Toutes les requêtes utilisent la clé d'un agent (résolu par slug via
 * src/lib/agents.ts). L'identité utilisateur Dify = email NextAuth.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import {
  getAgentKey, getAgentKeyAny, defaultAgentSlug, AGENTS,
  canUseAgent, canUseAgentStatic, roleFromGroups,
} from "@/lib/agents";
import { getInstalledAgent } from "@/lib/installed-agents";
import { isUserActive } from "@/lib/user-cache";

export const DIFY_BASE_URL =
  process.env.DIFY_BASE_URL || "http://localhost:8081";

/**
 * Récupère l'utilisateur + clé Dify pour le slug d'agent demandé.
 * Si le slug n'est pas fourni, prend l'agent par défaut.
 * Retourne {user, key, agent} ou une NextResponse d'erreur.
 */
export async function requireDifyContext(
  agentSlug?: string | null,
): Promise<{ user: string; key: string; agent: string } | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Vérifie que l'utilisateur est encore actif côté Authentik
  // (auto-déconnexion live : un user désactivé voit ses requêtes
  // refusées dans les 3 min — TTL du cache).
  const active = await isUserActive(session.user.email);
  if (!active.active) {
    return NextResponse.json(
      { error: "user_disabled",
        message: "Votre compte a été désactivé. Contactez l'administrateur." },
      { status: 403 },
    );
  }

  const slug = agentSlug || defaultAgentSlug();
  if (!slug) {
    return NextResponse.json(
      { error: "no_agent",
        message: "Aucun agent n'est configuré sur cette AI Box." },
      { status: 503 },
    );
  }
  // Vérifie l'existence : statique d'abord, puis installé via marketplace
  const isStatic = !!AGENTS[slug];
  let dynamicAgent: Awaited<ReturnType<typeof getInstalledAgent>> = null;
  if (!isStatic) {
    dynamicAgent = await getInstalledAgent(slug);
    if (!dynamicAgent) {
      return NextResponse.json(
        { error: "unknown_agent", agent: slug },
        { status: 400 },
      );
    }
  }

  // Vérifie le rôle vs allowedRoles de l'agent
  const groups = (session.user as { groups?: string[] }).groups || [];
  const role = roleFromGroups(groups);
  const allowed = isStatic
    ? canUseAgentStatic(slug, role)
    : await canUseAgent(slug, role);
  if (!allowed) {
    const agentName = isStatic ? AGENTS[slug].name : (dynamicAgent?.name || slug);
    const agentRoles = isStatic
      ? AGENTS[slug].allowedRoles
      : dynamicAgent?.allowed_roles;
    return NextResponse.json(
      {
        error: "agent_forbidden",
        message:
          `L'agent « ${agentName} » est réservé aux ` +
          (agentRoles?.join(" / ") || "rôles autorisés") + ".",
        agent: slug,
      },
      { status: 403 },
    );
  }

  const key = isStatic ? getAgentKey(slug) : await getAgentKeyAny(slug);
  if (!key) {
    const agentName = isStatic ? AGENTS[slug].name : (dynamicAgent?.name || slug);
    return NextResponse.json(
      { error: "agent_unavailable",
        message: `L'agent « ${agentName} » n'est pas configuré.`,
        agent: slug },
      { status: 503 },
    );
  }
  return { user: session.user.email, key, agent: slug };
}

/** Wrapper minimaliste pour appeler Dify avec le bon header Bearer. */
export async function difyFetch(
  path: string,
  init: RequestInit & { key: string } = { key: "" },
): Promise<Response> {
  const { key, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (!headers.has("Content-Type") && rest.body) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${DIFY_BASE_URL}${path}`, { ...rest, headers });
}

/**
 * Fichier attaché à un message Dify (image ou document).
 * Doit avoir été pré-uploadé via /v1/files/upload (cf /api/files/upload).
 */
export interface DifyFile {
  type: "image" | "document";
  transfer_method: "local_file" | "remote_url";
  upload_file_id?: string;
  url?: string;
}

export interface DifyChatOptions {
  /** Identifiant utilisateur Dify (= email NextAuth). */
  user: string;
  /** Clé API de l'agent ciblé (résolu via requireDifyContext / getAgentKey). */
  key: string;
  /** Question/message utilisateur. Sera envoyé tel quel dans `query`. */
  query: string;
  /** Conversation existante à continuer. Vide → nouvelle conversation. */
  conversationId?: string;
  /** Fichiers attachés. */
  files?: DifyFile[];
  /** Inputs Dify (pour les apps Chatflow paramétrés). Défaut : {}. */
  inputs?: Record<string, unknown>;
  /** AbortSignal client (propage l'annulation). */
  signal?: AbortSignal;
}

/**
 * Appelle `/v1/chat-messages` en mode `streaming` et retourne la Response
 * upstream brute (SSE). Le caller est responsable du parsing/tee/filtre.
 *
 * Sur 2xx + body : retourne `{ ok: true, response }`.
 * Sur erreur upstream (status non-2xx ou body absent) : retourne
 * `{ ok: false, status, bodyPreview }` — le caller peut transformer
 * en NextResponse JSON ou en error tool.
 *
 * Helper introduit Sprint 0 S0.1 — mutualise l'appel Dify utilisé par
 * /api/chat et (futur) /api/agents-tools/delegate_to_specialist.
 */
export async function difyChatStream(opts: DifyChatOptions): Promise<
  | { ok: true; response: Response; body: ReadableStream<Uint8Array> }
  | { ok: false; status: number; bodyPreview: string }
> {
  const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.key}`,
    },
    body: JSON.stringify({
      inputs: opts.inputs || {},
      query: opts.query,
      response_mode: "streaming",
      conversation_id: opts.conversationId || "",
      user: opts.user,
      files: opts.files || [],
    }),
    signal: opts.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => "");
    return {
      ok: false,
      status: upstream.status,
      bodyPreview: text.slice(0, 500),
    };
  }
  // Body est garanti non-null ici (check ci-dessus). On l'expose
  // explicitement pour que TS le voie aussi côté caller.
  return { ok: true, response: upstream, body: upstream.body };
}

/**
 * Variante "blocking" : appelle Dify en mode `blocking` et retourne
 * `{ answer, conversationId }` ou une erreur. Utilisée par les tools
 * qui veulent une réponse synchrone (delegate_to_specialist) plutôt
 * qu'un stream.
 *
 * @param timeoutMs durée max avant `AbortError` côté caller (défaut 60s).
 */
export async function difyChatBlocking(
  opts: DifyChatOptions & { timeoutMs?: number },
): Promise<
  | { ok: true; answer: string; conversationId: string; messageId?: string }
  | { ok: false; status: number; bodyPreview: string }
> {
  const ctrl = new AbortController();
  const linkAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", linkAbort, { once: true });
  }
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000);

  try {
    const upstream = await fetch(`${DIFY_BASE_URL}/v1/chat-messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.key}`,
      },
      body: JSON.stringify({
        inputs: opts.inputs || {},
        query: opts.query,
        response_mode: "blocking",
        conversation_id: opts.conversationId || "",
        user: opts.user,
        files: opts.files || [],
      }),
      signal: ctrl.signal,
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return {
        ok: false,
        status: upstream.status,
        bodyPreview: text.slice(0, 500),
      };
    }
    const data = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
    const answer = typeof data.answer === "string" ? data.answer : "";
    const conversationId = typeof data.conversation_id === "string"
      ? data.conversation_id
      : "";
    const messageId = typeof data.message_id === "string" ? data.message_id : undefined;
    return { ok: true, answer, conversationId, messageId };
  } finally {
    clearTimeout(timeout);
    if (opts.signal) opts.signal.removeEventListener("abort", linkAbort);
  }
}
