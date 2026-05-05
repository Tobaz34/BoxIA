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
import { useEffect, useState, useCallback } from "react";
import {
  Package, RefreshCw, ExternalLink, Loader2, AlertTriangle,
  CheckCircle2, ArrowUpCircle,
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

export function ServicesVersionsCard() {
  const [data, setData] = useState<VersionsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => { refresh(); }, [refresh]);

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
          <div className="divide-y divide-border">
            {data.services.map((s) => (
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
            ))}
          </div>
          <footer className="px-4 py-2 text-[10px] text-muted border-t border-border bg-background/40">
            Vérifié il y a {Math.round((Date.now() - new Date(data.fetched_at).getTime()) / 60000)} min
            {data.cached ? " (cache)" : ""}.
            {data.outdated > 0 && (
              <span className="ml-2">
                Pour mettre à jour : modifier la variable VERSION dans <code className="text-foreground">/srv/ai-stack/.env</code> + relancer <code className="text-foreground">tools/deploy-to-xefia.sh main</code>.
              </span>
            )}
          </footer>
        </>
      )}
    </section>
  );
}
