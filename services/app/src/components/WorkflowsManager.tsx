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
  Play, CheckCircle2, XCircle, Clock, ChevronDown, ChevronRight,
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

/** URL publique de n8n. Calculée dynamiquement en fonction du host
 *  courant pour fonctionner peu importe comment l'utilisateur accède à
 *  l'app :
 *
 *  - https://aibox.local           → https://aibox-flows.local (Caddy edge mDNS)
 *  - https://ai.client.fr          → https://flows.ai.client.fr (Caddy edge prod)
 *  - http://192.168.15.210:3100    → http://192.168.15.210:5678 (IP brute, pas Caddy)
 *  - http://localhost:3100         → http://localhost:5678 (dev)
 *
 *  Si on n'arrive pas à dériver, fallback sur l'URL flat-mDNS par défaut.
 */
function n8nPublicUrl(): string {
  if (typeof window === "undefined") return "https://aibox-flows.local";
  const { protocol, hostname, port } = window.location;
  // Mode IP brute / localhost / dev : remplace juste le port
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname === "localhost") {
    return `${protocol}//${hostname}:5678`;
  }
  // Mode flat-mDNS : aibox.local → aibox-flows.local
  if (hostname.endsWith(".local")) {
    const prefix = hostname.split(".")[0].split("-")[0]; // strip suffix éventuel
    return `https://${prefix}-flows.local`;
  }
  // Mode prod multi-label : foo.client.fr → flows.client.fr
  const parts = hostname.split(".");
  if (parts.length >= 2) {
    parts[0] = "flows";
    return `https://${parts.join(".")}`;
  }
  // Fallback
  return `${protocol}//${hostname}:5678`;
}

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

  const [expanded, setExpanded] = useState<string | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const toggleExpand = (id: string) => setExpanded((prev) => (prev === id ? null : id));

  const runManual = async (id: string) => {
    setRunningId(id);
    try {
      const r = await fetch(`/api/workflows/${id}/run`, { method: "POST" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert("Échec exécution : " + (j.detail || j.error || `HTTP ${r.status}`));
      } else {
        // Pas d'alert : on attend que l'utilisateur déplie pour voir l'exécution.
        setExpanded(id);
      }
    } finally {
      setRunningId(null);
    }
  };

  const [workflows, setWorkflows] = useState<N8nWorkflow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  // Import templates state
  const [importing, setImporting] = useState(false);
  const [importReport, setImportReport] = useState<{
    total: number; imported: number; skipped: number; failed: number;
  } | null>(null);
  // URL publique de n8n calculée côté client (window.location). Stockée
  // une fois pour éviter les re-calculs et permettre le SSR fallback.
  const [n8nUrl, setN8nUrl] = useState<string>("https://aibox-flows.local");
  useEffect(() => { setN8nUrl(n8nPublicUrl()); }, []);

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
      {/* Section Workflows IA (apps Dify mode=workflow) — compact */}
      <DifyWorkflowsSection isAdmin={isAdmin} />

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
          {isAdmin ? (
            <a
              href="/api/sso/n8n"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
              title="Ouvre n8n avec auto-login (vous êtes admin)"
            >
              <ExternalLink size={14} />
              Ouvrir n8n
            </a>
          ) : (
            <a
              href={n8nUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default"
            >
              <ExternalLink size={14} />
              Ouvrir n8n
            </a>
          )}
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
        <div className="border border-dashed border-border rounded-lg p-10 text-center text-muted">
          <Workflow size={32} className="mx-auto mb-3 opacity-50" />
          <p className="mb-4">Aucun workflow pour le moment.</p>
          <p className="text-xs mb-4 max-w-md mx-auto">
            Le repo BoxIA contient des workflows pré-écrits prêts à l'emploi
            (digest emails quotidien, relance factures impayées). Importez-les
            en 1 clic, ou créez le vôtre via n8n.
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap">
            <button
              onClick={async () => {
                setImporting(true);
                setImportReport(null);
                try {
                  const r = await fetch("/api/workflows/import-templates", {
                    method: "POST",
                  });
                  const j = await r.json().catch(() => ({}));
                  if (r.ok) {
                    setImportReport(j.summary);
                    await refresh();
                  } else {
                    setError(j.message || j.error || "Import échoué");
                  }
                } finally {
                  setImporting(false);
                }
              }}
              disabled={importing}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 transition-default disabled:opacity-50"
            >
              {importing ? "Import en cours…" : "📦 Importer les templates par défaut"}
            </button>
            <a
              href={isAdmin ? "/api/sso/n8n" : n8nUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-border text-sm hover:bg-muted/15 transition-default"
              title={isAdmin ? "Ouvre n8n avec auto-login (admin)" : undefined}
            >
              <ExternalLink size={14} />
              Ouvrir n8n pour créer le mien
            </a>
          </div>
          {importReport && (
            <div className="mt-4 text-xs text-accent">
              ✓ {importReport.imported} importé(s){importReport.skipped > 0 ? `, ${importReport.skipped} déjà présent(s)` : ""}
              {importReport.failed > 0 ? `, ${importReport.failed} échec(s)` : ""}
            </div>
          )}
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
                  <>
                    <button
                      onClick={() => runManual(w.id)}
                      disabled={runningId === w.id}
                      className="p-2 rounded text-muted hover:text-primary hover:bg-primary/10 transition-default disabled:opacity-50"
                      title="Exécuter maintenant"
                    >
                      <Play size={14} className={runningId === w.id ? "animate-pulse" : ""} />
                    </button>
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
                  </>
                )}
                <button
                  onClick={() => toggleExpand(w.id)}
                  className="p-2 rounded text-muted hover:text-foreground hover:bg-muted/30 transition-default"
                  title="Voir les exécutions"
                >
                  {expanded === w.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <a
                  href={
                    isAdmin
                      ? `/api/sso/n8n?to=${encodeURIComponent("/workflow/" + w.id)}`
                      : `${n8nUrl}/workflow/${w.id}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-2 rounded text-muted hover:text-foreground hover:bg-muted/30 transition-default"
                  title="Ouvrir dans n8n"
                >
                  <ExternalLink size={14} />
                </a>
              </div>
              {expanded === w.id && (
                <div className="col-span-3 mt-2 pt-3 border-t border-border">
                  <ExecutionsPanel workflowId={w.id} />
                </div>
              )}
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

// =========================================================================
// Section Workflows IA (apps Dify mode=workflow)
// =========================================================================

interface DifyWorkflow {
  slug: string;
  app_id: string;
  name: string;
  description: string;
  icon: string;
  icon_background: string;
  mode: string;
  installed_at: string;
}

function DifyWorkflowsSection({ isAdmin }: { isAdmin: boolean }) {
  const [workflows, setWorkflows] = useState<DifyWorkflow[] | null>(null);

  useEffect(() => {
    fetch("/api/dify/workflows", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : { workflows: [] })
      .then((j) => setWorkflows(j.workflows || []))
      .catch(() => setWorkflows([]));
  }, []);

  if (!workflows || workflows.length === 0) return null;

  return (
    <section className="mb-8">
      <h2 className="text-xs font-semibold uppercase tracking-wide mb-2 text-muted">
        Workflows IA ({workflows.length})
      </h2>
      <p className="text-xs text-muted mb-3">
        Pipelines IA déterministes (résumé de PDF, traduction, transcription…) installés via la marketplace.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {workflows.map((w) => (
          <div key={w.slug} className="rounded-lg border border-border bg-card p-3 flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-md flex items-center justify-center text-xl shrink-0"
              style={{ background: w.icon_background }}
            >
              {w.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-medium text-sm truncate">{w.name}</div>
              <p className="text-xs text-muted line-clamp-2 mt-0.5">{w.description || "—"}</p>
              <div className="mt-2">
                {isAdmin ? (
                  <a
                    href={`/api/sso/dify?to=${encodeURIComponent("/app/" + w.app_id + "/workflow")}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:opacity-90"
                  >
                    <ExternalLink size={11} />
                    Ouvrir l'éditeur
                  </a>
                ) : (
                  <span className="text-[10px] text-muted">Workflow IA installé</span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

interface N8nExecution {
  id: string;
  finished?: boolean;
  status?: string;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string;
}

interface ExecutionsResponse {
  executions: N8nExecution[];
  stats: { success: number; error: number; running: number; total: number };
}

function ExecutionsPanel({ workflowId }: { workflowId: string }) {
  const [data, setData] = useState<ExecutionsResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/workflows/${workflowId}/executions`, { cache: "no-store" });
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => { load(); }, [load]);

  const statusIcon = (status?: string, finished?: boolean) => {
    if (status === "success" || (finished && !status)) {
      return <CheckCircle2 size={12} className="text-accent" />;
    }
    if (status === "error" || status === "crashed") {
      return <XCircle size={12} className="text-red-400" />;
    }
    if (status === "running" || status === "waiting" || status === "new") {
      return <Clock size={12} className="text-yellow-400 animate-pulse" />;
    }
    return <Clock size={12} className="text-muted" />;
  };

  const dur = (e: N8nExecution) => {
    if (!e.startedAt) return "—";
    const start = new Date(e.startedAt).getTime();
    const end = e.stoppedAt ? new Date(e.stoppedAt).getTime() : Date.now();
    const sec = Math.max(0, Math.round((end - start) / 1000));
    if (sec < 60) return `${sec}s`;
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  };

  return (
    <div className="space-y-2">
      {data && (
        <div className="flex items-center gap-3 text-xs">
          <span className="font-medium text-muted">Sur 7 jours :</span>
          <span className="inline-flex items-center gap-1 text-accent">
            <CheckCircle2 size={11} />
            {data.stats.success} succès
          </span>
          <span className="inline-flex items-center gap-1 text-red-400">
            <XCircle size={11} />
            {data.stats.error} échec{data.stats.error > 1 ? "s" : ""}
          </span>
          {data.stats.running > 0 && (
            <span className="inline-flex items-center gap-1 text-yellow-400">
              <Clock size={11} />
              {data.stats.running} en cours
            </span>
          )}
          <span className="ml-auto">
            <button onClick={load} disabled={loading} className="text-muted hover:text-foreground" title="Rafraîchir">
              <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
            </button>
          </span>
        </div>
      )}
      {loading ? (
        <div className="text-xs text-muted py-2">Chargement…</div>
      ) : !data?.executions || data.executions.length === 0 ? (
        <div className="text-xs text-muted py-2">
          Aucune exécution récente. Cliquez sur ▶ pour déclencher une exécution manuelle.
        </div>
      ) : (
        <div className="rounded-md border border-border divide-y divide-border max-h-60 overflow-y-auto">
          {data.executions.slice(0, 10).map((e) => (
            <div key={e.id} className="px-3 py-1.5 flex items-center gap-2 text-xs">
              {statusIcon(e.status, e.finished)}
              <span className="font-mono text-muted text-[10px]">#{e.id}</span>
              <span className="text-muted">{e.mode || "manual"}</span>
              <span className="flex-1" />
              <span className="text-[10px] text-muted">{dur(e)}</span>
              <span className="text-[10px] text-muted">
                {e.startedAt ? new Date(e.startedAt).toLocaleString("fr-FR", {
                  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
                }) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
