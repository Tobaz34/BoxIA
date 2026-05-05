/**
 * Bridge connecteurs BoxIA → credentials n8n.
 *
 * Quand un user active un connecteur dans /connectors (slug `imap-generic`,
 * `smtp`, etc.), on pousse les credentials correspondantes dans n8n sous
 * forme de credential native typée. Ça permet aux workflows marketplace
 * qui utilisent les nodes n8n natifs (`emailReadImap`, `emailSend`, …) de
 * fonctionner sans demander à l'admin de re-saisir les creds dans la
 * console n8n.
 *
 * Convention de nommage : la credential n8n est créée avec le nom
 * `boxia:<slug>` pour permettre la mise à jour idempotente. Si l'admin
 * renomme la credential côté n8n, on perd le lien (on en re-créera une
 * nouvelle au prochain push).
 *
 * Le pont ne couvre PAS les connecteurs avec des workers BoxIA dédiés
 * (Pennylane, GLPI, Odoo) : ces workflows tapent directement les workers
 * Docker `aibox-conn-X:8000` qui lisent les creds dans connectors-state.
 * Liste des slugs supportés ici : voir `CREDENTIAL_MAPPERS` ci-dessous.
 */
import { getState } from "@/lib/connectors-state";
import { n8nFetch } from "@/lib/n8n";

/** Type d'une credential n8n native que l'on sait synthétiser. */
export type N8nCredentialType = "imap" | "smtp" | "slackApi" | "httpHeaderAuth";

/**
 * Métadonnées d'une credential n8n créée/mise à jour côté serveur.
 * `data` n'est jamais renvoyé par n8n après création (champ secret).
 */
export interface N8nCredentialRef {
  id: string;
  name: string;
  type: N8nCredentialType | string;
}

/**
 * Mapper d'un connecteur BoxIA → payload `data` d'une credential n8n.
 * Reçoit la config telle que stockée dans connectors-state (champs en
 * clair, indexés par leur key BoxIA). Doit retourner un objet conforme
 * au schéma de la credential n8n (les clés sont définies par les
 * `credentialTypes` de n8n — cf. n8n source `packages/nodes-base/credentials/`).
 *
 * Retourne `null` si la config est incomplète (validation manquée).
 */
type CredentialMapper = (config: Record<string, string>) => {
  type: N8nCredentialType;
  data: Record<string, unknown>;
} | null;

/** Convertit "ssl|starttls|none" + port → flags secure / startTls n8n. */
function tlsToFlags(tls: string | undefined, port: number): {
  secure: boolean;
  disableStartTls: boolean;
} {
  // n8n IMAP/SMTP credential : `secure` = SSL/TLS direct (port 465 ou 993).
  // `disableStartTls` = ne PAS utiliser STARTTLS sur connexion claire.
  // Mapping :
  //   ssl       → secure=true,  disableStartTls=true
  //   starttls  → secure=false, disableStartTls=false
  //   none      → secure=false, disableStartTls=true
  //   undefined → heuristique sur le port (993/465 = SSL, 143/587 = STARTTLS)
  if (tls === "ssl") return { secure: true, disableStartTls: true };
  if (tls === "starttls") return { secure: false, disableStartTls: false };
  if (tls === "none") return { secure: false, disableStartTls: true };
  if (port === 993 || port === 465) return { secure: true, disableStartTls: true };
  return { secure: false, disableStartTls: false };
}

/**
 * Mapping slug BoxIA → builder de credential n8n.
 *
 * Pour ajouter un nouveau pont (ex. `slack` → slackApi), enregistrer
 * son mapper ici. Le slug doit exister dans `CONNECTORS` (lib/connectors.ts).
 */
const CREDENTIAL_MAPPERS: Record<string, CredentialMapper> = {
  "imap-generic": (config) => {
    const host = config.host;
    const user = config.username;
    const password = config.password;
    if (!host || !user || !password) return null;
    const port = parseInt(config.port || "", 10) || 993;
    const flags = tlsToFlags(config.tls, port);
    return {
      type: "imap",
      data: {
        host,
        port,
        user,
        password,
        secure: flags.secure,
        // n8n IMAP n'a pas `disableStartTls` mais `allowUnauthorizedCerts`.
        allowUnauthorizedCerts: false,
      },
    };
  },
  "smtp": (config) => {
    const host = config.host;
    const user = config.username;
    const password = config.password;
    if (!host || !user || !password) return null;
    const port = parseInt(config.port || "", 10) || 587;
    const flags = tlsToFlags(config.tls, port);
    return {
      type: "smtp",
      data: {
        host,
        port,
        user,
        password,
        secure: flags.secure,
        disableStartTls: flags.disableStartTls,
      },
    };
  },
  "slack": (config) => {
    const token = config.bot_token;
    if (!token) return null;
    return {
      type: "slackApi",
      data: { accessToken: token },
    };
  },
};

