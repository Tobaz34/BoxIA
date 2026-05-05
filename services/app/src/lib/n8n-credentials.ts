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
import {
  decryptToken,
  getConnection,
  type OAuthConnection,
} from "@/lib/oauth-storage";

/** Type d'une credential n8n native que l'on sait synthétiser. */
export type N8nCredentialType =
  | "imap"
  | "smtp"
  | "slackApi"
  | "httpHeaderAuth"
  // Microsoft OAuth typed credentials (n8n 1.x). Chaque node Microsoft
  // attend son type spécifique, on synthétise les credentials à partir
  // de la connexion OAuth du connecteur BoxIA équivalent.
  | "microsoftOutlookOAuth2Api"
  | "microsoftOneDriveOAuth2Api"
  | "microsoftSharePointOAuth2Api"
  | "microsoftTeamsOAuth2Api";

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
 * Payload prêt pour POST /rest/credentials côté n8n.
 */
interface BuiltCredential {
  type: N8nCredentialType;
  data: Record<string, unknown>;
  /** Surcharge optionnelle du nom canonique `boxia:<slug>` (utile pour
   *  fan-out d'une seule connexion OAuth Microsoft vers 3-4 credentials
   *  n8n typées différentes). */
  nameOverride?: string;
}

/**
 * Mapper sync (connecteurs `form`) : reçoit la config en clair depuis
 * connectors-state. Retourne null si config incomplète.
 */
type FormCredentialMapper = (config: Record<string, string>) => BuiltCredential | null;

/**
 * Mapper async (connecteurs OAuth) : reçoit la connexion OAuth déchiffrée.
 * Peut retourner plusieurs credentials n8n à partir d'une seule connexion
 * OAuth (cas Microsoft : un seul consent broad couvre Outlook+OneDrive+
 * SharePoint+Teams, mais chaque node n8n exige un type spécifique).
 */
type OAuthCredentialMapper = (
  conn: OAuthConnection,
  decrypted: { access_token: string; refresh_token?: string },
) => BuiltCredential[] | null;

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
 * Mapping slug BoxIA → builder de credential n8n (form auth).
 * Pour ajouter un nouveau pont (ex. `slack` → slackApi), enregistrer
 * son mapper ici. Le slug doit exister dans `CONNECTORS` (lib/connectors.ts).
 */
