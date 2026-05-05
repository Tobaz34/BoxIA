"use client";

/**
 * DelegationCard — bloc collapsible qui matérialise une délégation du
 * Concierge à un agent spécialisé.
 *
 * Pourquoi : sans ce composant, l'utilisateur ne voit que la synthèse du
 * Concierge. Il ne sait pas qu'un sub-agent a été appelé, ni avec quel
 * prompt, ni avec quelle réponse intermédiaire. Pour la transparence
 * (RGPD + débugabilité), on matérialise la délégation comme un bloc
 * collapsible inline dans le message du Concierge.
 *
 * Usage typique : MessageMarkdown.tsx parse les délégations depuis le
 * stream agent_thought / tool_call et insère un <DelegationCard> à
 * l'endroit approprié dans le rendu.
 *
 * Format des données : c'est le payload du tool_call/tool_result Dify
 * pour delegate_to_specialist.
 *
 * Référence : Sprint 2b P0 #4 — tools/research/audit_P0_04_delegate.md
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Users, Loader2 } from "lucide-react";

export interface DelegationCardProps {
  /** Slug de l'agent appelé (general/vision/accountant/hr/support). */
  targetSlug: string;
  /** Nom affiché de l'agent (« Assistant comptable »). Si absent, fallback slug. */
  targetName?: string;
  /** Emoji/icon de l'agent ("📊", "👁"...). */
  targetIcon?: string;
  /** Le prompt envoyé au specialist (peut être long). */
  prompt?: string;
  /** La réponse retournée par le specialist (peut être long). */
  answer?: string;
  /** Profondeur courante (1 = direct par concierge, 2 = sub-délégation). */
  depth?: number;
  /** True si la délégation est en cours (sans réponse encore). */
  pending?: boolean;
  /** True si la délégation a échoué (timeout, agent indispo, etc.). */
  failed?: boolean;
  /** Message d'erreur si failed. */
  errorHint?: string;
}

export function DelegationCard({
  targetSlug,
  targetName,
  targetIcon,
  prompt,
  answer,
  depth,
  pending,
  failed,
  errorHint,
}: DelegationCardProps) {
  const [open, setOpen] = useState(false);

  const displayName = targetName || targetSlug;
  const icon = targetIcon || "🤖";

  const headerColor = failed
    ? "border-red-500/40 bg-red-500/5"
    : pending
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-violet-500/30 bg-violet-500/5";

  return (
    <div className={`my-2 rounded-md border ${headerColor} text-[13px]`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5"
      >
        {open ? (
          <ChevronDown size={14} className="text-muted shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-muted shrink-0" />
        )}
        <Users size={14} className="text-violet-400 shrink-0" />
        <span className="font-medium">
          {pending ? (
            <>
              <Loader2 size={12} className="inline animate-spin mr-1" />
              Demande à <span className="mr-1">{icon}</span>
              {displayName}…
            </>
          ) : failed ? (
            <>
              ❌ Délégation à <span className="mr-1">{icon}</span>
              {displayName} — échec
            </>
          ) : (
            <>
              🤝 Réponse de <span className="mr-1">{icon}</span>
              {displayName}
            </>
          )}
        </span>
        {typeof depth === "number" && depth > 1 && (
          <span className="text-[10px] text-muted ml-auto">depth {depth}</span>
        )}
      </button>

      {open && (
        <div className="border-t border-current/10 px-3 py-2 space-y-2">
          {prompt && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-muted hover:text-fg">
                Prompt envoyé
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-[11px] text-muted/90 bg-black/20 rounded p-2 max-h-48 overflow-auto">
                {prompt}
              </pre>
            </details>
          )}
          {failed && errorHint && (
            <div className="text-[12px] text-red-300">
              <strong>Erreur :</strong> {errorHint}
            </div>
          )}
          {!failed && answer && (
            <div className="text-[12px]">
              <div className="text-muted text-[11px] mb-1">
                Réponse intégrée par le Concierge dans sa synthèse ci-dessous.
              </div>
              <pre className="whitespace-pre-wrap text-[12px] bg-black/20 rounded p-2 max-h-72 overflow-auto">
                {answer}
              </pre>
            </div>
          )}
          {pending && !answer && !failed && (
            <div className="text-[12px] text-amber-300/80 italic">
              Le specialist réfléchit… (timeout 60s)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
