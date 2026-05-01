"use client";

/**
 * Sélecteur de langue pour /settings.
 *
 * Côté client uniquement (cookie + state). Le rechargement n'est pas
 * strictement nécessaire — le contexte React met à jour les composants
 * qui appellent useT(). Mais pour les chaînes statiquement rendues côté
 * serveur (ex: <title> du <head>), un reload peut être utile.
 */
import { Globe } from "lucide-react";
import { useT, LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";

export function LanguageCard() {
  const { locale, setLocale, t } = useT();

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-2">
        <Globe size={16} className="text-muted" />
        <h2 className="font-semibold">{t("settings.language.header")}</h2>
      </div>
      <div className="flex flex-wrap gap-2 mb-2">
        {LOCALES.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setLocale(l as Locale)}
            className={
              "px-3 py-1.5 text-sm rounded-md transition-default " +
              (locale === l
                ? "bg-primary text-primary-foreground"
                : "bg-muted/15 text-muted hover:bg-muted/25")
            }
            aria-pressed={locale === l}
          >
            {LOCALE_LABELS[l as Locale]}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{t("settings.language.help")}</p>
    </div>
  );
}
