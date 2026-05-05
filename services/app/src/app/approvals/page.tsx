/**
 * Page /approvals — vue batch des actions HITL en attente.
 *
 * Visible à tous les users authentifiés : chaque user voit ses propres
 * pending (filtre par user_id côté API). Admin voit tout.
 *
 * Le composant ApprovalBanner gère le polling, l'affichage et les
 * décisions. En mode `fixed={false}`, il s'affiche inline dans la page
 * plutôt qu'en banner sticky.
 *
 * Référence : Sprint 1 P0 #2 — tools/research/audit_P0_02_hitl.md
 */
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { ApprovalBanner } from "@/components/ApprovalBanner";
import { ShieldAlert } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata = { title: "Approbations · AI Box" };

export default async function ApprovalsPage() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    redirect("/api/auth/signin?callbackUrl=/approvals");
  }
  const isAdmin = (session.user as { isAdmin?: boolean }).isAdmin || false;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
      <header className="flex items-start gap-3 border-b border-border pb-3">
        <ShieldAlert className="text-amber-400 mt-1 shrink-0" size={20} />
        <div>
          <h1 className="text-lg font-semibold">Actions en attente d&apos;approbation</h1>
          <p className="text-[13px] text-muted mt-0.5">
            {isAdmin
              ? "Toutes les actions sensibles en attente de validation, tous utilisateurs confondus."
              : "Les actions sensibles déclenchées par vos agents qui requièrent votre validation explicite."}{" "}
            Chaque action expire automatiquement après 5 minutes.
          </p>
        </div>
      </header>

      <ApprovalBanner fixed={false} />

      <section className="text-[12px] text-muted border-t border-border pt-3 space-y-1.5">
        <p>
          <strong>Pourquoi ce gate ?</strong> Un prompt injection dans un email
          lu, un PDF uploadé ou un titre de page web peut convaincre un agent IA
          d&apos;appeler un tool mutatif (envoi mail, suppression document, install
          workflow…). Ce gate garantit qu&apos;aucune mutation n&apos;est exécutée sans
          un clic explicite côté humain.
        </p>
        <p>
          La case <em>« ne plus me redemander pour cette tâche »</em> mémorise
          l&apos;approbation pour les prochains appels du même tool dans la même
          tâche, jusqu&apos;à expiration TTL (5 min). Pratique pour les chaînes
          multi-step type « scrappe → résume → envoie mail ».
        </p>
      </section>
    </div>
  );
}
