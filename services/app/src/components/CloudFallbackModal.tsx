"use client";

/**
 * Modale d'autorisation explicite pour bascule cloud.
 *
 * Affichée par Chat.tsx quand le serveur émet un event SSE
 * `cloud_fallback_needed` (cf. lib/local-failure-detect.ts), typiquement
 * sur OOM Ollama / context overflow / model unavailable. L'utilisateur
 * voit le pourquoi (tier-mid 12 GB ne suffit pas pour vision concurrent),
 * le provider/modèle proposé, le coût estimé, et 3 actions :
 *
 *   - "Configurer le cloud"  → redirige /settings#cloud (si pas configuré)
 *   - "Annuler"               → ferme la modale, garde l'erreur visible
 *   - "Toujours autoriser"    → V2 (sera stocké en localStorage policy)
 *
 * V1 : on ne propose PAS de re-soumission automatique au cloud (nécessite
 * un endpoint /api/chat-cloud avec store de clé locale chiffrée — V2).
 *
 * RGPD : le banner mentionne explicitement que :
 *   - les données vont sortir du LAN
 *   - un PII scrub (caviardage emails / téléphones / IBAN / SIRET) est
 *     appliqué avant l'envoi (configurable dans /settings)
 */
import { useRouter } from "next/navigation";
import {
  Cloud, AlertTriangle, X, Settings as SettingsIcon, ExternalLink,
} from "lucide-react";

export interface CloudFallbackContext {
  /** Type de défaillance détectée. */
  kind: "oom" | "context_overflow" | "model_unavailable" | "unknown";
  /** Message technique (court) pour debug. */
  reason: string;
  /** Provider suggéré (default openai). */
  suggested_provider: "openai" | "anthropic" | "mistral";
  /** Modèle suggéré (gpt-4o pour vision, gpt-4o-mini sinon). */
  suggested_model: string;
  /** Coût estimé en € (très approximatif). */
  estimated_cost_eur: number;
  /** Slug agent original (pour audit). */
  agent: string | null;
}

interface Props {
  ctx: CloudFallbackContext;
  /** Map des providers configurés côté admin (clés OK dans /settings). */
  configuredProviders: Set<"openai" | "anthropic" | "mistral">;
  onClose: () => void;
}

const KIND_LABEL: Record<CloudFallbackContext["kind"], string> = {
  oom: "Mémoire GPU saturée",
  context_overflow: "Limite de contexte dépassée",
  model_unavailable: "Modèle indisponible",
  unknown: "Défaillance locale",
};

const KIND_DETAIL: Record<CloudFallbackContext["kind"], string> = {
  oom:
    "Le modèle local n'a pas pu charger en VRAM. Cela arrive typiquement " +
    "quand un modèle vision est demandé alors qu'un modèle texte 14B est " +
    "déjà chargé (sur GPU 12 GB).",
  context_overflow:
    "La requête (avec ses fichiers attachés) dépasse la fenêtre de " +
    "contexte du modèle local (4k/8k/32k tokens selon configuration).",
  model_unavailable:
    "Le modèle local est temporairement indisponible (Ollama non joignable, " +
    "modèle non installé, ou réseau Docker en panne).",
  unknown:
    "Une erreur inattendue est survenue côté local. Le cloud peut " +
    "permettre de débloquer la situation pour cette requête.",
};

const PROVIDER_LABEL: Record<"openai" | "anthropic" | "mistral", string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  mistral: "Mistral",
};

export function CloudFallbackModal({ ctx, configuredProviders, onClose }: Props) {
  const router = useRouter();
  const isProviderConfigured = configuredProviders.has(ctx.suggested_provider);
  const anyProviderConfigured = configuredProviders.size > 0;

  function goToSettings() {
    onClose();
    router.push("/settings#cloud-providers");
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-card border border-border rounded-lg w-full max-w-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — banner orange car situation dégradée */}
        <div className="flex items-start gap-3 p-5 border-b border-border">
          <div className="w-10 h-10 rounded-md bg-yellow-500/15 text-yellow-400 flex items-center justify-center shrink-0">
            <AlertTriangle size={20} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold">
              {KIND_LABEL[ctx.kind]} — bascule cloud proposée
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Votre carte graphique locale n'a pas pu traiter cette requête.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted/30 text-muted"
            title="Fermer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <p className="text-sm">{KIND_DETAIL[ctx.kind]}</p>

          {/* Suggestion */}
          <div className="rounded-md border border-border bg-muted/5 p-3 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <Cloud size={14} className="text-cyan-400" />
              Solution proposée
            </div>
            <div className="text-sm">
              Utiliser <strong>{PROVIDER_LABEL[ctx.suggested_provider]}</strong>{" "}
              ({ctx.suggested_model}) pour cette requête uniquement.
            </div>
            <div className="text-xs text-muted">
              Coût estimé : <strong>~{ctx.estimated_cost_eur.toFixed(3)} €</strong>{" "}
              · Provider {isProviderConfigured ? "✓ configuré" : "non configuré"}
            </div>
          </div>

          {/* RGPD warning */}
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-xs px-3 py-2">
            ⚠ Vos données vont sortir du LAN. Un caviardage automatique
            (emails, téléphones, IBAN, SIRET) est appliqué avant l'envoi
            si le filtre PII est activé dans <em>Paramètres</em>.
          </div>

          {/* Status providers */}
          {!anyProviderConfigured && (
            <div className="rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs px-3 py-2">
              ℹ Aucun provider cloud n'est configuré pour cette box. L'admin
              doit ajouter une clé API dans <em>Paramètres → Providers cloud</em>.
            </div>
          )}
          {anyProviderConfigured && !isProviderConfigured && (
            <div className="rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-300 text-xs px-3 py-2">
              ℹ Le provider suggéré ({PROVIDER_LABEL[ctx.suggested_provider]})
              n'est pas configuré, mais d'autres le sont (
              {[...configuredProviders].map((p) => PROVIDER_LABEL[p]).join(", ")}
              ). Configurez {PROVIDER_LABEL[ctx.suggested_provider]} dans{" "}
              <em>Paramètres</em> ou utilisez un agent dédié.
            </div>
          )}

          <p className="text-[11px] text-muted">
            Détails techniques (debug) : <code className="font-mono">{ctx.reason}</code>
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-2 text-sm rounded-md border border-border hover:bg-muted/20"
          >
            Annuler
          </button>
          <button
            onClick={goToSettings}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-500 text-white text-sm font-medium hover:bg-cyan-400"
          >
            <SettingsIcon size={14} />
            Configurer le cloud
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
