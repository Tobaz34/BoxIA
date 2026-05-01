"use client";

/**
 * /workflows/marketplace — admin only.
 *
 * Marketplace dédiée aux workflows n8n pré-écrits pour TPE/PME (digest
 * factures impayées, alerte tickets GLPI, snapshots Qdrant, healthcheck
 * stack, etc.).
 *
 * Workflow :
 * 1. GET /api/workflows/marketplace → liste catalogue + cross-check installés
 * 2. Affichage par catégorie + filtre + recherche
 * 3. Clic "Installer" → POST /api/workflows/marketplace/install
 * 4. Toast feedback + refresh
 *
 * Le workflow est créé `active: false` côté n8n. L'admin doit ensuite
 * configurer les credentials_required (s'il y en a) puis activer le
 * workflow depuis /workflows.
 */
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Workflow, Search, ShieldAlert, Plus, RefreshCw, AlertCircle,
  CheckCircle2, KeyRound, ExternalLink,
} from "lucide-react";
import { useT } from "@/lib/i18n";

interface MarketplaceCategoryDef {
  id: string;
  label: string;
  icon: string;
}

interface MarketplaceWorkflow {
  file: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  difficulty: "facile" | "moyen" | "avance";
  credentials_required: string[];
  boxia_services: string[];
  default_active: boolean;
  installed: boolean;
  workflow_id: string | null;
  active: boolean;
  source?: "boxia" | "community";
  source_url?: string;
  total_views?: number;
  author?: string;
}

type SourceTab = "boxia" | "community";

const DIFFICULTY_LABEL: Record<string, string> = {
  facile: "Facile",
  moyen: "Moyen",
  avance: "Avancé",
};

const DIFFICULTY_COLOR: Record<string, string> = {
  facile: "bg-emerald-500/15 text-emerald-400",
  moyen: "bg-amber-500/15 text-amber-400",
  avance: "bg-rose-500/15 text-rose-400",
};

