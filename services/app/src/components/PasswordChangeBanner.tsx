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
import { useT } from "@/lib/i18n";

interface Status {
  must_change: boolean;
  change_url?: string;
  username?: string;
}

// Clé localStorage : si le user a cliqué « J'ai changé », on stocke ici
// pour ne pas re-afficher la bannière tant que l'API confirme aussi.
// Permet de persister le dismiss côté client même si l'API Authentik
// PATCH a échoué (le user n'est pas spammé).
const LS_DISMISSED_KEY = "aibox.password-banner-dismissed";

export function PasswordChangeBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const { t } = useT();

  // Read le dismiss local au mount (avant de fetcher l'état serveur)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(LS_DISMISSED_KEY) === "1") {
      setLocallyDismissed(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me/password-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j) {
          setStatus(j);
          // Si l'API confirme que le flag est down, on clean le marker
          // local (cas : un autre admin a fait le reset, ou recovery script).
          if (!j.must_change && typeof window !== "undefined") {
            localStorage.removeItem(LS_DISMISSED_KEY);
          }
        }
      })
      .catch(() => { /* silencieux : pas critique */ });
    return () => { cancelled = true; };
  }, []);

  // Hide si :
  //  - l'API dit que le user a déjà changé (must_change=false)
  //  - OU le user a cliqué « J'ai changé » localement (sticky même au refresh)
  if (!status?.must_change || locallyDismissed) return null;

  async function dismiss() {
    setDismissing(true);
    // 1) Marqueur local IMMÉDIAT — la bannière disparaît même si l'API
    //    Authentik patch est lente ou échoue.
    if (typeof window !== "undefined") {
      localStorage.setItem(LS_DISMISSED_KEY, "1");
    }
    setLocallyDismissed(true);
    // 2) Best-effort : tente d'aussi clear le flag côté Authentik. Si ça
    //    échoue (ex : token expiré), pas grave — au prochain login ça
    //    se réconciliera.
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
          <strong>{t("passwordBanner.detected")}</strong>{" "}
          {hasOpened ? t("passwordBanner.afterOpen") : t("passwordBanner.cta")}
        </div>
        <div className="flex items-center gap-2">
          {!hasOpened && (
            <button
              onClick={openChange}
              disabled={!status.change_url}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500 text-amber-950 text-xs font-medium hover:bg-amber-400 transition-default disabled:opacity-40"
            >
              <ExternalLink size={12} />
              {t("passwordBanner.changeNow")}
            </button>
          )}
          {hasOpened && (
            <button
              onClick={dismiss}
              disabled={dismissing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-accent text-accent-foreground text-xs font-medium hover:opacity-90 transition-default disabled:opacity-40"
            >
              <Check size={12} />
              {dismissing ? "..." : t("passwordBanner.iChanged")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
