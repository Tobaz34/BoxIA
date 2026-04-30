"use client";

/**
 * Carte « Charger les données de démo » dans /settings (admin only).
 *
 * Pour les démos commerciales : 1 clic et la box arrive avec 3 documents
 * d'exemple (procédure congés, modèle devis, FAQ TVA) pré-indexés. Les
 * agents peuvent immédiatement répondre à des questions métier
 * concrètes.
 *
 * Idempotent : skip les docs déjà présents.
 */
import { useState } from "react";
import { useSession } from "next-auth/react";
import { Database, Check, AlertCircle, Loader2, FileText } from "lucide-react";

interface ReportEntry {
  name: string;
  status: "uploaded" | "skipped" | "error";
  error?: string;
}

interface ReportSummary {
  total: number;
  uploaded: number;
  skipped: number;
  failed: number;
}

export function SeedDemoCard() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ReportEntry[] | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);

  async function loadDemo() {
    if (!confirm(
      "Charger les documents de démo dans la base de connaissances ? " +
      "Idempotent — les fichiers déjà présents sont ignorés.",
    )) return;
    setLoading(true);
    setError(null);
    setReport(null);
    setSummary(null);
    try {
      const r = await fetch("/api/seed-demo", { method: "POST" });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setReport(j.report || []);
      setSummary(j.summary || null);
    } finally {
      setLoading(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Database size={16} className="text-primary" />
        <h2 className="font-semibold">Données de démo</h2>
      </div>
      <p className="text-xs text-muted mb-4">
        Charge des documents-types (procédure congés, modèle de devis,
        FAQ TVA) dans la base de connaissances pour rendre la box
        immédiatement démontrable. Idempotent.
      </p>

      <button
        onClick={loadDemo}
        disabled={loading}
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default disabled:opacity-50"
      >
        {loading ? <Loader2 size={14} className="animate-spin" /> : <Database size={14} />}
        {loading ? "Chargement…" : "Charger les données de démo"}
      </button>

      {error && (
        <div className="mt-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2 flex items-start gap-2">
          <AlertCircle size={14} className="shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {summary && (
        <div className="mt-3 rounded-md bg-accent/10 border border-accent/30 text-accent text-sm px-3 py-2">
          <div className="flex items-center gap-2 mb-1">
            <Check size={14} />
            <span className="font-medium">
              {summary.uploaded} upload{summary.uploaded > 1 ? "s" : ""},
              {summary.skipped > 0 && ` ${summary.skipped} déjà présent${summary.skipped > 1 ? "s" : ""},`}
              {summary.failed > 0 && ` ${summary.failed} échec${summary.failed > 1 ? "s" : ""}`}
              {summary.failed === 0 && summary.uploaded === 0 && summary.skipped === 0
                ? " · aucun fichier à charger"
                : ""}
            </span>
          </div>
        </div>
      )}

      {report && report.length > 0 && (
        <div className="mt-3 rounded-md border border-border divide-y divide-border">
          {report.map((r) => (
            <div key={r.name} className="px-3 py-2 flex items-center gap-2 text-xs">
              <FileText size={12} className="text-muted shrink-0" />
              <span className="flex-1 truncate">{r.name}</span>
              {r.status === "uploaded" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent">
                  ✓ uploadé
                </span>
              )}
              {r.status === "skipped" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted/15 text-muted">
                  déjà présent
                </span>
              )}
              {r.status === "error" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400" title={r.error}>
                  erreur
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
