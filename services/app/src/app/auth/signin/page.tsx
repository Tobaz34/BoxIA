/**
 * Page de signin OIDC.
 *
 * Server component qui lit le branding depuis les env vars (server-only,
 * pas inlined au build) et passe les valeurs au sous-composant client
 * `<SignInButton />`. C'est ce sous-composant qui appelle `signIn()` depuis
 * next-auth/react.
 *
 * IMPORTANT : avant 2026-05-07 cette page était `"use client"` et lisait
 * `branding.name` / `branding.clientName` depuis lib/branding.ts. Côté SSR
 * `process.env.BRAND_NAME` valait "AI Box" et `process.env.CLIENT_NAME`
 * valait "CLIKINFO" (ou autre selon .env). Côté client (post-hydration)
 * ces vars étaient `undefined` (pas préfixées `NEXT_PUBLIC_`) → tomber
 * sur les fallbacks (`"AI Box"` et `""`). Mismatch SSR/CSR → React
 * error #418 → la page ne s'hydrate plus → le bouton "Se connecter" perd
 * son onClick → login complètement bloqué côté UI (le user devait taper
 * une commande curl pour login). Fix : rendre le branding server-side.
 */
import { branding } from "@/lib/branding";
import { SignInButton } from "./SignInButton";

export default function SignInPage() {
  return (
    <div className="bg-card border border-border rounded-lg p-8 max-w-md w-full">
      <div className="text-center mb-6">
        <div className="w-12 h-12 mx-auto rounded bg-primary/20 text-primary flex items-center justify-center text-2xl font-bold">
          ⬡
        </div>
        <h1 className="text-2xl font-semibold mt-3">{branding.name}</h1>
        {branding.clientName && (
          <p className="text-sm text-muted mt-1">{branding.clientName}</p>
        )}
      </div>

      <SignInButton />

      <p className="text-xs text-muted text-center mt-4">
        Authentification sécurisée. Vos données restent chez vous.
      </p>
    </div>
  );
}
