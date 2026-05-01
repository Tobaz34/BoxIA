/**
 * Barrel export pour la lib i18n.
 *
 * Usage côté composant client :
 *   import { useT } from "@/lib/i18n";
 *   const { t, locale, setLocale } = useT();
 *
 * Usage installation (root layout / providers) :
 *   import { I18nProvider } from "@/lib/i18n";
 */
export { I18nProvider, useT } from "./context";
export {
  LOCALES,
  LOCALE_LABELS,
  DEFAULT_LOCALE,
  type Locale,
} from "./types";
