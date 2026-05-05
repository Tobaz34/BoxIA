"use client";

/**
 * ApprovalBanner — banner global générique qui affiche les actions
 * en attente d'approbation utilisateur (HITL).
 *
 * Version générique de ConciergeApprovalBanner (qui reste comme
 * thin wrapper rétrocompat). Ajouts vs Concierge :
 * - Checkbox "ne plus me redemander pour cette tâche" → flag
 *   auto_approve_persistent (D5/D7 décisions architecturales P0 #2)
 * - Endpoint configurable (par défaut /api/approvals + /api/approvals/<id>/decide)
 *
 * Pourquoi : la HITL doit couvrir TOUS les tools mutatifs, pas juste
 * le Concierge (cf tools/research/audit_P0_02_hitl.md). Cet écran est
 * le banner global ; la page /approvals offre une vue batch.
 *
 * Polling : toutes les 5s. Stoppe (silencieux) quand 0 pending pour
 * ne pas spammer le réseau.
 *
 * UX : pas de modal, banner sticky en haut. Plusieurs actions pending
 * → empilées (rare mais important de ne pas en cacher).
 */
import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, Check, X, Loader2 } from "lucide-react";

interface PendingApproval {
  id: string;
  action: string;
  description: string;
  params: Record<string, unknown>;
  created_at: number;
  expires_at: number;
  status: "pending" | "approved" | "rejected";
  user_id?: string;
  auto_approve_key?: string;
  conversation_id?: string;
}

interface DecideResult {
  ok?: boolean;
  execution?: { body?: { message?: string; error?: string } };
  error?: string;
}

const POLL_MS = 5000;

export interface ApprovalBannerProps {
  /** Endpoint GET pour lister les pending (défaut /api/approvals). */
  pendingUrl?: string;
  /** Builder pour l'URL de décision (défaut /api/approvals/:id/decide). */
  decideUrlFor?: (id: string) => string;
  /** Position fixed top (true) ou inline (false, pour la page /approvals). */
  fixed?: boolean;
}

export function ApprovalBanner({
  pendingUrl = "/api/approvals",
  decideUrlFor = (id) => `/api/approvals/${id}/decide`,
  fixed = true,
}: ApprovalBannerProps) {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [autoApprove, setAutoApprove] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(pendingUrl, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { pending?: PendingApproval[] };
      setPending(j.pending || []);
    } catch {
      // silencieux : si la box est down, on n'affiche rien
    }
  }, [pendingUrl]);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const decide = useCallback(
    async (action_id: string, decision: "approve" | "reject") => {
      setBusy((b) => ({ ...b, [action_id]: true }));
      try {
        const r = await fetch(decideUrlFor(action_id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision,
            // Si l'utilisateur a coché la case auto-approuver pour cette
            // tâche, on transmet le flag → l'approbation persiste pour
            // les futurs appels avec la même (action, auto_approve_key).
            auto_approve_persistent:
              decision === "approve" && Boolean(autoApprove[action_id]),
          }),
        });
        const j = (await r.json()) as DecideResult;
        if (decision === "approve") {
          setLastResult({
            id: action_id,
            ok: !!j.ok,
            message:
              j.execution?.body?.message ||
              j.execution?.body?.error ||
              j.error ||
              (j.ok ? "Action exécutée." : "Erreur d'exécution."),
          });
        } else {
          setLastResult({
            id: action_id,
            ok: true,
            message: "Action refusée.",
          });
        }
        await poll();
        setTimeout(
          () => setLastResult((r) => (r?.id === action_id ? null : r)),
          6000,
        );
      } catch (e: unknown) {
        setLastResult({
          id: action_id,
          ok: false,
          message: `Erreur réseau : ${String(e).slice(0, 80)}`,
        });
      } finally {
        setBusy((b) => ({ ...b, [action_id]: false }));
      }
    },
    [decideUrlFor, poll, autoApprove],
  );

  if (pending.length === 0 && !lastResult) return null;

  const containerClass = fixed
    ? "fixed top-0 left-0 right-0 z-40 flex flex-col gap-1 px-3 pt-2 pointer-events-none"
    : "flex flex-col gap-2";

  return (
    <div className={containerClass}>
      {pending.map((p) => {
        const ttl = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
        const showAutoApproveOption = Boolean(p.auto_approve_key);
        return (
          <div
            key={p.id}
            className={
              (fixed ? "pointer-events-auto mx-auto w-full max-w-3xl " : "") +
              "rounded-md border border-amber-500/40 bg-amber-500/10 backdrop-blur shadow-lg px-3 py-2 flex flex-col gap-2"
            }
          >
            <div className="flex items-start gap-3">
              <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-amber-300">
                  Action en attente d&apos;approbation
                </div>
                <div className="text-[13px] mt-0.5">{p.description}</div>
                <div className="text-[10px] text-muted mt-0.5">
                  Tool: <code>{p.action}</code> · expire dans {ttl}s
                  {p.user_id && ` · ${p.user_id}`}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  disabled={busy[p.id]}
                  onClick={() => decide(p.id, "approve")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                >
                  {busy[p.id] ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Check size={12} />
                  )}
                  Approuver
                </button>
                <button
                  disabled={busy[p.id]}
                  onClick={() => decide(p.id, "reject")}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[12px] border border-border hover:bg-muted/30 disabled:opacity-50"
                >
                  <X size={12} />
                  Refuser
                </button>
              </div>
            </div>
            {showAutoApproveOption && (
              <label className="flex items-center gap-1.5 text-[11px] text-amber-200/80 ml-6 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-amber-400"
                  checked={Boolean(autoApprove[p.id])}
                  onChange={(e) =>
                    setAutoApprove((s) => ({ ...s, [p.id]: e.target.checked }))
                  }
                />
                Ne plus me redemander pour cette tâche (jusqu&apos;à expiration)
              </label>
            )}
          </div>
        );
      })}
      {lastResult && (
        <div
          className={
            (fixed ? "pointer-events-auto mx-auto w-full max-w-3xl " : "") +
            "rounded-md border px-3 py-2 text-[12px] shadow " +
            (lastResult.ok
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
              : "border-red-500/40 bg-red-500/10 text-red-300")
          }
        >
          {lastResult.message}
        </div>
      )}
    </div>
  );
}
