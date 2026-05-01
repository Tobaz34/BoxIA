/**
 * Client mem0 (mémoire long-terme par user) — service `aibox-mem0`.
 *
 * Activé par feature flag (env `MEM0_API_KEY` présent). Si absent, no-op
 * silencieux : on ne casse pas le chat si le service est down ou pas configuré.
 *
 * 2 fonctions principales :
 * - `searchUserMemory(userId, query, limit)` : récupère le top-K facts
 *   pertinents pour le contexte avant d'envoyer au LLM
 * - `addUserMemory(userId, agentId, messages)` : extrait + stocke les faits
 *   après un échange réussi (fire-and-forget, non bloquant)
 */

const MEMORY_BASE_URL = process.env.MEM0_BASE_URL || "http://aibox-mem0:8000";
const MEMORY_API_KEY = process.env.MEM0_API_KEY || "";
const MEMORY_TIMEOUT_MS = Number(process.env.MEM0_TIMEOUT_MS || 5000);
const MEMORY_FETCH_LIMIT = Number(process.env.MEM0_SEARCH_LIMIT || 5);

export interface MemoryFact {
  id: string;
  user_id: string;
  agent_id: string;
  fact: string;
  source_text: string;
  created_at: string;
  score: number | null;
  metadata: Record<string, unknown>;
}

export function isMemoryEnabled(): boolean {
  return Boolean(MEMORY_API_KEY);
}

/**
 * Recherche les faits pertinents pour un user. Renvoie [] si désactivé ou erreur.
 * NE LÈVE JAMAIS — la mémoire est best-effort, pas critique.
 */
export async function searchUserMemory(
  userId: string,
  query: string,
  options?: { limit?: number; agentId?: string }
): Promise<MemoryFact[]> {
  if (!isMemoryEnabled() || !userId) return [];

  const limit = options?.limit ?? MEMORY_FETCH_LIMIT;
  const params = new URLSearchParams({
    user_id: userId,
    query: query.slice(0, 1000),
    limit: String(limit),
  });
  if (options?.agentId) params.set("agent_id", options.agentId);

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEMORY_TIMEOUT_MS);
    const r = await fetch(`${MEMORY_BASE_URL}/memory/search?${params}`, {
      headers: { Authorization: `Bearer ${MEMORY_API_KEY}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data?.facts) ? data.facts : [];
  } catch {
    return [];
  }
}

/**
 * Stocke un nouvel échange en mémoire. Fire-and-forget : ne bloque pas la
 * réponse au user, on n'attend pas le résultat.
 */
export function addUserMemory(
  userId: string,
  agentId: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  metadata?: Record<string, unknown>
): void {
  if (!isMemoryEnabled() || !userId || messages.length === 0) return;

  // Fire-and-forget : pas d'await
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30_000); // mem0 add est lent
      await fetch(`${MEMORY_BASE_URL}/memory/add`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${MEMORY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          agent_id: agentId,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content.slice(0, 8000),
          })),
          metadata: metadata || {},
        }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
    } catch {
      // Silencieux — la mémoire ne doit jamais casser le chat
    }
  })();
}

/**
 * Suppression complète de la mémoire d'un user (RGPD art. 17).
 * À appeler depuis l'endpoint `/api/me/delete-conversations` (ou un nouveau).
 */
export async function deleteUserMemory(userId: string): Promise<{ ok: boolean; facts_deleted?: number; error?: string }> {
  if (!isMemoryEnabled()) return { ok: true, facts_deleted: 0 };
  try {
    const r = await fetch(`${MEMORY_BASE_URL}/memory/user/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${MEMORY_API_KEY}` },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, facts_deleted: data?.facts_deleted };
  } catch (e: unknown) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Format une liste de facts en bloc texte injectable dans un system prompt.
 * Vide si pas de facts.
 */
export function formatMemoryContext(facts: MemoryFact[]): string {
  if (!facts || facts.length === 0) return "";
  const lines = facts.map((f, i) => `${i + 1}. ${f.fact}`).join("\n");
  return `Mémoire utilisateur (informations connues sur ce user) :\n${lines}\n\nUtilise ces informations si elles sont pertinentes pour répondre, sans les répéter explicitement sauf si demandé.\n\n`;
}
