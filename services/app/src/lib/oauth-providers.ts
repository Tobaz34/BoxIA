/**
 * Registry des providers OAuth Device Flow.
 *
 * Chaque provider a :
 *   - device_endpoint : URL pour POST {client_id, scope} → renvoie {device_code, user_code, verification_uri, ...}
 *   - token_endpoint  : URL pour POST {client_id, device_code, grant_type=...} → renvoie {access_token, refresh_token}
 *   - userinfo_endpoint : pour récupérer email/name après auth
 *   - default_scopes  : scopes minimaux quand connector_scopes ne dit rien
 *   - connector_scopes : par slug de connecteur, scopes spécifiques
 *
 * Provisioning Tobaz34 (à faire une fois par provider) :
 *   - Google : console.cloud.google.com → Credentials → Create OAuth client
 *     → Application type "TVs and Limited Input devices"
 *     → Copier client_id dans .env GOOGLE_OAUTH_CLIENT_ID
 *   - Microsoft : portal.azure.com → App registrations → New
 *     → Authentication → "Allow public client flows" = YES
 *     → API permissions → ajouter Microsoft Graph delegated scopes
 *     → Copier (Application) client ID dans .env MICROSOFT_OAUTH_CLIENT_ID
 *
 * Sans client_id défini, startDeviceFlow throw avec message explicite —
 * l'UI affiche "Provider non configuré" + lien vers les instructions.
 */

export type OAuthProviderId = "google" | "microsoft";

export interface OAuthProviderConfig {
  id: OAuthProviderId;
  name: string;
  /** OIDC Authorization Code + PKCE (flow recommandé prod). */
  authorize_endpoint: string;
  /** Device Authorization Grant (RFC 8628, fallback LAN sans domaine HTTPS). */
  device_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  /** Variable d'env qui doit fournir le client_id (visible côté UI pour debug). */
  client_id_env: string;
  client_id?: string;
  client_secret?: string;
  default_scopes: string[];
  /** Scopes spécifiques par slug de connector (override default_scopes). */
  connector_scopes?: Record<string, string[]>;
  /** Doc / lien pour le client final. */
  console_url?: string;
  /** Pour les providers qui exigent `prompt=consent` à chaque login pour
   *  garantir le refresh_token (Google notamment). */
  requires_consent_prompt?: boolean;
  /** Pour Google : `access_type=offline` est nécessaire pour avoir un
   *  refresh_token via auth code flow. */
  requires_offline_access?: boolean;
}

