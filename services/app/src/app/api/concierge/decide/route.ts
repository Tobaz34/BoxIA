/**
 * POST /api/concierge/decide
 *
 * Body : { action_id: string, decision: "approve" | "reject" }
 *
 * L'admin valide ou refuse une action Concierge en attente. Si
 * « approve », on déclenche IMMÉDIATEMENT l'exécution du tool en
 * appelant l'endpoint `/api/agents-tools/<action>` avec
 * `approval_token=action_id`. Le résultat est renvoyé tel quel au
 * frontend pour affichage dans le banner.
 *
 * Auth : session admin requise (audit log).
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { decide, listActive } from "@/lib/approval-gate";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

interface PostBody {
  action_id?: string;
  decision?: "approve" | "reject";
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  const id = body.action_id;
  const decision = body.decision;
  if (!id || !/^[0-9a-f]{32}$/.test(id)) {
    return NextResponse.json({ error: "invalid_action_id" }, { status: 400 });
  }
  if (decision !== "approve" && decision !== "reject") {
    return NextResponse.json({ error: "invalid_decision" }, { status: 400 });
  }

  const updated = await decide(id, decision === "approve" ? "approved" : "rejected");
  if (!updated) {
    return NextResponse.json({ error: "not_found_or_expired" }, { status: 404 });
  }
  await logAction(
    "concierge.approval",
    session.user.email,
    {
      decision,
      action: updated.action,
      action_id: id,
      params: updated.params,
    },
    ipFromHeaders(req),
  );

  // Si rejeté → on s'arrête là, le pending sera consumé au prochain
  // appel du tool (ou expirera). On peut aussi le supprimer maintenant
  // pour libérer le banner immédiatement — on le laisse, au cas où le
  // LLM re-tente automatiquement (il verra "rejected_by_user").
  if (decision === "reject") {
    return NextResponse.json({
      ok: true,
      decision: "rejected",
      action: updated.action,
    });
  }

  // Si approuvé → on exécute IMMÉDIATEMENT en re-appelant l'endpoint
  // mutatif avec le token. Cela passe par le mécanisme `consumeApproved`
  // qui supprimera le pending automatiquement.
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

  // Récupère ce qu'il reste de pending (l'action exécutée est purgée)
  const remaining = await listActive();
  return NextResponse.json({
    ok: result.status >= 200 && result.status < 300,
    decision: "approved",
    action: updated.action,
    execution: result,
    remaining_pending: remaining.length,
  });
}
