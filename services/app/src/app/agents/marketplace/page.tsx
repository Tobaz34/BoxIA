"use client";

/**
 * /agents/marketplace — admin only.
 *
 * Permet d'importer en 1 clic un template Dify (50+ disponibles) pour
 * l'ajouter au picker du chat (sans toucher la console Dify).
 *
 * Workflow :
 * 1. GET /api/dify/templates → liste tous les templates Explorer Dify
 * 2. Affichage par catégorie + filtre + recherche
 * 3. Clic "Activer" → modal avec nom/description/rôles autorisés
 * 4. Submit → POST /api/dify/install-template
 * 5. Refresh + apparait dans la sidebar du chat
 *
 * Bonus : section "Agents installés" avec bouton désinstaller.
 */
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Sparkles, Search, Tag, ShieldAlert, Plus, Trash2, RefreshCw,
  Bot, AlertCircle, CheckCircle2,
} from "lucide-react";

interface DifyTemplate {
  template_id: string;
  name: string;
  mode: "chat" | "advanced-chat" | "workflow" | "agent-chat" | "completion";
  icon: string;
  icon_background: string;
  description: string;
  category: string;
  position: number;
}

interface InstalledAgent {
  slug: string;
  name: string;
  description: string;
  icon: string;
  icon_background: string;
  mode: string;
  category?: string;
  installed_at: string;
  source_template_id?: string;
  allowed_roles?: ("admin" | "manager" | "employee")[];
}

interface BoxiaFrCategory {
  id: string;
  label: string;
  icon: string;
}

interface BoxiaFrTemplate {
  slug: string;
  name: string;
  icon: string;
  icon_background: string;
  category: string;
  description: string;
  mode: "chat" | "agent-chat";
  suggested_questions: string[];
  tags: string[];
}

type SourceTab = "boxia-fr" | "explorer";

const ROLE_LABELS = { admin: "Admin", manager: "Manager", employee: "Employé" };
const ROLES: ("admin" | "manager" | "employee")[] = ["admin", "manager", "employee"];

const MODE_LABELS: Record<string, string> = {
  "chat": "Conversation",
  "advanced-chat": "Conversation avancée",
  "workflow": "Workflow (pipeline)",
  "agent-chat": "Agent autonome",
  "completion": "Génération",
};

