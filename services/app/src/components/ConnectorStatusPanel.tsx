"use client";

/**
 * Panneau de statut détaillé d'un connecteur, affiché en haut de la
 * modale de gestion. Donne une vue d'ensemble :
 *   - Compte connecté (email, scopes humanisés)
 *   - Périmètre (drives sélectionnés / inbox / calendrier)
 *   - Indexation RAG (chunks Qdrant, last sync) si applicable
 *   - Volume (count emails / events) si applicable
 *   - Lien direct vers /rag (filtré sur cette collection)
 *
 * Source : GET /api/connectors/[slug]/status (route agrégée).
 *
 * Admin only. Ré-utilisable dans la modale ConnectorsManager.
 */
import { useEffect, useState, useCallback } from "react";
import {
  Loader2, AlertTriangle, CheckCircle2, Database, Mail,
  Calendar, Folder, ExternalLink, RefreshCw, Search, FileText,
} from "lucide-react";

interface SelectedDrive {
  drive_id: string;
  drive_name: string;
  site_name: string;
  web_url?: string;
}

interface StatusResponse {
  slug: string;
  spec_name: string;
  spec_icon: string;
  connector_state?: {
    status: string;
    activated_at: number | null;
    last_sync_at: number | null;
    last_error: string | null;
  } | null;
  account: {
    email: string | null;
    name: string | null;
    provider_id: string;
    scopes_human: string[];
    expires_at: number | null;
    connected_at: number;
  } | null;
  rag?: {
    container: string;
    running: boolean;
    started_at?: string;
    collection: string;
    points: number;
    qdrant_status: string;
  } | null;
  scope: Record<string, unknown>;
}

