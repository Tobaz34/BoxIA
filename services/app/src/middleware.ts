/**
 * Middleware NextAuth — toutes les routes nécessitent un login, sauf :
 *   - /auth/*, /api/auth/* (pages de login NextAuth elles-mêmes)
 *   - /api/agents-tools/* (Bearer auth via AGENTS_API_KEY, pas NextAuth)
 *   - /api/system/health (public pour les healthchecks externes)
 *   - /api/version (info publique pour la carte version)
 *   - assets statiques (_next, favicon, robots)
 */
export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    "/((?!api/auth|auth/|api/agents-tools|api/system/health|api/version|_next/static|_next/image|favicon|robots).*)",
  ],
};
