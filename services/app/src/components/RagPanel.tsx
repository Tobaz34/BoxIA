"use client";

/**
 * Page /rag — Contrôle du RAG (Admin only).
 *
 * Trois fonctionnalités :
 *  1. Vue d'ensemble : 1 carte par collection Qdrant `rag_*` (taille,
 *     points, status, source, distance).
 *  2. Voir un échantillon : pour une collection donnée, liste les N
 *     fichiers indexés (group_by_file), avec preview, source et
 *     web_url ouvert dans un nouvel onglet.
 *  3. Tester une recherche : input texte → embed bge-m3 + Qdrant
 *     search → top-K hits avec score et preview.
 *
 * L'admin peut ainsi répondre à : "le RAG marche-t-il ?", "quels docs
 * sont dedans ?", "trouve-t-il bien le doc X quand je cherche Y ?"
 * sans passer par un agent.
 */
import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Database, RefreshCw, AlertCircle, Search, FileText,
  ExternalLink, ChevronDown, ChevronRight, Loader2,
} from "lucide-react";

interface Collection {
  name: string;
  source: string;
  tenant: string;
  status: string;
  points_count: number;
  indexed_vectors_count: number;
  segments_count: number;
  vector_size: number;
  vector_distance: string;
}

interface SampleFile {
  file_id: string;
  name: string;
  source?: string;
  web_url?: string;
  modified_at?: string;
  chunks: number;
  sample_text?: string;
}

interface SearchHit {
  id: string | number;
  score: number;
  name: string | null;
  source: string | null;
  file_id: string | null;
  chunk_idx: number | null;
  web_url: string | null;
  text_preview: string | null;
}

interface SearchResponse {
  collection: string;
  query: string;
  embed_ms: number;
  search_ms: number;
  vector_dim: number;
  count: number;
  hits: SearchHit[];
}

const SOURCE_LABEL: Record<string, { label: string; icon: string }> = {
  gdrive: { label: "Google Drive", icon: "📂" },
  msgraph: { label: "Microsoft 365 (OneDrive / SharePoint)", icon: "🔵" },
  smb: { label: "Partage SMB / NAS", icon: "💾" },
  nextcloud: { label: "Nextcloud", icon: "☁️" },
  unknown: { label: "Inconnu", icon: "❓" },
};

