"use client";

/**
 * /system — Dashboard admin avec KPIs + activité récente.
 *
 * Source : /api/stats (agrégation côté serveur de Authentik + Dify +
 * connectors state + audit applicatif). Auto-refresh toutes les 60 s.
 */
import {
  Activity, Users, Bot, MessageSquare, FileText, Plug,
  RefreshCw, AlertCircle, Cpu, MemoryStick, HardDrive, Zap,
  CheckCircle2, XCircle, Server,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface AgentStat {
  slug: string;
  name: string;
  conversations: number;
  available: boolean;
}
interface StatsResponse {
  summary: {
    users: { total: number; active: number };
    agents: { available: number; total: number };
    conversations_total: number;
    documents_total: number;
    connectors_active: number;
    audit_24h: number;
  };
  agents: AgentStat[];
  actions_24h: Record<string, number>;
  last_events: Array<{
    ts: number; actor: string; action: string; target?: string;
  }>;
}

interface Metrics {
  cpu_pct: number | null;
  ram_pct: number | null;
  disk_pct: number | null;
  gpu_pct: number | null;
}

interface HealthService {
  key: string;
  name: string;
  ok: boolean;
  latency_ms: number | null;
  status?: number;
  error?: string;
  version?: string;
  optional?: boolean;
}
interface HealthResponse {
  overall: "ok" | "degraded" | "down";
  summary: { total: number; up: number; down: number };
  services: HealthService[];
  checked_at: string;
}

function fmt(n: number): string { return n.toLocaleString("fr-FR"); }

function relTime(ts: number): string {
  const ms = Date.now() - ts;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

export function SystemDashboard() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch("/api/stats", { cache: "no-store" }),
        fetch("/api/system/metrics", { cache: "no-store" }),
        fetch("/api/system/health", { cache: "no-store" }),
      ]);
      if (r1.status === 403) { setForbidden(true); return; }
      if (r1.ok) setStats(await r1.json());
      else setError("Stats indisponibles");
      if (r2.ok) setMetrics(await r2.json());
      if (r3.ok) setHealth(await r3.json());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (forbidden) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <AlertCircle size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            Le tableau de bord système est réservé aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Activity size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">État du serveur</h1>
            <p className="text-sm text-muted">
              Vue d'ensemble · auto-rafraîchi toutes les minutes
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

      {error && !forbidden && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* Services backend (Dify, Ollama, Authentik, n8n, Prometheus) */}
      {health && (() => {
        // Optional sidecars that are down (feature OFF). On les compte
        // pour l'affichage du label "X service(s) optionnel(s) inactif(s)"
        // afin que le statut global ne contredise pas la liste.
        const optionalDown = health.services.filter((s) => s.optional && !s.ok);
        const optionalDownCount = optionalDown.length;
        return (
        <Section title="Services backend">
          <div className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2 text-sm">
              <OverallDot overall={health.overall} />
              <span className="font-medium">
                {health.overall === "ok"
                  ? optionalDownCount > 0
                    ? `Services principaux opérationnels (${optionalDownCount} service${optionalDownCount > 1 ? "s" : ""} optionnel${optionalDownCount > 1 ? "s" : ""} inactif${optionalDownCount > 1 ? "s" : ""})`
                    : "Tous les services sont opérationnels"
                  : health.overall === "down"
                  ? "Tous les services sont injoignables"
                  : `${health.summary.up}/${health.summary.total} services opérationnels`}
              </span>
              <span className="flex-1" />
              <span className="text-[10px] text-muted">
                {new Date(health.checked_at).toLocaleTimeString("fr-FR", {
                  hour: "2-digit", minute: "2-digit", second: "2-digit",
                })}
              </span>
            </div>
            <div className="divide-y divide-border">
              {health.services.map((s) => (
                <ServiceRow key={s.key} svc={s} />
              ))}
            </div>
          </div>
        </Section>
        );
      })()}

      {/* Ressources hardware */}
      <Section title="Ressources">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <ResourceCard icon={Cpu}        label="CPU"  value={metrics?.cpu_pct} hue="var(--primary)" />
          <ResourceCard icon={MemoryStick} label="RAM"  value={metrics?.ram_pct} hue="var(--accent)" />
          <ResourceCard icon={HardDrive}  label="Disque" value={metrics?.disk_pct} hue="270 80% 65%" />
          <ResourceCard icon={Zap}        label="GPU" value={metrics?.gpu_pct} hue="330 85% 65%" />
        </div>
      </Section>

      {/* Inférence locale (Ollama) — détaillé : modèles chargés + GPU vs CPU */}
      <Section title="Inférence locale (Ollama)">
        <InferenceCard />
      </Section>

      {/* KPI cards */}
      <Section title="Activité">
        {loading ? <Loading /> : stats ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard
              icon={Users}
              label="Utilisateurs"
              value={fmt(stats.summary.users.active)}
              suffix={` / ${stats.summary.users.total}`}
              hint="actifs / total"
            />
            <KpiCard
              icon={Bot}
              label="Assistants"
              value={fmt(stats.summary.agents.available)}
              suffix={` / ${stats.summary.agents.total}`}
              hint="opérationnels"
            />
            <KpiCard
              icon={MessageSquare}
              label="Conversations"
              value={fmt(stats.summary.conversations_total)}
              hint="total (admin)"
            />
            <KpiCard
              icon={FileText}
              label="Documents"
              value={fmt(stats.summary.documents_total)}
              hint="dans la KB"
            />
            <KpiCard
              icon={Plug}
              label="Connecteurs"
              value={fmt(stats.summary.connectors_active)}
              hint="actifs"
            />
            <KpiCard
              icon={Activity}
              label="Actions 24 h"
              value={fmt(stats.summary.audit_24h)}
              hint="audit applicatif"
            />
          </div>
        ) : null}
      </Section>

      {/* Conversations par agent */}
      {stats && stats.agents.length > 0 && (
        <Section title="Conversations par agent">
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {stats.agents.map((a) => {
              const max = Math.max(...stats.agents.map((x) => x.conversations), 1);
              const pct = (a.conversations / max) * 100;
              return (
                <div key={a.slug} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                  <span className="flex-1 min-w-0 truncate">{a.name}</span>
                  <div className="w-40 h-1.5 rounded-full bg-muted/20 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="tabular-nums text-xs text-muted w-10 text-right">
                    {a.conversations}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Activité 24h par action */}
      {stats && Object.keys(stats.actions_24h).length > 0 && (
        <Section title="Actions des dernières 24 heures">
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {Object.entries(stats.actions_24h)
              .sort((a, b) => b[1] - a[1])
              .map(([action, count]) => (
                <div key={action} className="px-4 py-2 flex items-center gap-3 text-sm">
                  <code className="text-xs text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                    {action}
                  </code>
                  <span className="flex-1" />
                  <span className="tabular-nums text-xs text-foreground">
                    {count}
                  </span>
                </div>
              ))}
          </div>
        </Section>
      )}

      {/* Dernières actions */}
      {stats && stats.last_events.length > 0 && (
        <Section title="Dernières actions">
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {stats.last_events.map((ev, i) => (
              <div key={`${ev.ts}-${i}`}
                   className="px-4 py-2 flex items-center gap-3 text-sm text-muted">
                <code className="text-xs text-muted bg-muted/15 px-1.5 py-0.5 rounded">
                  {ev.action}
                </code>
                <span className="flex-1 min-w-0 truncate">
                  {ev.actor} {ev.target ? `· ${ev.target}` : ""}
                </span>
                <span className="text-[10px] whitespace-nowrap">{relTime(ev.ts)}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Loading() {
  return (
    <div className="text-center text-sm text-muted py-6">Chargement…</div>
  );
}

function KpiCard({
  icon: Icon, label, value, suffix, hint,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  suffix?: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={12} className="text-muted" />
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {label}
        </span>
      </div>
      <div className="text-2xl font-semibold tabular-nums leading-none">
        {value}
        {suffix && <span className="text-sm text-muted font-normal">{suffix}</span>}
      </div>
      {hint && <div className="text-[10px] text-muted mt-1">{hint}</div>}
    </div>
  );
}

function OverallDot({ overall }: { overall: "ok" | "degraded" | "down" }) {
  if (overall === "ok") {
    return (
      <span className="relative inline-flex">
        <span className="w-2.5 h-2.5 rounded-full bg-accent" />
        <span className="absolute inset-0 w-2.5 h-2.5 rounded-full bg-accent animate-ping opacity-60" />
      </span>
    );
  }
  if (overall === "degraded") {
    return <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />;
  }
  return <span className="w-2.5 h-2.5 rounded-full bg-red-500" />;
}

function ServiceRow({ svc }: { svc: HealthService }) {
  // Pour un service optionnel down, on baisse la dramatisation visuelle :
  // c'est un sidecar feature-flag qu'on n'a juste pas activé pour ce
  // déploiement, pas un vrai problème.
  const isOptionalDown = svc.optional && !svc.ok;
  const Icon = svc.ok ? CheckCircle2 : isOptionalDown ? Server : XCircle;
  const color = svc.ok
    ? "text-accent"
    : isOptionalDown
    ? "text-muted"
    : "text-red-400";
  return (
    <div className="px-4 py-2.5 flex items-center gap-3 text-sm">
      <Server size={14} className="text-muted shrink-0" />
      <span className={"font-medium " + (isOptionalDown ? "text-muted" : "")}>
        {svc.name}
      </span>
      {svc.version && (
        <span className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
          v{svc.version}
        </span>
      )}
      {svc.optional && (
        <span className="text-[10px] text-muted bg-muted/15 px-1.5 py-0.5 rounded">
          optionnel
        </span>
      )}
      <span className="flex-1" />
      {svc.ok && svc.latency_ms != null && (
        <span className="text-[10px] tabular-nums text-muted">
          {svc.latency_ms} ms
        </span>
      )}
      {!svc.ok && svc.error && (
        <span
          className={
            "text-[10px] truncate max-w-[200px] " +
            (isOptionalDown ? "text-muted" : "text-red-400")
          }
          title={svc.error}
        >
          {isOptionalDown ? "non activé" : svc.error}
        </span>
      )}
      <Icon size={16} className={color + " shrink-0"} />
    </div>
  );
}

function ResourceCard({
  icon: Icon, label, value, hue,
}: {
  icon: typeof Users;
  label: string;
  value?: number | null;
  hue: string;
}) {
  const v = typeof value === "number" ? value : null;
  const colorCls = v == null ? "text-muted"
                 : v >= 80 ? "text-red-400"
                 : v >= 60 ? "text-yellow-400"
                 : "";
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={12} className="text-muted" />
        <span className="text-[10px] uppercase tracking-wide text-muted">
          {label}
        </span>
      </div>
      <div
        className={"text-2xl font-semibold tabular-nums leading-none " + colorCls}
        style={!colorCls && v != null ? { color: `hsl(${hue})` } : undefined}
      >
        {v != null ? `${v.toFixed(1)}%` : "—"}
      </div>
      {v != null && (
        <div className="mt-2 h-1 rounded-full bg-muted/20 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min(100, v)}%`,
              background: `hsl(${hue})`,
            }}
          />
        </div>
      )}
    </div>
  );
}

// =============================================================================
// InferenceCard — détail Ollama : modèles chargés, processeur (GPU/CPU), VRAM
// =============================================================================
//
// Affiche en clair :
//   - Combien de modèles sont en mémoire
//   - Pour chacun : nom, taille, taille en VRAM, processeur (100% GPU /
//     hybride / 100% CPU avec ALERTE)
//   - Une bannière rouge si AU MOINS UN modèle tourne en CPU pur ou hybride
//     (= GPU absent ou saturé). Le user TPE voit immédiatement qu'il y a un
//     problème de perf et doit agir (vérifier nvidia-container-toolkit, etc.)
//
// Source : /api/system/ollama-status (poll 10s).

type InferenceProcessorMode = "gpu" | "cpu" | "hybrid" | "unknown";
interface LoadedModel {
  name: string;
  size_mb: number;
  size_vram_mb: number;
  parameter_size?: string;
  processor: string;
  processor_mode: InferenceProcessorMode;
  gpu_pct: number;
  expires_at?: string;
}
interface OllamaStatus {
  ok: boolean;
  loaded: LoadedModel[];
  global_mode: InferenceProcessorMode;
  warning: string | null;
  error?: string;
}

function InferenceCard() {
  const [status, setStatus] = useState<OllamaStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/system/ollama-status", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as OllamaStatus;
        setStatus(j);
      } catch { /* silent */ }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!status) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <Loading />
      </div>
    );
  }

  if (!status.ok) {
    return (
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start gap-2 text-sm text-muted">
          <AlertCircle size={16} className="mt-0.5 text-amber-400 shrink-0" />
          <div>
            <div className="font-medium text-foreground">Ollama injoignable</div>
            <div className="mt-1 text-xs">
              {status.error || "Le service Ollama ne répond pas."} Vérifier que le container
              `ollama` est démarré et que <code>OLLAMA_BASE_URL</code> pointe au bon endroit.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const noModel = status.loaded.length === 0;

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Bannière warning si CPU/hybride */}
      {status.warning && (
        <div
          className={
            "px-4 py-3 text-sm border-b " +
            (status.global_mode === "cpu"
              ? "bg-red-500/10 border-red-500/30 text-red-300"
              : "bg-amber-500/10 border-amber-500/30 text-amber-300")
          }
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold">
                {status.global_mode === "cpu"
                  ? "🔴 ALERTE : Inférence sur CPU uniquement"
                  : "⚠ Offload partiel CPU"}
              </div>
              <div className="mt-1 text-xs whitespace-pre-line">{status.warning}</div>
              {status.global_mode === "cpu" && (
                <div className="mt-2 text-xs">
                  <strong>Action :</strong> vérifier que le container Ollama a accès au GPU :
                  <code className="ml-1 bg-black/30 px-1.5 py-0.5 rounded">
                    docker inspect ollama | grep -i nvidia
                  </code>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Liste des modèles loaded */}
      {noModel ? (
        <div className="p-5 text-sm text-muted">
          Aucun modèle local chargé pour l&apos;instant. Le 1er chat va déclencher un
          cold-start (~5-10 s). Les modèles sont déchargés automatiquement après 24 h
          d&apos;inactivité (env <code>OLLAMA_KEEP_ALIVE</code>).
        </div>
      ) : (
        <div className="divide-y divide-border">
          {status.loaded.map((m) => {
            const modeColor =
              m.processor_mode === "gpu"
                ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                : m.processor_mode === "hybrid"
                  ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                  : m.processor_mode === "cpu"
                    ? "text-red-400 bg-red-500/10 border-red-500/30"
                    : "text-muted bg-muted/10 border-muted/30";
            return (
              <div key={m.name} className="px-5 py-4 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium truncate">
                      {m.name}
                    </span>
                    {m.parameter_size && (
                      <span className="text-[10px] text-muted px-1.5 py-0.5 rounded bg-muted/20">
                        {m.parameter_size}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted tabular-nums">
                    Taille modèle : {(m.size_mb / 1024).toFixed(1)} GB ·
                    En VRAM : {(m.size_vram_mb / 1024).toFixed(1)} GB
                  </div>
                </div>
                <div
                  className={`text-xs font-mono font-semibold px-2.5 py-1 rounded border ${modeColor}`}
                >
                  {m.processor}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Footer info */}
      <div className="px-4 py-2 text-[11px] text-muted bg-muted/5 border-t border-border flex items-center justify-between">
        <span>
          {status.loaded.length} modèle{status.loaded.length > 1 ? "s" : ""} chargé
          {status.loaded.length > 1 ? "s" : ""}
        </span>
        <span>
          Refresh toutes les 10 s ·
          <span className={status.global_mode === "gpu" ? "text-emerald-400 ml-1" : "text-muted ml-1"}>
            mode global : <strong>{status.global_mode.toUpperCase()}</strong>
          </span>
        </span>
      </div>
    </div>
  );
}
