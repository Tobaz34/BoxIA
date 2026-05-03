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
      "gmail-workspace": [
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
    default_scopes: ["openid", "email", "profile", "offline_access"],
    connector_scopes: {
      "onedrive": [
        "openid", "email", "profile", "offline_access",
        "Files.Read", "Files.Read.All",
      ],
      "outlook-graph": [
        "openid", "email", "profile", "offline_access",
        "Mail.Read",
      ],
      "outlook-calendar": [
        "openid", "email", "profile", "offline_access",
        "Calendars.Read",
      ],
      "sharepoint-online": [
        "openid", "email", "profile", "offline_access",
        "Sites.Read.All",
      ],
      "microsoft-teams": [
        "openid", "email", "profile", "offline_access",
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
