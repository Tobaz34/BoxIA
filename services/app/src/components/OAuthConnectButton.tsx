"use client";

/**
 * Bouton "Connecter avec <Provider>" — OIDC Authorization Code + PKCE
 * (popup browser → Google/Microsoft → callback) avec un fallback Device
 * Flow accessible via un lien discret pour les déploiements LAN sans
 * domaine HTTPS.
 *
 * État courant lu depuis /api/oauth/connections (ne fuit jamais les
 * tokens). Si une connexion existe pour ce {provider, connector_slug},
 * affiche "Connecté @email" + bouton Déconnecter.
 */
import { useEffect, useState, useRef, useCallback } from "react";
import { ExternalLink, Loader2, CheckCircle2, AlertTriangle, Link2Off, Copy } from "lucide-react";

type ProviderId = "google" | "microsoft";

interface ProviderInfo {
  id: ProviderId;
  name: string;
  configured: boolean;
  client_id_env: string;
  console_url?: string;
}

interface Connection {
  id: string;
  provider_id: ProviderId;
  connector_slug: string;
  account_email?: string;
  account_name?: string;
  scopes: string[];
  connected_at: number;
  expires_at?: number;
}

const PROVIDER_NICE_NAME: Record<ProviderId, string> = {
  google: "Google",
  microsoft: "Microsoft 365",
};

const PROVIDER_SIBLING_DESC: Record<ProviderId, string> = {
  google: "Drive, Gmail, Calendar",
  microsoft: "OneDrive, Outlook, Calendar, SharePoint, Teams",
};

// Convertit un scope OAuth verbeux en label humain. Doublon volontaire
// avec lib/oauth-providers.ts:humanizeScope() — on évite l'import server-side
// dans un composant client.
function humanizeScope(scope: string): string | null {
  if (
    scope === "openid" || scope === "email" || scope === "profile" ||
    scope === "offline_access" || scope === "User.Read"
  ) return null;
  if (scope === "https://www.googleapis.com/auth/drive.readonly") return "Drive (lecture)";
  if (scope === "https://www.googleapis.com/auth/gmail.readonly") return "Gmail (lecture)";
  if (scope === "https://www.googleapis.com/auth/calendar.readonly") return "Calendar (lecture)";
  if (scope === "Files.Read" || scope === "Files.Read.All") return "OneDrive (lecture)";
  if (scope === "Mail.Read") return "Outlook Mail (lecture)";
  if (scope === "Calendars.Read") return "Outlook Calendar (lecture)";
  if (scope === "Sites.Read.All") return "SharePoint (lecture)";
  if (scope.startsWith("ChannelMessage")) return "Teams messages (lecture)";
  if (scope.startsWith("Channel")) return "Teams canaux (lecture)";
  return scope;
}

interface DeviceFlowResp {
  request_id: string;
  user_code: string;
  verification_url: string;
  verification_url_complete?: string;
  expires_in_seconds: number;
  interval: number;
}

const PROVIDER_BRAND: Record<ProviderId, { color: string; logo: string }> = {
  google: { color: "border-[#4285F4]/40 hover:bg-[#4285F4]/10", logo: "G" },
  microsoft: { color: "border-[#0078D4]/40 hover:bg-[#0078D4]/10", logo: "▦" },
};

