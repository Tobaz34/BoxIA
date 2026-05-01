/**
 * Types i18n — défini le contrat d'une langue.
 *
 * La structure FR (cf. messages.ts) est la source de vérité :
 * - Toute clé présente en FR DOIT exister en EN (autrement TypeScript râle).
 * - Le typage est inféré depuis le dict FR via `Messages = typeof MESSAGES.fr`.
 *
 * Convention de nommage des clés :
 *   <scope>.<sub>.<action>
 *   ex : sidebar.nav.chat
 *        workflows.marketplace.installButton
 *        common.cancel
 *
 * Pour les chaînes paramétrées : on utilise `{var}` comme placeholder, et la
 * fonction `t()` accepte un 2e arg `{ var: "value" }`.
 */

export type Locale = "fr" | "en";

export const LOCALES: readonly Locale[] = ["fr", "en"] as const;

export const LOCALE_LABELS: Record<Locale, string> = {
  fr: "Français",
  en: "English",
};

export const DEFAULT_LOCALE: Locale = "fr";
