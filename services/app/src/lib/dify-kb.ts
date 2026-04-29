/**
 * Helpers serveur pour l'API Dify v1 (Service Dataset API).
 *
 * Cette API est DISTINCTE de l'App API : elle utilise sa propre clé
 * (DIFY_KB_API_KEY = Bearer dataset-...) et son propre dataset
 * (DIFY_DEFAULT_DATASET_ID).
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export const DIFY_BASE_URL =
  process.env.DIFY_BASE_URL || "http://localhost:8081";
export const DIFY_KB_API_KEY =
  process.env.DIFY_KB_API_KEY || "";
export const DIFY_DEFAULT_DATASET_ID =
  process.env.DIFY_DEFAULT_DATASET_ID || "";

export async function requireKbContext(): Promise<
  { user: string; key: string; datasetId: string } | NextResponse
> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!DIFY_KB_API_KEY || !DIFY_DEFAULT_DATASET_ID) {
    return NextResponse.json(
      {
        error: "kb_unavailable",
        message:
          "La base de connaissances n'est pas configurée. " +
          "Demandez à l'administrateur de relancer le provisioning.",
      },
      { status: 503 },
    );
  }
  return {
    user: session.user.email,
    key: DIFY_KB_API_KEY,
    datasetId: DIFY_DEFAULT_DATASET_ID,
  };
}

export async function kbFetch(
  path: string,
  init: RequestInit & { key: string } = { key: "" },
): Promise<Response> {
  const { key, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set("Authorization", `Bearer ${key}`);
  if (!headers.has("Content-Type") && rest.body && !(rest.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${DIFY_BASE_URL}${path}`, { ...rest, headers });
}