export function OAuthConnectButton({
  provider, connectorSlug, onConnected,
}: {
  provider: ProviderId;
  connectorSlug: string;
  onConnected?: (conn: Connection) => void;
}) {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [oidcInProgress, setOidcInProgress] = useState(false);

  // Device flow fallback
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowResp | null>(null);
  const [polling, setPolling] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Watcher de fermeture de la popup OIDC — nettoyé au démontage
  const popupWatcherRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [pRes, cRes] = await Promise.all([
        fetch("/api/oauth/providers", { cache: "no-store" }),
        fetch("/api/oauth/connections", { cache: "no-store" }),
      ]);
      if (pRes.ok) {
        const pj = await pRes.json();
        setProviders(pj.providers);
      }
      if (cRes.ok) {
        const cj = await cRes.json();
        const found = (cj.connections as Connection[]).find(
          (c) => c.provider_id === provider && c.connector_slug === connectorSlug,
        );
        setConnection(found || null);
      }
    } catch { /* tolère */ }
  }, [provider, connectorSlug]);

  useEffect(() => {
    refresh();
    return () => {
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (popupWatcherRef.current) clearInterval(popupWatcherRef.current);
    };
  }, [refresh]);

  // Listener postMessage — la popup callback envoie le résultat
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; ok?: boolean; error?: string; connection?: Connection };
      if (data?.type !== "aibox-oauth-result") return;
      setOidcInProgress(false);
      if (data.ok && data.connection) {
        setConnection(data.connection);
        setOauthError(null);
        if (onConnected) onConnected(data.connection);
      } else if (data.error) {
        setOauthError(data.error);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onConnected]);

  const providerInfo = providers?.find((p) => p.id === provider);

  function stopDevicePolling() {
    setPolling(false);
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
  }

  // ===== OIDC popup flow =====

  function handleConnectOIDC(promptMode?: "select_account") {
    setOauthError(null);
    setOidcInProgress(true);
    const params = new URLSearchParams({
      provider,
      connector_slug: connectorSlug,
    });
    if (promptMode) params.set("prompt", promptMode);
    const url = `/api/oauth/start?${params.toString()}`;
    const w = 520;
    const h = 640;
    const left = (window.screen.width - w) / 2;
    const top = (window.screen.height - h) / 2;
    const popup = window.open(
      url,
      "aibox_oauth",
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,resizable=yes`,
    );
    if (!popup) {
      setOidcInProgress(false);
      setOauthError("Popup bloquée par le navigateur — autorise les popups pour ce site et réessaie.");
      return;
    }
    // Si l'admin ferme la popup sans completer, on arrête le spinner
    if (popupWatcherRef.current) clearInterval(popupWatcherRef.current);
    popupWatcherRef.current = setInterval(() => {
      if (popup.closed) {
        if (popupWatcherRef.current) {
          clearInterval(popupWatcherRef.current);
          popupWatcherRef.current = null;
        }
        setOidcInProgress(false);
        // Refresh au cas où le succès ait eu lieu juste avant la fermeture
        refresh();
      }
    }, 500);
  }

  // ===== Device flow fallback =====

  async function pollDeviceOnce(requestId: string, intervalSec: number) {
    try {
      const r = await fetch("/api/oauth/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      });
      const j = await r.json();
      if (j.state === "success") {
        stopDevicePolling();
        setDeviceFlow(null);
        await refresh();
        if (onConnected && j.connection) onConnected(j.connection as Connection);
        return;
      }
      if (j.state === "error") {
        setOauthError(j.error || "Erreur inconnue");
        stopDevicePolling();
        setDeviceFlow(null);
        return;
      }
      const nextInterval = (j.interval as number) || intervalSec;
      pollTimeoutRef.current = setTimeout(
        () => pollDeviceOnce(requestId, nextInterval),
        nextInterval * 1000,
      );
    } catch (e) {
      setOauthError(String(e instanceof Error ? e.message : e));
      stopDevicePolling();
    }
  }

  async function handleConnectDevice() {
    setOauthError(null);
    try {
      const r = await fetch("/api/oauth/device/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, connector_slug: connectorSlug }),
      });
      const j = await r.json();
      if (!r.ok) {
        setOauthError(j.error || `HTTP ${r.status}`);
        return;
      }
      const f = j as DeviceFlowResp;
      setDeviceFlow(f);
      setSecondsLeft(f.expires_in_seconds);
      setPolling(true);
      countdownRef.current = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
      pollTimeoutRef.current = setTimeout(
        () => pollDeviceOnce(f.request_id, f.interval),
        f.interval * 1000,
      );
    } catch (e) {
      setOauthError(String(e instanceof Error ? e.message : e));
    }
  }

  async function handleDisconnect() {
    if (!connection) return;
    if (!confirm(`Déconnecter ${connection.account_email || provider} ?`)) return;
    await fetch(`/api/oauth/connections?id=${encodeURIComponent(connection.id)}`, {
      method: "DELETE",
    });
    setConnection(null);
  }

  // ===== Rendu =====

  // Provider pas configuré
  if (providerInfo && !providerInfo.configured) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        <div className="flex items-center gap-1.5 font-medium text-amber-300 mb-1">
          <AlertTriangle size={12} /> Provider OAuth « {providerInfo.name} » non configuré
        </div>
        <div>
          L'admin Tobaz34 doit créer un OAuth client (Web application) puis ajouter{" "}
          <code className="text-foreground">{providerInfo.client_id_env}</code> +{" "}
          <code className="text-foreground">{providerInfo.client_id_env.replace("_ID", "_SECRET")}</code>{" "}
          dans <code className="text-foreground">/srv/ai-stack/.env</code>.
          Redirect URI à enregistrer chez le provider : <code className="text-foreground">{`${typeof window !== "undefined" ? window.location.origin : ""}/api/oauth/callback`}</code>
        </div>
        {providerInfo.console_url && (
          <a
            href={providerInfo.console_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline mt-1 inline-flex items-center gap-1"
          >
            Console <ExternalLink size={10} />
          </a>
        )}
      </div>
    );
  }

  // Connecté
  if (connection && !deviceFlow) {
    const niceScopes = (connection.scopes || [])
      .map(humanizeScope)
      .filter((s): s is string => !!s);
    return (
      <ConnectedCard
        connection={connection}
        provider={provider}
        niceScopes={niceScopes}
        onDisconnect={handleDisconnect}
        onConnectAnother={() => handleConnectOIDC("select_account")}
      />
    );
  }

  // Device flow modal-inline
  if (deviceFlow) {
    const expired = secondsLeft <= 0;
    return (
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-3 text-xs space-y-2">
        <div className="font-medium text-blue-300 flex items-center gap-1.5">
          {polling && !expired
            ? <Loader2 size={12} className="animate-spin" />
            : <AlertTriangle size={12} />}
          {expired ? "Code expiré" : "En attente d'autorisation (Device Flow)…"}
        </div>
        <div>
          1. Ouvre{" "}
          <a
            href={deviceFlow.verification_url_complete || deviceFlow.verification_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-400 hover:underline inline-flex items-center gap-1"
          >
            {deviceFlow.verification_url} <ExternalLink size={10} />
          </a>
        </div>
        <div>
          2. Entre le code :
          <div className="flex items-center gap-2 mt-1">
            <code className="font-mono text-base px-2 py-1 bg-card border border-border rounded tracking-wider">
              {deviceFlow.user_code}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(deviceFlow.user_code)}
              className="text-muted hover:text-foreground"
              title="Copier"
            >
              <Copy size={12} />
            </button>
          </div>
        </div>
        {!expired && (
          <div className="text-[10px] text-muted">
            Valide encore {Math.floor(secondsLeft / 60)}m{secondsLeft % 60}s
          </div>
        )}
        <button
          onClick={() => { stopDevicePolling(); setDeviceFlow(null); }}
          className="text-[11px] text-muted hover:text-foreground underline"
        >
          Annuler
        </button>
      </div>
    );
  }

  // État initial : bouton OIDC (primaire) + lien Device Flow (fallback)
  // Sibling-account hint : si un autre slug du même provider est déjà
  // connecté (ex: l'admin a connecté Drive, et il ouvre maintenant la
  // modale Gmail), on lui dit "votre compte X est déjà connecté pour
  // ce provider — réutilisez-le ?"
  return (
    <div className="space-y-2">
      <SiblingAccountHint provider={provider} connectorSlug={connectorSlug} />
      <button
        onClick={() => handleConnectOIDC()}
        disabled={!providerInfo || oidcInProgress}
        className={`w-full px-3 py-2 rounded-md border ${PROVIDER_BRAND[provider].color} bg-card text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50`}
      >
        {oidcInProgress
          ? <Loader2 size={14} className="animate-spin" />
          : <span className="font-bold">{PROVIDER_BRAND[provider].logo}</span>}
        {oidcInProgress
          ? "Autorisation en cours…"
          : `Connecter avec ${providerInfo?.name || provider}`}
      </button>
      <p className="text-[10px] text-muted">
        Une seule connexion {providerInfo?.name || provider} couvre tous les services compatibles
        {provider === "google" ? " (Drive, Gmail, Calendar)" : provider === "microsoft" ? " (OneDrive, Outlook, Calendar, SharePoint, Teams)" : ""}.
      </p>
      <div className="flex items-center justify-end">
        <button
          onClick={handleConnectDevice}
          disabled={!providerInfo}
          className="text-[10px] text-muted hover:text-foreground underline"
          title="Pour les déploiements LAN sans domaine HTTPS public"
        >
          ou utiliser un code à entrer sur un autre device
        </button>
      </div>
      {oauthError && (
        <div className="text-[11px] text-red-400 flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {oauthError}
        </div>
      )}
    </div>
  );
}

/**
 * Si une connexion OAuth existe pour le même provider mais un AUTRE
 * connector_slug, on l'affiche en hint + propose un bouton "Activer ici
 * aussi" qui copie le token vers le slug courant. Compatible avec les
 * connexions créées avant le broadcast automatique du callback.
 */
function SiblingAccountHint({
  provider, connectorSlug,
}: { provider: ProviderId; connectorSlug: string }) {
  const [sibling, setSibling] = useState<Connection | null>(null);
  const [adopting, setAdopting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/oauth/connections", { cache: "no-store" });
        if (!r.ok) return;
        const j = await r.json();
        const conns = (j.connections as Connection[]) || [];
        const sameProvider = conns.find(
          (c) => c.provider_id === provider && c.connector_slug !== connectorSlug,
        );
        if (!cancelled) setSibling(sameProvider || null);
      } catch { /* tolère */ }
    }
    load();
    return () => { cancelled = true; };
  }, [provider, connectorSlug]);

  if (!sibling) return null;

  async function adopt() {
    if (!sibling) return;
    setAdopting(true);
    try {
      // POST sur /api/oauth/connections/adopt (créé en parallèle)
      await fetch("/api/oauth/connections/adopt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_id: sibling.id,
          target_slug: connectorSlug,
        }),
      });
      // Recharger l'état parent (refresh via reload — robuste, simple)
      window.location.reload();
    } catch {
      setAdopting(false);
    }
  }

  return (
    <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-1.5 mb-1">
        <CheckCircle2 size={12} className="text-blue-400" />
        <span className="font-medium text-blue-300">
          Compte déjà connecté{sibling.account_email ? ` (${sibling.account_email})` : ""}
        </span>
      </div>
      <div className="text-muted text-[11px] mb-2">
        Vous l'utilisez déjà pour <code className="text-foreground">{sibling.connector_slug}</code>.
        Activer ici sans nouveau consent ?
      </div>
      <button
        onClick={adopt}
        disabled={adopting}
        className="text-[11px] px-2 py-1 rounded bg-blue-500/15 hover:bg-blue-500/25 text-blue-200 disabled:opacity-50"
      >
        {adopting ? "…" : "Réutiliser ce compte"}
      </button>
    </div>
  );
}

/**
 * Carte "Connecté" affichée quand une connexion existe pour ce slug.
 * Affiche :
 *   - le compte (email) connecté, ou un warning si l'email est manquant
 *     (avec un bouton "Récupérer l'identité" qui appelle refresh-userinfo)
 *   - les permissions accordées en labels humains (Drive (lecture)…)
 *   - 2 boutons :
 *       1. « Déconnecter ce service » (juste ce slug — comportement original)
 *       2. « Déconnecter tout » (cascade : delete tous les sibling slugs
 *          du même compte/provider) — exposé via /api/oauth/accounts DELETE
 *   - 1 lien « Ajouter un autre compte » qui force prompt=select_account
 *     côté provider (Microsoft) ou access_type=offline+prompt=consent (Google)
 *     — utile quand l'admin a un compte perso ET un pro et veut switch.
 */
function ConnectedCard({
  connection, provider, niceScopes, onDisconnect, onConnectAnother,
}: {
  connection: Connection;
  provider: ProviderId;
  niceScopes: string[];
  onDisconnect: () => void;
  onConnectAnother: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [cascading, setCascading] = useState(false);
  const noEmail = !connection.account_email;

  async function refreshUserinfo() {
    setRefreshing(true);
    try {
      await fetch("/api/oauth/accounts/refresh-userinfo", { method: "POST" });
      window.location.reload();
    } catch {
      setRefreshing(false);
    }
  }

  async function disconnectAccount() {
    if (noEmail) {
      // Pas d'email → cascade par provider sans filtre
      if (!confirm(
        `Cette action déconnecte TOUS les services ${PROVIDER_NICE_NAME[provider]} ` +
        `liés à ce token (${PROVIDER_SIBLING_DESC[provider]}). Continuer ?`,
      )) return;
    } else {
      if (!confirm(
        `Déconnecter le compte ${connection.account_email} ?\n` +
        `→ Tous les services ${PROVIDER_NICE_NAME[provider]} associés ` +
        `(${PROVIDER_SIBLING_DESC[provider]}) seront déconnectés.`,
      )) return;
    }
    setCascading(true);
    const params = new URLSearchParams({ provider });
    if (connection.account_email) params.set("email", connection.account_email);
    else params.set("email", "");
    await fetch(`/api/oauth/accounts?${params.toString()}`, { method: "DELETE" });
    window.location.reload();
  }

  return (
    <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs space-y-2">
      <div className="flex items-start gap-2 flex-wrap">
        <CheckCircle2 size={12} className="text-emerald-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-emerald-300">
            {connection.account_email ? (
              <>
                Connecté avec <span className="font-semibold">{connection.account_email}</span>
              </>
            ) : (
              <>
                Connecté <span className="text-amber-300/80 ml-1">(compte non identifié)</span>
              </>
            )}
            {connection.account_name && (
              <span className="text-muted font-normal"> · {connection.account_name}</span>
            )}
          </div>
          <div className="text-[10px] text-muted">
            Couvre aussi : {PROVIDER_SIBLING_DESC[provider]}
          </div>
        </div>
      </div>

      {noEmail && (
        <button
          onClick={refreshUserinfo}
          disabled={refreshing}
          className="text-[10px] text-amber-300 hover:text-amber-200 underline disabled:opacity-50"
        >
          {refreshing ? "…" : "Récupérer l'identité du compte"}
        </button>
      )}

      {niceScopes.length > 0 && (
        <div className="text-[10px] text-muted">
          Permissions :{" "}
          {niceScopes.map((s, i) => (
            <span key={s} className="text-foreground/80">
              {s}{i < niceScopes.length - 1 ? ", " : ""}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-3 pt-1 border-t border-emerald-500/10">
        <button
          onClick={onDisconnect}
          className="text-[11px] text-muted hover:text-foreground"
          title="Garde la connexion principale, retire juste ce service"
        >
          Retirer ce service
        </button>
        <button
          onClick={disconnectAccount}
          disabled={cascading}
          className="text-[11px] text-red-400/80 hover:text-red-300 inline-flex items-center gap-1 disabled:opacity-50"
          title="Déconnecte le compte entier (tous les services partagés)"
        >
          <Link2Off size={10} /> {cascading ? "…" : "Déconnecter le compte"}
        </button>
        <button
          onClick={onConnectAnother}
          className="text-[11px] text-blue-300 hover:text-blue-200 ml-auto"
          title="Ouvre le flow OAuth pour ajouter un compte différent"
        >
          + Ajouter un autre compte
        </button>
      </div>
    </div>
  );
}
