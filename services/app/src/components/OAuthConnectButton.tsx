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

  function handleConnectOIDC() {
    setOauthError(null);
    setOidcInProgress(true);
    const url = `/api/oauth/start?provider=${encodeURIComponent(provider)}&connector_slug=${encodeURIComponent(connectorSlug)}`;
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
    const watcher = setInterval(() => {
      if (popup.closed) {
        clearInterval(watcher);
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
            rel="noreferrer"
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
    return (
      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 flex-wrap">
          <CheckCircle2 size={12} className="text-emerald-400 shrink-0" />
          <span className="font-medium text-emerald-300">
            Connecté{connection.account_email ? ` — ${connection.account_email}` : ""}
          </span>
          <button
            onClick={handleDisconnect}
            className="ml-auto text-[11px] text-red-400/80 hover:text-red-300 flex items-center gap-1"
          >
            <Link2Off size={10} /> Déconnecter
          </button>
        </div>
        {connection.scopes && connection.scopes.length > 0 && (
          <div className="text-[10px] text-muted mt-1 font-mono line-clamp-2">
            scopes : {connection.scopes.join(", ")}
          </div>
        )}
      </div>
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
            rel="noreferrer"
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
  return (
    <div className="space-y-2">
      <button
        onClick={handleConnectOIDC}
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