/** Slug → liste des slugs BoxIA pour lesquels on sait pousser une credential n8n. */
export function bridgedConnectorSlugs(): string[] {
  return Object.keys(CREDENTIAL_MAPPERS);
}

/**
 * Cherche une credential existante côté n8n par nom exact.
 * Retourne null si introuvable, ou si l'API liste échoue.
 *
 * Note : `/rest/credentials` ne retourne pas les `data` (sécurité), donc
 * on ne peut pas comparer le contenu pour décider d'un patch ; on fait un
 * PATCH inconditionnel quand la credential existe (n8n écrase `data`).
 */
async function findCredentialByName(name: string): Promise<N8nCredentialRef | null> {
  try {
    const r = await n8nFetch("/rest/credentials");
    if (!r.ok) return null;
    const j = await r.json();
    const list: unknown[] = j.data || j;
    if (!Array.isArray(list)) return null;
    for (const raw of list) {
      const c = raw as Record<string, unknown>;
      if (c.name === name) {
        return {
          id: String(c.id),
          name: String(c.name),
          type: String(c.type || ""),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Nom canonique d'une credential n8n générée par BoxIA. */
export function bridgedCredentialName(slug: string): string {
  return `boxia:${slug}`;
}

/**
 * Push (create or update) la credential n8n correspondant au connecteur
 * BoxIA `slug`. Si le connecteur n'a pas de mapper enregistré ou que sa
 * config est incomplète, retourne null sans erreur.
 *
 * Idempotent : appelable plusieurs fois (re-active, re-config), met à
 * jour la credential existante si trouvée, sinon la crée.
 */
export async function pushCredentialFromConnector(
  slug: string,
): Promise<N8nCredentialRef | null> {
  const mapper = CREDENTIAL_MAPPERS[slug];
  if (!mapper) return null;
  const state = await getState(slug);
  if (!state || state.status !== "active") return null;
  const built = mapper(state.config);
  if (!built) return null;

  const name = bridgedCredentialName(slug);
  const existing = await findCredentialByName(name);

  try {
    if (existing) {
      // PATCH /rest/credentials/<id> body { name, type, data }
      const r = await n8nFetch(`/rest/credentials/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, type: built.type, data: built.data }),
      });
      if (!r.ok) {
        console.warn(`[n8n-credentials] PATCH ${existing.id} (${slug}) → HTTP ${r.status}`);
        return null;
      }
      return { id: existing.id, name, type: built.type };
    } else {
      const r = await n8nFetch("/rest/credentials", {
        method: "POST",
        body: JSON.stringify({ name, type: built.type, data: built.data }),
      });
      if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        console.warn(
          `[n8n-credentials] POST (${slug}) → HTTP ${r.status} ${errBody.slice(0, 200)}`,
        );
        return null;
      }
      const j = await r.json();
      const created = j.data || j;
      return {
        id: String(created.id),
        name: String(created.name || name),
        type: built.type,
      };
    }
  } catch (e) {
    console.warn(`[n8n-credentials] error pushing ${slug}:`, e);
    return null;
  }
}

/**
 * Supprime la credential n8n associée à un connecteur BoxIA. Best-effort,
 * ne renvoie pas d'erreur si introuvable. Utilisé par le hook deactivate.
 *
 * Note : si des workflows utilisent encore cette credential, n8n les
 * laisse tourner mais ils erreront au prochain run (auth manquante). On
 * accepte ce risque pour respecter le geste utilisateur (si tu désactives
 * le connecteur, c'est que tu ne veux plus que les workflows tournent).
 */
export async function deleteCredentialForConnector(slug: string): Promise<boolean> {
  if (!CREDENTIAL_MAPPERS[slug]) return false;
  const existing = await findCredentialByName(bridgedCredentialName(slug));
  if (!existing) return false;
  try {
    const r = await n8nFetch(`/rest/credentials/${existing.id}`, {
      method: "DELETE",
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Récupère la ref (id, name) d'une credential déjà pushée pour un slug
 * donné, sans en re-créer. Utilisé par l'install marketplace pour patcher
 * les nodes du workflow JSON. Retourne null si la credential n'existe pas
 * encore côté n8n (cas : connecteur actif mais push n'a pas eu lieu).
 */
export async function getCredentialRefForSlug(
  slug: string,
): Promise<N8nCredentialRef | null> {
  if (!CREDENTIAL_MAPPERS[slug]) return null;
  return findCredentialByName(bridgedCredentialName(slug));
}

/**
 * Push toutes les credentials des connecteurs BoxIA actifs dont on connaît
 * le mapper. Utile pour un re-sync explicite (bouton "Re-pousser les
 * credentials" en admin) ou un cron de cohérence.
 *
 * Retourne la liste des slugs pushés avec succès.
 */
export async function pushAllBridgedCredentials(): Promise<string[]> {
  const out: string[] = [];
  for (const slug of bridgedConnectorSlugs()) {
    const ref = await pushCredentialFromConnector(slug);
    if (ref) out.push(slug);
  }
  return out;
}
