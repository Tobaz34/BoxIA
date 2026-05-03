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
function CloudProvidersBadges() {
  const [providers, setProviders] = useState<Array<{
    id: "openai" | "anthropic" | "mistral";
    label: string;
    configured: boolean;
    cost_eur_this_month?: number;
  }>>([]);

  useEffect(() => {
    const labels = { openai: "OpenAI", anthropic: "Anthropic", mistral: "Mistral" };
    fetch("/api/cloud-providers", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => {
        if (!j) return;
        const ids = ["openai", "anthropic", "mistral"] as const;
        setProviders(ids.map((id) => ({
          id,
          label: labels[id],
          configured: j.providers?.[id]?.configured === true,
          cost_eur_this_month: j.providers?.[id]?.cost_eur_this_month,
        })));
      })
      .catch(() => { /* silent */ });
  }, []);

  if (providers.length === 0) return null;
  const anyConfigured = providers.some((p) => p.configured);
  if (!anyConfigured) return null;  // Pas de bruit si rien

  return (
    <div className="hidden lg:flex items-center gap-1 px-3 border-l border-border">
      <Cloud size={12} className="text-muted shrink-0" />
      {providers.map((p) => (
        <span
          key={p.id}
          title={
            p.configured
              ? `${p.label} : configuré${p.cost_eur_this_month
                  ? ` · ${p.cost_eur_this_month.toFixed(2)}€ ce mois` : ""}`
              : `${p.label} : non configuré`
          }
          className={
            "inline-flex items-center justify-center w-6 h-5 rounded text-[9px] font-bold tracking-tight " +
            (p.configured
              ? "bg-emerald-500/20 text-emerald-400 ring-1 ring-emerald-500/40"
              : "bg-muted/10 text-muted/50")
          }
          aria-label={`${p.label} ${p.configured ? "actif" : "inactif"}`}
        >
          {p.id === "openai" ? "AI" : p.id === "anthropic" ? "An" : "Mi"}
        </span>
      ))}
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
      <CloudProvidersBadges />
    </div>
  );
}
