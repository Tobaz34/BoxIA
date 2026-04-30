/**
 * Branding configuration — lue d'abord depuis `/data/branding.json`
 * (modifiable via /settings côté admin), avec fallback sur les env vars
 * du container (premier démarrage).
 *
 * IMPORTANT : cette fonction est synchrone-friendly côté serveur via
 * `getBranding()` qui fait un readFileSync. Pour les Server Components
 * c'est OK ; pour les Client Components, fetch /api/branding à la place.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const BRANDING_FILE = path.join(STATE_DIR, "branding.json");

export interface BrandingShape {
  name: string;
  logoUrl: string;
  primaryColor: string;
  accentColor: string;
  footer: string;
  clientName: string;
}

const DEFAULTS: BrandingShape = {
  name:         process.env.BRAND_NAME         || "AI Box",
  logoUrl:      process.env.BRAND_LOGO_URL     || "",
  primaryColor: process.env.BRAND_PRIMARY_COLOR || "#3b82f6",
  accentColor:  process.env.BRAND_ACCENT_COLOR || "#10b981",
  footer:       process.env.BRAND_FOOTER_TEXT  || "",
  clientName:   process.env.CLIENT_NAME         || "",
};

/** Lit le branding effectif (fichier persistant > env vars > defaults). */
export function getBranding(): BrandingShape {
  try {
    const txt = readFileSync(BRANDING_FILE, "utf8");
    const parsed = JSON.parse(txt) as Partial<{
      name: string; logoUrl: string; primaryColor: string;
      accentColor: string; footerText: string; clientName: string;
    }>;
    return {
      ...DEFAULTS,
      ...(parsed.name         ? { name: parsed.name } : {}),
      ...(parsed.logoUrl      ? { logoUrl: parsed.logoUrl } : {}),
      ...(parsed.primaryColor ? { primaryColor: parsed.primaryColor } : {}),
      ...(parsed.accentColor  ? { accentColor: parsed.accentColor } : {}),
      ...(parsed.footerText   ? { footer: parsed.footerText } : {}),
      ...(parsed.clientName   ? { clientName: parsed.clientName } : {}),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Compatibilité avec l'ancien import : équivalent au runtime au getBranding(). */
export const branding: BrandingShape = getBranding();
