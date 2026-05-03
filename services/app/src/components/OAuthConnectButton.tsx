"use client";

/**
 * Bouton "Connecter avec <Provider>" + modal Device Flow.
 *
 * Utilisé dans ConnectorsManager quand le connecteur a authMethod
 * google_oauth ou azure_ad. Le bouton dispatch un POST
 * /api/oauth/device/start, montre user_code + verification_url, et
 * polle /api/oauth/device/poll en boucle jusqu'à success ou expiration.
 *
 * Affiche aussi l'état courant : si une connexion OAuth existe déjà
 * pour ce connector_slug + provider, montre "Connecté en tant que X"
 * + bouton "Déconnecter" qui DELETE /api/oauth/connections.
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
  const [flow, setFlow] = useState<DeviceFlowResp | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
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

  const providerInfo = providers?.find((p) => p.id === provider);

  function stopPolling() {
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

  async function pollOnce(requestId: string, intervalSec: number) {
    try {
      const r = await fetch("/api/oauth/device/poll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId }),
      });
      const j = await r.json();
      if (j.state === "success") {
        setSuccess(true);
        stopPolling();
        setFlow(null);
        await refresh();
        if (onConnected && j.connection) onConnected(j.connection as Connection);
        return;
      }
      if (j.state === "error") {
        setError(j.error || "Erreur inconnue");
        stopPolling();
        setFlow(null);
        return;
      }
      const nextInterval = (j.interval as number) || intervalSec;
      pollTimeoutRef.current = setTimeout(
        () => pollOnce(requestId, nextInterval),
        nextInterval * 1000,
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      stopPolling();
    }
  }

  async function handleConnect() {
    setError(null);
    setSuccess(false);
    try {
      const r = await fetch("/api/oauth/device/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, connector_slug: connectorSlug }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      const f = j as DeviceFlowResp;
      setFlow(f);
      setSecondsLeft(f.expires_in_seconds);
      setPolling(true);
      countdownRef.current = setInterval(() => {
        setSecondsLeft((s) => Math.max(0, s - 1));
      }, 1000);
      pollTimeoutRef.current = setTimeout(
        () => pollOnce(f.request_id, f.interval),
        f.interval * 1000,
      );
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function handleDisconnect() {
    if (!connection) return;
    if (!confirm(`Déconnecter ${connection.account_email || provider} ?`)) return;
    await fetch(`/api/oauth/connections?id=${encodeURIComponent(connection.id)}`, {
      method: "DELETE",
    });
    setConnection(null);
    setSuccess(false);
  }

  // État : provider pas configuré côté serveur (client_id absent)
  if (providerInfo && !providerInfo.configured) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
        <div className="flex items-center gap-1.5 font-medium text-amber-300 mb-1">
          <AlertTriangle size={12} /> Provider OAuth « {providerInfo.name} » non configuré
        </div>
        <div>
          L'admin Tobaz34 doit créer un OAuth client (type « TVs and Limited Input devices »)
          puis ajouter <code className="text-foreground">{providerInfo.client_id_env}</code> dans{" "}
          <code className="text-foreground">/srv/ai-stack/.env</code>.
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

  // État : déjà connecté
  if (connection && !flow) {
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

  // État : flow en cours (modal-like inline)
  if (flow) {
    const expired = secondsLeft <= 0;
    return (
      <div className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-3 text-xs space-y-2">
        <div className="font-medium text-blue-300 flex items-center gap-1.5">
          {polling && !expired
            ? <Loader2 size={12} className="animate-spin" />
            : <AlertTriangle size={12} />}
          {expired ? "Code expiré" : "En attente d'autorisation…"}
        </div>
        <div>
          1. Ouvre{" "}
          <a
            href={flow.verification_url_complete || flow.verification_url}
            target="_blank"
            rel="noreferrer"
            className="text-blue-400 hover:underline inline-flex items-center gap-1"
          >
            {flow.verification_url} <ExternalLink size={10} />
          </a>{" "}
          sur n'importe quel device
        </div>
        <div>
          2. Entre ce code :
          <div className="flex items-center gap-2 mt-1">
            <code className="font-mono text-base px-2 py-1 bg-card border border-border rounded tracking-wider">
              {flow.user_code}
            </code>
            <button
              onClick={() => navigator.clipboard?.writeText(flow.user_code)}
              className="text-muted hover:text-foreground"
              title="Copier"
            >
              <Copy size={12} />
            </button>
          </div>
        </div>
        <div className="text-muted">
          3. Autorise l'accès aux scopes demandés. La box détectera automatiquement (≤ {flow.interval}s).
        </div>
        {!expired && (
          <div className="text-[10px] text-muted">
            Code valide encore {Math.floor(secondsLeft / 60)}m{secondsLeft % 60}s
          </div>
        )}
        <button
          onClick={() => { stopPolling(); setFlow(null); }}
          className="text-[11px] text-muted hover:text-foreground underline"
        >
          Annuler
        </button>
      </div>
    );
  }

  // État initial : bouton Connecter
  return (
    <div className="space-y-2">
      <button
        onClick={handleConnect}
        disabled={!providerInfo}
        className={`w-full px-3 py-2 rounded-md border ${PROVIDER_BRAND[provider].color} bg-card text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50`}
      >
        <span className="font-bold">{PROVIDER_BRAND[provider].logo}</span>
        Connecter avec {providerInfo?.name || provider}
      </button>
      {error && (
        <div className="text-[11px] text-red-400 flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}
      {success && !connection && (
        <div className="text-[11px] text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={11} /> Connecté ! Récupération en cours…
        </div>
      )}
    </div>
  );
}
