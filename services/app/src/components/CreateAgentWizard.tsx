"use client";
/**
 * Wizard de création d'un agent custom — affiché en modale, 3 étapes :
 *   1. Identité   : nom, emoji, description courte
 *   2. Domaine    : domaine métier, ton, rôles autorisés, mots-clés expertise
 *   3. Preview    : pre-prompt généré par l'IA, éditable, + 4 questions
 *
 * Le pre-prompt est généré via /api/agents/draft-prompt (qui appelle
 * Ollama qwen2.5:14b avec un meta-prompt structuré). L'admin peut
 * éditer librement avant de cliquer "Créer".
 *
 * Côté serveur : POST /api/agents/create crée l'app Dify, configure le
 * model, génère la clé API, et persiste les méta dans
 * /data/custom-agents.json.
 */
import { useState } from "react";
import {
  X, Loader2, Sparkles, Check, ArrowLeft, ArrowRight, RefreshCw,
} from "lucide-react";

interface Props {
  onClose: () => void;
  onCreated: (slug: string) => void;
}

const DOMAINS: { key: string; label: string; emoji: string }[] = [
  { key: "comptabilité", label: "Comptabilité / Finance", emoji: "📊" },
  { key: "rh", label: "Ressources humaines", emoji: "👥" },
  { key: "support-client", label: "Support client", emoji: "🎧" },
  { key: "commercial", label: "Commercial / Ventes", emoji: "💼" },
  { key: "juridique", label: "Juridique / Conformité", emoji: "⚖️" },
  { key: "marketing", label: "Marketing / Communication", emoji: "📣" },
  { key: "technique-it", label: "Technique / IT", emoji: "🛠️" },
  { key: "autre", label: "Autre / Polyvalent", emoji: "🤖" },
];

const TONES: { key: string; label: string; description: string }[] = [
  { key: "formal", label: "Professionnel", description: "Vouvoiement, formel, terminologie précise" },
  { key: "friendly", label: "Convivial", description: "Tutoiement bienveillant, pédagogique" },
  { key: "direct", label: "Direct", description: "Factuel, concis, droit au but" },
];

const ROLES: { key: "admin" | "manager" | "employee"; label: string }[] = [
  { key: "admin", label: "Admin" },
  { key: "manager", label: "Manager" },
  { key: "employee", label: "Employé" },
];

interface DraftResult {
  pre_prompt: string;
  opening_statement: string;
  suggested_questions: string[];
  generation_ms: number;
  fallback: boolean;
}

