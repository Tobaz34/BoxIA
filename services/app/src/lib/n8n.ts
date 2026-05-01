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
// n8n exige un password 8+ chars + 1 majuscule + 1 chiffre. Le ADMIN_PASSWORD
// historique (généré par `gen_secret`) ne respectait pas toujours la règle, on
// stocke donc un mot de passe spécifique n8n dans .env (auto-provisionné par
// le wizard first-run). Fallback sur ADMIN_PASSWORD pour rétro-compat.
const ADMIN_PASSWORD = process.env.N8N_PASSWORD || process.env.ADMIN_PASSWORD || "";

interface CachedAuth {
  cookieHeader: string;
  expires_at: number;
}
let cached: CachedAuth | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function loginN8n(): Promise<CachedAuth | null> {
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return null;
  try {
    // n8n 1.x utilise `emailOrLdapLoginId`. Depuis ~1.70 le serveur
    // attend `email` directement (renvoie 500 « Email is required »
    // sinon). On envoie les deux clés pour être rétro-compatible avec
    // les anciennes versions ET la nouvelle.
    const r = await fetch(`${N8N_BASE}/rest/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: ADMIN_EMAIL,
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
  // n8n 1.70+ : PATCH /rest/workflows/<id> body {"active":true|false}.
  // n8n < 1.70 : POST /rest/workflows/<id>/(de)activate.
  // On essaie PATCH d'abord, fallback POST /(de)activate sur 404.
  try {
    const pr = await n8nFetch(`/rest/workflows/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    });
    if (pr.ok) return true;
    if (pr.status === 404) {
      const r = await n8nFetch(
        `/rest/workflows/${id}/${active ? "activate" : "deactivate"}`,
        { method: "POST" },
      );
      return r.ok;
    }
    return false;
  } catch {
    return false;
  }
}

export interface N8nExecution {
  id: string;
  workflowId?: string;
  finished?: boolean;
  status?: "success" | "error" | "running" | "waiting" | "canceled" | "crashed" | "new";
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
  retryOf?: string | null;
  retrySuccessId?: string | null;
}

interface N8nExecutionsResponse {
  results?: N8nExecution[];
  data?: N8nExecution[];
  count?: number;
  estimated?: boolean;
}

/** Liste les exécutions d'un workflow (ou globalement si workflowId omis). */
export async function listExecutions(
  workflowId?: string,
  limit = 25,
): Promise<N8nExecution[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (workflowId) {
    // n8n attend une `filter` JSON-encoded
    params.set("filter", JSON.stringify({ workflowId }));
  }
  try {
    const r = await n8nFetch(`/rest/executions?${params}`);
    if (!r.ok) return [];
    const j = (await r.json()) as N8nExecutionsResponse;
    return j.results || j.data || [];
  } catch {
    return [];
  }
}

/** Stats globales : count par statut sur les N derniers jours.
 *  N8n ne fournit pas d'endpoint d'agrégation — on liste et on compte. */
export async function executionsStats(
  workflowId?: string,
  daysBack = 7,
  limit = 200,
): Promise<{ success: number; error: number; running: number; total: number }> {
  const list = await listExecutions(workflowId, limit);
  const cutoff = Date.now() - daysBack * 86400_000;
  let success = 0, error = 0, running = 0, total = 0;
  for (const e of list) {
    if (e.startedAt && new Date(e.startedAt).getTime() < cutoff) continue;
    total++;
    if (e.status === "success" || (e.finished && !e.status)) success++;
    else if (e.status === "error" || e.status === "crashed") error++;
    else if (e.status === "running" || e.status === "waiting") running++;
  }
  return { success, error, running, total };
}

export interface N8nCredential {
  id: string;
  name: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Liste les credentials configurés (lecture seule, sans secrets). */
export async function listCredentials(): Promise<N8nCredential[]> {
  try {
    const r = await n8nFetch("/rest/credentials");
    if (!r.ok) return [];
    const j = await r.json();
    const data = j.data || j;
    return (Array.isArray(data) ? data : []).map((c: Record<string, unknown>) => ({
      id: String(c.id),
      name: String(c.name || "(sans nom)"),
      type: c.type ? String(c.type) : undefined,
      createdAt: c.createdAt ? String(c.createdAt) : undefined,
      updatedAt: c.updatedAt ? String(c.updatedAt) : undefined,
    }));
  } catch {
    return [];
  }
}

/** Déclenche manuellement un workflow via /rest/workflows/<id>/run.
 *  n8n renvoie un `executionId` qu'on peut suivre via /rest/executions/<id>.
 */
export async function runWorkflow(
  workflowId: string,
): Promise<{ ok: boolean; executionId?: string; error?: string }> {
  try {
    const r = await n8nFetch(`/rest/workflows/${workflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ workflowData: {} }),
    });
    if (!r.ok) {
      return { ok: false, error: `HTTP ${r.status}` };
    }
    const j = await r.json();
    return { ok: true, executionId: j.data?.executionId || j.executionId };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

/** Crée un workflow dans n8n à partir de son JSON.
 *  Retourne le workflow créé (avec id) ou null si échec.
 *
 *  Le JSON template peut venir de templates/n8n/*.json. n8n accepte le
 *  format complet (name, nodes, connections, settings, etc.). On strip
 *  les champs id/createdAt/updatedAt qui doivent être assignés par n8n.
 */
export async function createWorkflow(
  template: Record<string, unknown>,
): Promise<N8nWorkflow | null> {
  try {
    // Strip les champs read-only ET serveur-side avant push.
    // n8n exige active NOT NULL côté DB SQLite (sinon SQLITE_CONSTRAINT 500).
    // settings doit aussi exister (objet vide accepté).
    const {
      id: _id, createdAt: _ca, updatedAt: _ua, versionId: _vid,
      active: _act, triggerCount: _tc, pinData: _pd,
      staticData: _sd, meta: _meta, shared: _sh,
      ...payload
    } = template as Record<string, unknown>;
    void _id; void _ca; void _ua; void _vid; void _act; void _tc;
    void _pd; void _sd; void _meta; void _sh;

    const finalPayload: Record<string, unknown> = {
      ...payload,
      active: false,                     // toujours désactivé à la création
      settings: payload.settings || {},  // objet requis
    };

    const r = await n8nFetch("/rest/workflows", {
      method: "POST",
      body: JSON.stringify(finalPayload),
    });
    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      console.warn("[n8n] createWorkflow non-ok:", r.status, errBody.slice(0, 200));
      return null;
    }
    const j = await r.json();
    return (j.data || j) as N8nWorkflow;
  } catch (e) {
    console.warn("[n8n] createWorkflow error:", e);
    return null;
  }
}
