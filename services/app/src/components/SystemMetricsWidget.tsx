"use client";

/**
 * Mini-graphiques (sparklines) en temps réel pour CPU / RAM / Disque / GPU.
 *
 * - Polling /api/system/metrics toutes les 5 s
 * - Historique gardé en mémoire : 60 derniers points (= 5 min)
 * - Rendu SVG inline (aucune dépendance externe)
 * - Couleur par métrique, dégradé subtil sous la courbe
 * - Valeur courante affichée en chiffre à côté
 */

import { useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, HardDrive, Zap, Cloud, type LucideIcon } from "lucide-react";
import { ProviderLogo, PROVIDER_LABELS } from "@/lib/cloud-provider-logos";
import type { CloudProviderId } from "@/lib/cloud-providers";

const HISTORY_LEN = 60;        // 60 points × 5 s = 5 min
const POLL_MS     = 5000;

interface Metrics {
  cpu_pct: number | null;
  ram_pct: number | null;
  disk_pct: number | null;
  gpu_pct: number | null;
  gpu_mem_pct: number | null;
}

interface MetricSeries {
  cpu: (number | null)[];
  ram: (number | null)[];
  disk: (number | null)[];
  gpu: (number | null)[];
}

const EMPTY_SERIES: MetricSeries = { cpu: [], ram: [], disk: [], gpu: [] };

/** Couleur du chiffre courant, en seuil charge.
 *  Couleur "normale" passée via inline style (depuis le hue HSL),
 *  warning / critical statiques (Tailwind ne peut pas générer
 *  d'arbitrary values à partir d'expressions runtime). */
function thresholdClass(value: number | null): string | null {
  if (value == null) return "text-muted";
  if (value >= 80) return "text-red-400";
  if (value >= 60) return "text-yellow-400";
  return null; // → on appliquera la couleur du hue via style
}

interface SparkProps {
  values: (number | null)[];
  current: number | null;
  width?: number;
  height?: number;
  /** Couleur principale (HSL — ex 217 91% 60% pour blue-500). */
  hue: string;
}

