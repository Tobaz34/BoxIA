"use client";

/**
 * Affichage des sources RAG sous une réponse d'assistant.
 *
 * Quand Dify utilise des chunks de la KB pour répondre, il les renvoie
 * dans `retriever_resources` (event message_end + GET /messages).
 * Ce composant les rend en chips compacts ; un clic ouvre/ferme la
 * lecture du chunk complet.
 */
import { ChevronDown, FileText, FileSpreadsheet, FileCode, FileJson } from "lucide-react";
import { useState } from "react";

export interface RetrieverResource {
  position?: number;
  dataset_id?: string;
  dataset_name?: string;
  document_id?: string;
  document_name?: string;
  segment_id?: string;
  score?: number;
  content?: string;
}

function iconFor(name: string) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["xlsx", "csv"].includes(ext)) return FileSpreadsheet;
  if (["json", "xml"].includes(ext)) return FileJson;
  if (["html", "htm", "md", "markdown"].includes(ext)) return FileCode;
  return FileText;
}

export function MessageSources({ sources }: { sources: RetrieverResource[] }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!sources || sources.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border/50">
      <div className="text-[10px] uppercase tracking-wide text-muted mb-2">
        Sources ({sources.length})
      </div>
      <div className="space-y-1.5">
        {sources.map((s, idx) => {
          const id = s.segment_id || `${idx}`;
          const isOpen = expanded === id;
          const Icon = iconFor(s.document_name || "");
          const scorePct =
            typeof s.score === "number" ? Math.round(s.score * 100) : null;
          return (
            <div
              key={id}
              className="rounded-md border border-border bg-background/40"
            >
              <button
                onClick={() => setExpanded(isOpen ? null : id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-muted/15 transition-default"
              >
                <Icon size={12} className="text-muted shrink-0" />
                <span className="truncate font-medium flex-1">
                  {s.document_name || "Document"}
                </span>
                {typeof s.position === "number" && (
                  <span className="text-[10px] text-muted">
                    chunk {s.position}
                  </span>
                )}
                {scorePct !== null && (
                  <span
                    className={
                      "text-[10px] px-1.5 py-0.5 rounded-full " +
                      (scorePct >= 70
                        ? "bg-accent/15 text-accent"
                        : scorePct >= 50
                        ? "bg-primary/15 text-primary"
                        : "bg-muted/20 text-muted")
                    }
                  >
                    {scorePct}%
                  </span>
                )}
                <ChevronDown
                  size={12}
                  className={
                    "text-muted transition-default " + (isOpen ? "rotate-180" : "")
                  }
                />
              </button>
              {isOpen && s.content && (
                <div className="px-3 pb-3 pt-1 text-xs text-muted whitespace-pre-wrap leading-relaxed border-t border-border/40">
                  {s.content}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