export function ConnectorStatusPanel({ slug }: { slug: string }) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/connectors/${encodeURIComponent(slug)}/status`, {
        cache: "no-store",
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "load_failed");
      } else {
        setStatus(j);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => { refresh(); }, [refresh]);

  async function syncNow() {
    setSyncing(true);
    try {
      await fetch(`/api/connectors/${encodeURIComponent(slug)}/sync`, { method: "POST" });
      // Polling court pour voir le effect du restart
      setTimeout(() => refresh(), 2000);
    } finally {
      setTimeout(() => setSyncing(false), 2000);
    }
  }

  if (loading && !status) {
    return (
      <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted flex items-center gap-2">
        <Loader2 size={12} className="animate-spin" /> Chargement du statut…
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-300 flex items-start gap-2">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>Statut indisponible : {error || "unknown"}</span>
      </div>
    );
  }

  const isActive = status.connector_state?.status === "active";

  return (
    <div className="rounded-lg border border-border bg-card/50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
          État du connecteur
        </h3>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-muted hover:text-foreground transition-default p-1 rounded disabled:opacity-50"
          title="Rafraîchir"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {/* Compte */}
      {status.account ? (
        <div className="flex items-start gap-2 text-xs">
          <CheckCircle2 size={12} className="text-emerald-400 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div>
              Connecté avec{" "}
              <span className="font-medium text-foreground">
                {status.account.email || "(email indisponible)"}
              </span>
              {status.account.name && (
                <span className="text-muted"> · {status.account.name}</span>
              )}
            </div>
            {status.account.scopes_human.length > 0 && (
              <div className="text-[10px] text-muted mt-0.5">
                Permissions : {status.account.scopes_human.join(" · ")}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2 text-xs text-muted">
          <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <span>Aucune connexion OAuth — branche le compte ci-dessous.</span>
        </div>
      )}

      {/* Périmètre + indexation */}
      <ScopeBlock status={status} />

      {/* RAG card si applicable */}
      {status.rag && (
        <RagBlock
          rag={status.rag}
          syncing={syncing}
          onSyncNow={syncNow}
        />
      )}

      {/* Permissions/last_error issus de connector_state */}
      {status.connector_state?.last_error && (
        <div className="text-[11px] text-red-400 flex items-start gap-1">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          Dernière erreur : {status.connector_state.last_error}
        </div>
      )}

      {!isActive && status.account && (
        <div className="text-[11px] text-amber-300 flex items-start gap-1">
          <AlertTriangle size={11} className="mt-0.5 shrink-0" />
          Connecteur en mode <code className="text-foreground">inactive</code> côté
          AI Box — clique « Activer » en bas pour le rendre disponible aux agents.
        </div>
      )}
    </div>
  );
}

function ScopeBlock({ status }: { status: StatusResponse }) {
  const scope = status.scope as Record<string, unknown>;
  const type = scope.type as string;

  if (type === "sharepoint_libraries") {
    const libs = (scope.libraries as SelectedDrive[]) || [];
    return (
      <div className="text-xs">
        <div className="flex items-center gap-1.5 text-muted mb-1">
          <Folder size={11} />
          <span>Bibliothèques sélectionnées ({libs.length})</span>
        </div>
        {libs.length === 0 ? (
          <div className="text-[11px] text-amber-300 ml-4">
            Aucune bibliothèque cochée. Utilise le sélecteur ci-dessous pour
            choisir ce qu'il faut indexer.
          </div>
        ) : (
          <ul className="ml-4 space-y-0.5">
            {libs.map((l) => (
              <li key={l.drive_id} className="text-foreground/90 truncate">
                <FileText size={10} className="inline mr-1 text-muted" />
                {l.site_name} → <span className="font-medium">{l.drive_name}</span>
                {l.web_url && (
                  <a href={l.web_url} target="_blank" rel="noopener noreferrer"
                     className="text-muted hover:text-primary ml-1">
                    <ExternalLink size={10} className="inline" />
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (type === "google_drive") {
    return (
      <div className="text-xs flex items-start gap-1.5">
        <Folder size={11} className="text-muted mt-0.5 shrink-0" />
        <div>
          <div>
            Périmètre :{" "}
            {scope.shared_drive_id
              ? <span className="font-medium">Drive partagé <code className="text-[10px]">{String(scope.shared_drive_id).slice(0, 16)}…</code></span>
              : <span>tout le Drive de l'utilisateur</span>}
          </div>
        </div>
      </div>
    );
  }

  if (type === "onedrive_user") {
    return (
      <div className="text-xs flex items-start gap-1.5 text-muted">
        <Folder size={11} className="mt-0.5 shrink-0" />
        Périmètre : OneDrive personnel/business du compte connecté
      </div>
    );
  }

  if (type === "gmail_inbox" || type === "outlook_inbox") {
    const count = scope.messages_total as number | null;
    return (
      <div className="text-xs flex items-start gap-1.5">
        <Mail size={11} className="text-muted mt-0.5 shrink-0" />
        <div className="flex-1">
          <div>
            Boîte mail :{" "}
            {count != null
              ? <span className="font-medium">{count.toLocaleString("fr-FR")} messages</span>
              : <span className="text-muted">count indisponible</span>}
          </div>
          {scope.note ? (
            <div className="text-[10px] text-muted mt-0.5">{String(scope.note)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  if (type === "google_calendar" || type === "outlook_calendar") {
    const count = scope.upcoming_30d as number | null;
    return (
      <div className="text-xs flex items-start gap-1.5">
        <Calendar size={11} className="text-muted mt-0.5 shrink-0" />
        <div className="flex-1">
          <div>
            Événements à venir (30 j) :{" "}
            {count != null
              ? <span className="font-medium">{count}</span>
              : <span className="text-muted">indisponible</span>}
          </div>
          {scope.note ? (
            <div className="text-[10px] text-muted mt-0.5">{String(scope.note)}</div>
          ) : null}
        </div>
      </div>
    );
  }

  return null;
}

function RagBlock({
  rag, syncing, onSyncNow,
}: {
  rag: NonNullable<StatusResponse["rag"]>;
  syncing: boolean;
  onSyncNow: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2 space-y-1">
      <div className="flex items-center gap-1.5 text-xs">
        <Database size={11} className="text-primary" />
        <span className="text-muted">Indexation RAG</span>
        <span className="ml-auto text-[10px] text-muted font-mono">
          {rag.collection}
        </span>
      </div>
      <div className="text-xs flex items-center gap-2 flex-wrap">
        <span>
          <span className="font-semibold text-foreground">
            {rag.points.toLocaleString("fr-FR")}
          </span>{" "}
          chunks indexés
        </span>
        <StatusDot
          color={
            rag.qdrant_status === "green"
              ? "bg-emerald-400"
              : rag.qdrant_status === "yellow"
              ? "bg-amber-400"
              : "bg-gray-400"
          }
          label={rag.qdrant_status}
        />
        <span className="text-muted">·</span>
        <span className="text-muted">
          worker:{" "}
          {rag.running ? (
            <span className="text-emerald-300">running</span>
          ) : (
            <span className="text-red-300">arrêté</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2 pt-1 flex-wrap">
        <button
          onClick={onSyncNow}
          disabled={syncing || !rag.running}
          className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted/30 disabled:opacity-50"
          title={rag.running ? "Force un sync immédiat" : "Worker arrêté"}
        >
          {syncing ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
          Synchroniser maintenant
        </button>
        <a
          href={`/rag#${encodeURIComponent(rag.collection)}`}
          className="text-[11px] inline-flex items-center gap-1 px-2 py-1 rounded border border-border hover:bg-muted/30 text-primary/90"
          title="Ouvrir le panneau RAG pour tester une recherche"
        >
          <Search size={10} /> Tester dans le RAG
        </a>
      </div>
    </div>
  );
}

function StatusDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted">
      <span className={`w-1.5 h-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}