const FORM_CREDENTIAL_MAPPERS: Record<string, FormCredentialMapper> = {
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

/**
 * Construit le bloc `oauthTokenData` attendu par les credentials n8n typées
 * (microsoft*OAuth2Api, googleOAuth2Api, etc.). Le format reproduit ce que
 * n8n écrirait lui-même après un flow OAuth interne. n8n utilise ensuite
 * le `clientId/clientSecret` câblés dans son credentialType pour rafraîchir
 * le token automatiquement quand il expire.
 */
function buildOAuthTokenData(
  conn: OAuthConnection,
  decrypted: { access_token: string; refresh_token?: string },
): Record<string, unknown> {
  const expiresIn = conn.expires_at
    ? Math.max(0, Math.floor((conn.expires_at - Date.now()) / 1000))
    : 3600;
  return {
    access_token: decrypted.access_token,
    refresh_token: decrypted.refresh_token || "",
    token_type: "Bearer",
    expires_in: expiresIn,
    scope: conn.scopes.join(" "),
  };
}

/**
 * Données communes pour les 4 credentials Microsoft typées : clientId,
 * clientSecret + oauthTokenData. n8n se charge ensuite du refresh.
 */
function microsoftOAuthData(
  conn: OAuthConnection,
  decrypted: { access_token: string; refresh_token?: string },
): Record<string, unknown> {
  return {
    clientId: process.env.MICROSOFT_OAUTH_CLIENT_ID || "",
    clientSecret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET || "",
    oauthTokenData: buildOAuthTokenData(conn, decrypted),
  };
}

/**
 * Mappers OAuth par slug BoxIA.
 *
 * Cas Microsoft : un seul consent broad (5 scopes : Files.Read, Mail.Read,
 * Calendars.Read, Sites.Read.All, Channel*.Read.All) couvre tous les nodes
 * Microsoft de n8n. Mais chaque node natif exige son type de credential
 * spécifique → on fan-out depuis la connexion `microsoft:<slug>` vers
 * la cred typée correspondante. Le push d'un seul slug suffit (les autres
 * connecteurs Microsoft sont gérés par leurs propres push).
 */
const OAUTH_CREDENTIAL_MAPPERS: Record<string, OAuthCredentialMapper> = {
  "outlook-graph": (conn, decrypted) => [
    {
      type: "microsoftOutlookOAuth2Api",
      data: microsoftOAuthData(conn, decrypted),
      nameOverride: "boxia:microsoft-outlook",
    },
  ],
  // outlook-calendar partage le node `microsoftOutlook` côté n8n donc
  // pas de credential séparée — le push se fait via outlook-graph.
  // Cas typique : l'admin a juste connecté outlook-calendar sans Mail —
  // on pousse quand même la cred outlook (sans Mail.Read côté token).
  "outlook-calendar": (conn, decrypted) => [
    {
      type: "microsoftOutlookOAuth2Api",
      data: microsoftOAuthData(conn, decrypted),
      nameOverride: "boxia:microsoft-outlook",
    },
  ],
  "onedrive": (conn, decrypted) => [
    {
      type: "microsoftOneDriveOAuth2Api",
      data: microsoftOAuthData(conn, decrypted),
      nameOverride: "boxia:microsoft-onedrive",
    },
  ],
  "sharepoint": (conn, decrypted) => [
    {
      type: "microsoftSharePointOAuth2Api",
      data: microsoftOAuthData(conn, decrypted),
      nameOverride: "boxia:microsoft-sharepoint",
    },
  ],
};

/** Slug → liste des slugs BoxIA pour lesquels on sait pousser une credential n8n. */
export function bridgedConnectorSlugs(): string[] {
  return [
    ...Object.keys(FORM_CREDENTIAL_MAPPERS),
    ...Object.keys(OAUTH_CREDENTIAL_MAPPERS),
  ];
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
 * Synthétise les credentials n8n à pousser pour un slug donné, sans encore
 * les pousser. Sépare la logique de mapping (form vs OAuth) du I/O n8n
 * pour pouvoir tester unitairement et fan-out une connexion OAuth vers
 * plusieurs credentials typées.
 */
async function buildCredentials(slug: string): Promise<BuiltCredential[]> {
  // 1) Form-based connector (creds en clair dans connectors-state)
  const formMapper = FORM_CREDENTIAL_MAPPERS[slug];
  if (formMapper) {
    const state = await getState(slug);
    if (!state || state.status !== "active") return [];
    const built = formMapper(state.config);
    return built ? [built] : [];
  }
  // 2) OAuth-based connector (token chiffré dans oauth-storage)
  const oauthMapper = OAUTH_CREDENTIAL_MAPPERS[slug];
  if (oauthMapper) {
    // Provider derived from slug : pour l'instant tous les slugs OAuth
    // bridgés sont Microsoft. Si on ajoute Google plus tard, il faudra
    // passer le provider explicitement (ex. via une struct {provider, slug}).
    const conn = await getConnection(`microsoft:${slug}`);
    if (!conn) return [];
    const accessToken = decryptToken(conn.access_token_encrypted);
    if (!accessToken) {
      console.warn(`[n8n-credentials] decrypt failed for microsoft:${slug}`);
      return [];
    }
    const refreshToken = conn.refresh_token_encrypted
      ? decryptToken(conn.refresh_token_encrypted) || undefined
      : undefined;
    const built = oauthMapper(conn, { access_token: accessToken, refresh_token: refreshToken });
    return built || [];
  }
  return [];
}

/**
 * Pousse (POST ou PATCH) une credential n8n. Retourne la ref ou null.
 */
async function upsertCredential(
  name: string,
  type: string,
  data: Record<string, unknown>,
): Promise<N8nCredentialRef | null> {
  const existing = await findCredentialByName(name);
  try {
    if (existing) {
      const r = await n8nFetch(`/rest/credentials/${existing.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, type, data }),
      });
      if (!r.ok) {
        console.warn(`[n8n-credentials] PATCH ${existing.id} (${name}) → HTTP ${r.status}`);
        return null;
      }
      return { id: existing.id, name, type };
    } else {
      const r = await n8nFetch("/rest/credentials", {
        method: "POST",
        body: JSON.stringify({ name, type, data }),
      });
      if (!r.ok) {
        const errBody = await r.text().catch(() => "");
        console.warn(
          `[n8n-credentials] POST (${name}) → HTTP ${r.status} ${errBody.slice(0, 200)}`,
        );
        return null;
      }
      const j = await r.json();
      const created = j.data || j;
      return {
        id: String(created.id),
        name: String(created.name || name),
        type,
      };
    }
  } catch (e) {
    console.warn(`[n8n-credentials] error upserting ${name}:`, e);
    return null;
  }
}

/**
 * Push (create or update) la credential n8n correspondant au connecteur
 * BoxIA `slug`. Si le connecteur n'a pas de mapper enregistré, ou que sa
 * config / connexion OAuth est absente, retourne null sans erreur.
 *
 * Idempotent : appelable plusieurs fois, met à jour les credentials
 * existantes par nom canonique.
 *
 * Cas multi-credentials (Microsoft) : retourne la PREMIÈRE référence (pour
 * compat) — la liste complète est exposée par `pushCredentialsFromConnector`.
 */
export async function pushCredentialFromConnector(
  slug: string,
): Promise<N8nCredentialRef | null> {
  const refs = await pushCredentialsFromConnector(slug);
  return refs[0] || null;
}

/**
 * Variante qui retourne TOUTES les credentials créées/mises à jour pour
 * un slug (utile pour Microsoft où une connexion OAuth se fan-out vers
 * plusieurs credentials n8n typées).
 */
export async function pushCredentialsFromConnector(
  slug: string,
): Promise<N8nCredentialRef[]> {
  const builds = await buildCredentials(slug);
  if (builds.length === 0) return [];
  const out: N8nCredentialRef[] = [];
  for (const built of builds) {
    const name = built.nameOverride || bridgedCredentialName(slug);
    const ref = await upsertCredential(name, built.type, built.data);
    if (ref) out.push(ref);
  }
  return out;
}

/**
 * Pour un slug donné, retourne tous les noms canoniques de credentials
 * n8n potentielles. Couvre le cas Microsoft où le slug `outlook-graph`
 * peut produire la cred `boxia:microsoft-outlook` (nameOverride).
 */
function candidateCredentialNames(slug: string): string[] {
  const out = new Set<string>();
  out.add(bridgedCredentialName(slug));
  // Pour les connecteurs OAuth Microsoft, les noms sont fixes (cf. mappers)
  if (OAUTH_CREDENTIAL_MAPPERS[slug]) {
    if (slug === "outlook-graph" || slug === "outlook-calendar") {
      out.add("boxia:microsoft-outlook");
    }
    if (slug === "onedrive") out.add("boxia:microsoft-onedrive");
    if (slug === "sharepoint") out.add("boxia:microsoft-sharepoint");
  }
  return Array.from(out);
}

/**
 * Supprime la (les) credential(s) n8n associée(s) à un connecteur BoxIA.
 * Best-effort, ne renvoie pas d'erreur si introuvable.
 *
 * Note : si des workflows utilisent encore cette credential, n8n les
 * laisse tourner mais ils erreront au prochain run (auth manquante).
 *
 * Cas Microsoft : la cred `boxia:microsoft-outlook` est partagée entre
 * `outlook-graph` et `outlook-calendar`. On ne la supprime que si AUCUN
 * des deux n'est encore actif (sinon on casse l'autre connecteur).
 */
export async function deleteCredentialForConnector(slug: string): Promise<boolean> {
  if (!OAUTH_CREDENTIAL_MAPPERS[slug] && !FORM_CREDENTIAL_MAPPERS[slug]) return false;

  // Pour Outlook (mail vs calendar partagent la même cred), check sibling
  if (slug === "outlook-graph" || slug === "outlook-calendar") {
    const sibling = slug === "outlook-graph" ? "outlook-calendar" : "outlook-graph";
    const sibConn = await getConnection(`microsoft:${sibling}`);
    if (sibConn) return false; // ne pas supprimer, le frère utilise la même cred
  }

  let any = false;
  for (const name of candidateCredentialNames(slug)) {
    const existing = await findCredentialByName(name);
    if (!existing) continue;
    try {
      const r = await n8nFetch(`/rest/credentials/${existing.id}`, {
        method: "DELETE",
      });
      if (r.ok) any = true;
    } catch {
      // best-effort
    }
  }
  return any;
}

/**
 * Récupère la ref (id, name) d'une credential déjà pushée pour un slug
 * donné, sans en re-créer. Utilisé par l'install marketplace pour patcher
 * les nodes du workflow JSON. Retourne null si la credential n'existe pas
 * encore côté n8n.
 *
 * Cas multi-cred (Microsoft) : retourne la PREMIÈRE trouvée par ordre des
 * `candidateCredentialNames`.
 */
export async function getCredentialRefForSlug(
  slug: string,
): Promise<N8nCredentialRef | null> {
  if (!OAUTH_CREDENTIAL_MAPPERS[slug] && !FORM_CREDENTIAL_MAPPERS[slug]) return null;
  for (const name of candidateCredentialNames(slug)) {
    const ref = await findCredentialByName(name);
    if (ref) return ref;
  }
  return null;
}

/**
 * Push toutes les credentials des connecteurs BoxIA actifs dont on connaît
 * le mapper. Utile pour un re-sync explicite (bouton "Re-pousser les
 * credentials" en admin) ou un cron de cohérence.
 *
 * Retourne la liste des slugs pushés avec succès (au moins 1 cred créée).
 */
export async function pushAllBridgedCredentials(): Promise<string[]> {
  const out: string[] = [];
  for (const slug of bridgedConnectorSlugs()) {
    const refs = await pushCredentialsFromConnector(slug);
    if (refs.length > 0) out.push(slug);
  }
  return out;
}