export default function MarketplacePage() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [templates, setTemplates] = useState<DifyTemplate[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [installed, setInstalled] = useState<InstalledAgent[]>([]);
  const [boxiaFrCatalog, setBoxiaFrCatalog] = useState<{
    categories: BoxiaFrCategory[];
    templates: BoxiaFrTemplate[];
  }>({ categories: [], templates: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<SourceTab>("boxia-fr");
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [installingBoxiaFr, setInstallingBoxiaFr] = useState<string | null>(null);
  const [installingTemplate, setInstallingTemplate] = useState<DifyTemplate | null>(null);
  const [installInProgress, setInstallInProgress] = useState(false);

  // Modal install
  const [installName, setInstallName] = useState("");
  const [installDescription, setInstallDescription] = useState("");
  const [installRoles, setInstallRoles] = useState<("admin" | "manager" | "employee")[]>([]);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const [tr, ar, br] = await Promise.all([
        fetch("/api/dify/templates", { cache: "no-store" }),
        fetch("/api/dify/installed-agents", { cache: "no-store" }),
        fetch("/api/dify/boxia-fr", { cache: "no-store" }),
      ]);
      if (tr.status === 403) {
        setError("Accès réservé aux administrateurs.");
        return;
      }
      if (tr.ok) {
        const tjson = await tr.json();
        setTemplates(tjson.templates || []);
        setCategories(tjson.categories || []);
      }
      if (ar.ok) {
        const ajson = await ar.json();
        setInstalled(ajson.agents || []);
      }
      if (br.ok) {
        const bjson = await br.json();
        setBoxiaFrCatalog({
          categories: bjson.categories || [],
          templates: bjson.templates || [],
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const installBoxiaFr = async (tpl: BoxiaFrTemplate) => {
    setInstallingBoxiaFr(tpl.slug);
    try {
      const r = await fetch("/api/dify/boxia-fr/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug: tpl.slug }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("Échec installation : " + (j.detail || j.error || `HTTP ${r.status}`));
        return;
      }
      await reload();
    } finally {
      setInstallingBoxiaFr(null);
    }
  };

  useEffect(() => { if (status === "authenticated") reload(); }, [status]);

  const filtered = useMemo(() => {
    let list = templates;
    if (activeCategory !== "all") {
      list = list.filter((t) => t.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      );
    }
    return list;
  }, [templates, activeCategory, search]);

  const installedTemplateIds = useMemo(
    () => new Set(installed.map((a) => a.source_template_id).filter(Boolean)),
    [installed],
  );

  const openInstall = (t: DifyTemplate) => {
    setInstallingTemplate(t);
    setInstallName(t.name);
    setInstallDescription(t.description);
    setInstallRoles([]);
  };

  const submitInstall = async () => {
    if (!installingTemplate) return;
    setInstallInProgress(true);
    try {
      const r = await fetch("/api/dify/install-template", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          template_id: installingTemplate.template_id,
          name: installName.trim() || installingTemplate.name,
          description: installDescription.trim(),
          allowed_roles: installRoles,
          category: installingTemplate.category,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("Échec installation : " + (j.detail || j.error || `HTTP ${r.status}`));
        return;
      }
      setInstallingTemplate(null);
      await reload();
    } finally {
      setInstallInProgress(false);
    }
  };

  const uninstall = async (slug: string, name: string) => {
    if (!confirm(`Désinstaller l'assistant « ${name} » ?\n\n` +
                 "L'app sera supprimée de Dify ET de la liste des assistants. Conversations existantes perdues.")) return;
    const r = await fetch(`/api/dify/installed-agents?slug=${encodeURIComponent(slug)}`, {
      method: "DELETE",
    });
    if (r.ok) await reload();
    else alert("Erreur désinstallation");
  };

  if (status === "loading") {
    return <div className="p-6 text-sm text-muted">Chargement…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <ShieldAlert size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            La marketplace d'assistants est accessible aux administrateurs uniquement.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Sparkles size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Marketplace d'assistants</h1>
            <p className="text-sm text-muted">
              Activez en 1 clic des assistants pré-configurés (résumé de PDF, traduction,
              compte-rendu de réunion…).
            </p>
          </div>
        </div>
        <button
          onClick={reload}
          disabled={loading}
          className="p-2 rounded hover:bg-muted/20 text-muted hover:text-foreground transition-default"
          title="Rafraîchir"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Section : agents installés */}
      {installed.length > 0 && (
        <section className="mb-6">
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
            Assistants activés ({installed.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {installed.map((a) => (
              <div
                key={a.slug}
                className="rounded-lg border border-border bg-card p-3 flex items-start gap-3"
              >
                <div
                  className="w-10 h-10 rounded-md flex items-center justify-center text-xl shrink-0"
                  style={{ background: a.icon_background }}
                >
                  {a.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="font-medium text-sm truncate">{a.name}</span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent shrink-0">
                      Activé
                    </span>
                  </div>
                  <p className="text-xs text-muted line-clamp-2">{a.description || "—"}</p>
                  <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                    <span className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                      {MODE_LABELS[a.mode] || a.mode}
                    </span>
                    {a.allowed_roles && a.allowed_roles.length > 0 && (
                      <span className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                        {a.allowed_roles.map((r) => ROLE_LABELS[r]).join(" / ")}
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => uninstall(a.slug, a.name)}
                  className="p-1.5 rounded hover:bg-red-500/15 text-muted hover:text-red-400 transition-default shrink-0"
                  title="Désinstaller"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Onglets : BoxIA-FR / Communauté Dify */}
      <div className="mb-4 border-b border-border flex items-center gap-1">
        <button
          onClick={() => { setTab("boxia-fr"); setActiveCategory("all"); }}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (tab === "boxia-fr"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          🇫🇷 BoxIA-FR
          <span className="ml-2 text-xs opacity-60">({boxiaFrCatalog.templates.length})</span>
        </button>
        <button
          onClick={() => { setTab("explorer"); setActiveCategory("all"); }}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (tab === "explorer"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          🌐 Communauté Dify
          <span className="ml-2 text-xs opacity-60">({templates.length})</span>
        </button>
      </div>

      {tab === "boxia-fr" && (
        <div className="mb-4 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs px-3 py-2 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>
            Templates en français adaptés au marché TPE/PME français : TVA française,
            code du travail, conventions BTP, RGPD, e-commerce. <strong>Tous configurés
            sur Qwen2.5-7B local</strong> (pas d&apos;API key externe nécessaire).
          </span>
        </div>
      )}

      {/* Filtres */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"
          />
          <input
            type="text"
            placeholder="Rechercher un assistant…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 rounded-md bg-card border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button
            onClick={() => setActiveCategory("all")}
            className={
              "px-2.5 py-1 text-xs rounded-md transition-default " +
              (activeCategory === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted/15 text-muted hover:bg-muted/25")
            }
          >
            Tout
          </button>
          {tab === "boxia-fr"
            ? boxiaFrCatalog.categories.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCategory(c.id)}
                  className={
                    "px-2.5 py-1 text-xs rounded-md transition-default flex items-center gap-1 " +
                    (activeCategory === c.id
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/15 text-muted hover:bg-muted/25")
                  }
                >
                  <span aria-hidden>{c.icon}</span>
                  {c.label}
                </button>
              ))
            : categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setActiveCategory(c)}
                  className={
                    "px-2.5 py-1 text-xs rounded-md transition-default " +
                    (activeCategory === c
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/15 text-muted hover:bg-muted/25")
                  }
                >
                  {c}
                </button>
              ))}
        </div>
      </div>

      {/* Grid BoxIA-FR */}
      {tab === "boxia-fr" && !loading && (() => {
        const installedSlugs = new Set(
          installed.map((a) => a.source_template_id).filter((s): s is string => !!s),
        );
        const filteredFr = boxiaFrCatalog.templates.filter((t) => {
          if (activeCategory !== "all" && t.category !== activeCategory) return false;
          if (search.trim()) {
            const q = search.toLowerCase();
            return t.name.toLowerCase().includes(q) ||
              t.description.toLowerCase().includes(q) ||
              t.tags.some((tag) => tag.toLowerCase().includes(q));
          }
          return true;
        });
        if (filteredFr.length === 0) {
          return (
            <div className="text-center text-sm text-muted py-12">
              Aucun template BoxIA-FR trouvé.
            </div>
          );
        }
        const cat = (id: string) =>
          boxiaFrCatalog.categories.find((c) => c.id === id);
        return (
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
              Templates BoxIA-FR ({filteredFr.length})
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredFr.map((t) => {
                const installed_ = installedSlugs.has(`boxia-fr:${t.slug}`);
                const isInstalling = installingBoxiaFr === t.slug;
                return (
                  <div
                    key={t.slug}
                    className="rounded-lg border border-border bg-card p-3 flex flex-col"
                  >
                    <div className="flex items-start gap-3 mb-2">
                      <div
                        className="w-10 h-10 rounded-md flex items-center justify-center text-xl shrink-0"
                        style={{ background: t.icon_background }}
                      >
                        {t.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-sm">{t.name}</div>
                        <div className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded inline-block mt-0.5">
                          {cat(t.category)?.label || t.category}
                        </div>
                      </div>
                    </div>
                    <p className="text-xs text-muted line-clamp-4 flex-1 mb-2">
                      {t.description || "—"}
                    </p>
                    {t.tags.length > 0 && (
                      <div className="flex items-center gap-1 flex-wrap mb-2">
                        {t.tags.slice(0, 4).map((tag) => (
                          <span key={tag} className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="flex items-center justify-end gap-2 mt-auto">
                      {installed_ ? (
                        <span className="text-xs text-accent flex items-center gap-1 px-2.5 py-1">
                          <CheckCircle2 size={12} />
                          Déjà activé
                        </span>
                      ) : (
                        <button
                          onClick={() => installBoxiaFr(t)}
                          disabled={isInstalling}
                          className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default flex items-center gap-1 disabled:opacity-50"
                        >
                          {isInstalling ? (
                            <RefreshCw size={12} className="animate-spin" />
                          ) : (
                            <Plus size={12} />
                          )}
                          {isInstalling ? "Installation…" : "Activer"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })()}

      {/* Grid Dify Explorer */}
      {tab === "explorer" && (loading ? (
        <div className="text-center text-sm text-muted py-12">Chargement…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-sm text-muted py-12">
          Aucun template trouvé. Essaie un autre filtre.
        </div>
      ) : (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
            Templates disponibles ({filtered.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((t) => {
              const isInstalled = installedTemplateIds.has(t.template_id);
              return (
                <div
                  key={t.template_id}
                  className="rounded-lg border border-border bg-card p-3 flex flex-col"
                >
                  <div className="flex items-start gap-3 mb-2">
                    <div
                      className="w-10 h-10 rounded-md flex items-center justify-center text-xl shrink-0"
                      style={{ background: t.icon_background }}
                    >
                      {t.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{t.name}</div>
                      <div className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded inline-block mt-0.5">
                        {MODE_LABELS[t.mode] || t.mode}
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted line-clamp-3 flex-1 mb-3">
                    {t.description || "—"}
                  </p>
                  <div className="flex items-center justify-between gap-2 mt-auto">
                    <span className="text-[10px] text-muted flex items-center gap-1">
                      <Tag size={10} />
                      {t.category}
                    </span>
                    {isInstalled ? (
                      <span className="text-xs text-accent flex items-center gap-1 px-2.5 py-1">
                        <CheckCircle2 size={12} />
                        Déjà activé
                      </span>
                    ) : (
                      <button
                        onClick={() => openInstall(t)}
                        className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default flex items-center gap-1"
                      >
                        <Plus size={12} />
                        Activer
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      {/* Modal install */}
      {installingTemplate && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => !installInProgress && setInstallingTemplate(null)}
        >
          <div
            className="bg-card border border-border rounded-lg p-6 w-full max-w-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-10 h-10 rounded-md flex items-center justify-center text-xl"
                style={{ background: installingTemplate.icon_background }}
              >
                {installingTemplate.icon}
              </div>
              <div>
                <h2 className="font-semibold">Activer cet assistant</h2>
                <p className="text-xs text-muted">{installingTemplate.category} · {MODE_LABELS[installingTemplate.mode]}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-muted block mb-1">Nom affiché</label>
                <input
                  value={installName}
                  onChange={(e) => setInstallName(e.target.value)}
                  className="w-full px-3 py-2 rounded-md bg-muted/15 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs text-muted block mb-1">Description</label>
                <textarea
                  value={installDescription}
                  onChange={(e) => setInstallDescription(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 rounded-md bg-muted/15 border border-border text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
              <div>
                <label className="text-xs text-muted block mb-1">
                  Rôles autorisés (vide = tout le monde)
                </label>
                <div className="flex gap-2 flex-wrap">
                  {ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => {
                        setInstallRoles((prev) =>
                          prev.includes(r)
                            ? prev.filter((x) => x !== r)
                            : [...prev, r],
                        );
                      }}
                      className={
                        "px-3 py-1 text-xs rounded-md transition-default " +
                        (installRoles.includes(r)
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/15 text-muted hover:bg-muted/25")
                      }
                    >
                      {ROLE_LABELS[r]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => setInstallingTemplate(null)}
                disabled={installInProgress}
                className="px-3 py-1.5 text-sm rounded-md hover:bg-muted/15 transition-default disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={submitInstall}
                disabled={installInProgress || !installName.trim()}
                className="px-4 py-1.5 text-sm rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default flex items-center gap-2 disabled:opacity-50"
              >
                {installInProgress ? (
                  <RefreshCw size={12} className="animate-spin" />
                ) : (
                  <Bot size={12} />
                )}
                {installInProgress ? "Installation…" : "Activer l'assistant"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
