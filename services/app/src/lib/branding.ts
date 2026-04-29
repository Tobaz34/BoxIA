/**
 * Branding configuration — lue depuis les env vars du container.
 * Permet à chaque déploiement client d'avoir son propre logo, nom, couleurs.
 */
export const branding = {
  name:         process.env.BRAND_NAME         || "AI Box",
  logoUrl:      process.env.BRAND_LOGO_URL     || "",
  primaryColor: process.env.BRAND_PRIMARY_COLOR || "#3b82f6",
  accentColor:  process.env.BRAND_ACCENT_COLOR || "#10b981",
  footer:       process.env.BRAND_FOOTER_TEXT  || "",
  clientName:   process.env.CLIENT_NAME         || "",
};
