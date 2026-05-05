/**
 * POST /api/approvals/[id]/decide
 *
 * Body : {
 *   decision: "approve" | "reject",
 *   auto_approve_persistent?: boolean   // si true + decision==="approve",
 *                                        // mémorise l'auto-approbation pour
 *                                        // les prochains appels avec la même
 *                                        // (action, auto_approve_key) jusqu'à
 *                                        // expiration TTL
 * }
 *
 * Version générique de `/api/concierge/decide` (qui reste comme alias
 * rétrocompat). Différences :
 * - URL path avec id (REST-style) au lieu de body.action_id
 * - Tous les users authentifiés peuvent décider, mais seulement de LEURS
 *   propres pending (filtre user_id). Admin peut décider de toutes.
 * - Support du flag `auto_approve_persistent` (P0 #2 — limite la fatigue UI
 *   en mémorisant le feu vert pour une tâche qui requiert plusieurs steps
 *   sensibles successifs).
 *
 * Auth : session NextAuth requise. Vérification ownership via user_id.
 *
 * Référence : Sprint 1 P0 #2 — tools/research/audit_P0_02_hitl.md +
 *             DECISIONS-P0.md §D2 + §D7
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { decide, listActive } from "@/lib/approval-gate";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

interface PostBody {
  decision?: "approve" | "reject";
  auto_approve_persistent?: boolean;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    return NextResponse.json({ error: "invalid_action_id" }, { status: 400 });
  }

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin || false;
  const userEmail = session.user.email;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  // Vérifie ownership : si la pending a un user_id et qu'il ne match pas
  // le user courant ET le user n'est pas admin → 403.
  // Recherche dans listActive (pas idéal mais pas de getById direct
  // dans approval-gate ; pourra être ajouté dans une future itération).
  const allPending = await listActive(); // sans filtre pour la vérif ownership
  const target = allPending.find((p) => p.id === id);
  if (!target) {
    return NextResponse.json({ error: "not_found_or_expired" }, { status: 404 });
  }
  if (target.user_id && target.user_id !== userEmail && !isAdmin) {
    return NextResponse.json({ error: "forbidden_not_owner" }, { status: 403 });
  }

  const updated = await decide(
    id,
    decision === "approve" ? "approved" : "rejected",
    { auto_approve_persistent: Boolean(body.auto_approve_persistent) },
  );
  if (!updated) {
    return NextResponse.json({ error: "not_found_or_expired" }, { status: 404 });
  }

  await logAction(
    "concierge.approval", // garde le même action audit pour cohérence histo
    userEmail,
    {
      decision,
      action: updated.action,
      action_id: id,
      params: updated.params,
      auto_approve_persistent: Boolean(body.auto_approve_persistent),
      via: "approvals_api",
    },
    ipFromHeaders(req),
  );

  // Si rejeté → on s'arrête là, pas d'exécution.
  if (decision === "reject") {
    return NextResponse.json({
      ok: true,
      decision: "rejected",
      action: updated.action,
    });
  }

  // Si approuvé → exécution IMMÉDIATE en re-appelant l'endpoint mutatif
  // avec le token. consumeApproved supprimera le pending automatiquement.
  // (Les auto_approve_persistent restent en revanche pour les futurs appels.)
  const agentsKey = process.env.AGENTS_API_KEY;
  if (!agentsKey) {
    return NextResponse.json(
      { ok: false, error: "no_agents_api_key" },
      { status: 500 },
    );
  }
  const url = new URL(req.url);
  const internalUrl = `${url.origin}/api/agents-tools/${updated.action}`;
  let result: { status: number; body: unknown };
  try {
    const r = await fetch(internalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentsKey}`,
      },
      body: JSON.stringify({
        ...updated.params,
        approval_token: id,
      }),
    });
    const json = await r.json().catch(() => ({}));
    result = { status: r.status, body: json };
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: "execution_failed", detail: String(e).slice(0, 300) },
      { status: 502 },
    );
  }

  const remainingScoped = await listActive(isAdmin ? undefined : userEmail);
  return NextResponse.json({
    ok: result.status >= 200 && result.status < 300,
    decision: "approved",
    action: updated.action,
    execution: result,
    remaining_pending: remainingScoped.length,
    auto_approve_persistent: Boolean(body.auto_approve_persistent),
  });
}
