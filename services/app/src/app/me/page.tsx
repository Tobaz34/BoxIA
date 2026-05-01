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
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Download, Trash2, ShieldCheck, AlertTriangle, FileJson,
  Brain, RefreshCw,
} from "lucide-react";

interface MemoryFact {
  id: string;
  fact: string;
  agent_id: string;
  created_at: string;
  score: number | null;
}

export default function MePage() {
  const { data: session } = useSession();
  const [deleting, setDeleting] = useState(false);
  const [report, setReport] = useState<Record<string, { count: number; deleted: number; errors: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mémoire long-terme (mem0) — best effort : si désactivé, section masquée
  const [memEnabled, setMemEnabled] = useState<boolean | null>(null);
  const [memFacts, setMemFacts] = useState<MemoryFact[]>([]);
  const [memLoading, setMemLoading] = useState(true);
  const [memDeleting, setMemDeleting] = useState(false);

  const loadMemory = async () => {
    setMemLoading(true);
    try {
      const r = await fetch("/api/me/memory", { cache: "no-store" });
      if (r.ok) {
        const j = await r.json();
        setMemEnabled(j.enabled === true);
        setMemFacts(Array.isArray(j.facts) ? j.facts : []);
      } else {
        setMemEnabled(false);
      }
    } catch {
      setMemEnabled(false);
    } finally {
      setMemLoading(false);
    }
  };

  useEffect(() => { loadMemory(); }, []);

  const deleteMemory = async () => {
    if (!confirm(
      "Supprimer DÉFINITIVEMENT toute votre mémoire long-terme ? " +
      "L'assistant oubliera tout ce qu'il sait de vous (préférences, " +
      "contexte, etc.). Action irréversible — RGPD art. 17."
    )) return;
    setMemDeleting(true);
    try {
      const r = await fetch("/api/me/memory", { method: "DELETE" });
      if (r.ok) {
        setMemFacts([]);
      }
    } finally {
      setMemDeleting(false);
    }
  };

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

      {/* Mémoire long-terme (mem0) — masqué si feature désactivée serveur */}
      {memEnabled !== false && (
        <section className="bg-card border border-border rounded-lg p-5 mb-4">
          <div className="flex items-center justify-between mb-1">
            <h2 className="font-semibold flex items-center gap-2">
              <Brain size={16} className="text-primary" />
              Mémoire long-terme
            </h2>
            <button
              onClick={loadMemory}
              disabled={memLoading}
              className="p-1.5 rounded hover:bg-muted/20 text-muted hover:text-foreground transition-default"
              title="Rafraîchir"
            >
              <RefreshCw size={14} className={memLoading ? "animate-spin" : ""} />
            </button>
          </div>
          <p className="text-sm text-muted mb-3">
            Liste des informations que la AI Box a mémorisées sur vous au fil
            des conversations (préférences, contexte professionnel, faits durables).
            Ces données sont utilisées pour personnaliser les réponses sans
            avoir à tout réexpliquer à chaque fois. Vous gardez le contrôle :
            consultation et suppression à tout moment (RGPD art. 15 et 17).
          </p>

          {memLoading ? (
            <div className="text-sm text-muted py-4">Chargement…</div>
          ) : memFacts.length === 0 ? (
            <div className="text-sm text-muted bg-muted/10 rounded-md px-3 py-3 border border-border">
              Aucune information mémorisée pour le moment. Discutez avec un
              assistant et partagez votre contexte (entreprise, préférences) :
              les faits durables seront extraits automatiquement.
            </div>
          ) : (
            <>
              <div className="rounded-md border border-border divide-y divide-border max-h-72 overflow-y-auto mb-3">
                {memFacts.map((f) => (
                  <div key={f.id} className="px-3 py-2 text-sm flex items-start gap-2">
                    <span className="text-primary mt-0.5">•</span>
                    <div className="flex-1 min-w-0">
                      <div>{f.fact}</div>
                      <div className="text-[10px] text-muted mt-0.5">
                        Agent : <code className="bg-muted/15 px-1 py-0.5 rounded">{f.agent_id}</code>
                        {" · "}
                        {new Date(f.created_at).toLocaleDateString("fr-FR", {
                          day: "2-digit", month: "short", year: "numeric",
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted">
                  {memFacts.length} fait{memFacts.length > 1 ? "s" : ""} mémorisé{memFacts.length > 1 ? "s" : ""}
                </span>
                <button
                  onClick={deleteMemory}
                  disabled={memDeleting}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-red-500/15 text-red-400 text-xs font-medium hover:bg-red-500/25 transition-default disabled:opacity-50"
                >
                  <Trash2 size={12} />
                  {memDeleting ? "Suppression…" : "Tout effacer"}
                </button>
              </div>
            </>
          )}
        </section>
      )}

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
