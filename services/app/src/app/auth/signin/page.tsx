"use client";

import { signIn } from "next-auth/react";
import { branding } from "@/lib/branding";

export default function SignInPage() {
  return (
    <div className="bg-card border border-border rounded-lg p-8 max-w-md w-full">
      <div className="text-center mb-6">
        <div className="w-12 h-12 mx-auto rounded bg-primary/20 text-primary flex items-center justify-center text-2xl font-bold">⬡</div>
        <h1 className="text-2xl font-semibold mt-3">{branding.name}</h1>
        {branding.clientName && (
          <p className="text-sm text-muted mt-1">{branding.clientName}</p>
        )}
      </div>

      <button
        onClick={() => signIn("authentik", { callbackUrl: "/" })}
        className="w-full bg-primary text-primary-foreground rounded-md py-3 font-medium hover:opacity-90 transition-default"
      >
        Se connecter
      </button>

      <p className="text-xs text-muted text-center mt-4">
        Authentification sécurisée. Vos données restent chez vous.
      </p>
    </div>
  );
}
