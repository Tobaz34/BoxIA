"use client";

/**
 * Chip live-status pour les connecteurs RAG OAuth (google-drive, onedrive,
 * sharepoint).
 *
 * Affiche, en complément du libellé "sync : il y a 5 min" basé sur
 * connectors-state, un indicateur LIVE :
 *   - 🟢 "actif · N points indexés" quand le worker tourne et qu'un Sync OK
 *     a été vu dans les logs.
 *   - 🟡 "synchronisation en cours…" pendant le 1er run.
 *   - 🔴 "erreur : <log line>" si Sync KO.
 *   - ⚪️ "non démarré" si le container n'existe pas (toujours le cas tant
 *     qu'on n'a pas cliqué « Synchroniser »).
 *
 * Source : GET /api/connectors/sync-status?slug=<slug>. Polling 10 s.
 *
 * Composant pensé léger : monté uniquement pour les slugs sync-able.
 */
import { useEffect, useState } from "react";

const SYNC_SLUGS = new Set(["google-drive", "onedrive", "sharepoint"]);
const POLL_MS = 10_000;

interface SyncStatus {
  slug: string;
  container: string;
  running: boolean;
  state?: "idle" | "syncing" | "error" | "stopped";
  not_started?: boolean;
  qdrant?: { points: number; status: string };
  last_sync?: { ok: boolean | null; log_line: string | null };
  hint?: string;
  error?: string;
}

export function ConnectorSyncStatus({ slug }: { slug: string }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!SYNC_SLUGS.has(slug)) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`/api/connectors/sync-status?slug=${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        if (!cancelled && r.ok) {
          const j = (await r.json()) as SyncStatus;
          setStatus(j);
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [slug]);

  if (!SYNC_SLUGS.has(slug)) return null;
  if (!status) return null;

  // Render
  if (status.not_started || status.error === "container_not_found") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted/30 text-muted"
        title={status.hint || "Worker non démarré"}
      >
        <Dot color="bg-gray-400" /> non démarré
      </span>
    );
  }

  if (status.state === "syncing") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300"
        title={`Worker ${status.container} actif — premier sync en cours`}
      >
        <Dot color="bg-amber-400" pulse /> synchronisation…
      </span>
    );
  }

  if (status.state === "error") {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-300"
        title={status.last_sync?.log_line || "Sync KO"}
      >
        <Dot color="bg-red-400" /> erreur
      </span>
    );
  }

  if (status.state === "idle") {
    const points = status.qdrant?.points ?? 0;
    return (
      <span
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300"
        title={status.last_sync?.log_line || "Worker en attente, dernier sync OK"}
      >
        <Dot color="bg-emerald-400" /> actif · {points.toLocaleString("fr-FR")} pts
      </span>
    );
  }

  // Cas dégradés (ex: docker_unreachable)
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-muted/30 text-muted"
      title={status.hint || status.error || (loading ? "chargement…" : "")}
    >
      <Dot color="bg-gray-400" /> état inconnu
    </span>
  );
}

function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={
        "w-1.5 h-1.5 rounded-full " + color + (pulse ? " animate-pulse" : "")
      }
    />
  );
}
