"use client";

/**
 * /bench — Dashboard observabilité IA (locale + cloud) + résultats des
 * benchmarks. 3 sections empilées :
 *
 *   1. POUR VOUS (admin client) : conso ce mois, top agents, économies vs cloud
 *   2. QUALITÉ (dernier bench)  : score local vs cloud par catégorie + bouton relancer
 *   3. DIAGNOSTIC INFRA (admin) : Ollama VRAM, conformité RGPD, anomalies live
 *
 * Réutilise les APIs existantes (/api/cloud-providers, /api/system/*,
 * /api/stats) + la nouvelle /api/bench/history. Pas de polling agressif :
 * les sections "live" rafraîchissent toutes les 30 s, les autres au mount.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BarChart3, Bot, Cloud, Cpu, ShieldCheck, Activity,
  AlertTriangle, CheckCircle2, RefreshCw, Play, Calendar,
  TrendingUp, Server, Sparkles,
} from "lucide-react";

// ---- Types des APIs réutilisées ------------------------------------------

interface CloudProviderState {
  configured: boolean;
  cost_eur_this_month?: number;
  requests_this_month?: number;
  last_success_at?: number;
}
interface CloudResp {
  state: Record<string, CloudProviderState>;
  budget_monthly_eur: number;
  pii_scrub_enabled: boolean;
}

interface OllamaModel {
  name: string;
  size_mb: number;
  processor: string;
}
interface OllamaStatus {
  loaded: OllamaModel[];
}

interface SystemHealth {
  overall: "ok" | "degraded" | "down";
  summary: { total: number; up: number; down: number };
  services: Array<{
    key: string;
    name: string;
    ok: boolean;
    optional?: boolean;
    error?: string;
  }>;
}

interface AgentStat {
  slug: string;
  name: string;
  conversations: number;
  available: boolean;
}
interface StatsResp {
  summary: {
    users: { total: number; active: number };
    agents: { available: number; total: number };
    conversations_total: number;
    audit_24h: number;
  };
  agents: AgentStat[];
}

interface BenchRunSummary {
  id: string;
  generated_at: string | null;
  n_executed: number;
  n_skipped: number;
  local_avg_score: number | null;
  cloud_avg_score: number | null;
  ratio_local_over_cloud: number | null;
  local_avg_latency_s: number | null;
  cloud_avg_latency_s: number | null;
  by_category: Record<string, { local_avg: number; cloud_avg: number; n: number }>;
}
interface BenchHistoryResp {
  runs: BenchRunSummary[];
  runs_dir: string;
  total: number;
}

interface BenchActiveResp {
  active: Array<{ id: string; started_at: string; pid?: number }>;
}

// ---- Helpers -------------------------------------------------------------

const CATEGORY_ICON: Record<string, string> = {
  accounting: "💰", vision: "👁️", rag: "📚", files: "📄",
  tools: "🔧", compliance: "⚖️", robustness: "🛡️",
};

function pctColor(pct: number | null | undefined): string {
  if (pct == null) return "text-muted";
  if (pct >= 80) return "text-emerald-400";
  if (pct >= 60) return "text-amber-400";
  if (pct >= 30) return "text-orange-400";
  return "text-red-400";
}

function fmtEur(v: number): string {
  return v.toFixed(2).replace(".", ",") + " €";
}

function relTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return "à l'instant";
  if (d < 3_600_000) return `il y a ${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `il y a ${Math.floor(d / 3_600_000)} h`;
  return `il y a ${Math.floor(d / 86_400_000)} j`;
}

// ---- Composant principal -------------------------------------------------

export function BenchDashboard({ isAdmin }: { isAdmin: boolean }) {
  const [cloud, setCloud] = useState<CloudResp | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [health, setHealth] = useState<SystemHealth | null>(null);
  const [stats, setStats] = useState<StatsResp | null>(null);
  const [history, setHistory] = useState<BenchHistoryResp | null>(null);
  const [activeRun, setActiveRun] = useState<BenchActiveResp | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const [c, o, h, s, hi, ar] = await Promise.allSettled([
      fetch("/api/cloud-providers", { cache: "no-store" }),
      fetch("/api/system/ollama-status", { cache: "no-store" }),
      fetch("/api/system/health", { cache: "no-store" }),
      fetch("/api/stats", { cache: "no-store" }),
      fetch("/api/bench/history", { cache: "no-store" }),
      fetch("/api/bench/run", { cache: "no-store" }),
    ]);
    if (c.status === "fulfilled" && c.value.ok) setCloud(await c.value.json());
    if (o.status === "fulfilled" && o.value.ok) setOllama(await o.value.json());
    if (h.status === "fulfilled" && h.value.ok) setHealth(await h.value.json());
    if (s.status === "fulfilled" && s.value.ok) setStats(await s.value.json());
    if (hi.status === "fulfilled" && hi.value.ok) setHistory(await hi.value.json());
    if (ar.status === "fulfilled" && ar.value.ok) setActiveRun(await ar.value.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function startBench(opts: { category?: string; skipCloud?: boolean }) {
    setRunning(true);
    setRunError(null);
    try {
      const r = await fetch("/api/bench/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: opts.category,
          skip_cloud: opts.skipCloud || false,
        }),
      });
      const j = await r.json();
      if (!r.ok) {
        setRunError(j.message || j.error || `HTTP ${r.status}`);
        return;
      }
      // Démarré : on refresh l'état toutes les 10s pour catcher la fin
      await refresh();
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  }

  // ---- Calculs dérivés ---------------------------------------------------

  // Conso cloud ce mois (sum sur tous providers)
  const cloudCost = cloud
    ? Object.values(cloud.state).reduce((a, p) => a + (p.cost_eur_this_month || 0), 0)
    : 0;
  const cloudReqs = cloud
    ? Object.values(cloud.state).reduce((a, p) => a + (p.requests_this_month || 0), 0)
    : 0;
  const budget = cloud?.budget_monthly_eur || 0;
  const budgetPct = budget > 0 ? (cloudCost / budget) * 100 : 0;

  // Conso totale (locale + cloud) — local approximé depuis stats.audit_24h * 30
  // (rough mais montre l'ordre de grandeur).
  const totalReqsApprox = (stats?.summary.conversations_total || 0) + cloudReqs;
  const localReqsApprox = Math.max(0, totalReqsApprox - cloudReqs);

  // Économie vs full-cloud : 0.04€ moyen par requête cloud (moyenne pondérée
  // input/output ~1500 tokens à 0.025€/1K, source: pricing Anthropic).
  const economy = localReqsApprox * 0.04;

  // Top agents (déjà fournis, on prend top 5 conv)
  const topAgents = (stats?.agents || [])
    .filter((a) => a.conversations > 0)
    .sort((a, b) => b.conversations - a.conversations)
    .slice(0, 5);
  const topMax = Math.max(1, ...topAgents.map((a) => a.conversations));

  // Dernier bench
  const lastBench = history?.runs[0];

  // Anomalies inline
  const anomalies: Array<{ severity: "high" | "medium" | "low"; msg: string; }> = [];
  if (health) {
    const downCore = health.services.filter((s) => !s.optional && !s.ok);
    for (const s of downCore) {
      anomalies.push({ severity: "high", msg: `Service core down : ${s.name} (${s.error || "?"})` });
    }
  }
  if (budget > 0 && budgetPct >= 80) {
    anomalies.push({
      severity: budgetPct >= 100 ? "high" : "medium",
      msg: `Budget cloud à ${budgetPct.toFixed(0)}% (${fmtEur(cloudCost)} / ${fmtEur(budget)})`,
    });
  }
  if (lastBench) {
    const ageH = (Date.now() - new Date(lastBench.generated_at || "").getTime()) / 3_600_000;
    if (ageH > 7 * 24) {
      anomalies.push({ severity: "low", msg: `Dernier bench il y a > 7 jours — relancer pour suivre la dérive` });
    }
    if (lastBench.ratio_local_over_cloud != null && lastBench.ratio_local_over_cloud < 0.5) {
      anomalies.push({
        severity: "medium",
        msg: `Score local < 50% du cloud (${(lastBench.ratio_local_over_cloud * 100).toFixed(0)}%) — config Ollama à revoir`,
      });
    }
  }

  // ---- Render ------------------------------------------------------------

  if (loading) {
    return <div className="p-6 text-sm text-muted">Chargement…</div>;
  }

  return (
    <div className="p-6 max-w-6xl mx-auto pb-12 space-y-6">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <BarChart3 size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Bench & observabilité IA</h1>
            <p className="text-sm text-muted">
              Suivi de votre utilisation IA · qualité locale vs cloud · diagnostic infra
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="p-2 rounded text-muted hover:text-foreground hover:bg-muted/20"
          title="Rafraîchir"
        >
          <RefreshCw size={16} />
        </button>
      </header>

      {/* ============================================================
          SECTION 1 — POUR VOUS (admin client)
          ============================================================ */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide mb-3 text-muted">
          📊 Pour vous — votre utilisation ce mois
        </h2>

        {/* KPI cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <KpiCard
            icon={Activity}
            label="Requêtes IA"
            value={String(totalReqsApprox)}
            sub={`dont ${cloudReqs} cloud`}
          />
          <KpiCard
            icon={Cloud}
            label="Coût cloud"
            value={fmtEur(cloudCost)}
            sub={budget > 0 ? `/ ${fmtEur(budget)} (${budgetPct.toFixed(0)}%)` : "pas de budget défini"}
            color={budgetPct >= 80 ? "text-amber-400" : undefined}
          />
          <KpiCard
            icon={TrendingUp}
            label="Économie estimée"
            value={fmtEur(economy)}
            sub="vs scénario full-cloud"
            color="text-emerald-400"
          />
          <KpiCard
            icon={ShieldCheck}
            label="Filtre PII"
            value={cloud?.pii_scrub_enabled ? "ON" : "OFF"}
            sub={cloud?.pii_scrub_enabled ? "RGPD ✓" : "à activer"}
            color={cloud?.pii_scrub_enabled ? "text-emerald-400" : "text-red-400"}
          />
        </div>

        {/* Budget bar */}
        {budget > 0 && (
          <div className="mb-4 p-3 rounded-lg border border-border bg-card">
            <div className="flex justify-between text-xs text-muted mb-1.5">
              <span>Budget cloud mensuel</span>
              <span>{fmtEur(cloudCost)} / {fmtEur(budget)}</span>
            </div>
            <div className="h-2 bg-muted/20 rounded-full overflow-hidden">
              <div
                className={
                  "h-full rounded-full transition-all " +
                  (budgetPct >= 100 ? "bg-red-500" : budgetPct >= 80 ? "bg-amber-500" : "bg-emerald-500")
                }
                style={{ width: `${Math.min(100, budgetPct)}%` }}
              />
            </div>
            {economy > 0 && (
              <p className="text-xs text-muted mt-2">
                💡 Sans l'IA locale, vous auriez payé approximativement <strong>{fmtEur(cloudCost + economy)}</strong> ce mois.
                Économie estimée : <strong className="text-emerald-400">{fmtEur(economy)}</strong>.
              </p>
            )}
          </div>
        )}

        {/* Top agents */}
        {topAgents.length > 0 && (
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border text-sm font-medium flex items-center gap-2">
              <Bot size={14} className="text-muted" />
              Top {topAgents.length} agents (toutes conversations)
            </div>
            <div className="divide-y divide-border">
              {topAgents.map((a, i) => (
                <div key={a.slug} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <span className="text-xs text-muted w-4 text-right">#{i + 1}</span>
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  <div className="w-40 h-1.5 rounded-full bg-muted/20 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(a.conversations / topMax) * 100}%` }}
                    />
                  </div>
                  <span className="tabular-nums text-xs text-muted w-12 text-right">
                    {a.conversations}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ============================================================
          SECTION 2 — QUALITÉ (dernier bench)
          ============================================================ */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide mb-3 text-muted flex items-center gap-2">
          <Sparkles size={12} className="text-primary" />
          Qualité — bench local vs cloud
        </h2>

        <div className="rounded-lg border border-border bg-card p-4">
          {/* Toolbar */}
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <div className="text-sm">
              {lastBench ? (
                <>
                  <span className="text-muted">Dernier run : </span>
                  <span className="font-medium">{lastBench.id}</span>
                  <span className="text-muted ml-2">
                    · {lastBench.generated_at ? relTime(lastBench.generated_at) : "?"}
                    · {lastBench.n_executed} prompts
                  </span>
                </>
              ) : (
                <span className="text-muted italic">Aucun bench joué pour l'instant.</span>
              )}
            </div>
            {isAdmin && (
              <div className="flex items-center gap-2">
                {activeRun && activeRun.active.length > 0 ? (
                  <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-amber-500/15 text-amber-400">
                    <RefreshCw size={11} className="animate-spin" />
                    Run en cours ({activeRun.active[0].id})
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => startBench({ category: "accounting", skipCloud: false })}
                      disabled={running}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-muted/20 hover:bg-muted/30 transition-default disabled:opacity-50"
                      title="5 prompts comptabilité, ~5 min"
                    >
                      <Play size={11} /> Bench rapide (compta, ~5 min)
                    </button>
                    <button
                      onClick={() => startBench({})}
                      disabled={running}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded bg-primary text-primary-foreground hover:opacity-90 transition-default disabled:opacity-50"
                      title="30 prompts toutes catégories, ~30 min"
                    >
                      <Play size={11} /> Bench complet (~30 min)
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {runError && (
            <div className="mb-3 px-3 py-2 rounded text-xs bg-red-500/10 border border-red-500/30 text-red-400">
              {runError}
            </div>
          )}

          {lastBench ? (
            <>
              {/* Score global */}
              <div className="grid grid-cols-3 gap-3 mb-4">
                <div className="rounded border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Local moyen</div>
                  <div className={"text-2xl font-semibold tabular-nums " + pctColor(lastBench.local_avg_score)}>
                    {lastBench.local_avg_score?.toFixed(1) ?? "—"}%
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    latence moy {lastBench.local_avg_latency_s?.toFixed(1) ?? "—"}s
                  </div>
                </div>
                <div className="rounded border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Cloud moyen (référence)</div>
                  <div className={"text-2xl font-semibold tabular-nums " + pctColor(lastBench.cloud_avg_score)}>
                    {lastBench.cloud_avg_score?.toFixed(1) ?? "—"}%
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    latence moy {lastBench.cloud_avg_latency_s?.toFixed(1) ?? "—"}s
                  </div>
                </div>
                <div className="rounded border border-border p-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Ratio local / cloud</div>
                  <div className={"text-2xl font-semibold tabular-nums " + pctColor((lastBench.ratio_local_over_cloud || 0) * 100)}>
                    {((lastBench.ratio_local_over_cloud || 0) * 100).toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    {((lastBench.ratio_local_over_cloud || 0) >= 0.7) ? "✓ local OK" : "⚠ local en retrait"}
                  </div>
                </div>
              </div>

              {/* Par catégorie */}
              {Object.keys(lastBench.by_category).length > 0 && (
                <div className="rounded border border-border overflow-hidden">
                  <div className="px-3 py-2 border-b border-border text-xs font-medium text-muted">
                    Détail par catégorie
                  </div>
                  <div className="divide-y divide-border">
                    {Object.entries(lastBench.by_category).map(([cat, d]) => {
                      const delta = d.local_avg - d.cloud_avg;
                      return (
                        <div key={cat} className="px-3 py-2 flex items-center gap-3 text-xs">
                          <span className="w-32">{CATEGORY_ICON[cat] || "•"} {cat} <span className="text-muted">({d.n})</span></span>
                          <span className={"w-14 tabular-nums text-right " + pctColor(d.local_avg)}>{d.local_avg.toFixed(0)}%</span>
                          <span className="text-muted">vs</span>
                          <span className={"w-14 tabular-nums text-right " + pctColor(d.cloud_avg)}>{d.cloud_avg.toFixed(0)}%</span>
                          <span className={"w-12 tabular-nums text-right " + (delta >= -10 ? "text-emerald-400" : "text-red-400")}>
                            {delta >= 0 ? "+" : ""}{delta.toFixed(0)}
                          </span>
                          <div className="flex-1 h-1.5 bg-muted/20 rounded-full overflow-hidden">
                            <div
                              className={"h-full rounded-full " + (delta >= -10 ? "bg-emerald-500" : "bg-red-500")}
                              style={{ width: `${Math.min(100, d.local_avg)}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Historique */}
              {history && history.runs.length > 1 && (
                <div className="mt-3">
                  <div className="text-[10px] uppercase tracking-wide text-muted mb-1.5">
                    Historique ({history.runs.length} runs au total)
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {history.runs.slice(0, 10).map((r) => (
                      <span
                        key={r.id}
                        className="text-[10px] px-2 py-0.5 rounded bg-muted/15 text-muted font-mono"
                        title={`${r.id} · ${r.generated_at}`}
                      >
                        {r.id.slice(8, 14)} · {r.local_avg_score?.toFixed(0)}/{r.cloud_avg_score?.toFixed(0)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-sm text-muted py-4 text-center">
              Lancez un bench pour comparer la qualité de l'IA locale (qwen3:14b)
              avec le cloud (Anthropic Claude). 30 prompts couvrant comptabilité,
              vision, RAG, génération de fichiers, conformité FR…
            </div>
          )}
        </div>
      </section>

      {/* ============================================================
          SECTION 3 — DIAGNOSTIC INFRA (admin only)
          ============================================================ */}
      {isAdmin && (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide mb-3 text-muted">
            🔧 Diagnostic infra (admin BoxIA gestionnaire)
          </h2>

          {/* Anomalies */}
          {anomalies.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 mb-2 text-sm font-medium text-amber-400">
                <AlertTriangle size={14} /> {anomalies.length} anomalie{anomalies.length > 1 ? "s" : ""} détectée{anomalies.length > 1 ? "s" : ""}
              </div>
              <ul className="space-y-1 text-xs">
                {anomalies.map((a, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={
                      a.severity === "high" ? "text-red-400"
                      : a.severity === "medium" ? "text-amber-400"
                      : "text-muted"
                    }>●</span>
                    <span>{a.msg}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {anomalies.length === 0 && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 flex items-center gap-2 text-sm text-emerald-400">
              <CheckCircle2 size={14} /> Aucune anomalie détectée
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            {/* Ollama VRAM */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <Cpu size={14} className="text-primary" /> Modèles chargés en VRAM
                {ollama && (
                  <span className="text-xs text-muted ml-auto">
                    {ollama.loaded.length} actif{ollama.loaded.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              {ollama?.loaded.length === 0 ? (
                <p className="text-xs text-muted">Aucun modèle chargé. Le 1ᵉʳ chat va déclencher un cold-start ~5-10s.</p>
              ) : (
                <ul className="space-y-1 text-xs font-mono">
                  {ollama?.loaded.map((m) => (
                    <li key={m.name} className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="flex-1 truncate">{m.name}</span>
                      <span className="text-muted tabular-nums">{(m.size_mb / 1024).toFixed(1)} GB</span>
                      <span className="text-muted text-[10px]">{m.processor}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Conformité RGPD */}
            <div className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2 text-sm font-medium mb-2">
                <ShieldCheck size={14} className="text-primary" /> Conformité RGPD
              </div>
              <ul className="space-y-1.5 text-xs">
                <li className="flex justify-between">
                  <span className="text-muted">Filtre PII</span>
                  <span className={cloud?.pii_scrub_enabled ? "text-emerald-400" : "text-red-400"}>
                    {cloud?.pii_scrub_enabled ? "ON" : "OFF (déconseillé)"}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Requêtes envoyées au cloud (mois)</span>
                  <span className="tabular-nums">{cloudReqs}</span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Providers actifs</span>
                  <span>
                    {cloud
                      ? Object.entries(cloud.state).filter(([, p]) => p.configured).map(([k]) => k).join(", ") || "aucun"
                      : "—"}
                  </span>
                </li>
                <li className="flex justify-between">
                  <span className="text-muted">Coût total mois</span>
                  <span className="tabular-nums">{fmtEur(cloudCost)}</span>
                </li>
              </ul>
            </div>

            {/* Services backend */}
            {health && (
              <div className="rounded-lg border border-border bg-card p-3 md:col-span-2">
                <div className="flex items-center gap-2 text-sm font-medium mb-2">
                  <Server size={14} className="text-primary" /> Services backend
                  <span className={
                    "ml-auto text-xs " +
                    (health.overall === "ok" ? "text-emerald-400"
                     : health.overall === "down" ? "text-red-400" : "text-amber-400")
                  }>
                    {health.summary.up}/{health.summary.total} up
                  </span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5 text-xs">
                  {health.services.map((s) => (
                    <div key={s.key} className="flex items-center gap-1.5 px-2 py-1 rounded bg-muted/10">
                      <span className={
                        "w-1.5 h-1.5 rounded-full " +
                        (s.ok ? "bg-emerald-500"
                         : s.optional ? "bg-muted" : "bg-red-500")
                      } />
                      <span className={s.optional && !s.ok ? "text-muted" : ""}>{s.name}</span>
                      {s.optional && !s.ok && <span className="text-[9px] text-muted ml-auto">opt.</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Audit log link */}
            <div className="rounded-lg border border-border bg-card p-3 md:col-span-2">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Calendar size={14} className="text-muted" />
                  <span className="text-muted">Actions auditées 24h :</span>
                  <span className="font-medium">{stats?.summary.audit_24h ?? 0}</span>
                </div>
                <a href="/audit" className="text-xs text-primary hover:underline">Voir le journal complet →</a>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

function KpiCard({
  icon: Icon, label, value, sub, color,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={12} className="text-muted" />
        <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      </div>
      <div className={"text-2xl font-semibold tabular-nums leading-none " + (color || "")}>{value}</div>
      {sub && <div className="text-[10px] text-muted mt-1">{sub}</div>}
    </div>
  );
}
