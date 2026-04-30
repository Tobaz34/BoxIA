/**
 * Client Dify Console API pour l'édition des apps/agents.
 *
 * Contrairement aux App API keys (Bearer app-...) utilisées dans
 * /lib/dify.ts, l'API console nécessite un login admin (cookies HttpOnly
 * + Bearer tokens). On se connecte avec ADMIN_EMAIL / ADMIN_PASSWORD du
 * .env (provisionnés par le wizard) à chaque requête — c'est moins
 * efficace qu'un service token, mais Dify 1.x n'expose pas de tel token
 * pour l'API console.
 *
 * Cache du token : 5 min en mémoire pour limiter les logins répétés.
 */
const DIFY_BASE_URL = process.env.DIFY_BASE_URL || "http://localhost:8081";
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

interface CachedAuth {
  cookieHeader: string;
  csrfToken: string;
  expires_at: number;
}
let cached: CachedAuth | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function login(): Promise<CachedAuth | null> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;
  try {
    const r = await fetch(`${DIFY_BASE_URL}/console/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        language: "fr-FR",
        remember_me: true,
      }),
    });
    if (!r.ok) return null;
    // Dify met les tokens en cookies httpOnly. On reconstruit
    // le cookie header pour les prochaines requêtes + on extrait
    // l'access_token pour l'header Authorization.
    const setCookieHeaders: string[] = [];
    // Node fetch via undici expose les multiple set-cookie via getSetCookie()
    // (disponible en Node 18.14+). Fallback sur header séparé.
    type HasGetSetCookie = { getSetCookie?: () => string[] };
    const headers = r.headers as unknown as HasGetSetCookie;
    if (typeof headers.getSetCookie === "function") {
      setCookieHeaders.push(...headers.getSetCookie());
    } else {
      const sc = r.headers.get("set-cookie");
      if (sc) setCookieHeaders.push(sc);
    }

    let access = "", csrf = "", refresh = "";
    for (const sc of setCookieHeaders) {
      const m = sc.match(/^(\w+)=([^;]+)/);
      if (!m) continue;
      const [, name, value] = m;
      if (name === "access_token") access = value!;
      else if (name === "csrf_token") csrf = value!;
      else if (name === "refresh_token") refresh = value!;
    }
    if (!access) return null;

    const cookieHeader = [
      `access_token=${access}`,
      csrf ? `csrf_token=${csrf}` : "",
      refresh ? `refresh_token=${refresh}` : "",
    ].filter(Boolean).join("; ");

    return {
      cookieHeader,
      csrfToken: csrf,
      expires_at: Date.now() + CACHE_TTL_MS,
    };
  } catch (e) {
    console.warn("[dify-console] login error:", e);
    return null;
  }
}

async function getAuth(): Promise<CachedAuth | null> {
  if (cached && cached.expires_at > Date.now()) return cached;
  cached = await login();
  return cached;
}

/** Wrapper fetch authentifié vers /console/api/. */
export async function consoleFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const auth = await getAuth();
  if (!auth) {
    throw new Error("Dify console login failed (ADMIN_EMAIL/ADMIN_PASSWORD?)");
  }
  // Extract access_token value from cookieHeader
  const accessMatch = auth.cookieHeader.match(/access_token=([^;]+)/);
  const accessToken = accessMatch?.[1] || "";

  const headers = new Headers(init.headers);
  headers.set("Cookie", auth.cookieHeader);
  if (accessToken) headers.set("Authorization", `Bearer ${accessToken}`);
  if (auth.csrfToken) headers.set("X-CSRF-TOKEN", auth.csrfToken);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const r = await fetch(`${DIFY_BASE_URL}${path}`, { ...init, headers });
  // Si 401, on invalide le cache et on retente une fois
  if (r.status === 401) {
    cached = null;
    const auth2 = await getAuth();
    if (auth2) {
      const accessMatch2 = auth2.cookieHeader.match(/access_token=([^;]+)/);
      const accessToken2 = accessMatch2?.[1] || "";
      const h2 = new Headers(init.headers);
      h2.set("Cookie", auth2.cookieHeader);
      if (accessToken2) h2.set("Authorization", `Bearer ${accessToken2}`);
      if (auth2.csrfToken) h2.set("X-CSRF-TOKEN", auth2.csrfToken);
      if (init.body && !h2.has("Content-Type")) h2.set("Content-Type", "application/json");
      return fetch(`${DIFY_BASE_URL}${path}`, { ...init, headers: h2 });
    }
  }
  return r;
}

export interface DifyAppDetail {
  id: string;
  name: string;
  description: string;
  icon: string;
  icon_background: string;
  mode: string;
  model_config?: {
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
    suggested_questions_after_answer?: { enabled: boolean };
    model?: { provider: string; name: string; mode: string };
  };
}

/** Récupère la config détaillée d'une app Dify par son ID. */
export async function getDifyApp(appId: string): Promise<DifyAppDetail | null> {
  try {
    const r = await consoleFetch(`/console/api/apps/${appId}`);
    if (!r.ok) return null;
    return (await r.json()) as DifyAppDetail;
  } catch {
    return null;
  }
}

/** Met à jour le model-config d'une app Dify (pre_prompt, opening, suggestions). */
export async function updateDifyAppConfig(
  appId: string,
  patch: {
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
  },
): Promise<{ ok: boolean; error?: string }> {
  // On doit poster le model-config COMPLET (Dify ne fait pas de patch
  // partiel). On récupère le current, on merge nos changements.
  const current = await getDifyApp(appId);
  if (!current?.model_config) {
    return { ok: false, error: "no_current_config" };
  }
  const mc = JSON.parse(JSON.stringify(current.model_config));
  // Strip read-only fields
  for (const k of ["id", "app_id", "provider", "created_at", "updated_at"]) {
    delete mc[k];
  }
  if (patch.pre_prompt !== undefined) mc.pre_prompt = patch.pre_prompt;
  if (patch.opening_statement !== undefined) mc.opening_statement = patch.opening_statement;
  if (patch.suggested_questions !== undefined) mc.suggested_questions = patch.suggested_questions;

  const r = await consoleFetch(`/console/api/apps/${appId}/model-config`, {
    method: "POST",
    body: JSON.stringify(mc),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return { ok: false, error: `status=${r.status} ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

/** Recherche un app par nom (utile pour mapper agent.slug → app.id). */
export async function findDifyAppIdByName(name: string): Promise<string | null> {
  try {
    const r = await consoleFetch(`/console/api/apps?page=1&limit=50`);
    if (!r.ok) return null;
    const j = await r.json();
    for (const app of j.data || []) {
      if (app.name === name) return app.id;
    }
    return null;
  } catch {
    return null;
  }
}
