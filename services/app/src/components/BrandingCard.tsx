"use client";

/**
 * Carte d'édition du branding (page /settings, admin only).
 *
 * Édite : nom de la box, URL du logo, couleur primaire, couleur accent,
 * footer, nom du client. Persisté côté serveur via POST /api/branding.
 */
import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Save, Check, AlertCircle, Palette } from "lucide-react";

interface Branding {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  footerText?: string;
  clientName?: string;
}

export function BrandingCard() {
  const { data: session } = useSession();
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;

  const [b, setB] = useState<Branding>({});
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    fetch("/api/branding")
      .then((r) => r.json())
      .then(setB)
      .finally(() => setHydrated(true));
  }, []);

  async function save() {
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/branding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(b),
      });
      const j = await r.json();
      if (!r.ok) {
        setError(j.message || j.error || `Erreur ${r.status}`);
        return;
      }
      setB(j);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } finally {
      setSubmitting(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="bg-card border border-border rounded-lg p-4 opacity-70">
        <div className="flex items-center gap-2 text-muted text-sm">
          <AlertCircle size={14} />
          La modification du branding est réservée aux administrateurs.
        </div>
      </div>
    );
  }

  if (!hydrated) return null;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Palette size={16} className="text-primary" />
        <h2 className="font-semibold">Branding</h2>
      </div>
      <p className="text-xs text-muted mb-4">
        Personnalisez l'apparence de l'AI Box pour votre client. Les
        modifications s'appliquent au prochain rafraîchissement de la page.
      </p>

      <div className="grid md:grid-cols-2 gap-4">
        <Field label="Nom de la box" value={b.name}
               onChange={(v) => setB({ ...b, name: v })}
               placeholder="AI Box" />
        <Field label="Nom du client" value={b.clientName}
               onChange={(v) => setB({ ...b, clientName: v })}
               placeholder="ACME SARL" />

        <Field label="URL du logo" value={b.logoUrl}
               onChange={(v) => setB({ ...b, logoUrl: v })}
               placeholder="https://… ou /static/logo.png"
               help="Laissez vide pour le logo hexagone par défaut." />

        <ColorField label="Couleur primaire" value={b.primaryColor}
                    onChange={(v) => setB({ ...b, primaryColor: v })} />
        <ColorField label="Couleur d'accent" value={b.accentColor}
                    onChange={(v) => setB({ ...b, accentColor: v })} />

        <Field label="Texte de pied de page" value={b.footerText}
               onChange={(v) => setB({ ...b, footerText: v })}
               placeholder="© 2026 ACME — Confidentiel" />
      </div>

      {error && (
        <div className="mt-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm px-3 py-2">
          {error}
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          onClick={save}
          disabled={submitting}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-default disabled:opacity-50"
        >
          {saved ? <Check size={14} /> : <Save size={14} />}
          {submitting ? "Enregistrement…" : saved ? "Enregistré" : "Enregistrer"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, placeholder, help,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  help?: string;
}) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1">{label}</label>
      <input
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:border-primary"
      />
      {help && <p className="text-[11px] text-muted mt-0.5">{help}</p>}
    </div>
  );
}

function ColorField({
  label, value, onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  const safeValue = value && /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#3b82f6";
  return (
    <div>
      <label className="text-xs font-medium block mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={safeValue}
          onChange={(e) => onChange(e.target.value)}
          className="w-10 h-10 rounded border border-border cursor-pointer"
        />
        <input
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder="#3b82f6"
          className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary"
        />
      </div>
    </div>
  );
}
