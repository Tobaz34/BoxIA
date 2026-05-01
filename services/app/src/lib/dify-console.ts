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
    model?: {
      provider: string;
      name: string;
      mode: string;
      completion_params?: {
        temperature?: number;
        top_p?: number;
        max_tokens?: number;
      };
    };
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

/** Met à jour le model-config d'une app Dify (pre_prompt, opening, suggestions, model). */
export async function updateDifyAppConfig(
  appId: string,
  patch: {
    pre_prompt?: string;
    opening_statement?: string;
    suggested_questions?: string[];
    model_name?: string;
    max_tokens?: number;
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
  if (patch.model_name !== undefined) {
    if (!mc.model) {
      return { ok: false, error: "no_model_in_config" };
    }
    // S'assurer que le modèle est enregistré côté provider Ollama avant
    // de switch (sinon Dify renvoie dify_upstream_error au runtime).
    const reg = await ensureOllamaModelRegistered(patch.model_name);
    if (!reg.ok) {
      return { ok: false, error: `register_failed: ${reg.error || "unknown"}` };
    }
    mc.model.name = patch.model_name;
    if (!mc.model.provider) mc.model.provider = "langgenius/ollama/ollama";
    if (!mc.model.mode) mc.model.mode = "chat";
  }
  if (patch.max_tokens !== undefined) {
    if (!mc.model) {
      return { ok: false, error: "no_model_in_config" };
    }
    mc.model.completion_params = {
      ...(mc.model.completion_params || {}),
      max_tokens: patch.max_tokens,
    };
  }

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

/** Liste les modèles Ollama enregistrés dans Dify (langgenius/ollama/ollama). */
export async function listOllamaModelsInDify(): Promise<string[]> {
  const provider = "langgenius/ollama/ollama";
  try {
    const r = await consoleFetch(
      `/console/api/workspaces/current/model-providers/${provider}/models`,
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || [])
      .map((m: { model?: string }) => m.model || "")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Enregistre un modèle Ollama dans Dify si absent (idempotent).
 *  Sans cette étape, l'app Dify renvoie dify_upstream_error. */
export async function ensureOllamaModelRegistered(
  modelName: string,
): Promise<{ ok: boolean; added: boolean; error?: string }> {
  const existing = await listOllamaModelsInDify();
  if (existing.includes(modelName)) {
    return { ok: true, added: false };
  }
  const provider = "langgenius/ollama/ollama";
  const ollamaUrl = process.env.OLLAMA_INTERNAL_URL || "http://ollama:11434";
  try {
    const r = await consoleFetch(
      `/console/api/workspaces/current/model-providers/${provider}/models/credentials`,
      {
        method: "POST",
        body: JSON.stringify({
          model: modelName,
          model_type: "llm",
          credentials: {
            mode: "chat",
            model: modelName,
            context_size: "4096",
            max_tokens: "4096",
            base_url: ollamaUrl,
          },
        }),
      },
    );
    if (r.status !== 200 && r.status !== 201) {
      const text = await r.text().catch(() => "");
      return { ok: false, added: false, error: `status=${r.status} ${text.slice(0, 200)}` };
    }
    return { ok: true, added: true };
  } catch (e) {
    return { ok: false, added: false, error: (e as Error).message };
  }
}

/** Crée une nouvelle app Dify de type "chat" (mode chat).
 *  Renvoie l'ID de l'app créée ou null. */
export async function createDifyChatApp(
  name: string,
  description: string,
  icon: string = "🤖",
): Promise<{ id: string } | null> {
  try {
    const r = await consoleFetch(`/console/api/apps`, {
      method: "POST",
      body: JSON.stringify({
        name,
        description: description.slice(0, 200),
        icon_type: "emoji",
        icon: icon.slice(0, 4),
        icon_background: "#FFEAD5",
        mode: "chat",
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn("[dify-console] createDifyChatApp failed:", r.status, t.slice(0, 200));
      return null;
    }
    const j = await r.json();
    if (!j.id) return null;
    return { id: j.id };
  } catch (e) {
    console.warn("[dify-console] createDifyChatApp error:", e);
    return null;
  }
}

/** Configure le model-config initial d'une app Dify fraîchement créée. */
export async function setDifyAppInitialConfig(
  appId: string,
  config: {
    model_name: string;
    pre_prompt: string;
    opening_statement: string;
    suggested_questions: string[];
    max_tokens?: number;
  },
): Promise<{ ok: boolean; error?: string }> {
  // S'assure que le modèle est enregistré côté provider Ollama
  const reg = await ensureOllamaModelRegistered(config.model_name);
  if (!reg.ok) {
    return { ok: false, error: `register_failed: ${reg.error || "unknown"}` };
  }
  const mc = {
    pre_prompt: config.pre_prompt,
    prompt_type: "simple",
    chat_prompt_config: {},
    completion_prompt_config: {},
    user_input_form: [],
    dataset_query_variable: "",
    more_like_this: { enabled: false },
    opening_statement: config.opening_statement,
    suggested_questions: config.suggested_questions,
    suggested_questions_after_answer: { enabled: true },
    speech_to_text: { enabled: false },
    text_to_speech: { enabled: false, voice: "", language: "fr" },
    retriever_resource: { enabled: true },
    sensitive_word_avoidance: { enabled: false, type: "", configs: [] },
    agent_mode: { enabled: false, tools: [] },
    model: {
      provider: "langgenius/ollama/ollama",
      name: config.model_name,
      mode: "chat",
      completion_params: {
        temperature: 0.7,
        top_p: 1,
        max_tokens: config.max_tokens || 2048,
      },
    },
    dataset_configs: { retrieval_model: "multiple", top_k: 4 },
  };
  const r = await consoleFetch(`/console/api/apps/${appId}/model-config`, {
    method: "POST",
    body: JSON.stringify(mc),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return { ok: false, error: `status=${r.status} ${t.slice(0, 200)}` };
  }
  return { ok: true };
}

/** Génère une App API key pour une app Dify (token Bearer app-...).
 *  Cette clé est utilisée pour le runtime chat/messaging. */
export async function createDifyAppApiKey(
  appId: string,
): Promise<{ token: string } | null> {
  try {
    const r = await consoleFetch(`/console/api/apps/${appId}/api-keys`, {
      method: "POST",
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      console.warn("[dify-console] createDifyAppApiKey failed:", r.status, t.slice(0, 200));
      return null;
    }
    const j = await r.json();
    if (!j.token) return null;
    return { token: j.token };
  } catch (e) {
    console.warn("[dify-console] createDifyAppApiKey error:", e);
    return null;
  }
}

/** Supprime une app Dify par son ID. */
export async function deleteDifyApp(appId: string): Promise<boolean> {
  try {
    const r = await consoleFetch(`/console/api/apps/${appId}`, {
      method: "DELETE",
    });
    return r.ok;
  } catch {
    return false;
  }
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
