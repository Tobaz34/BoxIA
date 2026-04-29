/**
 * Middleware NextAuth — toutes les routes nécessitent un login,
 * sauf /auth/* et /api/auth/* (les pages de login).
 */
export { default } from "next-auth/middleware";

export const config = {
  matcher: [
    "/((?!api/auth|auth/|_next/static|_next/image|favicon|robots).*)",
  ],
};
