/**
 * Helpers serveur pour l'API Dify v1 (App API).
 *
 * Toutes les requêtes utilisent la clé de l'agent par défaut
 * (DIFY_DEFAULT_APP_API_KEY). L'identité utilisateur Dify =
 * email NextAuth (scope l'historique par user).
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export const DIFY_BASE_URL =
  process.env.DIFY_BASE_URL || "http://localhost:8081";
export const DIFY_API_KEY =
  process.env.DIFY_DEFAULT_APP_API_KEY || "";

/**
 * Récupère l'utilisateur et la clé. Retourne {user, key} ou une NextResponse
 * d'erreur prête à être renvoyée au client.
 */
export async function requireDifyContext(): Promise<
  { user: string; key: string } | NextResponse
> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!DIFY_API_KEY) {
    return NextResponse.json(
      { error: "no_default_agent",
        message: "Aucun assistant par défaut n'est configuré." },
      { status: 503 },
    );
  }
  return { user: session.user.email, key: DIFY_API_KEY };
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
