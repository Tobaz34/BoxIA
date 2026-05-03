"use client";

/**
 * Carte « Fournisseurs Cloud (BYOK) » — visible sur /settings.
 *
 * BYOK = Bring Your Own Key. L'admin du client utilise SES propres
 * abonnements ChatGPT Pro / Claude Pro / Mistral / Gemini pour bénéficier
 * des modèles cloud SOTA sans surcoût (les clés API sont à lui).
 *
 * Cette carte permet de :
 *   - Configurer / révoquer une clé par provider (chiffrement local AES-GCM
 *     + push à Dify si plugin installé).
 *   - Suivre l'état de santé live (Opérationnel / Attention / Erreur),
 *     synchronisé avec les badges header (cf. SystemMetricsWidget).
 *   - Voir le coût ce mois + nombre de requêtes par provider.
 *   - Activer/désactiver chaque modèle individuellement (avec son tarif
 *     €/1M tokens visible à côté).
 *   - Reset les compteurs (utile après résolution d'un état rouge :
 *     rotation de clé, top-up de crédits).
 *   - Régler le plafond mensuel global (alerte 80%, hard cap 100%).
 *   - Toggle PII scrub (RGPD) — ON par défaut.
 */
import { useEffect, useState } from "react";
import {
  Cloud, KeyRound, ShieldCheck, AlertCircle, Trash2, ExternalLink,
  CheckCircle2, RefreshCw, RotateCcw, ChevronDown, ChevronRight,
} from "lucide-react";
import { ProviderLogo } from "@/lib/cloud-provider-logos";

type ProviderId = "openai" | "anthropic" | "google" | "mistral";

interface ProviderCatalogEntry {
  id: ProviderId;
  name: string;
  default_models: string[];
  api_keys_url: string;
  key_format_hint: string;
}

interface ProviderState {
  id: string;
  configured: boolean;
  enabled_models: string[];
  key_prefix?: string;
  configured_at?: number;
  tokens_this_month?: number;
  cost_eur_this_month?: number;
  requests_this_month?: number;
  last_success_at?: number;
  last_error?: { at: number; status: number; code: string; message: string };
}

interface ModelPricing { in: number; out: number }

interface ApiResponse {
  catalog: ProviderCatalogEntry[];
  state: Record<string, ProviderState>;
  budget_monthly_eur: number;
  pii_scrub_enabled: boolean;
  pricing: Record<string, ModelPricing>;
}

type Health = "ok" | "warning" | "error" | "idle";

function computeHealth(
  p: ProviderState | undefined, budget: number, totalUsage: number,
): Health {
  if (!p?.configured) return "idle";
  const now = Date.now();
  const FIVE_MIN = 5 * 60 * 1000;
  const THIRTY_MIN = 30 * 60 * 1000;
  if (p.last_error) {
    const age = now - p.last_error.at;
    const isCritical = ["invalid_api_key", "insufficient_credits"].includes(p.last_error.code);
    if (age < FIVE_MIN && isCritical) return "error";
    if (age < FIVE_MIN || age < THIRTY_MIN) return "warning";
  }
  if (budget > 0) {
    const pct = totalUsage / budget;
    if (pct >= 1) return "error";
    if (pct >= 0.8) return "warning";
  }
  if (!p.last_success_at) return "idle";
  return "ok";
}

const HEALTH_COLOR: Record<Health, { border: string; bg: string; pill: string; label: string }> = {
  ok:      { border: "border-emerald-500/40", bg: "bg-emerald-500/5",
             pill: "bg-emerald-500/15 text-emerald-400", label: "Opérationnel" },
  warning: { border: "border-amber-500/50",   bg: "bg-amber-500/5",
             pill: "bg-amber-500/15 text-amber-400", label: "Attention" },
  error:   { border: "border-red-500/60",     bg: "bg-red-500/5",
             pill: "bg-red-500/15 text-red-400", label: "En erreur" },
  idle:    { border: "border-border",         bg: "bg-muted/5",
             pill: "bg-muted/15 text-muted", label: "Configuré" },
};

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return "à l'instant";
  if (d < 3_600_000) return `il y a ${Math.floor(d / 60_000)} min`;
  if (d < 86_400_000) return `il y a ${Math.floor(d / 3_600_000)} h`;
  return `il y a ${Math.floor(d / 86_400_000)} j`;
}

