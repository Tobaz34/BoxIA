"use client";

/**
 * Bouton "Se connecter" — délègue à `signIn()` de next-auth/react.
 *
 * Sous-composant client séparé pour que la page parente (page.tsx) puisse
 * rester un server component et lire le branding via `process.env.*` sans
 * créer de mismatch SSR/CSR (cf commentaire dans page.tsx pour le bug
 * React #418 corrigé 2026-05-07).
 */
import { signIn } from "next-auth/react";

export function SignInButton() {
  return (
    <button
      onClick={() => signIn("authentik", { callbackUrl: "/" })}
      className="w-full bg-primary text-primary-foreground rounded-md py-3 font-medium hover:opacity-90 transition-default"
    >
      Se connecter
    </button>
  );
}
