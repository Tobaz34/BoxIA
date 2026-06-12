"use client";

/**
 * Carte « Versions des services » dans /system.
 *
 * Pour chaque service Docker tiers (Dify, Qdrant, n8n, Authentik,
 * Ollama, Langfuse), affiche la version actuelle + le latest stable
 * sur GitHub Releases, avec un badge ⚠ si une mise à jour est dispo.
 *
 * V1 : info-only (pas de bouton « Mettre à jour »). L'admin change
 * la version dans .env serveur puis redéploie. La V2 ajoutera le
 * bouton qui patch .env via le watcher hôte.
 *
 * Source : GET /api/system/services-versions (cache 30 min côté
 * serveur pour ne pas spammer GitHub Releases API).
 */
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Package, RefreshCw, ExternalLink, Loader2, AlertTriangle,
  CheckCircle2, ArrowUpCircle, RotateCcw, X,
} from "lucide-react";

interface ServiceVersion {
  slug: string;
  name: string;
  current: string | null;
  latest: string | null;
  github_repo: string;
  up_to_date: boolean | null;
  latest_published_at: string | null;
  release_url: string;
  release_name?: string;
  error?: string | null;
}

interface VersionsResponse {
  services: ServiceVersion[];
  fetched_at: string;
  total: number;
  outdated: number;
  cached?: boolean;
}

interface UpdateStatus {
  state: "idle" | "requested" | "running" | "done" | "rolled_back" | "failed" | "unknown";
  message?: string;
  slug?: string;
  target?: string;
  log_tail?: string[];
  exit_code?: number;
  finished_at?: string;
}

const SLUGS_UPDATABLE = new Set([
  "dify", "qdrant", "authentik", "n8n", "ollama", "langfuse",
]);

