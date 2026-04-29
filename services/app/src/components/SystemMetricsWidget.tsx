"use client";

import { useEffect, useState } from "react";
import { Cpu, MemoryStick, HardDrive, Zap } from "lucide-react";

interface Metrics {
  cpu_pct: number | null;
  ram_pct: number | null;
  disk_pct: number | null;
  gpu_pct: number | null;
  gpu_mem_pct: number | null;
}

function pctColor(p: number | null): string {
  if (p == null) return "text-muted";
  if (p < 50) return "text-accent";
  if (p < 80) return "text-yellow-400";
  return "text-destructive";
}

function MetricBar({ icon: Icon, label, value }: { icon: any; label: string; value: number | null }) {
  return (
    <div
      className="flex items-center gap-1.5 text-xs"
      title={`${label} : ${value != null ? value.toFixed(1) : "—"} %`}
    >
      <Icon size={12} className="text-muted shrink-0" />
      <span className="text-muted hidden md:inline">{label}</span>
      <div className="w-12 h-1.5 rounded-full bg-muted/20 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pctColor(value).replace("text-", "bg-")}`}
          style={{ width: `${Math.min(100, value ?? 0)}%` }}
        />
      </div>
      <span className={`tabular-nums w-9 text-right ${pctColor(value)}`}>
        {value != null ? `${value.toFixed(0)}%` : "—"}
      </span>
    </div>
  );
}

export function SystemMetricsWidget() {
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch("/api/system/metrics", { cache: "no-store" });
        if (r.ok && !cancelled) setMetrics(await r.json());
      } catch { /* ignore */ }
    }
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return (
    <div className="hidden lg:flex items-center gap-4 text-xs px-3 border-l border-border">
      <MetricBar icon={Cpu}        label="CPU"  value={metrics?.cpu_pct ?? null} />
      <MetricBar icon={MemoryStick} label="RAM" value={metrics?.ram_pct ?? null} />
      <MetricBar icon={HardDrive}  label="Disk" value={metrics?.disk_pct ?? null} />
      <MetricBar icon={Zap}        label="GPU"  value={metrics?.gpu_pct ?? null} />
    </div>
  );
}
