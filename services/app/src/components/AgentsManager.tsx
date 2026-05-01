"use client";

/**
 * Page /agents — gestion des assistants IA (admin only).
 *
 * Affiche les agents du catalogue (lib/agents.ts) en cards. Chaque card
 * a un bouton "Configurer" qui ouvre un modal d'édition pour :
 *   - pre_prompt (instructions système de l'agent)
 *   - opening_statement (message d'accueil de l'agent)
 *   - suggested_questions (3 questions pré-définies)
 *
 * V1 : édition des 4 agents existants. V2 : création d'agents custom.
 */
import {
  Bot, Settings as SettingsIcon, Save, Check, X,
  ShieldCheck, Briefcase, User, Plus, Minus, RotateCcw,
  MessageSquare, Cpu, Loader2, Sparkles, Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { CreateAgentWizard } from "@/components/CreateAgentWizard";

interface AgentMeta {
  slug: string;
  name: string;
  icon: string;
  description: string;
  available: boolean;
  isDefault?: boolean;
  allowedRoles?: string[];
  custom?: boolean;
}

interface AgentDetail {
  slug: string;
  name: string;
  icon: string;
  description: string;
  available: boolean;
  isDefault: boolean;
  allowedRoles: string[];
  app_id: string;
  pre_prompt: string;
  opening_statement: string;
  suggested_questions: string[];
  model: { provider: string; name: string; mode: string } | null;
  max_tokens: number | null;
  custom?: boolean;
}

interface ModelOption {
  name: string;
  size: number;
  size_label: string;
  family?: string;
  parameter_size?: string;
  quantization?: string;
  chat: boolean;
  installed: boolean;
  registered: boolean;
}

const ROLE_BADGE: Record<string, { label: string; cls: string; icon: typeof Bot }> = {
  admin:    { label: "Admin",   cls: "bg-primary/15 text-primary",   icon: ShieldCheck },
  manager:  { label: "Manager", cls: "bg-accent/15 text-accent",     icon: Briefcase },
  employee: { label: "Employé", cls: "bg-muted/15 text-muted",       icon: User },
};

export function AgentsManager() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [agents, setAgents] = useState<AgentMeta[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<AgentDetail | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved">("idle");
  const [showWizard, setShowWizard] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Modèles dispos (Ollama installés + statut Dify). Chargé une fois à
  // l'ouverture du modal. Si la requête échoue, on retombe sur un dropdown
  // vide et on affiche juste le modèle actuel.
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  // Tracking du modèle initial pour confirmer le switch
  const [initialModelName, setInitialModelName] = useState<string | null>(null);
  const [initialMaxTokens, setInitialMaxTokens] = useState<number | null>(null);

  function refreshAgents() {
    setLoading(true);
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((j) => setAgents(j.agents))
      .catch(() => setError("Impossible de charger les agents"))
      .finally(() => setLoading(false));
  }

  async function handleDelete() {
    if (!editing || !editing.custom) return;
    if (!confirm(`Supprimer définitivement l'assistant "${editing.name}" ?\n\nL'app Dify et toutes ses conversations seront supprimées. Cette action est irréversible.`)) {
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${editing.slug}`, { method: "DELETE" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setEditing(null);
      refreshAgents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(r.status))
      .then((j) => setAgents(j.agents))
      .catch(() => setError("Impossible de charger les agents"))
      .finally(() => setLoading(false));
  }, []);

  async function openEdit(slug: string) {
    setEditLoading(true);
    setEditing(null);
    setError(null);
    try {
      const r = await fetch(`/api/agents/${slug}`, { cache: "no-store" });
      if (r.status === 403) {
        setError("La configuration d'agent est réservée aux administrateurs.");
        return;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      const detail: AgentDetail = await r.json();
      setEditing(detail);
      setInitialModelName(detail.model?.name || null);
      setInitialMaxTokens(detail.max_tokens);
      // Chargement liste modèles en parallèle (ne bloque pas l'édition)
      if (!models) {
        setModelsLoading(true);
        fetch("/api/agents/models", { cache: "no-store" })
          .then((rr) => rr.ok ? rr.json() : Promise.reject(rr.status))
          .then((j) => setModels(j.models))
          .catch(() => {/* tolérable, on garde le sélecteur vide */})
          .finally(() => setModelsLoading(false));
      }
    } finally {
      setEditLoading(false);
    }
  }

  async function save() {
    if (!editing) return;
    setSavingState("saving");
    setError(null);
    try {
      const currentModel = editing.model?.name || null;
      const modelChanged = currentModel && currentModel !== initialModelName;
      const tokensChanged = editing.max_tokens !== initialMaxTokens;

      const payload: Record<string, unknown> = {
        pre_prompt: editing.pre_prompt,
        opening_statement: editing.opening_statement,
        suggested_questions: editing.suggested_questions.filter((q) => q.trim()),
      };
      if (modelChanged && currentModel) payload.model_name = currentModel;
      if (tokensChanged && editing.max_tokens !== null) {
        payload.max_tokens = editing.max_tokens;
      }

      const r = await fetch(`/api/agents/${editing.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.details || j.message || j.error || `Erreur ${r.status}`);
        setSavingState("idle");
        return;
      }
      setSavingState("saved");
      // Si on a changé le modèle, on rafraîchit la liste pour mettre à jour
      // le statut "registered" du nouveau modèle.
      if (modelChanged) {
        fetch("/api/agents/models", { cache: "no-store" })
          .then((rr) => rr.ok ? rr.json() : null)
          .then((j) => { if (j) setModels(j.models); })
          .catch(() => {/* ignore */});
      }
      setTimeout(() => {
        setSavingState("idle");
        setEditing(null);
      }, 1200);
    } catch (e: unknown) {
      setError((e as Error).message);
      setSavingState("idle");
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto pb-12">
      <header className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-primary/15 text-primary flex items-center justify-center">
            <Bot size={20} />
          </div>
          <div>
            <h1 className="text-xl font-semibold">Mes assistants</h1>
            <p className="text-sm text-muted">
              {agents?.length || 0} assistant{(agents?.length || 0) > 1 ? "s" : ""} configuré{(agents?.length || 0) > 1 ? "s" : ""}
              {!isAdmin && " · lecture seule"}
            </p>
          </div>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowWizard(true)}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:opacity-90"
            title="Créer un nouvel assistant"
          >
            <Sparkles size={14} /> Nouvel assistant
          </button>
        )}
      </header>

      {!isAdmin && (
        <div className="mb-4 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm px-3 py-2">
          Vous pouvez voir les assistants disponibles mais leur configuration
          est réservée aux administrateurs.
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-muted py-12">Chargement…</div>
      ) : agents && agents.length > 0 ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {agents.map((a) => (
            <div
              key={a.slug}
              className="rounded-lg border border-border bg-card p-4 hover:border-primary/50 transition-default"
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="w-12 h-12 rounded-md bg-primary/10 flex items-center justify-center text-2xl shrink-0">
                  {a.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-semibold truncate">{a.name}</h3>
                    {a.isDefault && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/15 text-primary">
                        défaut
                      </span>
                    )}
                    {a.custom && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-accent/15 text-accent inline-flex items-center gap-0.5">
                        <Sparkles size={9} /> custom
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-0.5 line-clamp-2">
                    {a.description}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap mb-3">
                {(a.allowedRoles || []).length === 0 ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-muted/15 text-muted">
                    🌐 ouvert à tous
                  </span>
                ) : (
                  (a.allowedRoles || []).map((r) => {
                    const meta = ROLE_BADGE[r];
                    if (!meta) return null;
                    const Ic = meta.icon;
                    return (
                      <span
                        key={r}
                        className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium ${meta.cls}`}
                      >
                        <Ic size={10} /> {meta.label}
                      </span>
                    );
                  })
                )}
              </div>

              <div className="flex gap-2">
                {/* Bouton Discuter — sélectionne l'agent + redirige vers le
                    chat. Dispo pour tous les rôles (pas juste admins). */}
                <a
                  href={`/?agent=${encodeURIComponent(a.slug)}`}
                  className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-accent/10 text-accent hover:bg-accent/20 text-sm font-medium transition-default"
                  title={`Discuter avec ${a.name}`}
                >
                  <MessageSquare size={14} />
                  Discuter
                </a>
                {isAdmin && (
                  <button
                    onClick={() => openEdit(a.slug)}
                    disabled={editLoading}
                    className="flex-1 inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-sm font-medium transition-default disabled:opacity-50"
                  >
                    <SettingsIcon size={14} />
                    Configurer
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted">
          <Bot size={32} className="mx-auto mb-3 opacity-50" />
          <p>Aucun assistant disponible.</p>
        </div>
      )}

      {/* Modal édition */}
      {editing && (
        <div
          className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={() => setEditing(null)}
        >
          <div
            className="bg-card border border-border rounded-lg w-full max-w-2xl shadow-2xl max-h-[90vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-card border-b border-border px-5 py-3 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{editing.icon}</span>
                <div>
                  <h2 className="font-semibold">{editing.name}</h2>
                  <p className="text-xs text-muted">{editing.description}</p>
                </div>
              </div>
              <button
                onClick={() => setEditing(null)}
                className="p-1 rounded hover:bg-muted/30"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Modèle (éditable) */}
              {editing.model && (
                <div className="rounded-md border border-border bg-muted/5 p-3 space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    <Cpu size={14} className="text-primary" />
                    Modèle IA
                    {modelsLoading && <Loader2 size={12} className="animate-spin text-muted" />}
                  </div>

                  <div>
                    <label className="text-[11px] text-muted block mb-1">
                      Choisir le modèle
                    </label>
                    <select
                      value={editing.model.name}
                      onChange={(e) =>
                        setEditing(editing.model
                          ? { ...editing, model: { ...editing.model, name: e.target.value } }
                          : editing)
                      }
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                    >
                      {/* Si le modèle actuel n'est pas dans la liste (cas
                         marginal : provider Dify ≠ ollama, ou modèle
                         désinstallé), on l'inclut quand même pour ne pas
                         casser l'affichage. */}
                      {!models?.some((m) => m.name === editing.model?.name) && editing.model && (
                        <option value={editing.model.name}>
                          {editing.model.name} (actuel)
                        </option>
                      )}
                      {(models || [])
                        .filter((m) => m.chat && m.installed)
                        .map((m) => (
                          <option key={m.name} value={m.name}>
                            {m.name}
                            {m.parameter_size ? ` · ${m.parameter_size}` : ""}
                            {m.size_label !== "—" ? ` · ${m.size_label}` : ""}
                            {!m.registered ? " (sera enregistré)" : ""}
                          </option>
                        ))}
                    </select>
                    <p className="text-[10px] text-muted mt-1">
                      Plus le modèle est gros (paramètres), plus il est précis
                      mais plus il consomme de VRAM et de temps. Repère :
                      <strong> 7B</strong> = rapide quotidien (~5 Go),
                      <strong> 14B</strong> = calculs métier précis (~9 Go),
                      <strong> 32B</strong> = expertise pointue (~19 Go, lent).
                    </p>
                  </div>

                  {/* Vue des autres modèles dispo, info-only */}
                  {models && models.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 pt-1 border-t border-border/50">
                      {models.filter((m) => m.installed && m.chat).slice(0, 8).map((m) => {
                        const isCurrent = m.name === editing.model?.name;
                        return (
                          <span
                            key={m.name}
                            title={
                              `${m.size_label}` +
                              (m.parameter_size ? ` · ${m.parameter_size}` : "") +
                              (m.quantization ? ` · ${m.quantization}` : "") +
                              (!m.registered ? " · non enregistré dans Dify" : "")
                            }
                            className={
                              "text-[10px] px-1.5 py-0.5 rounded font-mono " +
                              (isCurrent
                                ? "bg-primary/20 text-primary"
                                : m.registered
                                  ? "bg-muted/15 text-muted"
                                  : "bg-yellow-500/10 text-yellow-400")
                            }
                          >
                            {m.name}
                            {!m.registered && " ⚠"}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  {/* max_tokens slider */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[11px] text-muted">
                        Longueur max de réponse (max_tokens)
                      </label>
                      <span className="text-[11px] font-mono text-foreground">
                        {editing.max_tokens ?? "—"}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={512}
                      max={8192}
                      step={256}
                      value={editing.max_tokens ?? 1024}
                      onChange={(e) =>
                        setEditing({ ...editing, max_tokens: Number(e.target.value) })
                      }
                      className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-[10px] text-muted mt-0.5">
                      <span>512 (court)</span>
                      <span>2048 (équilibré)</span>
                      <span>8192 (long)</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Pre prompt */}
              <div>
                <label className="text-xs font-medium block mb-1">
                  Instructions système (pre-prompt)
                </label>
                <p className="text-[11px] text-muted mb-1.5">
                  Le « rôle » et les compétences de l'agent. Ce texte est invisible
                  pour l'utilisateur final mais guide chaque réponse.
                </p>
                <textarea
                  value={editing.pre_prompt}
                  onChange={(e) =>
                    setEditing({ ...editing, pre_prompt: e.target.value })
                  }
                  rows={8}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                />
                <div className="text-[10px] text-muted mt-0.5 text-right">
                  {editing.pre_prompt.length} car.
                </div>
              </div>

              {/* Opening statement */}
              <div>
                <label className="text-xs font-medium block mb-1">
                  Message d'accueil
                </label>
                <p className="text-[11px] text-muted mb-1.5">
                  Affiché au démarrage d'une nouvelle conversation avec cet
                  assistant.
                </p>
                <textarea
                  value={editing.opening_statement}
                  onChange={(e) =>
                    setEditing({ ...editing, opening_statement: e.target.value })
                  }
                  rows={2}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                />
              </div>

              {/* Suggested questions */}
              <div>
                <label className="text-xs font-medium block mb-1">
                  Questions suggérées au démarrage
                </label>
                <p className="text-[11px] text-muted mb-2">
                  Jusqu'à 4 questions cliquables affichées sur la page d'accueil
                  de l'agent.
                </p>
                <div className="space-y-2">
                  {editing.suggested_questions.map((q, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={q}
                        onChange={(e) => {
                          const next = [...editing.suggested_questions];
                          next[i] = e.target.value;
                          setEditing({ ...editing, suggested_questions: next });
                        }}
                        placeholder={`Question ${i + 1}…`}
                        className="flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-primary"
                      />
                      <button
                        onClick={() => {
                          const next = editing.suggested_questions.filter((_, k) => k !== i);
                          setEditing({ ...editing, suggested_questions: next });
                        }}
                        className="p-1.5 rounded text-muted hover:bg-red-500/10 hover:text-red-400"
                        title="Retirer"
                      >
                        <Minus size={14} />
                      </button>
                    </div>
                  ))}
                  {editing.suggested_questions.length < 4 && (
                    <button
                      onClick={() =>
                        setEditing({
                          ...editing,
                          suggested_questions: [...editing.suggested_questions, ""],
                        })
                      }
                      className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground transition-default"
                    >
                      <Plus size={12} /> Ajouter une question
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="sticky bottom-0 bg-card border-t border-border px-5 py-3 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => openEdit(editing.slug)}
                  title="Recharger depuis Dify"
                  className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1"
                >
                  <RotateCcw size={12} /> Recharger
                </button>
                {editing.custom && (
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    title="Supprimer cet assistant custom"
                    className="text-xs text-red-400 hover:text-red-300 inline-flex items-center gap-1 disabled:opacity-50"
                  >
                    {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                    {deleting ? "Suppression…" : "Supprimer"}
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setEditing(null)}
                  className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/20"
                >
                  Annuler
                </button>
                <button
                  onClick={save}
                  disabled={savingState === "saving"}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {savingState === "saved" ? <Check size={14} /> : <Save size={14} />}
                  {savingState === "saving" ? "Enregistrement…"
                   : savingState === "saved" ? "Enregistré"
                   : "Enregistrer"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Wizard de création d'un agent custom */}
      {showWizard && (
        <CreateAgentWizard
          onClose={() => setShowWizard(false)}
          onCreated={(slug) => {
            setShowWizard(false);
            refreshAgents();
            // Ouvre directement la modale d'édition pour l'agent créé
            setTimeout(() => openEdit(slug), 600);
          }}
        />
      )}
    </div>
  );
}
