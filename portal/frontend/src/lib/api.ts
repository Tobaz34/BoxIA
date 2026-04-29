// Client API typé pour le backend FastAPI portal/backend.

export type Client = {
  id: number;
  name: string;
  sector: string;
  users_count: number;
  domain: string;
  admin_email: string;
  server_ip: string;
  server_user: string;
  hw_profile: "tpe" | "pme" | "pme-plus";
  status: "draft" | "deploying" | "deployed" | "failed";
  config_yaml?: string;
  deployed_at?: string;
};

export type Questionnaire = {
  items?: QuestionItem[];
  chapters?: { id: string; label: string; items: QuestionItem[] }[];
};

export type QuestionItem = {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  options?: ({ value: string; label: string; activates?: string[] })[] | string[];
};

const BASE = "/api";

async function http<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`${method} ${path} → ${r.status} ${text}`);
  }
  return r.json() as Promise<T>;
}

export const api = {
  listClients: () => http<Client[]>("GET", "/clients"),
  getClient:   (id: number) => http<Client>("GET", `/clients/${id}`),
  createClient: (payload: Partial<Client>) => http<Client>("POST", "/clients", payload),
  questionnaire: (full = false) =>
    http<Questionnaire>("GET", `/questionnaire${full ? "?full=true" : ""}`),
  deploy: (id: number, body: { technologies: Record<string, unknown>; use_cases?: string[] }) =>
    http<{ client_id: number; status: string; config_preview?: string }>(
      "POST",
      `/clients/${id}/deploy`,
      body,
    ),
};
