/**
 * GET /api/stats — agrégation des KPI pour le dashboard /system.
 *
 * Admin only. Fait des appels en parallèle aux sources :
 *   - Authentik /core/users/ → users count + actifs/désactivés
 *   - Dify /v1/conversations par agent → total conversations
 *   - Dify /v1/datasets/{id}/documents → docs indexés
 *   - lib/connectors-state → connecteurs actifs
 *   - app-audit (last 24h) → activité récente
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, akFetch } from "@/lib/authentik";
import { difyFetch, DIFY_BASE_URL } from "@/lib/dify";
import { listAvailableAgents, getAgentKey } from "@/lib/agents";
import { listStates } from "@/lib/connectors-state";
import { readAudit } from "@/lib/app-audit";

export const dynamic = "force-dynamic";

void DIFY_BASE_URL; // silence unused if not used directly here

interface AgentStat {
  slug: string;
  name: string;
  conversations: number;
  available: boolean;
}

export async function GET(_req: NextRequest) {
  const ctx = await requireAdmin();
  if (ctx instanceof NextResponse) return ctx;

  // ---- Users (Authentik) ----
  let usersTotal = 0, usersActive = 0;
  try {
    const r = await akFetch(`/core/users/?page_size=200`);
    if (r.ok) {
      const j = await r.json();
      usersTotal = j.pagination?.count ?? (j.results || []).length;
      usersActive = (j.results || []).filter(
        (u: { is_active: boolean }) => u.is_active,
      ).length;
    }
  } catch { /* noop */ }

  // ---- Agents + conversations ----
  const agents = listAvailableAgents();
  const agentStats: AgentStat[] = await Promise.all(
    agents.map(async (a) => {
      const key = getAgentKey(a.slug);
      let convs = 0;
      if (key) {
        try {
          // pass current admin email as user
          const r = await difyFetch(
            `/v1/conversations?user=${encodeURIComponent(ctx.user.email)}&limit=100`,
            { key },
          );
          if (r.ok) {
            const j = await r.json();
            convs = (j.data || []).length;
          }
        } catch { /* noop */ }
      }
      return { slug: a.slug, name: a.name, conversations: convs, available: !!key };
    }),
  );
  const conversationsTotal = agentStats.reduce(
    (sum, a) => sum + a.conversations, 0,
  );

  // ---- Documents (KB Dify) ----
  let documentsTotal = 0;
  const KB_KEY = process.env.DIFY_KB_API_KEY || "";
  const DS_ID = process.env.DIFY_DEFAULT_DATASET_ID || "";
  if (KB_KEY && DS_ID) {
    try {
      const r = await fetch(
        `${process.env.DIFY_BASE_URL || "http://localhost:8081"}/v1/datasets/${DS_ID}/documents?limit=100`,
        { headers: { Authorization: `Bearer ${KB_KEY}` } },
      );
      if (r.ok) {
        const j = await r.json();
        documentsTotal = (j.data || []).length;
      }
    } catch { /* noop */ }
  }

  // ---- Connecteurs ----
  const states = await listStates();
  const connectorsActive = Object.values(states).filter(
    (s) => s.status === "active",
  ).length;

  // ---- Activité récente (24h) ----
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const recent = await readAudit({ since, limit: 200 });

  // Buckets : par action
  const actionCounts: Record<string, number> = {};
  for (const e of recent) {
    actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
  }

  return NextResponse.json({
    summary: {
      users: { total: usersTotal, active: usersActive },
      agents: { available: agentStats.filter((a) => a.available).length, total: agentStats.length },
      conversations_total: conversationsTotal,
      documents_total: documentsTotal,
      connectors_active: connectorsActive,
      audit_24h: recent.length,
    },
    agents: agentStats,
    actions_24h: actionCounts,
    last_events: recent.slice(0, 10),
  });
}