export function CloudProvidersCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const reload = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/cloud-providers", { cache: "no-store" });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        setError(j.detail || `HTTP ${r.status}`);
        return;
      }
      setData(await r.json());
      setError(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  async function configure(id: string) {
    if (!keyInput.trim()) return;
    setSubmitting(true);
    try {
      const r = await fetch("/api/cloud-providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, api_key: keyInput.trim() }),
      });
      const j = await r.json();
      if (!r.ok) {
        alert("Échec : " + (j.detail || j.error || `HTTP ${r.status}`));
        return;
      }
      setEditing(null);
      setKeyInput("");
      await reload();
    } finally {
      setSubmitting(false);
    }
  }

  async function revoke(id: string) {
    if (!confirm(`Révoquer la clé ${id} ? L'accès aux modèles cloud sera coupé.`)) return;
    const r = await fetch(`/api/cloud-providers?id=${id}`, { method: "DELETE" });
    if (r.ok) await reload();
    else alert("Erreur révocation");
  }

  async function resetCounters(id: string) {
    if (!confirm(`Reset compteurs ${id} (coût ce mois, requêtes, dernière erreur) ?`)) return;
    const r = await fetch("/api/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "reset_counters" }),
    });
    if (r.ok) await reload();
    else alert("Erreur reset");
  }

  async function toggleModel(id: string, model: string) {
    if (!data) return;
    const cur = data.state[id]?.enabled_models || [];
    const next = cur.includes(model)
      ? cur.filter((m) => m !== model)
      : [...cur, model];
    const r = await fetch("/api/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action: "update_models", enabled_models: next }),
    });
    if (r.ok) await reload();
  }

  async function updateBudget(eur: number) {
    await fetch("/api/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ budget_monthly_eur: eur }),
    });
    await reload();
  }

  async function togglePiiScrub() {
    if (!data) return;
    await fetch("/api/cloud-providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pii_scrub_enabled: !data.pii_scrub_enabled }),
    });
    await reload();
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading) {
    return (
      <div id="cloud-providers" className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-semibold flex items-center gap-2">
          <Cloud size={16} className="text-muted" />
          Fournisseurs Cloud (BYOK)
        </h2>
        <p className="text-sm text-muted mt-2">Chargement…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div id="cloud-providers" className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-semibold">Fournisseurs Cloud</h2>
        <p className="text-sm text-red-400 mt-2">{error || "Erreur de chargement"}</p>
      </div>
    );
  }

  const totalCost = Object.values(data.state).reduce(
    (sum, s) => sum + (s.cost_eur_this_month || 0), 0,
  );
  const totalRequests = Object.values(data.state).reduce(
    (sum, s) => sum + (s.requests_this_month || 0), 0,
  );
  const budgetPct = data.budget_monthly_eur > 0
    ? Math.round((totalCost / data.budget_monthly_eur) * 100)
    : 0;

  return (
    <div id="cloud-providers" className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold flex items-center gap-2">
          <Cloud size={16} className="text-muted" />
          Fournisseurs Cloud (BYOK)
        </h2>
        <button
          onClick={reload}
          className="p-1.5 rounded hover:bg-muted/20 text-muted"
          title="Rafraîchir"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Bandeau RGPD */}
      <div className="mb-3 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs px-3 py-2 flex items-start gap-2">
        <ShieldCheck size={12} className="shrink-0 mt-0.5" />
        <span>
          <strong>Bring Your Own Key (BYOK)</strong> — utilise tes propres
          abonnements ChatGPT Pro / Claude Pro / Gemini / Mistral pour les
          tâches haute capacité. <strong>Aucune donnée personnelle envoyée</strong>{" "}
          (filtre PII automatique : emails, téléphones, SIRET, IBAN, cartes).
          Les clés sont chiffrées AES-256-GCM at-rest.
        </span>
      </div>

      {/* Settings globaux */}
      <div className="space-y-2 mb-4 text-xs">
        <label className="flex items-center justify-between p-2 rounded bg-muted/10">
          <span className="flex items-center gap-1.5">
            <ShieldCheck size={11} />
            Filtre PII actif (RGPD)
          </span>
          <button
            onClick={togglePiiScrub}
            className={
              "px-2.5 py-0.5 rounded text-[10px] font-medium transition-default " +
              (data.pii_scrub_enabled
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400")
            }
          >
            {data.pii_scrub_enabled ? "ON" : "OFF (déconseillé)"}
          </button>
        </label>
        <label className="flex items-center justify-between p-2 rounded bg-muted/10">
          <span>Plafond mensuel (€)</span>
          <input
            type="number"
            min="0"
            step="10"
            defaultValue={data.budget_monthly_eur}
            onBlur={(e) => updateBudget(Number(e.target.value) || 0)}
            className="w-20 px-2 py-0.5 text-right rounded bg-background border border-border text-xs"
          />
        </label>
        {data.budget_monthly_eur > 0 && (
          <div className="text-[11px] text-muted">
            Conso ce mois : <strong>{totalCost.toFixed(3)} €</strong> /{" "}
            {data.budget_monthly_eur} € ({budgetPct}%) ·{" "}
            <strong>{totalRequests}</strong> requêtes
            {budgetPct >= 80 && (
              <span className={"ml-2 " + (budgetPct >= 100 ? "text-red-400" : "text-amber-400")}>
                {budgetPct >= 100 ? "⛔ Plafond atteint" : "⚠ Approche du plafond"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Liste des providers */}
      <div className="space-y-2">
        {data.catalog.map((p) => {
          const state = data.state[p.id];
          const configured = state?.configured;
          const isEditing = editing === p.id;
          const isExpanded = expanded.has(p.id);
          const health = computeHealth(state, data.budget_monthly_eur, totalCost);
          const colors = HEALTH_COLOR[health];
          const enabled = state?.enabled_models || [];

          return (
            <div
              key={p.id}
              className={`rounded-md border p-2.5 ${configured ? colors.border : "border-border"} ${configured ? colors.bg : "bg-muted/5"}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="inline-flex items-center justify-center w-5 h-5 shrink-0">
                      <ProviderLogo id={p.id as ProviderId} size={14} colored={configured} />
                    </span>
                    <span className="font-medium text-sm">{p.name}</span>
                    {configured && (
                      <span className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded ${colors.pill}`}>
                        {health === "ok" && <CheckCircle2 size={9} />}
                        {health === "warning" && <AlertCircle size={9} />}
                        {health === "error" && <AlertCircle size={9} />}
                        {colors.label}
                      </span>
                    )}
                  </div>

                  {/* Stats — visibles dès qu'on a un compteur */}
                  {configured && (
                    <div className="mt-1 text-[10px] text-muted flex flex-wrap gap-x-3 gap-y-0.5">
                      {state.key_prefix && (
                        <span className="font-mono">Clé : {state.key_prefix}••••</span>
                      )}
                      <span>{enabled.length}/{p.default_models.length} modèles activés</span>
                      {(state.requests_this_month || 0) > 0 && (
                        <span>{state.requests_this_month} req</span>
                      )}
                      {(state.cost_eur_this_month || 0) > 0 && (
                        <span><strong>{(state.cost_eur_this_month || 0).toFixed(3)} €</strong> ce mois</span>
                      )}
                      {state.last_success_at && (
                        <span className="text-emerald-400/80">✓ {relTime(state.last_success_at)}</span>
                      )}
                      {state.last_error && (
                        <span className={health === "error" ? "text-red-400" : "text-amber-400"}>
                          ✗ {state.last_error.code} ({relTime(state.last_error.at)})
                        </span>
                      )}
                    </div>
                  )}
                  {state?.last_error?.message && (
                    <div className={`mt-1 text-[10px] ${health === "error" ? "text-red-400" : "text-amber-400"}`}>
                      {state.last_error.message}
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  {configured && (
                    <>
                      <button
                        onClick={() => toggleExpanded(p.id)}
                        className="p-1 rounded text-muted hover:text-foreground hover:bg-muted/20"
                        title={isExpanded ? "Masquer modèles" : "Voir/éditer modèles"}
                      >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                      <button
                        onClick={() => resetCounters(p.id)}
                        className="p-1 rounded text-muted hover:text-amber-400 hover:bg-amber-500/10"
                        title="Reset compteurs (coût + erreurs)"
                      >
                        <RotateCcw size={11} />
                      </button>
                    </>
                  )}
                  <a
                    href={p.api_keys_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1 rounded text-muted hover:text-foreground hover:bg-muted/20"
                    title="Obtenir une clé API"
                  >
                    <ExternalLink size={11} />
                  </a>
                  {configured ? (
                    <button
                      onClick={() => revoke(p.id)}
                      className="p-1 rounded text-muted hover:text-red-400 hover:bg-red-500/10"
                      title="Révoquer la clé"
                    >
                      <Trash2 size={11} />
                    </button>
                  ) : (
                    <button
                      onClick={() => { setEditing(p.id); setKeyInput(""); }}
                      className="px-2 py-0.5 rounded text-[10px] bg-primary text-primary-foreground hover:opacity-90"
                    >
                      <KeyRound size={9} className="inline mr-0.5" />
                      Configurer
                    </button>
                  )}
                </div>
              </div>

              {/* Panneau modèles activables (expand) */}
              {configured && isExpanded && (
                <div className="mt-2 pt-2 border-t border-border space-y-1">
                  <div className="text-[10px] text-muted mb-1">
                    Modèles activables (toggle) — tarifs €/1M tokens (in/out) :
                  </div>
                  {p.default_models.map((m) => {
                    const isOn = enabled.includes(m);
                    const price = data.pricing[m];
                    return (
                      <label
                        key={m}
                        className="flex items-center justify-between gap-2 p-1.5 rounded hover:bg-muted/10 cursor-pointer text-xs"
                      >
                        <span className="flex items-center gap-2 min-w-0 flex-1">
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={() => toggleModel(p.id, m)}
                            className="accent-primary"
                          />
                          <span className="font-mono truncate">{m}</span>
                        </span>
                        {price && (
                          <span className="text-[10px] text-muted tabular-nums shrink-0">
                            in {price.in.toFixed(2)} · out {price.out.toFixed(2)}
                          </span>
                        )}
                      </label>
                    );
                  })}
                </div>
              )}

              {/* Form clé API */}
              {isEditing && (
                <div className="mt-2 pt-2 border-t border-border">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={p.key_format_hint}
                    autoFocus
                    className="w-full px-2 py-1.5 text-xs font-mono rounded bg-background border border-border focus:outline-none focus:border-primary"
                  />
                  <div className="flex justify-end gap-1.5 mt-1.5">
                    <button
                      onClick={() => { setEditing(null); setKeyInput(""); }}
                      className="px-2.5 py-0.5 text-[11px] rounded border border-border hover:bg-muted/15"
                    >
                      Annuler
                    </button>
                    <button
                      onClick={() => configure(p.id)}
                      disabled={submitting || !keyInput.trim()}
                      className="px-2.5 py-0.5 text-[11px] rounded bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
                    >
                      {submitting ? "Enregistrement…" : "Enregistrer"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 flex items-start gap-1.5 text-[11px] text-muted">
        <AlertCircle size={11} className="shrink-0 mt-0.5" />
        <span>
          Les clés sont chiffrées AES-256-GCM localement (jamais en clair sur
          disque) ET poussées à Dify si plugin disponible. Les coûts affichés
          sont des <em>estimations</em> basées sur la taille des prompts/réponses
          — la facture réelle vient du dashboard du provider.
        </span>
      </div>
    </div>
  );
}
