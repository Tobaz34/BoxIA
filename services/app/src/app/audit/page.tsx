"use client";

/**
 * /audit — Journal d'audit (admin only).
 *
 * Source : events Authentik (déjà tracés automatiquement). Affichage
 * paginé, avec filtre par action et par user.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Activity, Search, AlertCircle, RefreshCw, LogIn, LogOut,
  UserPlus, UserMinus, Edit, Shield, Lock, AlertTriangle,
} from "lucide-react";

interface AkEvent {
  pk: string;
  user: { username?: string; email?: string; pk?: number } | null;
  action: string;
  app: string;
  client_ip: string | null;
  context: Record<string, unknown>;
  created: string;
}

const ACTION_LABEL: Record<string, { label: string; icon: typeof Activity; color: string }> = {
  login:                { label: "Connexion",            icon: LogIn,        color: "text-accent" },
  logout:               { label: "Déconnexion",          icon: LogOut,       color: "text-muted" },
  login_failed:         { label: "Échec de connexion",   icon: AlertTriangle,color: "text-yellow-400" },
  user_write:           { label: "Modification user",    icon: Edit,         color: "text-primary" },
  password_set:         { label: "Mdp défini",           icon: Lock,         color: "text-primary" },
  model_created:        { label: "Création",             icon: UserPlus,     color: "text-accent" },
  model_updated:        { label: "Modification",         icon: Edit,         color: "text-primary" },
  model_deleted:        { label: "Suppression",          icon: UserMinus,    color: "text-red-400" },
  authorize_application:{ label: "Autorisation app",     icon: Shield,       color: "text-accent" },
  configuration_error:  { label: "Erreur config",        icon: AlertCircle,  color: "text-red-400" },
  suspicious_request:   { label: "Requête suspecte",     icon: AlertTriangle,color: "text-red-400" },
  source_linked:        { label: "Source liée",          icon: Activity,     color: "text-muted" },
};

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `il y a ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

function actionMeta(action: string) {
  return ACTION_LABEL[action] || { label: action, icon: Activity, color: "text-muted" };
}

export default function AuditPage() {
  const [events, setEvents] = useState<AkEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  const refresh = useCallback(async () => {
    const params = new URLSearchParams({ page_size: "100" });
    if (search) params.set("username", search);
    if (actionFilter) params.set("action", actionFilter);
    try {
      const r = await fetch(`/api/audit?${params}`, { cache: "no-store" });
      if (r.status === 403) {
        setForbidden(true);
        setEvents([]);
        return;
      }
      if (!r.ok) {
        setEvents([]);
        return;
      }
      const j = await r.json();
      setEvents(j.results || []);
    } finally {
      setLoading(false);
    }
  }, [search, actionFilter]);

  useEffect(() => {
    const t = setTimeout(() => refresh(), 300);
    return () => clearTimeout(t);
  }, [refresh]);

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <AlertCircle size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            Le journal d'audit est accessible uniquement aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Activity size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Journal d'audit</h1>
            <p className="text-sm text-muted">
              {events.length} événement{events.length > 1 ? "s" : ""} récents · source Authentik
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="text-muted hover:text-foreground transition-default p-2 rounded hover:bg-muted/20"
          title="Rafraîchir"
        >
          <RefreshCw size={16} />
        </button>
      </header>

      <div className="mb-4 grid grid-cols-[1fr_220px] gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrer par utilisateur (username)…"
            className="w-full bg-card border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
        >
          <option value="">Toutes les actions</option>
          <option value="login">Connexions</option>
          <option value="login_failed">Échecs de connexion</option>
          <option value="logout">Déconnexions</option>
          <option value="model_created">Créations</option>
          <option value="model_updated">Modifications</option>
          <option value="model_deleted">Suppressions</option>
          <option value="password_set">Mots de passe</option>
          <option value="authorize_application">Autorisations app</option>
          <option value="suspicious_request">Requêtes suspectes</option>
        </select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Chargement…</div>
        ) : events.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Aucun événement.</div>
        ) : (
          events.map((ev) => {
            const meta = actionMeta(ev.action);
            const Icon = meta.icon;
            return (
              <div
                key={ev.pk}
                className="px-4 py-3 border-b border-border last:border-0 grid grid-cols-[auto_1fr_auto] gap-3 items-center text-sm hover:bg-muted/10"
              >
                <Icon size={14} className={meta.color + " shrink-0"} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{meta.label}</span>
                    <span className="text-[10px] text-muted">{ev.action}</span>
                  </div>
                  <div className="text-xs text-muted truncate">
                    {ev.user?.username || ev.user?.email || "—"}
                    {ev.client_ip && (
                      <span className="ml-2 text-[10px]">· {ev.client_ip}</span>
                    )}
                    {ev.app && (
                      <span className="ml-2 text-[10px]">· {ev.app}</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted whitespace-nowrap">
                  {relTime(ev.created)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
