"use client";

/**
 * Page /workflows — liste les automatisations n8n + lien direct vers
 * la console n8n (https://aibox-flows.local) pour l'édition.
 *
 * Tous les utilisateurs voient la liste. Seuls les admins peuvent
 * activer/désactiver.
 */
import {
  Workflow, ExternalLink, Power, RefreshCw, AlertCircle, Tag, Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";

interface N8nWorkflow {
  id: string;
  name: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: { id: string; name: string }[];
  nodes?: { type: string; name: string }[];
  triggerCount?: number;
}

const N8N_PUBLIC_URL = "https://aibox-flows.local";

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(iso).toLocaleDateString("fr-FR");
}

export function WorkflowsManager() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [workflows, setWorkflows] = useState<N8nWorkflow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/workflows", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.message || j.error || "Erreur de chargement");
        setWorkflows([]);
        return;
      }
      const j = await r.json();
      setWorkflows(j.workflows || []);
      setError(null);
    } catch {
      setError("n8n indisponible");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function toggle(id: string, active: boolean) {
    setToggling(id);
    try {
      const r = await fetch(`/api/workflows/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.error || `Erreur ${r.status}`);
        return;
      }
      // Refresh local list
      setWorkflows((curr) =>
        curr ? curr.map((w) => (w.id === id ? { ...w, active } : w)) : curr,
      );
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Workflow size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Automatisations</h1>
            <p className="text-sm text-muted">
              {workflows?.length || 0} workflow{(workflows?.length || 0) > 1 ? "s" : ""} n8n
              {(workflows?.length || 0) > 0 && (
                <> · {workflows!.filter((w) => w.active).length} actif{workflows!.filter((w) => w.active).length > 1 ? "s" : ""}</>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            className="text-muted hover:text-foreground p-2 rounded hover:bg-muted/20 transition-default"
            title="Rafraîchir"
          >
            <RefreshCw size={16} />
          </button>
          <a
            href={N8N_PUBLIC_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
          >
            <ExternalLink size={14} />
            Ouvrir n8n
          </a>
        </div>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-muted py-12">Chargement…</div>
      ) : workflows && workflows.length === 0 ? (
        <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
          <Workflow size={32} className="mx-auto mb-3 opacity-50" />
          <p>Aucun workflow pour le moment.</p>
          <p className="text-xs mt-1">
            Cliquez sur « Ouvrir n8n » pour créer votre premier workflow.
          </p>
        </div>
      ) : workflows && workflows.length > 0 ? (
        <div className="rounded-lg border border-border bg-card divide-y divide-border">
          {workflows.map((w) => (
            <div
              key={w.id}
              className="px-4 py-3 grid grid-cols-[auto_1fr_auto] gap-3 items-center"
            >
              <span
                className={
                  "w-2 h-2 rounded-full " +
                  (w.active ? "bg-accent" : "bg-muted/40")
                }
                title={w.active ? "Actif" : "Inactif"}
              />
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium truncate">{w.name}</span>
                  {w.tags?.map((t) => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full bg-muted/15 text-muted"
                    >
                      <Tag size={9} /> {t.name}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-muted flex items-center gap-3 mt-0.5 flex-wrap">
                  <span>maj {relTime(w.updatedAt)}</span>
                  {typeof w.triggerCount === "number" && w.triggerCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Zap size={10} /> {w.triggerCount} déclencheur{w.triggerCount > 1 ? "s" : ""}
                    </span>
                  )}
                  {w.nodes && w.nodes.length > 0 && (
                    <span>{w.nodes.length} nœud{w.nodes.length > 1 ? "s" : ""}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {isAdmin && (
                  <button
                    onClick={() => toggle(w.id, !w.active)}
                    disabled={toggling === w.id}
                    className={
                      "p-2 rounded transition-default " +
                      (w.active
                        ? "text-accent hover:bg-accent/10"
                        : "text-muted hover:bg-muted/30 hover:text-foreground")
                    }
                    title={w.active ? "Désactiver" : "Activer"}
                  >
                    <Power size={14} />
                  </button>
                )}
                <a
                  href={`${N8N_PUBLIC_URL}/workflow/${w.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded text-muted hover:text-foreground hover:bg-muted/30 transition-default"
                  title="Ouvrir dans n8n"
                >
                  <ExternalLink size={14} />
                </a>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <div className="mt-6 rounded-lg bg-muted/5 border border-border p-4">
        <div className="flex items-start gap-3">
          <AlertCircle size={16} className="text-muted shrink-0 mt-0.5" />
          <div className="text-xs text-muted leading-relaxed">
            <strong>n8n</strong> est l'éditeur visuel de workflows. Cliquez sur
            <strong> « Ouvrir n8n »</strong> en haut pour accéder à l'éditeur
            complet (drag & drop, 400+ intégrations). Les workflows créés ici
            sont automatiquement listés sur cette page.
          </div>
        </div>
      </div>
    </div>
  );
}
