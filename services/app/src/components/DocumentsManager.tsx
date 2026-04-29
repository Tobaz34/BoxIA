"use client";

/**
 * Page /documents : drag & drop + liste des documents indexés dans la
 * Knowledge Base partagée. Tous les agents (général, comptable, RH,
 * support) ont la KB attachée → ils peuvent répondre en s'appuyant
 * sur ces documents (RAG).
 */
import {
  Upload, FileText, FileSpreadsheet, FileCode, FileJson,
  Trash2, RefreshCw, AlertCircle, CheckCircle2, Loader2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

interface DifyDoc {
  id: string;
  name: string;
  data_source_type?: string;
  data_source_info?: { upload_file_id?: string; upload_file?: { extension?: string } };
  position?: number;
  doc_form?: string;
  word_count?: number;
  hit_count?: number;
  enabled?: boolean;
  archived?: boolean;
  display_status?: string;       // "indexing" | "available" | "error" | ...
  indexing_status?: string;
  created_at?: number;
  updated_at?: number;
  tokens?: number;
}

const ACCEPT =
  ".pdf,.txt,.md,.markdown,.docx,.csv,.xlsx,.html,.htm,.json,.xml";

function iconFor(name: string) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["xlsx", "csv"].includes(ext)) return FileSpreadsheet;
  if (["json", "xml"].includes(ext)) return FileJson;
  if (["html", "htm", "md", "markdown"].includes(ext)) return FileCode;
  return FileText;
}

function relTime(epoch?: number): string {
  if (!epoch) return "—";
  const ms = Date.now() - epoch * 1000;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(epoch * 1000).toLocaleDateString("fr-FR");
}

function statusBadge(d: DifyDoc) {
  const s = d.display_status || d.indexing_status || "";
  if (s === "available" || d.enabled) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-accent/15 text-accent">
        <CheckCircle2 size={10} /> indexé
      </span>
    );
  }
  if (s === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-400">
        <AlertCircle size={10} /> erreur
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-muted/20 text-muted">
      <Loader2 size={10} className="animate-spin" /> {s || "en cours"}
    </span>
  );
}

export function DocumentsManager() {
  const [docs, setDocs] = useState<DifyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/documents?limit=100", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.message || `Erreur ${r.status}`);
        setDocs([]);
        return;
      }
      const j = await r.json();
      setDocs(j.data || []);
      setError(null);
    } catch {
      setError("Connexion au serveur impossible");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    // Auto-refresh tant que des docs sont en cours d'indexation
    const t = setInterval(() => {
      // peek: si un doc est encore en cours, refresh
      const indexing = docs.some(
        (d) =>
          (d.display_status || d.indexing_status || "") !== "available" &&
          (d.display_status || d.indexing_status || "") !== "error",
      );
      if (indexing) refresh();
    }, 5000);
    return () => clearInterval(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function uploadFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      for (const f of list) {
        const fd = new FormData();
        fd.append("file", f);
        const r = await fetch("/api/documents", {
          method: "POST",
          body: fd,
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          setError(
            `Échec upload « ${f.name} » : ${j.message || j.error || r.status}`,
          );
          break;
        }
      }
      await refresh();
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Supprimer « ${name} » de la base de connaissances ?`)) return;
    const r = await fetch(`/api/documents/${id}`, { method: "DELETE" });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setError(`Échec suppression : ${j.message || j.error || r.status}`);
    } else {
      await refresh();
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) {
      uploadFiles(e.dataTransfer.files);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <FileText size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Documents</h1>
            <p className="text-sm text-muted">
              Base de connaissances partagée par tous les assistants.
            </p>
          </div>
        </div>
        <button
          onClick={refresh}
          className="text-muted hover:text-foreground transition-default p-2 rounded hover:bg-muted/20"
          title="Rafraîchir"
        >
          <RefreshCw size={16} />
        </button>
      </header>

      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={
          "cursor-pointer rounded-lg border-2 border-dashed transition-default p-8 text-center " +
          (dragOver
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/60 hover:bg-muted/10")
        }
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            if (e.target.files) uploadFiles(e.target.files);
            if (e.target) e.target.value = "";
          }}
        />
        {uploading ? (
          <>
            <Loader2 size={28} className="mx-auto mb-2 text-primary animate-spin" />
            <div className="text-sm">Téléversement en cours…</div>
          </>
        ) : (
          <>
            <Upload size={28} className="mx-auto mb-2 text-muted" />
            <div className="text-sm font-medium">
              Glissez vos fichiers ici ou cliquez pour parcourir
            </div>
            <div className="text-xs text-muted mt-1">
              PDF, Word, Excel, CSV, Markdown, HTML, JSON · jusqu'à 15&nbsp;Mo / fichier
            </div>
          </>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* Liste */}
      <div className="mt-6">
        {loading ? (
          <div className="text-sm text-muted py-6 text-center">Chargement…</div>
        ) : docs.length === 0 ? (
          <div className="text-sm text-muted py-6 text-center">
            Aucun document pour l'instant. Importez votre premier fichier
            ci-dessus pour que les assistants puissent y faire référence.
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {docs.map((d) => {
              const Icon = iconFor(d.name);
              return (
                <div
                  key={d.id}
                  className="px-4 py-3 flex items-center gap-3 group"
                >
                  <Icon size={18} className="text-muted shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{d.name}</div>
                    <div className="text-[11px] text-muted flex items-center gap-2">
                      <span>{relTime(d.created_at)}</span>
                      {typeof d.word_count === "number" && (
                        <>
                          <span>·</span>
                          <span>
                            {d.word_count.toLocaleString("fr-FR")} mots
                          </span>
                        </>
                      )}
                      {typeof d.hit_count === "number" && d.hit_count > 0 && (
                        <>
                          <span>·</span>
                          <span>{d.hit_count} consult.</span>
                        </>
                      )}
                    </div>
                  </div>
                  {statusBadge(d)}
                  <button
                    onClick={() => remove(d.id, d.name)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-red-500/10 hover:text-red-400 text-muted transition-default"
                    title="Supprimer"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