export const OAUTH_PROVIDERS: Record<OAuthProviderId, OAuthProviderConfig> = {
  google: {
    id: "google",
    name: "Google",
    authorize_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    device_endpoint: "https://oauth2.googleapis.com/device/code",
    token_endpoint: "https://oauth2.googleapis.com/token",
    userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
    requires_consent_prompt: true,
    requires_offline_access: true,
    client_id_env: "GOOGLE_OAUTH_CLIENT_ID",
    client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
    // NB: pour TVs and Limited Input devices, client_secret est requis par
    // /token (oui, paradoxal pour un "public" client) — Google doc précise
    // qu'il s'agit d'un secret-non-secret embarqué dans l'app distribuée.
    client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    default_scopes: ["openid", "email", "profile"],
    connector_scopes: {
      "google-drive": [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      "gmail": [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.readonly",
      ],
      "google-calendar": [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/calendar.readonly",
      ],
    },
    console_url: "https://console.cloud.google.com/apis/credentials",
  },
  microsoft: {
    id: "microsoft",
    name: "Microsoft 365",
    // tenant=common = multi-tenant + comptes personnels
    authorize_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    device_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    token_endpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userinfo_endpoint: "https://graph.microsoft.com/v1.0/me",
    client_id_env: "MICROSOFT_OAUTH_CLIENT_ID",
    client_id: process.env.MICROSOFT_OAUTH_CLIENT_ID,
    // Public client → pas de secret côté Azure AD si "Allow public client flows" activé
    client_secret: process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
    // User.Read est requis pour /v1.0/me (userinfo) — sans ça l'email
    // du compte n'est jamais renseigné, et l'UI affiche juste "Connecté"
    // sans préciser quel compte. Vérifié 2026-05-04 : 5 connexions
    // existantes sans account_email à cause de cet oubli.
    default_scopes: ["openid", "email", "profile", "offline_access", "User.Read"],
    connector_scopes: {
      "onedrive": [
        "openid", "email", "profile", "offline_access", "User.Read",
        "Files.Read", "Files.Read.All",
      ],
      "outlook-graph": [
        "openid", "email", "profile", "offline_access", "User.Read",
        "Mail.Read",
      ],
      "outlook-calendar": [
        "openid", "email", "profile", "offline_access", "User.Read",
        "Calendars.Read",
      ],
      "sharepoint": [
        "openid", "email", "profile", "offline_access", "User.Read",
        "Sites.Read.All",
      ],
      "teams": [
        "openid", "email", "profile", "offline_access", "User.Read",
        "Channel.ReadBasic.All", "ChannelMessage.Read.All",
      ],
    },
    console_url: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
};

/** Map auth method des connectors.ts → providerId. */
export function providerForAuthMethod(authMethod: string | undefined): OAuthProviderId | null {
  if (authMethod === "google_oauth") return "google";
  if (authMethod === "azure_ad") return "microsoft";
  return null;
}

/**
 * Convertit un scope OAuth verbeux ("Files.Read", "https://www.googleapis
 * .com/auth/drive.readonly") en label humain pour l'UI ("OneDrive — lecture").
 *
 * Renvoie `null` pour les scopes "infrastructure" (openid, email, profile,
 * offline_access, User.Read) qui n'apportent pas d'info à l'utilisateur.
 */
export function humanizeScope(scope: string): string | null {
  // Infrastructure → on les masque
  if (
    scope === "openid" || scope === "email" || scope === "profile" ||
    scope === "offline_access" || scope === "User.Read"
  ) return null;

  // Google
  if (scope === "https://www.googleapis.com/auth/drive.readonly") return "Google Drive — lecture";
  if (scope === "https://www.googleapis.com/auth/gmail.readonly") return "Gmail — lecture";
  if (scope === "https://www.googleapis.com/auth/calendar.readonly") return "Google Calendar — lecture";
  if (scope === "https://www.googleapis.com/auth/contacts.readonly") return "Contacts — lecture";

  // Microsoft Graph
  if (scope === "Files.Read" || scope === "Files.Read.All") return "OneDrive / Drive — lecture";
  if (scope === "Mail.Read") return "Outlook Mail — lecture";
  if (scope === "Calendars.Read") return "Outlook Calendar — lecture";
  if (scope === "Sites.Read.All") return "SharePoint — lecture";
  if (scope.startsWith("Channel")) return "Teams — lecture canaux";
  if (scope.startsWith("ChannelMessage")) return "Teams — lecture messages";

  // Inconnu : on retourne tel quel pour ne pas tromper l'utilisateur
  return scope;
}

/**
 * Liste de scopes → liste de labels humains, sans doublons, sans nulls.
 * Utilisée par l'UI pour afficher "Ce compte donne accès à : OneDrive…"
 */
export function humanizeScopes(scopes: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of scopes) {
    const h = humanizeScope(s);
    if (h && !seen.has(h)) {
      seen.add(h);
      out.push(h);
    }
  }
  return out;
}

/**
 * Slugs frères qui partagent le même compte OAuth chez un provider.
 * Ex: connecter Google Drive autorise aussi Gmail + Calendar avec le
 * même token (si l'utilisateur consent aux scopes union).
 *
 * Source : keys de `connector_scopes` du provider.
 */
export function siblingSlugs(providerId: OAuthProviderId): string[] {
  const p = OAUTH_PROVIDERS[providerId];
  return Object.keys(p.connector_scopes || {});
}

/**
 * Union de tous les scopes des connecteurs frères chez un provider.
 * Permet de demander en 1 seul consent l'accès à Drive+Gmail+Calendar
 * (Google) ou OneDrive+Outlook+Calendar+SharePoint+Teams (Microsoft).
 *
 * Utilisé par /api/oauth/start avec ?broad=1 pour activer le mode
 * "1 connexion couvre tous les connecteurs du provider".
 *
 * Inclut toujours les `default_scopes` (openid/email/profile/offline_access).
 */
export function unionConnectorScopes(providerId: OAuthProviderId): string[] {
  const p = OAUTH_PROVIDERS[providerId];
  const all = new Set<string>(p.default_scopes);
  for (const scopes of Object.values(p.connector_scopes || {})) {
    for (const s of scopes) all.add(s);
  }
  return Array.from(all);
}
