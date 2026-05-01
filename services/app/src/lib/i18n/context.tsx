"use client";

/**
 * I18nProvider — installe la langue + l'expose via React context.
 *
 * Pattern : on lit la langue UNE FOIS au mount (cookie > navigator > FR),
 * puis on l'expose via context. Le `setLocale` met à jour le cookie + state.
 *
 * Usage :
 *   const { t, locale, setLocale } = useT();
 *   t("sidebar.nav.chat")                              // "Discuter"
 *   t("workflows.subtitle", { count: 5, plural: "s", active: 3, activePlural: "s" })
 *
 * On stocke dans `document.cookie` (pas `localStorage`) pour que le serveur
 * puisse aussi lire la langue (via cookies()) et faire du SSR localisé plus
 * tard si besoin. Pour l'instant tout est client-side.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from "react";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "./types";
import { MESSAGES, type Messages } from "./messages";

const COOKIE_NAME = "aibox_locale";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 an

interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readCookieLocale(): Locale | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`),
  );
  if (!m) return null;
  const v = decodeURIComponent(m[1]);
  return (LOCALES as readonly string[]).includes(v) ? (v as Locale) : null;
}

function detectInitialLocale(): Locale {
  const fromCookie = readCookieLocale();
  if (fromCookie) return fromCookie;
  if (typeof navigator !== "undefined") {
    const nav = (navigator.language || "").toLowerCase().slice(0, 2);
    if ((LOCALES as readonly string[]).includes(nav)) return nav as Locale;
  }
  return DEFAULT_LOCALE;
}

/** Résout une clé dotted ("a.b.c") dans un objet imbriqué. Renvoie undefined si pas trouvé. */
function resolveKey(obj: Messages, key: string): string | undefined {
  const parts = key.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Substitue {var} par params.var dans une chaîne template. */
function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : `{${k}}`,
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // SSR : on ne connaît pas la langue côté serveur — on rend en DEFAULT_LOCALE
  // puis on hydrate côté client après le mount. Évite l'hydration mismatch.
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(detectInitialLocale());
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    if (typeof document !== "undefined") {
      document.cookie = `${COOKIE_NAME}=${encodeURIComponent(l)}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`;
    }
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const dict = MESSAGES[locale] || MESSAGES[DEFAULT_LOCALE];
      // Fallback : si la clé n'existe pas dans la langue active, on tombe
      // sur FR (source de vérité). Si toujours pas trouvée → renvoie la clé
      // brute pour faciliter le debug visuel ("workflows.foo.bar").
      const value =
        resolveKey(dict, key) ||
        resolveKey(MESSAGES[DEFAULT_LOCALE], key) ||
        key;
      return format(value, params);
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/**
 * Hook principal.
 *
 * Renvoie `{ t, locale, setLocale }`. Si appelé hors du Provider, fallback
 * sur une impl statique qui retourne juste les chaînes FR (utile pour les
 * tests ou les composants qui peuvent être rendus sans provider).
 */
export function useT(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (ctx) return ctx;
  // Fallback statique : pas de provider monté.
  return {
    locale: DEFAULT_LOCALE,
    setLocale: () => {},
    t: (key, params) => {
      const value = resolveKey(MESSAGES[DEFAULT_LOCALE], key) || key;
      return format(value, params);
    },
  };
}
