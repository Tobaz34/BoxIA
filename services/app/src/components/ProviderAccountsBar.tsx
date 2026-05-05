"use client";

/**
 * ProviderAccountsBar — section "Comptes connectés" en haut de /connectors.
 *
 * Affiche 1 tuile par provider OAuth supporté (Microsoft 365, Google Workspace,
 * Meta — future). Une connexion broad-scope chez un provider couvre tous ses
 * connecteurs frères (Outlook + OneDrive + Calendar + SharePoint + Teams pour
 * Microsoft, Drive + Gmail + Calendar pour Google).
 *
 * Pour l'utilisateur final TPE/PME, c'est plus naturel : "je connecte mon
 * Microsoft 365" (1 clic, 1 consent) plutôt que de cliquer sur 5 connecteurs
 * dispersés dans 4 hubs métier différents.
 *
 * État stocké côté serveur :
 *   - GET /api/oauth/accounts → comptes regroupés par (provider, email)
 *   - GET /api/oauth/providers → providers + flag `configured`
 *   - Connexion : popup vers /api/oauth/start?provider=…&connector_slug=…
 *     (le slug est un "anchor" — le sibling broadcast remplit le reste)
 *   - Déconnexion : DELETE /api/oauth/accounts?provider=…&email=…
 */
import { useEffect, useState, useCallback } from "react";
import {
  RefreshCw, AlertTriangle, CheckCircle2, ExternalLink,
  LogOut, Plus, RotateCw,
} from "lucide-react";

interface AccountSummary {
  provider_id: "google" | "microsoft";
  provider_name: string;
  account_email: string | null;
  account_name?: string;
  connected_at: number;
  last_refreshed_at?: number;
  expires_at?: number;
  slugs: string[];
  scopes: string[];
}

interface ProviderInfo {
  id: "google" | "microsoft";
  name: string;
  configured: boolean;
  client_id_env: string;
  console_url?: string;
}

/**
 * Carte d'identité statique par provider (icône, slug d'anchor pour le start
 * OIDC, baseline de services disponibles affichée même si pas connecté).
 */
const PROVIDER_CARDS: Record<"microsoft" | "google" | "meta", {
  id: "microsoft" | "google" | "meta";
  name: string;
  icon: string;
  description: string;
  /** Slug utilisé pour démarrer le flow (anchor). Le scope broad couvre les
   *  siblings — au callback, on broadcastera vers tous les frères. */
  anchor_slug: string;
  /** Liste de services humains affichée comme baseline. */
  services_baseline: string[];
  /** "soon" = pas encore implémenté côté backend (tuile inactive). */
  status: "live" | "soon";
}> = {
  microsoft: {
    id: "microsoft",
    name: "Microsoft 365",
    icon: "🪟",
    description:
      "Une connexion couvre Outlook (mail + calendrier), OneDrive, SharePoint et Teams.",
    anchor_slug: "outlook-graph",
    services_baseline: ["Outlook Mail", "Calendrier", "OneDrive", "SharePoint", "Teams"],
    status: "live",
  },
  google: {
    id: "google",
    name: "Google Workspace",
    icon: "🔵",
    description: "Une connexion couvre Drive, Gmail et Calendar.",
    anchor_slug: "google-drive",
    services_baseline: ["Drive", "Gmail", "Calendar"],
    status: "live",
  },
  meta: {
    id: "meta",
    name: "Meta (Facebook / Instagram)",
    icon: "📘",
    description:
      "Publication sur Pages Facebook et Instagram Business depuis l'IA.",
    anchor_slug: "facebook-pages",
    services_baseline: ["Facebook Pages", "Instagram Business"],
    status: "soon",
  },
};

/** Humanise un scope OAuth pour l'UI (mirror de lib/oauth-providers.ts). */
function humanizeScope(s: string): string | null {
  if (
    s === "openid" || s === "email" || s === "profile" ||
    s === "offline_access" || s === "User.Read"
  ) return null;
  if (s === "https://www.googleapis.com/auth/drive.readonly") return "Drive — lecture";
  if (s === "https://www.googleapis.com/auth/gmail.readonly") return "Gmail — lecture";
  if (s === "https://www.googleapis.com/auth/calendar.readonly") return "Calendar — lecture";
  if (s === "https://www.googleapis.com/auth/contacts.readonly") return "Contacts — lecture";
  if (s === "Files.Read" || s === "Files.Read.All") return "Drive / OneDrive — lecture";
  if (s === "Mail.Read") return "Mail — lecture";
  if (s === "Mail.Send") return "Mail — envoi";
  if (s === "Calendars.Read") return "Calendrier — lecture";
  if (s === "Sites.Read.All") return "SharePoint — lecture";
  if (s.startsWith("Channel")) return "Teams — canaux";
  if (s.startsWith("ChannelMessage")) return "Teams — messages";
  return s;
}

function relTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

interface Props {
  /** Callback appelé après un connect/disconnect pour rafraîchir le parent. */
  onChange?: () => void;
}

export function ProviderAccountsBar({ onChange }: Props) {
  const [accounts, setAccounts] = useState<AccountSummary[] | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [aR, pR] = await Promise.all([
        fetch("/api/oauth/accounts", { cache: "no-store" }),
        fetch("/api/oauth/providers", { cache: "no-store" }),
      ]);
      if (aR.ok) {
        const aJ = await aR.json();
        setAccounts(aJ.accounts || []);
      } else {
        // 403 = pas admin → on cache le composant
        setAccounts([]);
      }
      if (pR.ok) {
        const pJ = await pR.json();
        setProviders(pJ.providers || []);
      } else {
        setProviders([]);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /** Ouvre la popup OIDC pour ce provider et watch sa fermeture pour refresh. */
  function openConnectPopup(providerId: "microsoft" | "google", forceConsent = false) {
    const card = PROVIDER_CARDS[providerId];
    setBusyProvider(providerId);
    setError(null);
    const params = new URLSearchParams({
      provider: providerId,
      connector_slug: card.anchor_slug,
    });
    // Reconnexion : on force `prompt=consent` pour que Microsoft réaffiche
    // l'écran de consentement (et pas un silent SSO) — utile quand on étend
    // les scopes (ex: Mail.Send ajouté après une 1re connexion Mail.Read).
    if (forceConsent) params.set("prompt", "consent");
    const url = `/api/oauth/start?${params.toString()}`;
    const w = 520, h = 640;
    const left = (window.screen.width - w) / 2;
    const top = (window.screen.height - h) / 2;
    const popup = window.open(
      url,
      "aibox_oauth",
      `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no,resizable=yes`,
    );
    if (!popup) {
      setBusyProvider(null);
      setError("Popup bloquée par le navigateur. Autorise les popups pour ce site.");
      return;
    }
    const watcher = setInterval(() => {
      if (popup.closed) {
        clearInterval(watcher);
        setBusyProvider(null);
        // Refresh dans tous les cas (succès ou abandon — on saura via accounts)
        refresh();
        onChange?.();
      }
    }, 500);
  }

  async function handleDisconnect(account: AccountSummary) {
    if (!account.account_email) return;
    if (!confirm(
      `Déconnecter le compte ${account.account_email} ?\n\nÇa supprime ${account.slugs.length} connecteur(s) lié(s) côté BoxIA et révoque les credentials n8n associées. Les workflows qui en dépendent erreront au prochain run.`,
    )) return;
    setBusyProvider(account.provider_id);
    setError(null);
    try {
      const params = new URLSearchParams({
        provider: account.provider_id,
        email: account.account_email,
      });
      const r = await fetch(`/api/oauth/accounts?${params}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `HTTP ${r.status}`);
        return;
      }
      await refresh();
      onChange?.();
    } finally {
      setBusyProvider(null);
    }
  }

  if (loading) {
    return (
      <section className="mb-6 rounded-lg border border-border bg-card/30 p-4">
        <div className="text-xs text-muted">Chargement des comptes connectés…</div>
      </section>
    );
  }

  // Pas admin → l'API renvoie 403 → on cache complètement la section
  if (!providers || providers.length === 0) {
    return null;
  }

  return (
    <section className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Comptes connectés
          </h2>
          <p className="text-[11px] text-muted/80 mt-0.5">
            Connecter un compte SSO active d'un coup tous les services associés ci-dessous.
          </p>
        </div>
        <button
          onClick={refresh}
          className="text-muted hover:text-foreground p-1.5 rounded hover:bg-muted/20 transition-default"
          title="Rafraîchir"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={12} /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {(Object.values(PROVIDER_CARDS)).map((card) => {
          const providerInfo = providers.find((p) => p.id === card.id);
          const acct = accounts?.find((a) => a.provider_id === card.id) || null;
          const isConnected = !!acct;
          const busy = busyProvider === card.id;
          const isSoon = card.status === "soon";
          const notConfigured = providerInfo && !providerInfo.configured;

          // Scopes humanisés pour la liste de services accordés
          const scopeLabels: string[] = [];
          if (acct) {
            const seen = new Set<string>();
            for (const s of acct.scopes) {
              const h = humanizeScope(s);
              if (h && !seen.has(h)) {
                seen.add(h);
                scopeLabels.push(h);
              }
            }
          }

          return (
            <div
              key={card.id}
              className={
                "rounded-lg border p-4 transition-default " +
                (isConnected
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : isSoon || notConfigured
                  ? "border-border bg-card/30 opacity-70"
                  : "border-border bg-card hover:border-primary/60")
              }
            >
              {/* Header tuile */}
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl leading-none">{card.icon}</span>
                  <div className="min-w-0">
                    <div className="font-semibold text-sm">{card.name}</div>
                    {isConnected ? (
                      <div className="text-[11px] text-emerald-400 truncate flex items-center gap-1">
                        <CheckCircle2 size={10} />
                        {acct?.account_email || acct?.account_name || "connecté"}
                      </div>
                    ) : isSoon ? (
                      <div className="text-[11px] text-muted">Bientôt disponible</div>
                    ) : notConfigured ? (
                      <div className="text-[11px] text-amber-400">À provisionner</div>
                    ) : (
                      <div className="text-[11px] text-muted">Non connecté</div>
                    )}
                  </div>
                </div>
              </div>

              {/* Body */}
              {isConnected ? (
                <>
                  <div className="mb-2 flex flex-wrap gap-1">
                    {scopeLabels.length > 0 ? scopeLabels.map((l) => (
                      <span
                        key={l}
                        className="text-[10px] bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded"
                      >
                        {l}
                      </span>
                    )) : (
                      <span className="text-[10px] text-muted">
                        {acct!.slugs.length} service{acct!.slugs.length > 1 ? "s" : ""} liés
                      </span>
                    )}
                  </div>
                  {acct?.last_refreshed_at && (
                    <div className="text-[10px] text-muted mb-2">
                      Dernier refresh : {relTime(acct.last_refreshed_at)}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openConnectPopup(card.id as "microsoft" | "google", true)}
                      disabled={busy}
                      className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted/15 transition-default disabled:opacity-50"
                      title="Re-connecter pour étendre les permissions ou changer de compte"
                    >
                      <RotateCw size={11} className={busy ? "animate-spin" : ""} />
                      Reconnecter
                    </button>
                    <button
                      onClick={() => handleDisconnect(acct!)}
                      disabled={busy}
                      className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-default disabled:opacity-50"
                    >
                      <LogOut size={11} />
                      Déconnecter
                    </button>
                  </div>
                </>
              ) : isSoon ? (
                <p className="text-[11px] text-muted leading-snug">
                  {card.description}
                </p>
              ) : notConfigured ? (
                <div>
                  <p className="text-[11px] text-muted mb-2 leading-snug">
                    {card.description}
                  </p>
                  <p className="text-[10px] text-amber-400 mb-2">
                    Variables manquantes côté admin : <code>{providerInfo!.client_id_env}</code> +{" "}
                    <code>{providerInfo!.client_id_env.replace("_ID", "_SECRET")}</code>.
                  </p>
                  {providerInfo!.console_url && (
                    <a
                      href={providerInfo!.console_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-blue-400 hover:underline inline-flex items-center gap-1"
                    >
                      Console {card.name} <ExternalLink size={9} />
                    </a>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-[11px] text-muted leading-snug mb-2">
                    {card.description}
                  </p>
                  <div className="text-[10px] text-muted mb-2 flex flex-wrap gap-1">
                    {card.services_baseline.map((s) => (
                      <span key={s} className="bg-muted/20 px-1.5 py-0.5 rounded">{s}</span>
                    ))}
                  </div>
                  <button
                    onClick={() => openConnectPopup(card.id as "microsoft" | "google")}
                    disabled={busy}
                    className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded bg-primary text-primary-foreground hover:opacity-90 transition-default disabled:opacity-50"
                  >
                    {busy ? (
                      <RefreshCw size={11} className="animate-spin" />
                    ) : (
                      <Plus size={11} />
                    )}
                    Connecter avec {card.name}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
