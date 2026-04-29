"use client";

/**
 * /audit — Journal d'audit (admin only).
 *
 * 2 onglets :
 *   - Système (events Authentik) : login, password_set, model_*
 *   - Application (custom)        : connector.*, document.*, rgpd.*, user.*
 */
import { useCallback, useEffect, useState } from "react";
import {
  Activity, Search, AlertCircle, RefreshCw, LogIn, LogOut,
  UserPlus, UserMinus, Edit, Shield, Lock, AlertTriangle,
  Plug, FileText, ShieldCheck, Settings, Trash2, Eye, EyeOff,
  RotateCcw,
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

interface AppEvent {
  ts: number;
  actor: string;
  actor_role?: string;
  action: string;
  target?: string;
  details?: Record<string, unknown>;
  client_ip?: string | null;
}

const SYS_ACTION_LABEL: Record<string, { label: string; icon: typeof Activity; color: string }> = {
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

const APP_ACTION_LABEL: Record<string, { label: string; icon: typeof Activity; color: string }> = {
  "connector.activate":   { label: "Connecteur activé",      icon: Plug,        color: "text-accent" },
  "connector.deactivate": { label: "Connecteur désactivé",   icon: Plug,        color: "text-yellow-400" },
  "connector.hide":       { label: "Connecteur masqué",      icon: EyeOff,      color: "text-muted" },
  "connector.unhide":     { label: "Connecteur restauré",    icon: Eye,         color: "text-muted" },
  "connector.sync":       { label: "Sync connecteur",        icon: RotateCcw,   color: "text-primary" },
  "document.upload":      { label: "Document uploadé",       icon: FileText,    color: "text-accent" },
  "document.delete":      { label: "Document supprimé",      icon: Trash2,      color: "text-red-400" },
  "rgpd.export":          { label: "Export RGPD",            icon: ShieldCheck, color: "text-primary" },
  "rgpd.delete_conversations":
                          { label: "Suppression conv. user", icon: Trash2,      color: "text-red-400" },
  "user.invite":          { label: "Invite user",            icon: UserPlus,    color: "text-accent" },
  "user.role_change":     { label: "Changement de rôle",     icon: Shield,      color: "text-primary" },
  "user.toggle_active":   { label: "Activation/désactivation user", icon: UserMinus, color: "text-yellow-400" },
  "user.recovery_link":   { label: "Lien mdp regénéré",      icon: Lock,        color: "text-primary" },
  "settings.update":      { label: "Paramètres",             icon: Settings,    color: "text-muted" },
  "audit.access":         { label: "Consultation audit",     icon: Activity,    color: "text-muted" },
};

function relTime(iso: string | number): string {
  const ts = typeof iso === "number" ? iso : new Date(iso).getTime();
  const ms = Date.now() - ts;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `il y a ${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

type Tab = "app" | "system";

export default function AuditPage() {
  const [tab, setTab] = useState<Tab>("app");
  const [sys, setSys] = useState<AkEvent[]>([]);
  const [app, setApp] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    if (tab === "system") {
      const params = new URLSearchParams({ page_size: "100" });
      if (search) params.set("username", search);
      if (actionFilter) params.set("action", actionFilter);
      const r = await fetch(`/api/audit?${params}`, { cache: "no-store" });
      if (r.status === 403) { setForbidden(true); setSys([]); setLoading(false); return; }
      if (r.ok) setSys((await r.json()).results || []);
      else setSys([]);
    } else {
      const params = new URLSearchParams({ limit: "200" });
      if (search) params.set("actor", search);
      if (actionFilter) params.set("action", actionFilter);
      const r = await fetch(`/api/app-audit?${params}`, { cache: "no-store" });
      if (r.status === 403) { setForbidden(true); setApp([]); setLoading(false); return; }
      if (r.ok) setApp((await r.json()).entries || []);
      else setApp([]);
    }
    setLoading(false);
  }, [tab, search, actionFilter]);

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

  const items = tab === "system" ? sys : app;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <header className="mb-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Activity size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Journal d'audit</h1>
            <p className="text-sm text-muted">
              {items.length} événement{items.length > 1 ? "s" : ""}
              {" · "}{tab === "system" ? "Authentik (auth + admin)" : "AI Box App (actions)"}
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

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-border">
        <button
          onClick={() => setTab("app")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 transition-default " +
            (tab === "app" ? "border-primary text-foreground"
                           : "border-transparent text-muted hover:text-foreground")
          }
        >
          Application
        </button>
        <button
          onClick={() => setTab("system")}
          className={
            "px-4 py-2 text-sm font-medium border-b-2 transition-default " +
            (tab === "system" ? "border-primary text-foreground"
                              : "border-transparent text-muted hover:text-foreground")
          }
        >
          Système (Authentik)
        </button>
      </div>

      <div className="mb-4 grid grid-cols-[1fr_220px] gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tab === "system"
              ? "Filtrer par utilisateur (username)…"
              : "Filtrer par email / actor…"}
            className="w-full bg-card border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <select
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          className="bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
        >
          {tab === "system" ? (
            <>
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
            </>
          ) : (
            <>
              <option value="">Toutes les actions</option>
              <option value="connector.">Connecteurs</option>
              <option value="document.">Documents</option>
              <option value="rgpd.">RGPD</option>
              <option value="user.">Utilisateurs</option>
              <option value="settings.">Paramètres</option>
              <option value="audit.">Audit</option>
            </>
          )}
        </select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Chargement…</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted">Aucun événement.</div>
        ) : tab === "system" ? (
          (items as AkEvent[]).map((ev) => {
            const meta = SYS_ACTION_LABEL[ev.action] || { label: ev.action, icon: Activity, color: "text-muted" };
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
                    {ev.client_ip && (<span className="ml-2 text-[10px]">· {ev.client_ip}</span>)}
                    {ev.app && (<span className="ml-2 text-[10px]">· {ev.app}</span>)}
                  </div>
                </div>
                <div className="text-xs text-muted whitespace-nowrap">{relTime(ev.created)}</div>
              </div>
            );
          })
        ) : (
          (items as AppEvent[]).map((ev, i) => {
            const meta = APP_ACTION_LABEL[ev.action] || { label: ev.action, icon: Activity, color: "text-muted" };
            const Icon = meta.icon;
            return (
              <div
                key={`${ev.ts}-${i}`}
                className="px-4 py-3 border-b border-border last:border-0 grid grid-cols-[auto_1fr_auto] gap-3 items-center text-sm hover:bg-muted/10"
              >
                <Icon size={14} className={meta.color + " shrink-0"} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{meta.label}</span>
                    {ev.target && <span className="text-xs text-muted truncate">{ev.target}</span>}
                  </div>
                  <div className="text-xs text-muted truncate">
                    {ev.actor}
                    {ev.actor_role && (<span className="ml-2 text-[10px]">· {ev.actor_role}</span>)}
                    {ev.client_ip && (<span className="ml-2 text-[10px]">· {ev.client_ip}</span>)}
                  </div>
                </div>
                <div className="text-xs text-muted whitespace-nowrap">{relTime(ev.ts)}</div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
