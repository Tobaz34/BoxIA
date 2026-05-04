/**
 * /bench — Page d'observabilité IA (locale + cloud) + résultats des
 * benchmarks. Voir BenchDashboard.tsx pour le détail des sections.
 *
 * Accessible à tous les users connectés (section "Pour vous"). La section
 * "Diagnostic infra" se déplie uniquement pour les admins.
 */
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { redirect } from "next/navigation";
import { BenchDashboard } from "@/components/BenchDashboard";
import { logAudit } from "@/lib/app-audit";
import { roleFromGroups } from "@/lib/agents";

export const dynamic = "force-dynamic";

export default async function BenchPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/api/auth/signin");
  }
  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin || false;

  // Audit l'accès à la page (utile pour traquer qui consulte les KPIs
  // gestionnaire). Best-effort : ne bloque pas le rendu si ça échoue.
  const groups = (session.user as { groups?: string[] }).groups || [];
  void logAudit({
    ts: Date.now(),
    actor: session.user.email,
    actor_role: roleFromGroups(groups),
    action: "bench.access",
  }).catch(() => {/* noop */});

  return <BenchDashboard isAdmin={isAdmin} />;
}
