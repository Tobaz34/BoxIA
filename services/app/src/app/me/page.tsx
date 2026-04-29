"use client";

/**
 * /me — Mes données personnelles (RGPD).
 *
 * - Profil (lecture seule, source : NextAuth session + groupes Authentik)
 * - Bouton « Exporter mes données » → télécharge un JSON complet
 * - Bouton « Supprimer toutes mes conversations » → wipe Dify (toutes
 *   les apps), avec rapport
 *
 * NB : la suppression du COMPTE lui-même est réservée à l'admin (page
 * /users) — on respecte le principe que le user ne peut pas se faire
 * disparaître de la base sans intervention de l'admin (audit trail).
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Download, Trash2, ShieldCheck, AlertTriangle, FileJson } from "lucide-react";

export default function MePage() {
  const { data: session } = useSession();
  const [deleting, setDeleting] = useState(false);
  const [report, setReport] = useState<Record<string, { count: number; deleted: number; errors: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const groups = (session?.user as { groups?: string[] })?.groups || [];
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  async function deleteAll() {
    if (!confirm(
      "Supprimer DÉFINITIVEMENT toutes vos conversations sur tous les " +
      "assistants ? Cette action ne peut pas être annulée.",
    )) return;
    setDeleting(true);
    setReport(null);
    setError(null);
    try {
      const r = await fetch("/api/me/delete-conversations", { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setReport(j.report || {});
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <header className="mb-6 flex items-center gap-3">
        <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
          <ShieldCheck size={20} />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Mes données</h1>
          <p className="text-sm text-muted">
            Vos informations personnelles, vos conversations, et vos droits
            RGPD.
          </p>
        </div>
      </header>

      {/* Profil */}
      <section className="bg-card border border-border rounded-lg p-5 mb-4">
        <h2 className="font-semibold mb-3">Profil</h2>
        <dl className="grid grid-cols-[140px_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Nom</dt>
          <dd>{session?.user?.name || "—"}</dd>
          <dt className="text-muted">Email</dt>
          <dd>{session?.user?.email || "—"}</dd>
          <dt className="text-muted">Rôle</dt>
          <dd>
            {isAdmin ? "Administrateur" :
             groups.includes("AI Box — Managers") ? "Manager" :
             "Employé"}
          </dd>
          <dt className="text-muted">Groupes Authentik</dt>
          <dd className="flex flex-wrap gap-1">
            {groups.length === 0
              ? <span className="text-muted">—</span>
              : groups.map((g) => (
                <span
                  key={g}
                  className="text-[10px] px-2 py-0.5 rounded-full bg-muted/20 text-muted"
                >
                  {g}
                </span>
              ))}
          </dd>
        </dl>
      </section>

      {/* Export RGPD */}
      <section className="bg-card border border-border rounded-lg p-5 mb-4">
        <h2 className="font-semibold mb-1">Exporter mes données</h2>
        <p className="text-sm text-muted mb-3">
          Téléchargez un fichier JSON avec votre profil + l'intégralité de
          vos conversations sur tous les assistants. Conformément à l'article
          20 du RGPD (droit à la portabilité).
        </p>
        <a
          href="/api/me/export"
          download
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
        >
          <Download size={14} />
          <FileJson size={14} className="opacity-70" />
          Télécharger mes données (JSON)
        </a>
      </section>

      {/* Suppression conversations */}
      <section className="bg-card border border-border rounded-lg p-5 mb-4">
        <h2 className="font-semibold mb-1">Supprimer mes conversations</h2>
        <p className="text-sm text-muted mb-3">
          Efface définitivement toutes vos conversations sur tous les
          assistants. Votre compte reste actif. Cette action est
          irréversible.
        </p>
        <button
          onClick={deleteAll}
          disabled={deleting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-red-500/15 text-red-400 text-sm font-medium hover:bg-red-500/25 transition-default disabled:opacity-50"
        >
          <Trash2 size={14} />
          {deleting ? "Suppression en cours…" : "Supprimer toutes mes conversations"}
        </button>

        {report && (
          <div className="mt-4 rounded-md border border-border p-3 text-sm space-y-1">
            <div className="font-medium mb-1">Rapport de suppression</div>
            {Object.entries(report).map(([slug, r]) => (
              <div key={slug} className="flex justify-between text-xs">
                <span className="text-muted">{slug}</span>
                <span>
                  {r.deleted} / {r.count} conversation{r.count > 1 ? "s" : ""} supprimée{r.deleted > 1 ? "s" : ""}
                  {r.errors > 0 && (
                    <span className="text-red-400"> · {r.errors} erreur{r.errors > 1 ? "s" : ""}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
            {error}
          </div>
        )}
      </section>

      {/* Suppression compte = admin */}
      <section className="rounded-lg border border-border bg-muted/5 p-5">
        <div className="flex items-start gap-3">
          <AlertTriangle size={16} className="text-muted shrink-0 mt-0.5" />
          <div className="text-xs text-muted leading-relaxed">
            La suppression complète de votre compte (droit à l'oubli, RGPD
            art. 17) est réservée à l'administrateur de la AI Box pour
            préserver la traçabilité (logs Authentik, conformité). Pour
            exercer ce droit, contactez votre administrateur.
          </div>
        </div>
      </section>
    </div>
  );
}
