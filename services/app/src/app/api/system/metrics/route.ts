/**
 * GET /api/system/metrics — interroge Prometheus + DCGM exporter pour
 * remonter CPU, RAM, Disque, GPU en pourcentages.
 *
 * Cible : Prometheus interne aibox-prometheus:9090
 */
import { NextResponse } from "next/server";

const PROM = process.env.PROMETHEUS_URL || "http://aibox-prometheus:9090";

async function query(q: string): Promise<number | null> {
  try {
    const r = await fetch(
      `${PROM}/api/v1/query?query=${encodeURIComponent(q)}`,
      { cache: "no-store", signal: AbortSignal.timeout(2000) },
    );
    if (!r.ok) return null;
    const data = await r.json();
    const result = data?.data?.result?.[0]?.value?.[1];
    return result != null ? Number(result) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  // Requêtes PromQL — utilisent node-exporter et dcgm-exporter standards.
  const [cpu, mem, disk, gpu, gpuMem] = await Promise.all([
    // CPU : 100 - idle %
    query('100 - (avg(irate(node_cpu_seconds_total{mode="idle"}[1m])) * 100)'),
    // RAM : (total - available) / total * 100
    query("(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100"),
    // Disque / : utilisation %
    query('(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100'),
    // GPU utilization %
    query("avg(DCGM_FI_DEV_GPU_UTIL)"),
    // GPU memory used / total * 100
    query("avg(DCGM_FI_DEV_FB_USED) / avg(DCGM_FI_DEV_FB_TOTAL + DCGM_FI_DEV_FB_USED) * 100"),
  ]);

  return NextResponse.json({
    cpu_pct: cpu != null ? Math.round(cpu * 10) / 10 : null,
    ram_pct: mem != null ? Math.round(mem * 10) / 10 : null,
    disk_pct: disk != null ? Math.round(disk * 10) / 10 : null,
    gpu_pct: gpu != null ? Math.round(gpu * 10) / 10 : null,
    gpu_mem_pct: gpuMem != null ? Math.round(gpuMem * 10) / 10 : null,
    timestamp: new Date().toISOString(),
  });
}
