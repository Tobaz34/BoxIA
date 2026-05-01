"use client";

/**
 * Carte « Version & mises à jour » affichée sur /settings.
 *
 * Lit /api/version (public) qui renvoie :
 *   - version.app_version + build_date + commit_short + branch
 *   - changelog : 5 dernières entrées parsées depuis CHANGELOG.md
 *
 * UX : version + branch en gros, build date relative, expand pour voir
 * les changements récents en markdown rendu (titres, listes Added/Fixed/etc).
 */
import { useEffect, useState } from "react";
import { Tag, GitBranch, Calendar, ChevronDown, ChevronRight, Info } from "lucide-react";

interface VersionInfo {
  app_version: string;
  build_date: string;
  commit_sha: string;
  commit_short: string;
  commit_date: string;
  commit_message: string;
  branch: string;
}

interface ChangelogEntry {
  version: string;
  date: string;
  raw: string;
}

interface ApiResponse {
  incomplete: boolean;
  version: VersionInfo;
  changelog: ChangelogEntry[];
}

function relTime(iso: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return iso;
  const d = Math.floor(ms / 86400_000);
  if (d > 30) return new Date(iso).toLocaleDateString("fr-FR");
  if (d > 0) return `il y a ${d} j`;
  const h = Math.floor(ms / 3_600_000);
  if (h > 0) return `il y a ${h} h`;
  const min = Math.floor(ms / 60_000);
  if (min > 0) return `il y a ${min} min`;
  return "à l'instant";
}

/** Rendu markdown très minimal (h2/h3, listes, gras). Pas de XSS car
 *  le texte vient de /api/version qui lit notre propre CHANGELOG.md. */
function renderMd(raw: string): string {
  // Strip la première ligne `## [...] — date` (déjà affichée en header)
  const lines = raw.split("\n").slice(1);
  let html = "";
  let inUl = false;
  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (inUl) { html += "</ul>"; inUl = false; }
      html += `<h4 class="text-xs uppercase tracking-wide text-muted mt-3 mb-1">${escapeHtml(line.slice(4))}</h4>`;
    } else if (line.startsWith("- ")) {
      if (!inUl) { html += '<ul class="text-xs text-foreground/80 space-y-1 ml-4 list-disc">'; inUl = true; }
      // Bold inline **texte**
      const item = escapeHtml(line.slice(2)).replace(
        /\*\*([^*]+)\*\*/g, "<strong>$1</strong>",
      );
      html += `<li>${item}</li>`;
    } else if (line.trim() === "") {
      if (inUl) { html += "</ul>"; inUl = false; }
    } else {
      if (inUl) { html += "</ul>"; inUl = false; }
      html += `<p class="text-xs text-foreground/80 mt-1">${escapeHtml(line)}</p>`;
    }
  }
  if (inUl) html += "</ul>";
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function VersionCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setData(j))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-semibold mb-1">Version & mises à jour</h2>
        <p className="text-sm text-red-400">Erreur : {error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-semibold mb-1">Version & mises à jour</h2>
        <p className="text-sm text-muted">Chargement…</p>
      </div>
    );
  }

  const v = data.version;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Tag size={16} className="text-muted" />
        <h2 className="font-semibold">Version & mises à jour</h2>
      </div>

      {/* En-tête version courante */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Version
          </div>
          <div className="text-lg font-semibold">v{v.app_version}</div>
          {v.commit_short && (
            <div className="text-xs text-muted font-mono mt-0.5">
              {v.commit_short}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted flex items-center gap-1">
            <GitBranch size={10} /> Branche
          </div>
          <div className="text-sm font-medium">{v.branch || "—"}</div>
          {v.commit_message && (
            <div className="text-xs text-muted line-clamp-1 mt-0.5">
              {v.commit_message}
            </div>
          )}
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted flex items-center gap-1">
            <Calendar size={10} /> Build
          </div>
          <div className="text-sm font-medium">{relTime(v.build_date)}</div>
          {v.commit_date && (
            <div className="text-xs text-muted mt-0.5">
              commit {relTime(v.commit_date)}
            </div>
          )}
        </div>
      </div>

      {data.incomplete && (
        <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1.5 mb-3 flex items-start gap-1.5">
          <Info size={11} className="shrink-0 mt-0.5" />
          <span>
            Métadonnées de build incomplètes (script gen-version pas exécuté
            ou bind mount CHANGELOG.md absent).
          </span>
        </div>
      )}

      {/* Changelog récent */}
      {data.changelog.length > 0 && (
        <>
          <div className="text-xs uppercase tracking-wide text-muted mb-2">
            Dernières mises à jour & correctifs
          </div>
          <div className="space-y-1">
            {data.changelog.map((entry) => {
              const isOpen = expanded === entry.version;
              return (
                <div
                  key={entry.version}
                  className="border border-border rounded"
                >
                  <button
                    onClick={() => setExpanded(isOpen ? null : entry.version)}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/15 transition-default text-left"
                  >
                    {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span className="font-medium text-sm">v{entry.version}</span>
                    <span className="text-xs text-muted">— {entry.date}</span>
                  </button>
                  {isOpen && (
                    <div
                      className="px-3 pb-3 pt-1 border-t border-border"
                      dangerouslySetInnerHTML={{ __html: renderMd(entry.raw) }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