export function ServicesVersionsCard() {
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/system/services-versions", { cache: "no-store" });
      if (r.status === 403) {
        setError("forbidden");
        return;
      }
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "fetch_failed");
      } else {
        setData(j);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Polling de l'update status quand on est dans un état actif.
  // Stop dès qu'on atteint un état terminal (done / rolled_back / failed).
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchStatusOnce = useCallback(async () => {
    try {
      const r = await fetch("/api/system/services-versions/update-status", {
        cache: "no-store",
      });
      if (!r.ok) return;
      const j = (await r.json()) as UpdateStatus;
      setUpdateStatus(j);
      if (["done", "rolled_back", "failed", "idle"].includes(j.state)) {
        stopPolling();
        // Refresh la liste des versions (le current a changé si done)
        if (j.state === "done") refresh();
      }
    } catch { /* tolère */ }
  }, [refresh, stopPolling]);

  useEffect(() => {
    refresh();
    fetchStatusOnce(); // au cas où une MAJ est en cours quand on charge la page
    return () => stopPolling();
  }, [refresh, fetchStatusOnce, stopPolling]);

  // Si on détecte un état actif au load, on lance le polling.
  useEffect(() => {
    if (
      updateStatus &&
      ["requested", "running"].includes(updateStatus.state) &&
      !pollRef.current
    ) {
      pollRef.current = setInterval(fetchStatusOnce, 2000);
    }
  }, [updateStatus, fetchStatusOnce]);

  async function startUpdate(slug: string, targetVersion: string, name: string) {
    if (!confirm(
      `Mettre à jour ${name} vers ${targetVersion} ?\n\n` +
      `→ Image Docker pull\n` +
      `→ Container recreate\n` +
      `→ Smoke test (90s timeout)\n` +
      `→ Rollback automatique si KO\n\n` +
      `Le service sera indisponible 30-60 secondes pendant la MAJ.`,
    )) return;
    try {
      const r = await fetch("/api/system/services-versions/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, target_version: targetVersion }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert("Échec : " + (j.error || `HTTP ${r.status}`));
        return;
      }
      setUpdateStatus(j);
      // Démarre le polling immédiatement
      stopPolling();
      pollRef.current = setInterval(fetchStatusOnce, 2000);
    } catch (e) {
      alert("Erreur : " + (e as Error).message);
    }
  }

  if (error === "forbidden") return null;

  return (
    <section className="mb-6 rounded-lg border border-border bg-card overflow-hidden">
      <header className="px-4 py-3 flex items-center justify-between border-b border-border">
        <div className="flex items-center gap-2">
          <Package size={16} className="text-primary" />
          <h2 className="text-sm font-semibold">Versions des services tiers</h2>
          {data && (
            <span className="text-xs text-muted">
              ({data.total} services · {data.outdated > 0 ? (
                <span className="text-amber-300">{data.outdated} mise{data.outdated > 1 ? "s" : ""} à jour dispo</span>
              ) : (
                <span className="text-emerald-300">tout à jour</span>
              )})
            </span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-muted hover:text-foreground p-1 rounded hover:bg-muted/20 disabled:opacity-50"
          title="Forcer le check (vide le cache GitHub 30 min)"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {loading && !data && (
        <div className="px-4 py-6 text-xs text-muted flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" /> Vérification GitHub Releases…
        </div>
      )}

      {error && error !== "forbidden" && (
        <div className="px-4 py-3 text-xs text-amber-300 flex items-start gap-1.5">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {data && (
        <>
          {updateStatus && updateStatus.state !== "idle" && (
            <UpdateStatusPanel status={updateStatus} onDismiss={() => setUpdateStatus(null)} />
          )}
          <div className="divide-y divide-border">
            {data.services.map((s) => {
              const updating = updateStatus?.slug === s.slug
                && ["requested", "running"].includes(updateStatus.state);
              const canUpdate = SLUGS_UPDATABLE.has(s.slug)
                && s.up_to_date === false
                && s.latest
                && !updating
                && !(updateStatus && ["requested", "running"].includes(updateStatus.state));
              return (
                <div key={s.slug} className="px-4 py-3 grid grid-cols-[1fr_auto_auto] gap-3 items-center text-xs">
                  <div className="min-w-0">
                    <div className="font-medium">{s.name}</div>
                    <div className="text-[10px] text-muted font-mono truncate">{s.github_repo}</div>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <div className="font-mono">
                      <span className="text-muted">v</span>
                      <span className={s.current ? "text-foreground" : "text-muted/50"}>
                        {s.current || "?"}
                      </span>
                      {s.latest && s.up_to_date === false && (
                        <>
                          <span className="text-muted"> → </span>
                          <span className="text-amber-300">v{s.latest}</span>
                        </>
                      )}
                    </div>
                    {s.latest_published_at && (
                      <div className="text-[10px] text-muted">
                        {s.up_to_date === false
                          ? `latest du ${new Date(s.latest_published_at).toLocaleDateString("fr-FR")}`
                          : `à jour`}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {s.error ? (
                      <span title={s.error} className="text-muted">
                        <AlertTriangle size={12} />
                      </span>
                    ) : s.up_to_date === false ? (
                      <ArrowUpCircle size={14} className="text-amber-300" />
                    ) : s.up_to_date === true ? (
                      <CheckCircle2 size={14} className="text-emerald-400" />
                    ) : null}
                    {canUpdate && (
                      <button
                        onClick={() => startUpdate(s.slug, s.latest!, s.name)}
                        className="text-[10px] px-2 py-1 rounded bg-primary/15 text-primary hover:bg-primary/25"
                        title={`Mettre à jour ${s.name} vers v${s.latest}`}
                      >
                        Mettre à jour
                      </button>
                    )}
                    {updating && (
                      <span className="text-[10px] text-amber-300 inline-flex items-center gap-1">
                        <Loader2 size={10} className="animate-spin" /> MAJ…
                      </span>
                    )}
                    <a
                      href={s.release_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-muted hover:text-primary"
                      title="Voir les release notes sur GitHub"
                    >
                      <ExternalLink size={11} />
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
          <footer className="px-4 py-2 text-[10px] text-muted border-t border-border bg-background/40">
            Vérifié il y a {Math.round((Date.now() - new Date(data.fetched_at).getTime()) / 60000)} min
            {data.cached ? " (cache)" : ""}.
            {data.outdated > 0 && !updateStatus && (
              <span className="ml-2">
                Clique « Mettre à jour » sur un service pour lancer la MAJ avec rollback automatique.
              </span>
            )}
          </footer>
        </>
      )}
    </section>
  );
}

/**
 * Bandeau live au-dessus de la liste pendant qu'une MAJ tourne (ou
 * vient de finir, jusqu'à dismiss).
 */
function UpdateStatusPanel({
  status, onDismiss,
}: { status: UpdateStatus; onDismiss: () => void }) {
  const colors: Record<string, { bg: string; border: string; text: string; label: string; icon: React.ReactNode }> = {
    requested: {
      bg: "bg-blue-500/10", border: "border-blue-500/30", text: "text-blue-300",
      label: "En attente du watcher hôte",
      icon: <Loader2 size={12} className="animate-spin" />,
    },
    running: {
      bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-300",
      label: "MAJ en cours",
      icon: <Loader2 size={12} className="animate-spin" />,
    },
    done: {
      bg: "bg-emerald-500/10", border: "border-emerald-500/30", text: "text-emerald-300",
      label: "MAJ réussie",
      icon: <CheckCircle2 size={12} />,
    },
    rolled_back: {
      bg: "bg-amber-500/10", border: "border-amber-500/30", text: "text-amber-300",
      label: "Rollback automatique (smoke test KO)",
      icon: <RotateCcw size={12} />,
    },
    failed: {
      bg: "bg-red-500/10", border: "border-red-500/30", text: "text-red-300",
      label: "Échec — vérifier manuellement",
      icon: <AlertTriangle size={12} />,
    },
    unknown: {
      bg: "bg-muted/10", border: "border-border", text: "text-muted",
      label: "État inconnu",
      icon: <AlertTriangle size={12} />,
    },
  };
  const c = colors[status.state] || colors.unknown;
  const isTerminal = ["done", "rolled_back", "failed"].includes(status.state);

  return (
    <div className={`mx-4 mt-3 mb-1 rounded-md border ${c.bg} ${c.border} px-3 py-2 text-xs space-y-2`}>
      <div className="flex items-start gap-2">
        <span className={`${c.text} mt-0.5 shrink-0`}>{c.icon}</span>
        <div className="flex-1 min-w-0">
          <div className={`font-medium ${c.text}`}>
            {c.label}
            {status.slug && status.target && (
              <span className="text-muted font-normal">
                {" — "}{status.slug} → v{status.target}
              </span>
            )}
          </div>
          {status.message && (
            <div className="text-[11px] text-muted mt-0.5 truncate">
              {status.message}
            </div>
          )}
        </div>
        {isTerminal && (
          <button
            onClick={onDismiss}
            className="text-muted hover:text-foreground p-0.5 shrink-0"
            title="Fermer"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {status.log_tail && status.log_tail.length > 0 && (
        <details className="text-[10px]">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Voir le log ({status.log_tail.length} lignes)
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto bg-background/40 rounded p-2 font-mono text-foreground/80 whitespace-pre-wrap">
            {status.log_tail.slice(-30).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
