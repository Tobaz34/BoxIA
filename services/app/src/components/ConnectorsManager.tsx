"use client";

/**
 * Page /connectors — gestion des connecteurs.
 *
 * 3 sections :
 *   - ACTIFS    : connecteurs branchés (avec dernière synchro, nb objets, sync now, désactiver)
 *   - DISPONIBLES : prêts à brancher (filtrable par catégorie)
 *   - MASQUÉS   : cachés par l'admin (peuvent être restaurés)
 *
 * Modal d'activation : form généré dynamiquement depuis fields[].
 *
 * Réservée admin pour les actions write (l'API renvoie 403 sinon).
 */
import {
  Plug, Plus, Trash2, EyeOff, Eye, RefreshCw, AlertCircle,
  CheckCircle2, X, Settings as SettingsIcon, Search, Clock,
  Shield, Lock, ArrowLeft, ChevronRight,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { HUBS, type ConnectorCategory, type ConnectorHub } from "@/lib/connectors";

interface Field {
  key: string;
  label: string;
  type: "text" | "password" | "url" | "select";
  required?: boolean;
  placeholder?: string;
  helpText?: string;
  options?: { value: string; label: string }[];
}

type Category = ConnectorCategory;

type ImplStatus = "implemented" | "beta" | "coming_soon";
type Status = "active" | "inactive" | "hidden";

interface ConnectorItem {
  slug: string;
  name: string;
  icon: string;
  description: string;
  category: Category;
  implStatus: ImplStatus;
  authMethod?: string;
  fields: Field[];
  docUrl?: string;
  status: Status;
  state: {
    config_keys_present: string[];
    has_secrets: boolean;
    last_sync_at: number | null;
    last_error: string | null;
    activated_at: number | null;
    stats?: {
      objects_indexed?: number;
      last_objects_added?: number;
    };
    allowed_roles?: ("admin" | "manager" | "employee")[];
    allowed_users?: string[];
    permissions_updated_at?: number | null;
  } | null;
  accessible?: boolean;
}

type Role = "admin" | "manager" | "employee";
const ROLE_LABELS: Record<Role, string> = {
  admin: "Admin",
  manager: "Manager",
  employee: "Employé",
};

interface ApiResponse {
  connectors: ConnectorItem[];
  categories: Record<Category, { label: string; icon: string }>;
  summary: { total: number; active: number; hidden: number };
}

const IMPL_BADGE: Record<ImplStatus, { label: string; cls: string }> = {
  implemented:  { label: "Stable",     cls: "bg-accent/15 text-accent" },
  beta:         { label: "Bêta",       cls: "bg-yellow-500/15 text-yellow-400" },
  coming_soon:  { label: "À venir",    cls: "bg-muted/20 text-muted" },
};

function relTime(ms: number | null): string {
  if (!ms) return "jamais";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

export function ConnectorsManager() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<Category | "">("");
  // Hub sélectionné = vue drill-down ; null = grille de tuiles métier.
  const [currentHub, setCurrentHub] = useState<ConnectorHub | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Modal activation
  const [editing, setEditing] = useState<ConnectorItem | null>(null);
  const [editConfig, setEditConfig] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // Modal RBAC permissions (admin only)
  const [permsTarget, setPermsTarget] = useState<ConnectorItem | null>(null);
  const [permsRoles, setPermsRoles] = useState<Role[]>([]);
  const [permsUsersText, setPermsUsersText] = useState(""); // textarea, 1 email/ligne
  const [permsSaving, setPermsSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Admin : on demande TOUS les connecteurs même restrictés (l'écran
      // /connectors doit montrer toutes les permissions). L'API filtre
      // automatiquement pour les non-admins.
      const r = await fetch("/api/connectors?include_restricted=1", { cache: "no-store" });
      if (!r.ok) {
        setError("Erreur de chargement");
        return;
      }
      setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, []);

  function openPermissions(c: ConnectorItem) {
    setPermsTarget(c);
    // Pré-remplit avec l'état actuel (allowed_roles défini = restreint,
    // sinon les 3 rôles cochés = ouvert à tous).
    const cur = c.state?.allowed_roles;
    setPermsRoles(cur && cur.length > 0 ? cur : ["admin", "manager", "employee"]);
    setPermsUsersText((c.state?.allowed_users || []).join("\n"));
  }

  async function savePermissions() {
    if (!permsTarget) return;
    setPermsSaving(true);
    try {
      // Si les 3 rôles sont cochés, c'est équivalent à "ouvert" → on envoie []
      // pour clarifier l'intention côté serveur (allowed_roles undefined).
      const allRolesChecked =
        permsRoles.length === 3 &&
        permsRoles.includes("admin") &&
        permsRoles.includes("manager") &&
        permsRoles.includes("employee");
      const allowed_roles = allRolesChecked ? [] : permsRoles;
      const allowed_users = permsUsersText
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s && s.includes("@"));
      const r = await fetch(
        `/api/connectors/${permsTarget.slug}/permissions`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowed_roles, allowed_users }),
        },
      );
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("Échec : " + (j.detail || j.error || `HTTP ${r.status}`));
        return;
      }
      setPermsTarget(null);
      await refresh();
    } finally {
      setPermsSaving(false);
    }
  }

  function togglePermsRole(role: Role) {
    setPermsRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  }

  useEffect(() => { refresh(); }, [refresh]);

  // Une recherche active OU une catégorie filtrée force la vue plate
  // (les tuiles Hub ne sont pertinentes qu'en navigation libre).
  const isFlatView =
    !!search.trim() || !!categoryFilter || currentHub !== null;

  const { active, available, hidden } = useMemo(() => {
    const hubCats = currentHub ? new Set(HUBS[currentHub].categories) : null;
    const items = (data?.connectors || []).filter((c) => {
      if (search && !`${c.name} ${c.description} ${c.slug}`
            .toLowerCase().includes(search.toLowerCase())) return false;
      if (categoryFilter && c.category !== categoryFilter) return false;
      if (hubCats && !hubCats.has(c.category)) return false;
      return true;
    });
    return {
      active:    items.filter((c) => c.status === "active"),
      available: items.filter((c) => c.status === "inactive"),
      hidden:    items.filter((c) => c.status === "hidden"),
    };
  }, [data, search, categoryFilter, currentHub]);

  /**
   * Stats par hub pour la grille de tuiles : "X actifs / Y disponibles".
   * Calculé sur l'ensemble des connecteurs (pas filtré par search/category)
   * car la grille n'est affichée qu'en navigation libre.
   */
  const hubStats = useMemo(() => {
    const stats: Record<ConnectorHub, { active: number; total: number }> =
      Object.fromEntries(
        Object.keys(HUBS).map((h) => [h, { active: 0, total: 0 }]),
      ) as Record<ConnectorHub, { active: number; total: number }>;
    for (const c of data?.connectors || []) {
      for (const [hub, def] of Object.entries(HUBS)) {
        if (def.categories.includes(c.category)) {
          stats[hub as ConnectorHub].total += 1;
          if (c.status === "active") stats[hub as ConnectorHub].active += 1;
          break;
        }
      }
    }
    return stats;
  }, [data]);

  function openActivate(c: ConnectorItem) {
    setEditing(c);
    // Pré-remplir avec les clés présentes (sans valeurs secrètes — qu'on
    // demande de ré-entrer si besoin)
    const initial: Record<string, string> = {};
    for (const f of c.fields) initial[f.key] = "";
    setEditConfig(initial);
    setError(null);
  }

  async function submitActivate() {
    if (!editing) return;
    // Validation : champs required
    for (const f of editing.fields) {
      if (f.required && !editConfig[f.key]?.trim()) {
        setError(`Champ requis : ${f.label}`);
        return;
      }
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch(`/api/connectors/${editing.slug}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: editConfig }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setEditing(null);
      setEditConfig({});
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function deactivate(slug: string) {
    if (!confirm("Désactiver ce connecteur ? Les credentials seront conservés.")) return;
    await fetch(`/api/connectors/${slug}/deactivate`, { method: "POST" });
    refresh();
  }

  async function toggleHide(slug: string, hidden: boolean) {
    await fetch(`/api/connectors/${slug}/hide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hidden }),
    });
    refresh();
  }

  async function syncNow(slug: string) {
    await fetch(`/api/connectors/${slug}/sync`, { method: "POST" });
    refresh();
  }

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <AlertCircle size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            La gestion des connecteurs est réservée aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto pb-20">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Plug size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Connecteurs</h1>
            <p className="text-sm text-muted">
              {data?.summary.active || 0} actif{(data?.summary.active || 0) > 1 ? "s" : ""}
              {" · "}{data?.summary.total || 0} disponibles dans le catalogue
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

      {/* Filtres */}
      <div className="mb-6 grid grid-cols-[1fr_auto] gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher un connecteur (Outlook, Drive, Pennylane…)"
            className="w-full bg-card border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value as Category | "")}
          className="bg-card border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
        >
          <option value="">Toutes catégories</option>
          {data && Object.entries(data.categories).map(([key, cat]) => (
            <option key={key} value={key}>{cat.icon} {cat.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-center text-sm text-muted py-12">Chargement…</div>
      ) : !isFlatView ? (
        /* ---------- VUE HUB (grille de grandes tuiles métier) ---------- */
        <HubGrid
          stats={hubStats}
          onPick={(h) => setCurrentHub(h)}
        />
      ) : (
        <>
          {/* Breadcrumb : si on est dans un hub précis, montre le chemin de retour. */}
          {currentHub && (
            <div className="mb-4 flex items-center gap-2 text-sm">
              <button
                onClick={() => setCurrentHub(null)}
                className="inline-flex items-center gap-1 text-muted hover:text-foreground transition-default"
              >
                <ArrowLeft size={14} /> Tous les thèmes
              </button>
              <ChevronRight size={12} className="text-muted" />
              <span className="font-medium">
                {HUBS[currentHub].icon} {HUBS[currentHub].label}
              </span>
            </div>
          )}

          {/* ACTIFS */}
          {active.length > 0 && (
            <Section title="Actifs" count={active.length}>
              {active.map((c) => (
                <ActiveRow
                  key={c.slug}
                  c={c}
                  onSync={() => syncNow(c.slug)}
                  onConfig={() => openActivate(c)}
                  onPermissions={() => openPermissions(c)}
                  onDeactivate={() => deactivate(c.slug)}
                />
              ))}
            </Section>
          )}

          {/* DISPONIBLES */}
          <Section title="Disponibles" count={available.length}>
            {available.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted">
                Tous les connecteurs sont activés ou masqués.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {available.map((c) => (
                  <AvailableCard
                    key={c.slug}
                    c={c}
                    onActivate={() => openActivate(c)}
                    onHide={() => toggleHide(c.slug, true)}
                  />
                ))}
              </div>
            )}
          </Section>

          {/* MASQUÉS */}
          {hidden.length > 0 && (
            <Section title="Masqués" count={hidden.length} muted>
              {hidden.map((c) => (
                <div
                  key={c.slug}
                  className="px-4 py-2.5 flex items-center gap-3 border-b border-border last:border-0 text-sm"
                >
                  <span className="text-base">{c.icon}</span>
                  <span className="flex-1 text-muted truncate">{c.name}</span>
                  <button
                    onClick={() => toggleHide(c.slug, false)}
                    className="text-xs px-2 py-1 rounded hover:bg-muted/30 text-muted"
                  >
                    <Eye size={12} className="inline mr-1" /> Restaurer
                  </button>
                </div>
              ))}
            </Section>
          )}
        </>
      )}

      {error && !editing && (
        <div className="fixed bottom-4 right-4 max-w-sm rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 shadow-lg">
          {error}
        </div>
      )}

      {/* Modal Activation */}
      {editing && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-lg p-6 shadow-2xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-2xl">{editing.icon}</span>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold">{editing.name}</h2>
                  <span className={"inline-block text-[10px] px-1.5 py-0.5 rounded-full mt-0.5 " + IMPL_BADGE[editing.implStatus].cls}>
                    {IMPL_BADGE[editing.implStatus].label}
                  </span>
                </div>
              </div>
              <button
                onClick={() => setEditing(null)}
                className="p-1 rounded hover:bg-muted/30 shrink-0"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-sm text-muted mt-2 mb-4">{editing.description}</p>

            {editing.implStatus !== "implemented" && (
              <div className="mb-4 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs px-3 py-2">
                <strong>Connecteur en {IMPL_BADGE[editing.implStatus].label.toLowerCase()}.</strong>{" "}
                Vous pouvez enregistrer la configuration ; le worker de
                synchronisation sera activé dès qu'il sera disponible.
              </div>
            )}

            <div className="space-y-3">
              {editing.fields.map((f) => (
                <div key={f.key}>
                  <label className="text-xs font-medium block mb-1">
                    {f.label}
                    {f.required && <span className="text-red-400 ml-0.5">*</span>}
                  </label>
                  {f.type === "select" ? (
                    <select
                      value={editConfig[f.key] || ""}
                      onChange={(e) => setEditConfig({ ...editConfig, [f.key]: e.target.value })}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                    >
                      <option value="">— sélectionner —</option>
                      {f.options?.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === "password" ? "password" : f.type === "url" ? "url" : "text"}
                      value={editConfig[f.key] || ""}
                      onChange={(e) => setEditConfig({ ...editConfig, [f.key]: e.target.value })}
                      placeholder={f.placeholder}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                    />
                  )}
                  {f.helpText && (
                    <p className="text-[11px] text-muted mt-0.5">{f.helpText}</p>
                  )}
                </div>
              ))}
            </div>

            {error && (
              <div className="mt-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
                {error}
              </div>
            )}

            <div className="mt-5 flex items-center justify-between gap-2">
              {editing.docUrl && (
                <a
                  href={editing.docUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted hover:text-foreground"
                >
                  Documentation ↗
                </a>
              )}
              <div className="ml-auto flex gap-2">
                <button
                  onClick={() => setEditing(null)}
                  className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/20"
                >
                  Annuler
                </button>
                <button
                  onClick={submitActivate}
                  disabled={submitting}
                  className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  <CheckCircle2 size={14} />
                  {submitting ? "Activation…" : (editing.status === "active" ? "Mettre à jour" : "Activer")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal Permissions RBAC */}
      {permsTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => !permsSaving && setPermsTarget(null)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-lg p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-2xl">{permsTarget.icon}</span>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold flex items-center gap-2">
                    <Shield size={16} className="text-amber-400" />
                    Permissions
                  </h2>
                  <p className="text-xs text-muted">{permsTarget.name}</p>
                </div>
              </div>
              <button
                onClick={() => setPermsTarget(null)}
                disabled={permsSaving}
                className="p-1 rounded hover:bg-muted/30 shrink-0"
              >
                <X size={16} />
              </button>
            </div>

            <div className="text-xs text-muted mb-4">
              Choisissez les rôles autorisés à utiliser ce connecteur (recherche
              RAG, contenus indexés). Les <strong>admins ont toujours accès</strong>{" "}
              (impossible de se lock-out). Si vous cochez les 3 rôles, le connecteur
              est ouvert à tous.
            </div>

            {/* Cases à cocher rôles */}
            <div className="space-y-2 mb-4">
              {(["admin", "manager", "employee"] as Role[]).map((role) => (
                <label
                  key={role}
                  className="flex items-center gap-2.5 p-2 rounded-md border border-border cursor-pointer hover:bg-muted/15 transition-default"
                >
                  <input
                    type="checkbox"
                    checked={permsRoles.includes(role)}
                    disabled={role === "admin"} // admin toujours coché (bypass)
                    onChange={() => togglePermsRole(role)}
                    className="w-4 h-4"
                  />
                  <span className="text-sm font-medium">{ROLE_LABELS[role]}</span>
                  {role === "admin" && (
                    <span className="text-[10px] text-muted ml-auto">
                      (toujours autorisé)
                    </span>
                  )}
                </label>
              ))}
            </div>

            {/* Whitelist users (avancé) */}
            <details className="mb-4">
              <summary className="text-xs text-muted cursor-pointer hover:text-foreground">
                Whitelist par email (avancé)
              </summary>
              <div className="mt-2">
                <textarea
                  value={permsUsersText}
                  onChange={(e) => setPermsUsersText(e.target.value)}
                  placeholder="alice@boite.fr&#10;bob@boite.fr"
                  rows={3}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary resize-none"
                />
                <p className="text-[11px] text-muted mt-1">
                  Si défini, seuls ces emails (en plus du filtre par rôle) auront accès.
                  1 email par ligne.
                </p>
              </div>
            </details>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPermsTarget(null)}
                disabled={permsSaving}
                className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/20 disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={savePermissions}
                disabled={permsSaving}
                className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
              >
                {permsSaving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {permsSaving ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Grille de tuiles métier — la vue par défaut quand l'admin entre sur
 * /connectors. Chaque tuile représente un Hub (regroupement de catégories
 * techniques) et indique combien de connecteurs sont actifs / disponibles.
 */
function HubGrid({
  stats, onPick,
}: {
  stats: Record<ConnectorHub, { active: number; total: number }>;
  onPick: (h: ConnectorHub) => void;
}) {
  const hubs = (Object.entries(HUBS) as [ConnectorHub, typeof HUBS[ConnectorHub]][])
    .sort((a, b) => a[1].order - b[1].order);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {hubs.map(([key, def]) => {
        const s = stats[key] || { active: 0, total: 0 };
        const isActive = s.active > 0;
        return (
          <button
            key={key}
            onClick={() => onPick(key)}
            className={
              "group text-left rounded-lg border bg-card p-4 transition-default " +
              "hover:border-primary/60 hover:bg-card/80 focus:outline-none focus:border-primary " +
              (isActive ? "border-primary/40" : "border-border")
            }
          >
            <div className="flex items-start justify-between mb-2">
              <span className="text-3xl leading-none">{def.icon}</span>
              {isActive && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent font-medium">
                  <CheckCircle2 size={9} /> {s.active} actif{s.active > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="font-semibold text-base mb-1">{def.label}</div>
            <p className="text-xs text-muted leading-snug line-clamp-2 mb-3 min-h-[32px]">
              {def.description}
            </p>
            <div className="flex items-center justify-between text-[11px] text-muted">
              <span>{s.total} connecteur{s.total > 1 ? "s" : ""}</span>
              <span className="inline-flex items-center gap-0.5 text-muted group-hover:text-primary transition-default">
                Configurer <ChevronRight size={11} />
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Section({
  title, count, muted, children,
}: { title: string; count: number; muted?: boolean; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className={"text-xs font-semibold uppercase tracking-wide mb-2 " +
        (muted ? "text-muted" : "")}>
        {title} <span className="text-muted font-normal">({count})</span>
      </h2>
      <div className={muted
        ? "rounded-lg border border-border bg-muted/5"
        : "rounded-lg border border-border bg-card"}>
        {children}
      </div>
    </section>
  );
}

function ActiveRow({
  c, onSync, onConfig, onPermissions, onDeactivate,
}: {
  c: ConnectorItem;
  onSync: () => void;
  onConfig: () => void;
  onPermissions: () => void;
  onDeactivate: () => void;
}) {
  const restricted =
    (c.state?.allowed_roles && c.state.allowed_roles.length > 0) ||
    (c.state?.allowed_users && c.state.allowed_users.length > 0);
  return (
    <div className="px-4 py-3 grid grid-cols-[auto_1fr_auto] gap-4 items-center border-b border-border last:border-0">
      <span className="text-2xl">{c.icon}</span>
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="font-medium truncate">{c.name}</span>
          <span className={"text-[10px] px-1.5 py-0.5 rounded-full " + IMPL_BADGE[c.implStatus].cls}>
            {IMPL_BADGE[c.implStatus].label}
          </span>
          {restricted && (
            <span
              className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400"
              title={
                "Restreint à : " +
                ((c.state?.allowed_roles || []).map((r) => ROLE_LABELS[r]).join(", ") ||
                  (c.state?.allowed_users || []).join(", "))
              }
            >
              <Lock size={9} />
              Restreint
            </span>
          )}
        </div>
        <div className="text-xs text-muted flex items-center gap-3 flex-wrap">
          <span className="inline-flex items-center gap-1">
            <Clock size={10} />
            sync : {relTime(c.state?.last_sync_at || null)}
          </span>
          {c.state?.stats?.objects_indexed != null && (
            <span>{c.state.stats.objects_indexed.toLocaleString("fr-FR")} objets indexés</span>
          )}
          {c.state?.last_error && (
            <span className="text-red-400 truncate max-w-xs">⚠ {c.state.last_error}</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onSync}
          title="Synchroniser maintenant"
          className="p-2 rounded hover:bg-muted/30 text-muted hover:text-foreground transition-default"
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={onPermissions}
          title="Permissions (RBAC)"
          className={
            "p-2 rounded hover:bg-muted/30 transition-default " +
            (restricted ? "text-amber-400 hover:text-amber-300" : "text-muted hover:text-foreground")
          }
        >
          <Shield size={14} />
        </button>
        <button
          onClick={onConfig}
          title="Reconfigurer"
          className="p-2 rounded hover:bg-muted/30 text-muted hover:text-foreground transition-default"
        >
          <SettingsIcon size={14} />
        </button>
        <button
          onClick={onDeactivate}
          title="Désactiver"
          className="p-2 rounded hover:bg-red-500/10 text-muted hover:text-red-400 transition-default"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function AvailableCard({
  c, onActivate, onHide,
}: {
  c: ConnectorItem;
  onActivate: () => void;
  onHide: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-3 hover:border-primary/50 transition-default group">
      <div className="flex items-start gap-3 mb-2">
        <span className="text-2xl">{c.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="font-medium truncate">{c.name}</span>
            <span className={"text-[10px] px-1.5 py-0.5 rounded-full shrink-0 " + IMPL_BADGE[c.implStatus].cls}>
              {IMPL_BADGE[c.implStatus].label}
            </span>
          </div>
          <p className="text-xs text-muted line-clamp-2">{c.description}</p>
        </div>
      </div>
      <div className="flex gap-2 mt-2">
        <button
          onClick={onActivate}
          className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium transition-default"
        >
          <Plus size={12} /> Activer
        </button>
        <button
          onClick={onHide}
          title="Masquer"
          className="px-2 py-1.5 rounded-md text-muted hover:bg-muted/20 transition-default opacity-0 group-hover:opacity-100"
        >
          <EyeOff size={12} />
        </button>
      </div>
    </div>
  );
}
