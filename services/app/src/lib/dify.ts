/**
 * Helpers serveur pour l'API Dify v1 (App API).
 *
 * Toutes les requêtes utilisent la clé d'un agent (résolu par slug via
 * src/lib/agents.ts). L'identité utilisateur Dify = email NextAuth.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getAgentKey, defaultAgentSlug, AGENTS } from "@/lib/agents";

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

  const slug = agentSlug || defaultAgentSlug();
  if (!slug) {
    return NextResponse.json(
      { error: "no_agent",
        message: "Aucun agent n'est configuré sur cette AI Box." },
      { status: 503 },
    );
  }
  if (!AGENTS[slug]) {
    return NextResponse.json(
      { error: "unknown_agent", agent: slug },
      { status: 400 },
    );
  }
  const key = getAgentKey(slug);
  if (!key) {
    return NextResponse.json(
      { error: "agent_unavailable",
        message: `L'agent « ${AGENTS[slug].name} » n'est pas configuré.`,
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
