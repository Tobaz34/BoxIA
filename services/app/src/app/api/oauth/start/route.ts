/**
 * GET /api/oauth/start?provider=google&connector_slug=google-drive
 *
 * Démarre un flow OIDC Authorization Code + PKCE :
 *   - Génère code_verifier + state
 *   - Pose un cookie httpOnly avec le pending chiffré
 *   - Redirige vers le authorize_endpoint du provider
 *
 * L'admin atterrit sur Google/Microsoft, autorise, est redirigé vers
 * /api/oauth/callback. Cf lib/oauth-oidc.ts.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";
import { startOIDC, OAUTH_STATE_COOKIE } from "@/lib/oauth-oidc";
import type { OAuthProviderId } from "@/lib/oauth-providers";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  const isAdmin = (session?.user as { isAdmin?: boolean })?.isAdmin || false;
  if (!isAdmin || !session?.user?.email) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const connectorSlug = url.searchParams.get("connector_slug");
  if (!provider || !connectorSlug) {
    return NextResponse.json({ error: "missing_params" }, { status: 400 });
  }
  if (provider !== "google" && provider !== "microsoft") {
    return NextResponse.json({ error: "unsupported_provider" }, { status: 400 });
  }
  try {
    const result = startOIDC(
      provider as OAuthProviderId,
      connectorSlug,
      session.user.email,
    );
    await logAction("settings.update", `oauth_oidc_started:${provider}:${connectorSlug}`, {
      actor: session.user.email,
      ip: ipFromHeaders(req),
      redirect_uri: result.redirect_uri,
    });
    const resp = NextResponse.redirect(result.authorize_url, { status: 302 });
    // Cookie httpOnly + Secure si HTTPS, sameSite=Lax pour suivre le retour
    // de Google. 10 min de durée (cap aligné avec l'expiration du state).
    const isHttps = result.redirect_uri.startsWith("https://");
    resp.cookies.set(OAUTH_STATE_COOKIE, result.state_cookie_value, {
      httpOnly: true,
      sameSite: "lax",
      secure: isHttps,
      maxAge: 10 * 60,
      path: "/api/oauth",
    });
    return resp;
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
