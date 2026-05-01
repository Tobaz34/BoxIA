"use client";

/**
 * Carte « Fournisseurs Cloud (BYOK) » — visible sur /settings.
 *
 * BYOK = Bring Your Own Key. L'admin du client utilise SES propres
 * abonnements ChatGPT Pro / Claude Pro / Mistral pour bénéficier des
 * modèles cloud SOTA sans surcoût (les clés API sont à lui).
 *
 * Règles affichées clairement :
 *   - Filtre PII automatique avant envoi (caviarde emails / téléphones /
 *     SIRET / IBAN / cartes bancaires).
 *   - Plafond mensuel en € (alerte 80%, hard cap 100%).
 *   - Toujours opt-in conscient : default = local.
 */
import { useEffect, useState } from "react";
import {
  Cloud, KeyRound, ShieldCheck, AlertCircle, Trash2, ExternalLink,
  CheckCircle2, RefreshCw,
} from "lucide-react";

interface ProviderCatalogEntry {
  id: "openai" | "anthropic" | "mistral";
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
}

interface ApiResponse {
  catalog: ProviderCatalogEntry[];
  state: Record<string, ProviderState>;
  budget_monthly_eur: number;
  pii_scrub_enabled: boolean;
}

export function CloudProvidersCard() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  if (loading) {
    return (
      <div className="bg-card border border-border rounded-lg p-4">
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
      <div className="bg-card border border-border rounded-lg p-4">
        <h2 className="font-semibold">Fournisseurs Cloud</h2>
        <p className="text-sm text-red-400 mt-2">{error || "Erreur de chargement"}</p>
      </div>
    );
  }

  const totalCost = Object.values(data.state).reduce(
    (sum, s) => sum + (s.cost_eur_this_month || 0), 0,
  );
  const budgetPct = data.budget_monthly_eur > 0
    ? Math.round((totalCost / data.budget_monthly_eur) * 100)
    : 0;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
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
          abonnements ChatGPT Pro / Claude Pro / Mistral pour les tâches
          haute capacité. <strong>Aucune donnée personnelle envoyée</strong>{" "}
          (filtre PII automatique : emails, téléphones, SIRET, IBAN, cartes).
          Les clés sont stockées chiffrées côté Dify, jamais en clair sur disque.
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
            Conso ce mois : {totalCost.toFixed(2)} € / {data.budget_monthly_eur} € ({budgetPct}%)
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
          return (
            <div
              key={p.id}
              className={
                "rounded-md border p-2.5 " +
                (configured
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : "border-border bg-muted/5")
              }
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm">{p.name}</span>
                    {configured && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                        <CheckCircle2 size={9} />
                        Configuré
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-muted mt-0.5">
                    Modèles : {p.default_models.join(", ")}
                  </div>
                  {configured && state.key_prefix && (
                    <div className="text-[10px] text-muted mt-0.5 font-mono">
                      Clé : {state.key_prefix}••••
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
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
                      title="Révoquer"
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
          Les clés sont POSTées vers Dify (chiffrement at-rest) et jamais
          stockées en clair sur le disque BoxIA. Pour révoquer côté provider,
          fais-le aussi sur leurs consoles (lien <ExternalLink size={9} className="inline" /> ci-dessus).
        </span>
      </div>
    </div>
  );
}