export default function WorkflowsMarketplacePage() {
  const { data: session, status } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  const { t } = useT();

  const [workflows, setWorkflows] = useState<MarketplaceWorkflow[]>([]);
  const [categories, setCategories] = useState<MarketplaceCategoryDef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [activeSource, setActiveSource] = useState<SourceTab>("boxia");
  const [installingFile, setInstallingFile] = useState<string | null>(null);
  const [toast, setToast] = useState<
    { kind: "ok" | "warn" | "err"; msg: string } | null
  >(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/workflows/marketplace", {
        cache: "no-store",
      });
      if (r.status === 403) {
        setError("Accès réservé aux administrateurs.");
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.detail || `Marketplace indisponible (HTTP ${r.status})`);
        return;
      }
      const j = await r.json();
      setWorkflows(j.workflows || []);
      setCategories(j.categories || []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") reload();
  }, [status]);

  // Auto-dismiss toast après 4s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    // Filtre 1 : onglet de source (boxia / community). Les workflows
    // sans `source` sont assimilés à "boxia" (rétro-compat).
    let list = workflows.filter((w) => (w.source || "boxia") === activeSource);
    if (activeCategory !== "all") {
      list = list.filter((w) => w.category === activeCategory);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (w) =>
          w.name.toLowerCase().includes(q) ||
          w.description.toLowerCase().includes(q) ||
          w.category.toLowerCase().includes(q),
      );
    }
    // Communauté : tri par popularité décroissante (totalViews) ; officiels :
    // ordre du catalogue (déjà ordonné).
    if (activeSource === "community") {
      list = [...list].sort(
        (a, b) => (b.total_views || 0) - (a.total_views || 0),
      );
    }
    return list;
  }, [workflows, activeCategory, activeSource, search]);

  const counts = useMemo(() => {
    const boxia = workflows.filter((w) => (w.source || "boxia") === "boxia");
    const community = workflows.filter((w) => w.source === "community");
    const installed = workflows.filter((w) => w.installed).length;
    const active = workflows.filter((w) => w.installed && w.active).length;
    return {
      total: workflows.length,
      boxia_count: boxia.length,
      community_count: community.length,
      installed,
      active,
    };
  }, [workflows]);

  const installWorkflow = async (w: MarketplaceWorkflow) => {
    setInstallingFile(w.file);
    try {
      const r = await fetch("/api/workflows/marketplace/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: w.file }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setToast({
          kind: "err",
          msg: `Échec : ${j.detail || j.error || `HTTP ${r.status}`}`,
        });
        return;
      }
      if (j.already_installed) {
        setToast({
          kind: "warn",
          msg: t("workflows.marketplace.toastAlreadyInstalled", { name: j.name }),
        });
      } else {
        setToast({
          kind: "ok",
          msg: w.credentials_required.length > 0
            ? t("workflows.marketplace.toastInstalledNeedsCreds", { name: j.name })
            : t("workflows.marketplace.toastInstalled", { name: j.name }),
        });
      }
      await reload();
    } catch (e) {
      setToast({ kind: "err", msg: String(e).slice(0, 200) });
    } finally {
      setInstallingFile(null);
    }
  };

  if (status === "loading") {
    return <div className="p-6 text-sm text-muted">{t("common.loading")}</div>;
  }

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <ShieldAlert size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">{t("common.accessReserved")}</h1>
          <p className="text-sm text-muted">{t("common.accessReservedAdmin")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Workflow size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{t("workflows.marketplace.title")}</h1>
            <p className="text-sm text-muted">{t("workflows.marketplace.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs text-muted text-right hidden sm:block">
            <div>{t("workflows.marketplace.countAvailable", { count: counts.total })}</div>
            <div>{t("workflows.marketplace.countInstalled", { installed: counts.installed, active: counts.active })}</div>
          </div>
          <button
            onClick={reload}
            disabled={loading}
            className="p-2 rounded hover:bg-muted/20 text-muted hover:text-foreground transition-default"
            title={t("common.refresh")}
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 flex items-center gap-2">
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {toast && (
        <div
          className={
            "mb-4 rounded-md border text-sm px-3 py-2 flex items-center gap-2 " +
            (toast.kind === "ok"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : toast.kind === "warn"
              ? "bg-amber-500/10 border-amber-500/30 text-amber-400"
              : "bg-red-500/10 border-red-500/30 text-red-400")
          }
        >
          {toast.kind === "ok" ? (
            <CheckCircle2 size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
          {toast.msg}
        </div>
      )}

      {/* Onglets : Officiels BoxIA / Communauté n8n.io */}
      <div className="mb-4 border-b border-border flex items-center gap-1">
        <button
          onClick={() => setActiveSource("boxia")}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (activeSource === "boxia"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          ⭐ Officiels BoxIA
          <span className="ml-2 text-xs opacity-60">({counts.boxia_count})</span>
        </button>
        <button
          onClick={() => setActiveSource("community")}
          className={
            "px-4 py-2 text-sm font-medium transition-default border-b-2 -mb-px " +
            (activeSource === "community"
              ? "border-primary text-foreground"
              : "border-transparent text-muted hover:text-foreground")
          }
        >
          🌐 Communauté n8n
          <span className="ml-2 text-xs opacity-60">({counts.community_count})</span>
        </button>
        <div className="ml-auto pr-2">
          <a
            href="https://n8n.io/workflows/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1"
          >
            Voir 9000+ sur n8n.io <ExternalLink size={10} />
          </a>
        </div>
      </div>

      {/* Bandeau d'aide : seulement sur l'onglet communauté pour clarifier
          que ces workflows demandent souvent une config manuelle. */}
      {activeSource === "community" && (
        <div className="mb-4 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs px-3 py-2 flex items-start gap-2">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>
            Ces workflows viennent de la communauté n8n.io (top par popularité).
            Ils peuvent demander des credentials externes (OpenAI, Slack, Telegram…)
            à configurer dans n8n après installation. <strong>Toujours installés
            désactivés</strong> par sécurité.
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
            placeholder={t("workflows.marketplace.searchPlaceholder")}
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
            {t("workflows.marketplace.categoryAll")}
          </button>
          {categories.map((c) => (
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
          ))}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="text-center text-sm text-muted py-12">{t("common.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-sm text-muted py-12">
          {t("workflows.marketplace.empty")}
        </div>
      ) : (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
            Workflows ({filtered.length})
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((w) => {
              const isInstalling = installingFile === w.file;
              const cat = categories.find((c) => c.id === w.category);
              return (
                <div
                  key={w.file}
                  className="rounded-lg border border-border bg-card p-3 flex flex-col"
                >
                  <div className="flex items-start gap-3 mb-2">
                    <div className="w-10 h-10 rounded-md bg-muted/15 flex items-center justify-center text-xl shrink-0">
                      {w.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm break-words">
                        {w.name}
                      </div>
                      <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                        <span className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                          {cat?.label || w.category}
                        </span>
                        <span
                          className={
                            "text-[10px] px-1.5 py-0.5 rounded " +
                            (DIFFICULTY_COLOR[w.difficulty] ||
                              "bg-muted/15 text-muted")
                          }
                        >
                          {DIFFICULTY_LABEL[w.difficulty] || w.difficulty}
                        </span>
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted line-clamp-3 flex-1 mb-2">
                    {w.description || "—"}
                  </p>

                  {/* Métadonnées community : auteur + popularité + lien source */}
                  {w.source === "community" && (w.author || w.total_views) && (
                    <div className="text-[10px] text-muted mb-2 flex items-center gap-2 flex-wrap">
                      {w.author && <span>par <strong>{w.author}</strong></span>}
                      {w.total_views ? (
                        <span>· {w.total_views.toLocaleString("fr-FR")} vues</span>
                      ) : null}
                      {w.source_url && (
                        <a
                          href={w.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-400 hover:underline inline-flex items-center gap-0.5"
                        >
                          source <ExternalLink size={9} />
                        </a>
                      )}
                    </div>
                  )}

                  {w.credentials_required.length > 0 && (
                    <div className="text-[11px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1 mb-2 flex items-start gap-1">
                      <KeyRound size={11} className="shrink-0 mt-0.5" />
                      <span>
                        {t("workflows.marketplace.credsRequired", { list: w.credentials_required.join(", ") })}
                      </span>
                    </div>
                  )}

                  <div className="flex items-center justify-between gap-2 mt-auto">
                    <div className="flex items-center gap-1 flex-wrap">
                      {w.boxia_services.map((s) => (
                        <span
                          key={s}
                          className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded"
                        >
                          {s}
                        </span>
                      ))}
                    </div>
                    {w.installed ? (
                      <a
                        href="/workflows"
                        className="px-2.5 py-1 text-xs rounded-md bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25 transition-default flex items-center gap-1"
                      >
                        <CheckCircle2 size={12} />
                        {w.active
                          ? t("workflows.marketplace.active")
                          : t("workflows.marketplace.installed")}
                        <ExternalLink size={10} className="opacity-60" />
                      </a>
                    ) : (
                      <button
                        onClick={() => installWorkflow(w)}
                        disabled={isInstalling}
                        className="px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90 transition-default flex items-center gap-1 disabled:opacity-50"
                      >
                        {isInstalling ? (
                          <RefreshCw size={12} className="animate-spin" />
                        ) : (
                          <Plus size={12} />
                        )}
                        {isInstalling
                          ? t("workflows.marketplace.installing")
                          : t("workflows.marketplace.install")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <p className="text-[11px] text-muted mt-6 text-center">
        {t("workflows.marketplace.footerNote")}
      </p>
    </div>
  );
}
