/**
 * Branding par défaut (env vars uniquement) — SAFE côté client.
 *
 * Pour le branding "live" (modifié via /settings et persisté dans
 * /data/branding.json), utilise `getBranding()` depuis
 * `@/lib/branding-server` — server-only, lit le fichier à chaque
 * appel.
 */

export interface BrandingShape {
  name: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  footer: string;
  clientName: string;
}

/** Branding fallback — lu UNIQUEMENT depuis les env vars du build. */
export const branding: BrandingShape = {
  name:         process.env.BRAND_NAME         || "AI Box",
  logoUrl:      process.env.BRAND_LOGO_URL     || "",
  primaryColor: process.env.BRAND_PRIMARY_COLOR || "#3b82f6",
  accentColor:  process.env.BRAND_ACCENT_COLOR || "#10b981",
  footer:       process.env.BRAND_FOOTER_TEXT  || "",
  clientName:   process.env.CLIENT_NAME         || "",
};
