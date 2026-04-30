/**
 * Cache simple de l'état is_active des utilisateurs (à partir d'Authentik).
 *
 * Utilisé par les routes API pour rapidement vérifier que l'utilisateur
 * connecté est toujours actif côté Authentik. TTL court (3 min) pour
 * que la désactivation se propage rapidement, mais suffisamment long
 * pour ne pas bombarder Authentik à chaque requête.
 */
const TTL_MS = 3 * 60 * 1000;
const cache = new Map<string, { active: boolean; checked_at: number }>();

const AK_URL = process.env.AUTHENTIK_API_URL || "http://localhost:9000";
const AK_TOKEN = process.env.AUTHENTIK_API_TOKEN || "";

export interface UserActiveCheck {
  active: boolean;
  /** true si on a hit Authentik, false si on a servi depuis le cache. */
  fresh: boolean;
}

export async function isUserActive(email: string): Promise<UserActiveCheck> {
  if (!email) return { active: false, fresh: true };
  if (!AK_TOKEN) {
    // Pas de token admin → on ne peut pas vérifier, on assume actif
    // (fail-open : pas envie de bloquer toute l'app si l'AK_TOKEN est
    // absent — c'est documenté dans setup_authentik_management).
    return { active: true, fresh: true };
  }

  const now = Date.now();
  const cached = cache.get(email);
  if (cached && now - cached.checked_at < TTL_MS) {
    return { active: cached.active, fresh: false };
  }

  try {
    const r = await fetch(
      `${AK_URL}/api/v3/core/users/?email=${encodeURIComponent(email)}`,
      {
        headers: { Authorization: `Bearer ${AK_TOKEN}` },
        // Court timeout pour ne pas bloquer si Authentik rame
        signal: AbortSignal.timeout(2500),
      },
    );
    if (!r.ok) {
      // Si Authentik renvoie une erreur, on fail-open (mieux qu'un
      // déni de service global)
      return { active: cached?.active ?? true, fresh: false };
    }
    const j = await r.json();
    const u = (j.results || [])[0];
    const active = !!u?.is_active;
    cache.set(email, { active, checked_at: now });
    return { active, fresh: true };
  } catch {
    return { active: cached?.active ?? true, fresh: false };
  }
}

/** Nettoie le cache (utile pour les tests / rotations). */
export function clearUserCache(email?: string) {
  if (email) cache.delete(email);
  else cache.clear();
}
