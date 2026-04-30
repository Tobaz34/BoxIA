"use client";

/**
 * Bannière persistante en haut de l'app qui s'affiche tant que
 * l'utilisateur connecté a `attributes.must_change_password=true` côté
 * Authentik (livré avec le mot de passe par défaut `aibox-changeme2026`).
 *
 * Flow utilisateur :
 *   1. Bannière apparaît → propose un bouton « Changer maintenant »
 *   2. Click → ouvre la page utilisateur Authentik dans un NOUVEL onglet
 *      où il peut changer son mot de passe (le formulaire natif Authentik
 *      gère la validation, le hash, l'invalidation des sessions, etc.)
 *   3. Quand il revient sur l'onglet AI Box, il clique « J'ai changé,
 *      masquer le rappel » → POST /api/me/password-status { dismissed: true }
 *      qui clear le flag côté Authentik. Bannière disparaît.
 *
 * Pas de validation hard que le pwd a vraiment été changé : Authentik
 * admin API ne le permet pas. Tradeoff acceptable pour une box LAN.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, Check } from "lucide-react";

interface Status {
  must_change: boolean;
  change_url?: string;
  username?: string;
}

export function PasswordChangeBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/password-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setStatus(j); })
      .catch(() => { /* silencieux : pas critique */ });
    return () => { cancelled = true; };
  }, []);

  if (!status?.must_change) return null;

  async function dismiss() {
    setDismissing(true);
    try {
      const r = await fetch("/api/me/password-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissed: true }),
      });
      if (r.ok) setStatus({ must_change: false });
    } finally {
      setDismissing(false);
    }
  }

  function openChange() {
    if (status?.change_url) {
      window.open(status.change_url, "_blank", "noopener,noreferrer");
      setHasOpened(true);
    }
  }

  return (
    <div className="bg-amber-500/15 border-b border-amber-500/40 text-amber-200 px-4 py-2.5">
      <div className="max-w-6xl mx-auto flex items-center gap-3 flex-wrap">
        <AlertTriangle size={16} className="shrink-0 text-amber-400" />
        <div className="text-sm flex-1 min-w-[260px]">
          <strong>Mot de passe par défaut détecté.</strong>{" "}
          {hasOpened
            ? "Une fois changé dans la fenêtre Authentik, clique « J'ai changé »."
            : "Change-le dès maintenant pour sécuriser ton compte."}
        </div>
        <div className="flex items-center gap-2">
          {!hasOpened && (
            <button
              onClick={openChange}
              disabled={!status.change_url}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500 text-amber-950 text-xs font-medium hover:bg-amber-400 transition-default disabled:opacity-40"
            >
              <ExternalLink size={12} />
              Changer maintenant
            </button>
          )}
          {hasOpened && (
            <button
              onClick={dismiss}
              disabled={dismissing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 transition-default disabled:opacity-40"
            >
              <Check size={12} />
              {dismissing ? "..." : "J'ai changé"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
