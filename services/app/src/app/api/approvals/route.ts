/**
 * GET /api/approvals — liste les actions en attente d'approbation utilisateur.
 *
 * Version générique de `/api/concierge/pending` (qui reste comme alias
 * rétrocompat pour l'UI banner Concierge actuelle). Différences :
 * - Visible à tous les users authentifiés (pas juste admin) — chacun voit
 *   ses propres pending si `user_id` est défini sur le record. Les pending
 *   legacy sans `user_id` sont visibles par tous (rétrocompat).
 * - Optionnel `?action=<slug>` : filtre par tool spécifique.
 *
 * Auth : session NextAuth requise.
 *
 * Polling-friendly : retourne en quelques ms même si vide. Le frontend
 * poll toutes les 3-5s pour le banner global, ou à la demande pour la
 * page `/approvals`.
 *
 * Référence : Sprint 1 P0 #2 — tools/research/audit_P0_02_hitl.md
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { listActive } from "@/lib/approval-gate";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin || false;
  // Admin voit tout. Non-admin ne voit que ses propres pending (filtre par
  // user_id côté listActive). Les pending legacy sans user_id sont
  // considérées comme global et restent visibles à tous (rétrocompat
  // avec le Concierge actuel qui ne propage pas user_id).
  const userId = isAdmin ? undefined : session.user.email;
  const pending = await listActive(userId);

  // Filtre optionnel par action (?action=install_workflow)
  const url = new URL(req.url);
  const actionFilter = url.searchParams.get("action");
  const filtered = actionFilter
    ? pending.filter((p) => p.action === actionFilter)
    : pending;

  return NextResponse.json({
    pending: filtered,
    count: filtered.length,
    is_admin: isAdmin,
  });
}
