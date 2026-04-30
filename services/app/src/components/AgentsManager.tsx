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
  Bot, AlertCircle, Settings as SettingsIcon, Save, Check, X,
  ShieldCheck, Briefcase, User, Plus, Minus, RotateCcw,
  MessageSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";

interface AgentMeta {
  slug: string;
  name: string;
  icon: string;
  description: string;
  available: boolean;
  isDefault?: boolean;
  allowedRoles?: string[];
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
      setEditing(await r.json());
    } finally {
      setEditLoading(false);
    }
  }

  async function save() {
    if (!editing) return;
    setSavingState("saving");
    setError(null);
    try {
      const r = await fetch(`/api/agents/${editing.slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pre_prompt: editing.pre_prompt,
          opening_statement: editing.opening_statement,
          suggested_questions: editing.suggested_questions.filter((q) => q.trim()),
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.details || j.error || `Erreur ${r.status}`);
        setSavingState("idle");
        return;
      }
      setSavingState("saved");
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
              {/* Modèle (read-only) */}
              {editing.model && (
                <div className="text-xs text-muted bg-muted/10 rounded px-3 py-2">
                  <strong>Modèle :</strong> {editing.model.name} ({editing.model.mode})
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
              <button
                onClick={() => openEdit(editing.slug)}
                title="Recharger depuis Dify"
                className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1"
              >
                <RotateCcw size={12} /> Recharger
              </button>
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
    </div>
  );
}