export function CreateAgentWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🤖");
  const [description, setDescription] = useState("");

  // Step 2
  const [domain, setDomain] = useState("autre");
  const [tone, setTone] = useState("friendly");
  const [allowedRoles, setAllowedRoles] = useState<string[]>([]);
  const [expertise, setExpertise] = useState("");

  // Step 3 — preview generated
  const [draft, setDraft] = useState<DraftResult | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);

  function next() {
    setError(null);
    if (step === 1) {
      if (!name.trim() || name.trim().length < 2) {
        setError("Le nom doit faire au moins 2 caractères.");
        return;
      }
      if (!description.trim()) {
        setError("La description courte est requise (1 phrase).");
        return;
      }
      setStep(2);
    } else if (step === 2) {
      // Génère le draft en arrière-plan
      generateDraft();
      setStep(3);
    }
  }

  function back() {
    setError(null);
    if (step > 1) setStep((step - 1) as 1 | 2);
  }

  async function generateDraft() {
    setDrafting(true);
    setError(null);
    try {
      const r = await fetch("/api/agents/draft-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), description: description.trim(),
          domain, tone, language: "fr-FR",
          expertise_keywords: expertise.trim() || undefined,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.message || j.error || `HTTP ${r.status}`);
      }
      const j = (await r.json()) as DraftResult;
      setDraft(j);
    } catch (e) {
      setError("Génération du prompt échouée : " + (e as Error).message);
      // Fournir un brouillon vide pour que l'admin puisse écrire à la main
      setDraft({
        pre_prompt: "", opening_statement: "", suggested_questions: ["", "", "", ""],
        generation_ms: 0, fallback: true,
      });
    } finally {
      setDrafting(false);
    }
  }

  async function create() {
    if (!draft) return;
    setCreating(true);
    setError(null);
    try {
      const r = await fetch("/api/agents/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(), icon, description: description.trim(),
          domain, tone, language: "fr-FR",
          allowedRoles,
          pre_prompt: draft.pre_prompt,
          opening_statement: draft.opening_statement,
          suggested_questions: draft.suggested_questions.filter((q) => q.trim()),
          model_name: "qwen2.5:7b",
          max_tokens: 2048,
          expertise_keywords: expertise.trim() || undefined,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(j.message || j.details || j.error || `HTTP ${r.status}`);
      }
      onCreated(j.slug);
    } catch (e) {
      setError("Création échouée : " + (e as Error).message);
    } finally {
      setCreating(false);
    }
  }

  function toggleRole(r: string) {
    setAllowedRoles((cur) =>
      cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-full max-w-2xl shadow-2xl max-h-[92vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 bg-card border-b border-border px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-md bg-accent/15 text-accent flex items-center justify-center">
              <Sparkles size={18} />
            </div>
            <div>
              <h2 className="font-semibold">Nouvel assistant</h2>
              <p className="text-xs text-muted">
                Étape {step}/3 ·{" "}
                {step === 1 ? "Identité" : step === 2 ? "Domaine & rôles" : "Aperçu & validation"}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-muted/30">
            <X size={16} />
          </button>
        </div>

        {/* Progress dots */}
        <div className="flex gap-2 px-5 pt-3">
          {[1, 2, 3].map((s) => (
            <div
              key={s}
              className={`h-1 flex-1 rounded-full ${
                s <= step ? "bg-primary" : "bg-muted/30"
              }`}
            />
          ))}
        </div>

        <div className="p-5 space-y-4">
          {error && (
            <div className="rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
              {error}
            </div>
          )}

          {/* Step 1: identité */}
          {step === 1 && (
            <>
              <div>
                <label className="text-xs font-medium block mb-1">Nom de l'assistant</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex: Assistant juridique, Assistant marketing…"
                  maxLength={80}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Icône (emoji)</label>
                <div className="flex gap-2 flex-wrap">
                  {["🤖", "📊", "👥", "🎧", "💼", "⚖️", "📣", "🛠️", "📚", "✏️", "🔍", "🎓"].map((e) => (
                    <button
                      key={e}
                      onClick={() => setIcon(e)}
                      className={`w-10 h-10 rounded-md border text-xl flex items-center justify-center ${
                        icon === e ? "border-primary bg-primary/10" : "border-border hover:bg-muted/20"
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                  <input
                    value={icon}
                    onChange={(e) => setIcon(e.target.value.slice(0, 4))}
                    className="w-16 bg-background border border-border rounded-md px-2 text-center text-xl"
                    placeholder="…"
                  />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium block mb-1">Description courte (1 phrase)</label>
                <input
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ex: Réponses sur le droit du travail, le RGPD, les CGU/CGV…"
                  maxLength={200}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                />
                <div className="text-[10px] text-muted text-right mt-0.5">{description.length}/200</div>
              </div>
            </>
          )}

          {/* Step 2: domaine & rôles */}
          {step === 2 && (
            <>
              <div>
                <label className="text-xs font-medium block mb-2">Domaine d'expertise</label>
                <div className="grid grid-cols-2 gap-2">
                  {DOMAINS.map((d) => (
                    <button
                      key={d.key}
                      onClick={() => setDomain(d.key)}
                      className={`text-left px-3 py-2 rounded-md border text-sm flex items-center gap-2 ${
                        domain === d.key
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:bg-muted/20"
                      }`}
                    >
                      <span className="text-lg">{d.emoji}</span>
                      <span>{d.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-2">Ton de réponse</label>
                <div className="grid grid-cols-3 gap-2">
                  {TONES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setTone(t.key)}
                      className={`text-left px-3 py-2 rounded-md border text-xs ${
                        tone === t.key
                          ? "border-primary bg-primary/10"
                          : "border-border hover:bg-muted/20"
                      }`}
                    >
                      <div className="font-medium text-sm">{t.label}</div>
                      <div className="text-muted">{t.description}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-2">
                  Rôles autorisés ({allowedRoles.length === 0 ? "ouvert à tous" : `${allowedRoles.length} sélectionné(s)`})
                </label>
                <div className="flex gap-2 flex-wrap">
                  {ROLES.map((r) => (
                    <button
                      key={r.key}
                      onClick={() => toggleRole(r.key)}
                      className={`px-3 py-1.5 rounded-full text-xs border ${
                        allowedRoles.includes(r.key)
                          ? "bg-primary/15 border-primary text-primary"
                          : "border-border hover:bg-muted/20"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-muted mt-1">
                  Aucun coché = ouvert à tous les utilisateurs authentifiés.
                </p>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1">
                  Mots-clés d'expertise <span className="text-muted">(optionnel)</span>
                </label>
                <textarea
                  value={expertise}
                  onChange={(e) => setExpertise(e.target.value)}
                  placeholder="Ex: RGPD, contrats SaaS, jurisprudence française récente, CCN syntec…"
                  maxLength={500}
                  rows={2}
                  className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                />
                <p className="text-[10px] text-muted mt-0.5">
                  Précisions pour personnaliser le pre-prompt généré.
                </p>
              </div>
            </>
          )}

          {/* Step 3: preview & validation */}
          {step === 3 && (
            <>
              {drafting ? (
                <div className="py-12 text-center">
                  <Loader2 size={28} className="mx-auto mb-3 animate-spin text-primary" />
                  <p className="text-sm">Génération du prompt par qwen2.5:14b…</p>
                  <p className="text-xs text-muted mt-1">~10-30 secondes selon la charge GPU.</p>
                </div>
              ) : draft ? (
                <>
                  <div className="rounded-md border border-border bg-muted/5 p-3">
                    <div className="flex items-start gap-3">
                      <div className="text-3xl">{icon}</div>
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold">{name}</div>
                        <div className="text-xs text-muted">{description}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/15">
                            {DOMAINS.find((d) => d.key === domain)?.label}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/15">
                            ton {TONES.find((t) => t.key === tone)?.label.toLowerCase()}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted/15">
                            {allowedRoles.length === 0 ? "ouvert à tous" : `${allowedRoles.length} rôle(s)`}
                          </span>
                          {draft.fallback && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400">
                              fallback (pas de génération IA)
                            </span>
                          )}
                          {!draft.fallback && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/15 text-accent">
                              IA · {(draft.generation_ms / 1000).toFixed(1)}s
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={generateDraft}
                        disabled={drafting}
                        className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1"
                        title="Régénérer"
                      >
                        <RefreshCw size={12} /> Régénérer
                      </button>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium block mb-1">
                      Instructions système (pre-prompt)
                    </label>
                    <textarea
                      value={draft.pre_prompt}
                      onChange={(e) => setDraft({ ...draft, pre_prompt: e.target.value })}
                      rows={6}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
                    />
                    <div className="text-[10px] text-muted text-right mt-0.5">
                      {draft.pre_prompt.length} car.
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium block mb-1">Message d'accueil</label>
                    <textarea
                      value={draft.opening_statement}
                      onChange={(e) => setDraft({ ...draft, opening_statement: e.target.value })}
                      rows={2}
                      className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
                    />
                  </div>

                  <div>
                    <label className="text-xs font-medium block mb-1">Questions suggérées</label>
                    <div className="space-y-1.5">
                      {draft.suggested_questions.map((q, i) => (
                        <input
                          key={i}
                          value={q}
                          onChange={(e) => {
                            const next = [...draft.suggested_questions];
                            next[i] = e.target.value;
                            setDraft({ ...draft, suggested_questions: next });
                          }}
                          placeholder={`Question ${i + 1}…`}
                          className="w-full bg-background border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:border-primary"
                        />
                      ))}
                    </div>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-card border-t border-border px-5 py-3 flex items-center justify-between">
          <button
            onClick={back}
            disabled={step === 1 || creating || drafting}
            className="text-xs text-muted hover:text-foreground inline-flex items-center gap-1 disabled:opacity-30"
          >
            <ArrowLeft size={14} /> Retour
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/20"
            >
              Annuler
            </button>
            {step < 3 ? (
              <button
                onClick={next}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
              >
                Suivant <ArrowRight size={14} />
              </button>
            ) : (
              <button
                onClick={create}
                disabled={creating || drafting || !draft || !draft.pre_prompt.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-accent text-accent-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
              >
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                {creating ? "Création…" : "Créer l'assistant"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
