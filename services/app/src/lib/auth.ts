/**
 * NextAuth configuration — Authentik OIDC provider.
 *
 * Les variables d'env attendues :
 *   NEXTAUTH_URL                 https://app.<DOMAIN>  (ou http://...)
 *   NEXTAUTH_SECRET              32+ caractères, random
 *   AUTHENTIK_ISSUER             http://aibox-authentik-server:9000/application/o/aibox-app/
 *   AUTHENTIK_CLIENT_ID          aibox-app
 *   AUTHENTIK_CLIENT_SECRET      <généré par Authentik provider>
 */
import type { NextAuthOptions } from "next-auth";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    {
      id: "authentik",
      name: "Authentik",
      type: "oauth",
      wellKnown: process.env.AUTHENTIK_ISSUER
        ? `${process.env.AUTHENTIK_ISSUER}.well-known/openid-configuration`
        : undefined,
      clientId: process.env.AUTHENTIK_CLIENT_ID,
      clientSecret: process.env.AUTHENTIK_CLIENT_SECRET,
      authorization: { params: { scope: "openid email profile groups" } },
      idToken: true,
      checks: ["pkce", "state"],
      profile(profile: any) {
        return {
          id: profile.sub,
          name: profile.name || profile.preferred_username,
          email: profile.email,
          image: profile.picture,
          // Custom : groupes Authentik (pour distinguer admin vs user)
          groups: profile.groups || [],
        };
      },
    } as any,
  ],
  session: { strategy: "jwt", maxAge: 24 * 60 * 60 },
  callbacks: {
    async jwt({ token, profile, account }) {
      if (account && profile) {
        token.groups = (profile as any).groups || [];
      }
      return token;
    },
    async session({ session, token }) {
      (session.user as any).groups = token.groups || [];
      (session.user as any).isAdmin = ((token.groups as string[]) || [])
        .some((g) => /admin/i.test(g));
      return session;
    },
  },
  pages: {
    signIn: "/auth/signin",
    error: "/auth/error",
  },
};
