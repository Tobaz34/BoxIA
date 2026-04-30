/**
 * Client n8n REST API (server-side).
 *
 * n8n n'expose pas d'API token simple — on utilise l'auth par cookie
 * de session (login admin avec ADMIN_EMAIL / ADMIN_PASSWORD du wizard).
 * Le cookie est mis en cache 5 min pour éviter le re-login à chaque
 * requête.
 */
const N8N_BASE = process.env.N8N_BASE_URL || "http://localhost:5678";
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

interface CachedAuth {
  cookieHeader: string;
  expires_at: number;
}
let cached: CachedAuth | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loginN8n(): Promise<CachedAuth | null> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;
  try {
    const r = await fetch(`${N8N_BASE}/rest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emailOrLdapLoginId: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
      }),
    });
    if (!r.ok) return null;
    type HasGetSetCookie = { getSetCookie?: () => string[] };
    const headers = r.headers as unknown as HasGetSetCookie;
    let cookies: string[] = [];
    if (typeof headers.getSetCookie === "function") {
      cookies = headers.getSetCookie();
    } else {
      const sc = r.headers.get("set-cookie");
      if (sc) cookies = [sc];
    }
    const cookiePairs: string[] = [];
    for (const sc of cookies) {
      const m = sc.match(/^([^=]+)=([^;]+)/);
      if (m) cookiePairs.push(`${m[1]}=${m[2]}`);
    }
    if (cookiePairs.length === 0) return null;
    return {
      cookieHeader: cookiePairs.join("; "),
      expires_at: Date.now() + CACHE_TTL_MS,
    };
  } catch (e) {
    console.warn("[n8n] login error:", e);
    return null;
  }
}

async function getAuth(): Promise<CachedAuth | null> {
  if (cached && cached.expires_at > Date.now()) return cached;
  cached = await loginN8n();
  return cached;
}

export async function n8nFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = await getAuth();
  if (!auth) throw new Error("n8n login failed");
  const headers = new Headers(init.headers);
  headers.set("Cookie", auth.cookieHeader);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const r = await fetch(`${N8N_BASE}${path}`, { ...init, headers });
  if (r.status === 401) {
    cached = null;
    const a2 = await getAuth();
    if (a2) {
      const h2 = new Headers(init.headers);
      h2.set("Cookie", a2.cookieHeader);
      if (init.body && !h2.has("Content-Type")) h2.set("Content-Type", "application/json");
      return fetch(`${N8N_BASE}${path}`, { ...init, headers: h2 });
    }
  }
  return r;
}

export interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: { id: string; name: string }[];
  nodes?: { type: string; name: string }[];
  triggerCount?: number;
}

export async function listWorkflows(): Promise<N8nWorkflow[]> {
  try {
    const r = await n8nFetch("/rest/workflows?includeScopes=true");
    if (!r.ok) return [];
    const j = await r.json();
    // n8n peut renvoyer { data: [...] } ou directement [...]
    const data = Array.isArray(j) ? j : j.data;
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export async function setWorkflowActive(id: string, active: boolean): Promise<boolean> {
  try {
    const r = await n8nFetch(`/rest/workflows/${id}/${active ? "activate" : "deactivate"}`, {
      method: "POST",
    });
    return r.ok;
  } catch {
    return false;
  }
}