export function RagPanel() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/rag/collections", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "fetch_failed");
        setCollections([]);
      } else {
        setCollections(j.collections);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) refresh();
  }, [isAdmin, refresh]);

  if (!isAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <AlertCircle size={32} className="mx-auto text-muted mb-3" />
          <h1 className="text-lg font-semibold mb-1">Accès réservé</h1>
          <p className="text-sm text-muted">
            Le contrôle du RAG est réservé aux administrateurs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto pb-20">
      <header className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center shrink-0">
            <Database size={20} />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">Contrôle du RAG</h1>
            <p className="text-sm text-muted">
              {collections === null
                ? "Chargement…"
                : collections.length === 0
                ? "Aucune collection indexée pour l'instant — branchez un connecteur (Google Drive, OneDrive…) puis lancez une synchronisation."
                : `${collections.length} collection${collections.length > 1 ? "s" : ""} · ` +
                  `${collections.reduce((acc, c) => acc + c.points_count, 0).toLocaleString("fr-FR")} chunks indexés`}
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="text-muted hover:text-foreground transition-default p-2 rounded hover:bg-muted/20 disabled:opacity-50"
          title="Rafraîchir"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error === "qdrant_unreachable"
            ? "Qdrant n'est pas joignable. Vérifie que le service `aibox-qdrant` tourne."
            : error}
        </div>
      )}

      {collections && collections.length > 0 && (
        <div className="space-y-3">
          {collections.map((c) => {
            const meta = SOURCE_LABEL[c.source] || SOURCE_LABEL.unknown;
            const isOpen = expanded === c.name;
            return (
              <div
                key={c.name}
                className="rounded-lg border border-border bg-card overflow-hidden"
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : c.name)}
                  className="w-full px-4 py-3 grid grid-cols-[auto_1fr_auto_auto] gap-3 items-center hover:bg-muted/10 transition-default"
                >
                  <span className="text-2xl">{meta.icon}</span>
                  <div className="min-w-0 text-left">
                    <div className="font-medium truncate flex items-center gap-2">
                      {meta.label}
                      <span className="text-[10px] uppercase tracking-wide text-muted">
                        {c.tenant}
                      </span>
                    </div>
                    <div className="text-xs text-muted font-mono truncate">{c.name}</div>
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <StatusBadge status={c.status} />
                    <span className="text-muted">
                      {c.points_count.toLocaleString("fr-FR")} chunks · {c.vector_size}-d {c.vector_distance}
                    </span>
                  </div>
                  {isOpen ? <ChevronDown size={16} className="text-muted" /> : <ChevronRight size={16} className="text-muted" />}
                </button>
                {isOpen && <CollectionDetails collection={c.name} />}
              </div>
            );
          })}
        </div>
      )}

      {collections && collections.length === 0 && !error && (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted">
          <Database size={32} className="mx-auto mb-3 opacity-40" />
          <p className="mb-1">Aucune collection RAG pour l'instant.</p>
          <p>Branchez un connecteur (Google Drive, OneDrive…) puis lancez une synchronisation depuis <a href="/connectors" className="text-primary hover:underline">/connectors</a>.</p>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === "green"
    ? "bg-emerald-500/15 text-emerald-300"
    : status === "yellow"
    ? "bg-amber-500/15 text-amber-300"
    : status === "red"
    ? "bg-red-500/15 text-red-300"
    : "bg-muted/30 text-muted";
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full ${cls}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        status === "green" ? "bg-emerald-400" :
        status === "yellow" ? "bg-amber-400" :
        status === "red" ? "bg-red-400" : "bg-gray-400"
      }`} />
      {status}
    </span>
  );
}

function CollectionDetails({ collection }: { collection: string }) {
  const [tab, setTab] = useState<"sample" | "search">("sample");
  return (
    <div className="border-t border-border bg-background/40">
      <div className="flex border-b border-border">
        <TabButton active={tab === "sample"} onClick={() => setTab("sample")} label="Documents indexés" />
        <TabButton active={tab === "search"} onClick={() => setTab("search")} label="Tester une recherche" />
      </div>
      <div className="p-4">
        {tab === "sample" && <SampleView collection={collection} />}
        {tab === "search" && <SearchView collection={collection} />}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className={
        "px-4 py-2 text-xs font-medium transition-default border-b-2 " +
        (active
          ? "border-primary text-foreground"
          : "border-transparent text-muted hover:text-foreground")
      }
    >
      {label}
    </button>
  );
}

function SampleView({ collection }: { collection: string }) {
  const [files, setFiles] = useState<SampleFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(
        `/api/rag/sample?collection=${encodeURIComponent(collection)}&limit=30&group_by_file=1`,
        { cache: "no-store" },
      );
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "load_failed");
      } else {
        setFiles(j.files);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [collection]);

  useEffect(() => { load(); }, [load]);

  if (loading && !files) {
    return <div className="text-xs text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>;
  }
  if (error) {
    return <div className="text-xs text-red-400">Erreur : {error}</div>;
  }
  if (!files || files.length === 0) {
    return <div className="text-xs text-muted">Aucun fichier indexé.</div>;
  }
  return (
    <div className="space-y-2">
      {files.map((f) => (
        <div key={f.file_id} className="rounded-md border border-border bg-card p-3">
          <div className="flex items-start gap-2">
            <FileText size={14} className="text-muted mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium truncate">{f.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/30 text-muted">
                  {f.chunks} chunk{f.chunks > 1 ? "s" : ""}
                </span>
                {f.modified_at && (
                  <span className="text-[10px] text-muted">
                    modifié le {new Date(f.modified_at).toLocaleDateString("fr-FR")}
                  </span>
                )}
              </div>
              {f.sample_text && (
                <p className="text-xs text-muted mt-1 line-clamp-2 font-mono">
                  {f.sample_text}
                </p>
              )}
            </div>
            {f.web_url && (
              <a
                href={f.web_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted hover:text-primary p-1 shrink-0"
                title="Ouvrir le document"
              >
                <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SearchView({ collection }: { collection: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch() {
    if (!query.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetch("/api/rag/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection, query, limit: 5 }),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.error || "search_failed");
      } else {
        setResult(j);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
            placeholder="Ex : Pourquoi mon TJM augmente en 2025 ?"
            className="w-full bg-background border border-border rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none focus:border-primary"
          />
        </div>
        <button
          onClick={runSearch}
          disabled={loading || !query.trim()}
          className="px-4 py-2 text-sm font-medium rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Chercher
        </button>
      </div>
      {error && <div className="text-xs text-red-400">Erreur : {error}</div>}
      {result && (
        <>
          <div className="text-[10px] text-muted">
            {result.count} résultats · embed {result.embed_ms} ms · search {result.search_ms} ms · vecteur {result.vector_dim}-d
          </div>
          <div className="space-y-2">
            {result.hits.map((h) => (
              <div key={String(h.id)} className="rounded-md border border-border bg-card p-3">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <ScoreBadge score={h.score} />
                  <span className="font-medium truncate">{h.name || "(sans nom)"}</span>
                  {h.chunk_idx !== null && (
                    <span className="text-[10px] text-muted">chunk #{h.chunk_idx}</span>
                  )}
                  {h.web_url && (
                    <a href={h.web_url} target="_blank" rel="noopener noreferrer"
                       className="text-muted hover:text-primary ml-auto" title="Ouvrir">
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
                {h.text_preview && (
                  <p className="text-xs text-muted font-mono line-clamp-3">{h.text_preview}</p>
                )}
              </div>
            ))}
            {result.count === 0 && (
              <div className="text-xs text-muted">Aucun résultat. Essayez avec d'autres mots-clés.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const cls = score > 0.7 ? "bg-emerald-500/15 text-emerald-300"
    : score > 0.5 ? "bg-amber-500/15 text-amber-300"
    : "bg-muted/30 text-muted";
  return (
    <span className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full ${cls} font-mono`}>
      {pct}%
    </span>
  );
}
