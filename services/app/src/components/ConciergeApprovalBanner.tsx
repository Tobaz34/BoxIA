"use client";

/**
 * ConciergeApprovalBanner — banner global qui affiche les actions
 * Concierge en attente d'approbation utilisateur.
 *
 * Pourquoi : sans ce gate côté UI, un prompt injection dans un email
 * RAG / PDF / titre de page peut faire appeler un tool mutatif sans
 * que l'admin ait validé. La gate côté serveur (lib/approval-gate.ts)
 * bloque l'exécution ; ce composant est la matérialisation visuelle.
 *
 * Polling : toutes les 5s tant qu'admin connecté. Stoppe quand 0
 * pending pour éviter de spammer le réseau (relance dès qu'un
 * pending apparaît au prochain poll).
 *
 * UX : pas de modal, banner sticky en haut. Si plusieurs actions
 * pending → on les affiche toutes empilées (rare en pratique, mais
 * faut pas en cacher).
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
}

const POLL_MS = 5000;

export function ConciergeApprovalBanner() {
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<{
    id: string;
    ok: boolean;
    message: string;
  } | null>(null);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/concierge/pending", { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { pending?: PendingApproval[] };
      setPending(j.pending || []);
    } catch {
      // silencieux : si la box est down, on n'affiche rien
    }
  }, []);

  useEffect(() => {
    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  const decide = useCallback(
    async (action_id: string, decision: "approve" | "reject") => {
      setBusy((b) => ({ ...b, [action_id]: true }));
      try {
        const r = await fetch("/api/concierge/decide", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action_id, decision }),
        });
        const j = (await r.json()) as {
          ok?: boolean;
          execution?: { body?: { message?: string; error?: string } };
          error?: string;
        };
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
        // Re-poll immédiatement pour rafraîchir
        await poll();
        // Cleanup du toast après 6s
        setTimeout(() => setLastResult((r) => (r?.id === action_id ? null : r)), 6000);
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
    [poll],
  );

  if (pending.length === 0 && !lastResult) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-40 flex flex-col gap-1 px-3 pt-2 pointer-events-none">
      {pending.map((p) => {
        const ttl = Math.max(0, Math.round((p.expires_at - Date.now()) / 1000));
        return (
          <div
            key={p.id}
            className="pointer-events-auto mx-auto w-full max-w-3xl rounded-md border border-amber-500/40 bg-amber-500/10 backdrop-blur shadow-lg px-3 py-2 flex items-start gap-3"
          >
            <ShieldAlert size={16} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-amber-300">
                Action Concierge en attente d&apos;approbation
              </div>
              <div className="text-[13px] mt-0.5">{p.description}</div>
              <div className="text-[10px] text-muted mt-0.5">
                Tool: <code>{p.action}</code> · expire dans {ttl}s
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                disabled={busy[p.id]}
                onClick={() => decide(p.id, "approve")}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
              >
                {busy[p.id] ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
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
        );
      })}
      {lastResult && (
        <div
          className={
            "pointer-events-auto mx-auto w-full max-w-3xl rounded-md border px-3 py-2 text-[12px] shadow " +
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