/** Mini-graphique SVG : ligne + dégradé sous la courbe. */
function Sparkline({ values, current, width = 56, height = 20, hue }: SparkProps) {
  // On pad à gauche avec des nulls si on n'a pas encore HISTORY_LEN points,
  // pour que la courbe pousse de droite à gauche au démarrage.
  const padded = values.length < HISTORY_LEN
    ? [...Array(HISTORY_LEN - values.length).fill(null), ...values]
    : values.slice(-HISTORY_LEN);

  const step = width / (HISTORY_LEN - 1 || 1);
  const yFor = (v: number) => height - (Math.max(0, Math.min(100, v)) / 100) * height;

  // Construit le path : on saute les nulls (pas de tracé), on commence à
  // chaque retour de valeur avec un M.
  let path = "";
  let started = false;
  for (let i = 0; i < padded.length; i++) {
    const v = padded[i];
    if (v == null) { started = false; continue; }
    const x = i * step;
    const y = yFor(v);
    path += (started ? " L " : " M ") + x.toFixed(1) + " " + y.toFixed(1);
    started = true;
  }

  // Polygon de fill sous la courbe (uniquement pour les segments contigus).
  // Pour rester simple, on fait un seul polygone avec les valeurs valides
  // de la fin (le cas typique où on a une série continue récente).
  const lastIdx = padded.findIndex((v, i) =>
    v != null && padded.slice(i).every((x) => x != null),
  );
  let fillPath = "";
  if (lastIdx >= 0 && lastIdx < padded.length - 1) {
    const xStart = lastIdx * step;
    fillPath = `M ${xStart} ${height} `;
    for (let i = lastIdx; i < padded.length; i++) {
      const v = padded[i] ?? 0;
      fillPath += `L ${(i * step).toFixed(1)} ${yFor(v).toFixed(1)} `;
    }
    fillPath += `L ${(padded.length - 1) * step} ${height} Z`;
  }

  // Si vraiment aucune donnée, on rend une ligne plate centrée pour
  // éviter le "vide" pendant le tout 1er load.
  const empty = padded.every((v) => v == null);

  const gradId = `spark-grad-${hue.replace(/\s/g, "")}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      style={{ overflow: "visible" }}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%"  stopColor={`hsl(${hue})`} stopOpacity="0.35" />
          <stop offset="100%" stopColor={`hsl(${hue})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      {empty ? (
        <line
          x1={0} y1={height / 2} x2={width} y2={height / 2}
          stroke="hsl(var(--muted))" strokeWidth="1" strokeDasharray="2 2"
          opacity="0.5"
        />
      ) : (
        <>
          {fillPath && <path d={fillPath} fill={`url(#${gradId})`} />}
          {path && (
            <path
              d={path}
              fill="none"
              stroke={`hsl(${hue})`}
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {current != null && (
            <circle
              cx={(padded.length - 1) * step}
              cy={yFor(current)}
              r="1.8"
              fill={`hsl(${hue})`}
            />
          )}
        </>
      )}
    </svg>
  );
}

interface MetricRowProps {
  icon: LucideIcon;
  label: string;
  values: (number | null)[];
  current: number | null;
  hue: string;
}

function MetricRow({ icon: Icon, label, values, current, hue }: MetricRowProps) {
  const cls = thresholdClass(current);
  const inlineColor = cls === null ? { color: `hsl(${hue})` } : undefined;

  // tooltip min/max/avg sur les dernières valeurs
  const valid = values.filter((v): v is number => v != null);
  const mn = valid.length ? Math.min(...valid).toFixed(0) : "—";
  const mx = valid.length ? Math.max(...valid).toFixed(0) : "—";
  const avg = valid.length
    ? (valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(0)
    : "—";
  const tip =
    `${label} : ${current != null ? current.toFixed(1) : "—"} %\n` +
    `5 min : min ${mn}% · moy ${avg}% · max ${mx}%`;

  return (
    <div className="flex items-center gap-1.5 text-xs" title={tip}>
      <Icon size={12} className="text-muted shrink-0" />
      <span className="text-muted hidden md:inline">{label}</span>
      <Sparkline values={values} current={current} hue={hue} />
      <span
        className={`tabular-nums w-8 text-right ${cls || ""}`}
        style={inlineColor}
      >
        {current != null ? `${current.toFixed(0)}%` : "—"}
      </span>
    </div>
  );
}

/** Liste compacte des providers cloud configurés, à droite des sparklines.
 *  Vert → configuré (clé OK) ; gris → pas configuré. Hover = tooltip avec
 *  modèles activés et coût mensuel actuel.
 *
 *  Demande user 2026-05-03 : "lorsqu'une IA cloud est paramétrée, voir
 *  son icône en mode On (vert) au niveau des graphiques de consommation".
 */
/** Badge "IA locale" : affiche le modèle Ollama actuellement chargé en VRAM
 *  + son occupation mémoire + un point vert pulse "Active". Permet à
 *  l'utilisateur de voir d'un coup d'œil :
 *    - Si l'IA locale est prête (modèle loadé)
 *    - Quel modèle est en mémoire (qwen3:14b vs qwen2.5vl:7b)
 *    - Combien de VRAM est consommée
 *
 *  Demande user 2026-05-03 : "élément visuel dans la barre en haut avec
 *  les suivi des perf de l'IA LOCAL". Symétrique à CloudProvidersBadges.
 */
function LocalAiBadge() {
  const [info, setInfo] = useState<{
    loaded: Array<{ name: string; size_mb: number; processor: string }>;
    refreshed_at: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/system/ollama-status", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const j = await r.json();
        setInfo({ loaded: j.loaded || [], refreshed_at: Date.now() });
      } catch { /* silent */ }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (!info) return null;
  const isReady = info.loaded.length > 0;
  const totalVramMb = info.loaded.reduce((a, m) => a + (m.size_mb || 0), 0);

  // Modèle texte principal = celui qui n'est pas embedding (bge-*)
  const mainModel = info.loaded.find(
    (m) => !m.name.startsWith("bge") && !m.name.startsWith("nomic"),
  ) || info.loaded[0];

  return (
    <div
      className="hidden lg:flex items-center gap-1.5 px-3 border-l border-border"
      title={
        isReady
          ? `IA locale active — ${info.loaded.length} modèle(s) chargé(s) :\n` +
            info.loaded.map((m) =>
              `  • ${m.name} : ${(m.size_mb / 1024).toFixed(1)} GB (${m.processor})`,
            ).join("\n")
          : "Aucun modèle local chargé. Le 1er chat va déclencher un cold-start ~5-10s."
      }
    >
      <span
        className={
          "inline-block w-2 h-2 rounded-full " +
          (isReady
            ? "bg-emerald-500 ring-2 ring-emerald-500/30 animate-pulse"
            : "bg-muted")
        }
        aria-hidden
      />
      <span className="text-xs text-muted">Local</span>
      {mainModel && (
        <>
          <span className="text-xs font-medium text-foreground/80 truncate max-w-[8em]">
            {mainModel.name}
          </span>
          <span className="text-[10px] text-muted tabular-nums">
            {(totalVramMb / 1024).toFixed(1)}G
          </span>
        </>
      )}
    </div>
  );
}

/** Health status d'un provider — version client (logique inlinée pour éviter
 *  d'importer @/lib/cloud-providers qui contient des modules node:fs). */
type ProviderHealth = "ok" | "warning" | "error" | "idle";

interface ClientProviderState {
  id: CloudProviderId;
  configured: boolean;
  cost_eur_this_month?: number;
  requests_this_month?: number;
  last_success_at?: number;
  last_error?: { at: number; status: number; code: string; message: string };
}

function computeHealthClient(
  p: ClientProviderState,
  budgetMonthly: number,
  totalUsage: number,
): ProviderHealth {
  if (!p.configured) return "idle";
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;
  if (p.last_error) {
    const ageMs = now - p.last_error.at;
    const isCritical = ["invalid_api_key", "insufficient_credits"].includes(p.last_error.code);
    if (ageMs < FIVE_MIN && isCritical) return "error";
    if (ageMs < FIVE_MIN) return "warning";
    if (ageMs < THIRTY_MIN) return "warning";
  }
  if (budgetMonthly > 0) {
    const usagePct = totalUsage / budgetMonthly;
    if (usagePct >= 1) return "error";
    if (usagePct >= 0.8) return "warning";
  }
  if (!p.last_success_at) return "idle";
  return "ok";
}

/** Map health → classes Tailwind (ring + background + couleur icône) */
const HEALTH_STYLES: Record<ProviderHealth, string> = {
  ok:       "bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40",
  warning:  "bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/50 animate-pulse",
  error:    "bg-red-500/20 text-red-400 ring-1 ring-red-500/60 animate-pulse",
  idle:     "bg-muted/20 text-muted ring-1 ring-border",
};

const HEALTH_LABEL: Record<ProviderHealth, string> = {
  ok:       "Opérationnel",
  warning:  "Attention",
  error:    "En erreur",
  idle:     "Configuré (jamais utilisé)",
};

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "à l'instant";
  if (diff < 3_600_000) return `il y a ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `il y a ${Math.floor(diff / 3_600_000)} h`;
  return `il y a ${Math.floor(diff / 86_400_000)} j`;
}

function buildTooltip(
  p: ClientProviderState,
  health: ProviderHealth,
  budgetMonthly: number,
  totalUsage: number,
): string {
  const lines: string[] = [];
  lines.push(`${PROVIDER_LABELS[p.id]} — ${HEALTH_LABEL[health]}`);
  if (!p.configured) {
    lines.push("Clé API non configurée. Va dans /settings → Providers cloud.");
    return lines.join("\n");
  }
  if (p.last_success_at) {
    lines.push(`✓ Dernier appel OK : ${formatRelativeTime(p.last_success_at)}`);
  }
  if (p.last_error) {
    lines.push(
      `✗ Dernière erreur (${formatRelativeTime(p.last_error.at)}) : ${p.last_error.code}`,
    );
    if (p.last_error.message) lines.push(`   ${p.last_error.message}`);
  }
  if (typeof p.cost_eur_this_month === "number" && p.cost_eur_this_month > 0) {
    lines.push(`Coût ce mois : ${p.cost_eur_this_month.toFixed(3)}€`);
  }
  if (typeof p.requests_this_month === "number" && p.requests_this_month > 0) {
    lines.push(`Requêtes ce mois : ${p.requests_this_month}`);
  }
  if (budgetMonthly > 0) {
    const pct = (totalUsage / budgetMonthly) * 100;
    lines.push(`Budget global : ${totalUsage.toFixed(2)}€ / ${budgetMonthly}€ (${pct.toFixed(0)}%)`);
  }
  return lines.join("\n");
}

function CloudProvidersBadges() {
  const [providers, setProviders] = useState<ClientProviderState[]>([]);
  const [budgetMonthly, setBudgetMonthly] = useState(0);
  const [totalUsage, setTotalUsage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/cloud-providers", { cache: "no-store" });
        if (!r.ok || cancelled) return;
        const j = await r.json();
        const stateMap = j.state || {};
        const ids: CloudProviderId[] = ["openai", "anthropic", "google", "mistral"];
        const next: ClientProviderState[] = ids.map((id) => ({
          id,
          configured: stateMap[id]?.configured === true,
          cost_eur_this_month: stateMap[id]?.cost_eur_this_month,
          requests_this_month: stateMap[id]?.requests_this_month,
          last_success_at: stateMap[id]?.last_success_at,
          last_error: stateMap[id]?.last_error,
        }));
        setProviders(next);
        setBudgetMonthly(j.budget_monthly_eur || 0);
        setTotalUsage(next.reduce((a, p) => a + (p.cost_eur_this_month || 0), 0));
      } catch { /* silent */ }
    }
    load();
    // Refresh : (a) toutes les 15 s pour catcher rapidement les changements
    // de health (last_error / last_success_at qui évoluent à chaque appel
    // cloud) sans étouffer le serveur, (b) au retour du tab (focus) pour
    // voir immédiatement si l'admin vient de configurer une clé.
    const t = setInterval(load, 15_000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (providers.length === 0) return null;
  const anyConfigured = providers.some((p) => p.configured);
  if (!anyConfigured) return null;  // Pas de bruit si rien

  return (
    <div className="hidden lg:flex items-center gap-1.5 px-3 border-l border-border">
      <Cloud size={12} className="text-muted shrink-0" aria-hidden />
      {providers.map((p) => {
        const health = computeHealthClient(p, budgetMonthly, totalUsage);
        const styleCls = p.configured
          ? HEALTH_STYLES[health]
          : "opacity-30 grayscale";
        return (
          <span
            key={p.id}
            title={buildTooltip(p, health, budgetMonthly, totalUsage)}
            className={
              "inline-flex items-center justify-center w-6 h-6 rounded transition-default " +
              styleCls
            }
            aria-label={`${PROVIDER_LABELS[p.id]} ${HEALTH_LABEL[health]}`}
          >
            <ProviderLogo id={p.id} size={14} colored={p.configured && health !== "error"} />
          </span>
        );
      })}
    </div>
  );
}

export function SystemMetricsWidget() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [series, setSeries] = useState<MetricSeries>(EMPTY_SERIES);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    async function load() {
      try {
        const r = await fetch("/api/system/metrics", { cache: "no-store" });
        if (!r.ok || cancelledRef.current) return;
        const m: Metrics = await r.json();
        setMetrics(m);
        setSeries((s) => ({
          cpu:  [...s.cpu,  m.cpu_pct  ?? null].slice(-HISTORY_LEN),
          ram:  [...s.ram,  m.ram_pct  ?? null].slice(-HISTORY_LEN),
          disk: [...s.disk, m.disk_pct ?? null].slice(-HISTORY_LEN),
          gpu:  [...s.gpu,  m.gpu_pct  ?? null].slice(-HISTORY_LEN),
        }));
      } catch {
        /* on garde la dernière série, on ne reset pas en cas de hoquet */
      }
    }

    load();
    const t = setInterval(load, POLL_MS);
    return () => { cancelledRef.current = true; clearInterval(t); };
  }, []);

  // Couleurs HSL alignées sur le thème (cf. globals.css).
  // CPU : primary (blue) · RAM : accent (green) · Disk : violet · GPU : pink
  return (
    <div className="hidden lg:flex items-center gap-4 px-3 border-l border-border">
      <MetricRow
        icon={Cpu}
        label="CPU"
        values={series.cpu}
        current={metrics?.cpu_pct ?? null}
        hue="var(--primary)"
      />
      <MetricRow
        icon={MemoryStick}
        label="RAM"
        values={series.ram}
        current={metrics?.ram_pct ?? null}
        hue="var(--accent)"
      />
      <MetricRow
        icon={HardDrive}
        label="Disk"
        values={series.disk}
        current={metrics?.disk_pct ?? null}
        hue="270 80% 65%"
      />
      <MetricRow
        icon={Zap}
        label="GPU"
        values={series.gpu}
        current={metrics?.gpu_pct ?? null}
        hue="330 85% 65%"
      />
      <LocalAiBadge />
      <CloudProvidersBadges />
    </div>
  );
}
