/**
 * Branding effectif côté SERVEUR : lit /data/branding.json (modifiable
 * via POST /api/branding) avec fallback sur les env vars.
 *
 * NE PAS IMPORTER depuis un Client Component — utilise `node:fs` qui
 * n'est pas bundlable côté navigateur.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { branding as DEFAULTS, type BrandingShape } from "./branding";

const STATE_DIR = process.env.CONNECTORS_STATE_DIR || "/data";
const BRANDING_FILE = path.join(STATE_DIR, "branding.json");

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
