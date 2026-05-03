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
import { useEffect, useRef, useState } from "react";
import { Tag, GitBranch, Calendar, ChevronDown, ChevronRight, Info, RefreshCw, Download, CheckCircle2, AlertTriangle, Loader2, Github, Link2, Link2Off, KeyRound } from "lucide-react";

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

interface UpdateCheck {
  up_to_date?: boolean;
  behind_count?: number;
  local_sha?: string;
  remote_sha?: string;
  commits?: { sha: string; short: string; date: string; author: string; message: string }[];
  error?: string;
}

interface UpdateStatus {
  state: "idle" | "requested" | "running" | "done" | "failed";
  step?: string;
  message?: string;
  requested_at?: string;
  requested_by?: string;
  started_at?: string;
  finished_at?: string;
  branch?: string;
  exit_code?: number;
  log_tail?: string[];
}

interface GitHubStatus {
  connected: boolean;
  source?: "env" | "file" | null;
  login?: string;
  scopes?: string[];
  saved_at?: string;
  saved_by?: string;
  last_validated_at?: string;
  validation_error?: string;
  rate_limit?: { remaining: number; limit: number; reset_at: string };
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

function GitHubConnectionPanel({
  gh, onSave, onDelete, onRevalidate,
}: {
  gh: GitHubStatus | null;
  onSave: (token: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  onDelete: () => Promise<void>;
  onRevalidate: () => void;
}) {
  const [showInput, setShowInput] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  if (gh === null) {
    return (
      <div className="mb-3 px-3 py-2 rounded border border-border bg-muted/5 text-xs text-muted">
        <Loader2 size={12} className="inline animate-spin mr-1.5" />
        Chargement de l'état GitHub…
      </div>
    );
  }

  // Connecté
  if (gh.connected) {
    return (
      <div className="mb-3 px-3 py-2.5 rounded border border-border bg-muted/5">
        <div className="flex items-center gap-2 flex-wrap">
          <Github size={14} className="text-emerald-400" />
          <span className="text-xs font-medium text-emerald-300">
            GitHub connecté{gh.login ? ` — @${gh.login}` : ""}
          </span>
          <span className="text-[10px] text-muted">
            (source : {gh.source === "env" ? "provisioning .env" : "saisie UI"})
          </span>
          {gh.rate_limit && (
            <span className="text-[10px] text-muted">
              rate {gh.rate_limit.remaining}/{gh.rate_limit.limit}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={onRevalidate}
              className="text-[11px] text-muted hover:text-foreground flex items-center gap-1"
              title="Re-valider le token (ping /user)"
            >
              <RefreshCw size={10} /> Tester
            </button>
            {gh.source === "file" && (
              <button
                onClick={onDelete}
                className="text-[11px] text-red-400/80 hover:text-red-300 flex items-center gap-1"
                title="Supprimer le token stocké"
              >
                <Link2Off size={10} /> Déconnecter
              </button>
            )}
          </div>
        </div>
        {gh.validation_error && (
          <div className="mt-2 text-[11px] text-red-400 flex items-start gap-1.5">
            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
            Validation échouée : {gh.validation_error}
          </div>
        )}
        {gh.scopes && gh.scopes.length > 0 && (
          <div className="mt-1 text-[10px] text-muted font-mono">
            scopes : {gh.scopes.join(", ")}
          </div>
        )}
      </div>
    );
  }

  // Non connecté
  return (
    <div className="mb-3 px-3 py-2.5 rounded border border-amber-500/30 bg-amber-500/5">
      <div className="flex items-center gap-2 flex-wrap">
        <Github size={14} className="text-amber-400" />
        <span className="text-xs font-medium text-amber-300">
          GitHub non connecté
        </span>
        <span className="text-[11px] text-amber-200/70">
          — sans token, pas de vérification ni de mise à jour
        </span>
        <button
          onClick={() => setShowInput((s) => !s)}
          className="ml-auto px-2 py-1 rounded border border-border hover:bg-muted/15 text-[11px] flex items-center gap-1"
        >
          <KeyRound size={11} /> {showInput ? "Annuler" : "Connecter un token"}
        </button>
      </div>
      {showInput && (
        <div className="mt-2.5 space-y-2">
          <div className="text-[11px] text-muted">
            Crée un fine-grained PAT sur{" "}
            <a
              href="https://github.com/settings/personal-access-tokens/new"
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:underline"
            >
              github.com/settings/personal-access-tokens/new
            </a>{" "}
            avec accès <code className="text-foreground">Tobaz34/BoxIA</code> en lecture
            (Repository permissions → Contents : Read-only).
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); setSaveErr(null); }}
              placeholder="github_pat_… ou ghp_…"
              className="flex-1 px-2.5 py-1.5 rounded border border-border bg-card text-xs font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              disabled={saving || !tokenInput.trim()}
              onClick={async () => {
                setSaving(true);
                setSaveErr(null);
                const res = await onSave(tokenInput.trim());
                setSaving(false);
                if (res.ok) {
                  setTokenInput("");
                  setShowInput(false);
                } else {
                  setSaveErr(res.error);
                }
              }}
              className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs flex items-center gap-1.5"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Link2 size={11} />}
              Tester & enregistrer
            </button>
          </div>
          {saveErr && (
            <div className="text-[11px] text-red-400 flex items-start gap-1.5">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              {saveErr}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function UpdateBanner({
  check, checking, status, triggering, ghConnected, onCheck, onUpdate,
}: {
  check: UpdateCheck | null;
  checking: boolean;
  status: UpdateStatus;
  triggering: boolean;
  ghConnected: boolean;
  onCheck: () => void;
  onUpdate: () => void;
}) {
  // Mise à jour en cours / récemment terminée → bandeau de progression
  if (status.state === "requested" || status.state === "running") {
    return (
      <div className="mb-3 px-3 py-2.5 rounded border border-blue-500/30 bg-blue-500/10 text-xs">
        <div className="flex items-center gap-2 font-medium text-blue-300">
          <Loader2 size={13} className="animate-spin" />
          Mise à jour en cours
          {status.step && <span className="text-blue-400/70 font-normal">— {status.step}</span>}
        </div>
        {status.message && (
          <div className="mt-1 text-blue-200/80">{status.message}</div>
        )}
        {status.log_tail && status.log_tail.length > 0 && (
          <pre className="mt-2 text-[10px] text-blue-100/60 font-mono overflow-x-auto whitespace-pre-wrap">
            {status.log_tail.slice(-3).join("\n")}
          </pre>
        )}
      </div>
    );
  }
  if (status.state === "done") {
    return (
      <div className="mb-3 px-3 py-2.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-xs flex items-start gap-2">
        <CheckCircle2 size={13} className="text-emerald-400 mt-0.5 shrink-0" />
        <div>
          <div className="font-medium text-emerald-300">Mise à jour terminée</div>
          <div className="text-emerald-200/80 mt-0.5">
            {status.message || "Le service a redémarré sur la nouvelle version."}
            {status.finished_at && <> — {relTime(status.finished_at)}</>}
          </div>
        </div>
      </div>
    );
  }
  if (status.state === "failed") {
    return (
      <div className="mb-3 px-3 py-2.5 rounded border border-red-500/30 bg-red-500/10 text-xs">
        <div className="flex items-center gap-2 font-medium text-red-300">
          <AlertTriangle size={13} />
          Échec de la mise à jour
          {typeof status.exit_code === "number" && (
            <span className="text-red-400/70 font-normal">— exit {status.exit_code}</span>
          )}
        </div>
        {status.message && (
          <div className="mt-1 text-red-200/80">{status.message}</div>
        )}
        {status.log_tail && status.log_tail.length > 0 && (
          <pre className="mt-2 text-[10px] text-red-100/60 font-mono overflow-x-auto whitespace-pre-wrap">
            {status.log_tail.slice(-5).join("\n")}
          </pre>
        )}
        <div className="mt-2">
          <button
            onClick={onCheck}
            className="px-2 py-1 rounded border border-border hover:bg-muted/15 text-xs"
          >
            Re-vérifier
          </button>
        </div>
      </div>
    );
  }

  // État idle : bouton "Vérifier" + résultat
  const upToDate = check && check.up_to_date;
  const behind = check && !check.up_to_date && (check.behind_count ?? 0) > 0;
  const checkErr = check?.error;
  return (
    <div className="mb-3 flex items-start gap-3 flex-wrap">
      <button
        onClick={onCheck}
        disabled={checking || !ghConnected}
        title={!ghConnected ? "Connecte d'abord un token GitHub ci-dessus" : undefined}
        className="px-3 py-1.5 rounded border border-border hover:bg-muted/15 text-xs flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
        Vérifier les mises à jour
      </button>
      {upToDate && (
        <div className="text-xs text-emerald-400 flex items-center gap-1.5">
          <CheckCircle2 size={13} /> À jour ({check.local_sha?.slice(0, 7) || "?"})
        </div>
      )}
      {behind && (
        <>
          <div className="text-xs text-amber-300 flex items-center gap-1.5">
            <AlertTriangle size={13} />
            {check!.behind_count} commit{(check!.behind_count ?? 0) > 1 ? "s" : ""} de retard
            {check!.commits && check!.commits[0] && (
              <span className="text-muted ml-1 line-clamp-1 max-w-md">
                — dernier : {check!.commits[0].message}
              </span>
            )}
          </div>
          <button
            onClick={onUpdate}
            disabled={triggering}
            className="px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            {triggering ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            Mettre à jour maintenant
          </button>
        </>
      )}
      {check && !upToDate && !behind && (check.behind_count ?? 0) === -1 && (
        <div className="text-xs text-muted">
          Commit local introuvable côté distant (build de dev local ?)
        </div>
      )}
      {checkErr && (
        <div className="text-xs text-red-400 flex items-center gap-1.5">
          <AlertTriangle size={13} /> {checkErr}
        </div>
      )}
    </div>
  );
}

export function VersionCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [triggering, setTriggering] = useState(false);
  const [gh, setGh] = useState<GitHubStatus | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function refreshGh(revalidate = false) {
    fetch(`/api/system/github-status${revalidate ? "?revalidate=1" : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: GitHubStatus | null) => setGh(j))
      .catch(() => {});
  }

  useEffect(() => {
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => setData(j))
      .catch((e) => setError(String(e)));
    // Au mount, on lit le statut courant pour reprendre une MAJ en cours
    // (utile si l'admin recharge la page pendant un déploiement).
    fetch("/api/system/update-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: UpdateStatus | null) => {
        if (s && s.state !== "idle") {
          setStatus(s);
          startPolling();
        }
      })
      .catch(() => {});
    refreshGh(false);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSaveToken(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const r = await fetch("/api/system/github-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const j = await r.json();
      if (!r.ok) {
        return { ok: false, error: j.details || j.hint || j.error || `HTTP ${r.status}` };
      }
      refreshGh(true);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }

  async function handleDeleteToken() {
    if (!confirm("Supprimer le token GitHub ? Le bouton « Vérifier les mises à jour » ne fonctionnera plus.")) {
      return;
    }
    await fetch("/api/system/github-token", { method: "DELETE" });
    refreshGh(false);
    setCheck(null);
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch("/api/system/update-status", { cache: "no-store" });
        if (!r.ok) return;
        const s: UpdateStatus = await r.json();
        setStatus(s);
        if (s.state === "idle" || s.state === "done" || s.state === "failed") {
          if (pollRef.current) {
            clearInterval(pollRef.current);
            pollRef.current = null;
          }
        }
      } catch {
        // poll suivant
      }
    }, 2000);
  }

  async function handleCheck() {
    setChecking(true);
    setCheck(null);
    try {
      const r = await fetch("/api/system/check-updates", { cache: "no-store" });
      const j: UpdateCheck = await r.json();
      setCheck(j);
    } catch (e) {
      setCheck({ error: String(e instanceof Error ? e.message : e) });
    } finally {
      setChecking(false);
    }
  }

  async function handleUpdate() {
    if (!confirm("Lancer la mise à jour ? Le service redémarrera ~3-5 min, certaines actions seront indisponibles pendant ce temps.")) {
      return;
    }
    setTriggering(true);
    try {
      const r = await fetch("/api/system/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: "main" }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(`Erreur : ${j.error || r.status}`);
        return;
      }
      const s: UpdateStatus = await r.json();
      setStatus(s);
      startPolling();
    } finally {
      setTriggering(false);
    }
  }

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

      {/* Section "Connexion GitHub" : pré-requis pour le check + update */}
      <GitHubConnectionPanel
        gh={gh}
        onSave={handleSaveToken}
        onDelete={handleDeleteToken}
        onRevalidate={() => refreshGh(true)}
      />

      {/* Bandeau MAJ : statut en cours OU bouton vérifier */}
      <UpdateBanner
        check={check}
        checking={checking}
        status={status}
        triggering={triggering}
        ghConnected={gh?.connected || false}
        onCheck={handleCheck}
        onUpdate={handleUpdate}
      />

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
