/**
 * GET /api/oauth/callback?code=...&state=...
 *
 * Endpoint de redirection enregistré chez Google/Microsoft. Reçoit le code
 * d'autorisation, vérifie le state (anti-CSRF), exchange le code contre
 * access_token + refresh_token, persiste la connexion.
 *
 * Renvoie une page HTML qui :
 *   - sur succès : window.opener.postMessage({ ok: true, ... }) puis self.close()
 *   - sur erreur : affiche le message d'erreur, le user ferme la popup
 *
 * Pas d'auth NextAuth : la sécurité repose sur le cookie state (qui ne peut
 * être forgé) + le `state` matché. Si l'utilisateur n'est pas admin (peu
 * probable car il a démarré le flow), le store est mis à jour mais ça
 * n'expose rien tant que /api/oauth/connections est admin-only.
 */
import { NextResponse } from "next/server";
import { handleOIDCCallback, OAUTH_STATE_COOKIE } from "@/lib/oauth-oidc";
import { logAction, ipFromHeaders } from "@/lib/audit-helper";

export const dynamic = "force-dynamic";

function htmlPage(content: string, status: number = 200): NextResponse {
  return new NextResponse(content, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successPage(connection: { id: string; account_email?: string; account_name?: string; provider_id: string; connector_slug: string }): string {
  const data = JSON.stringify(connection);
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Connecté</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;max-width:400px;padding:24px}h1{color:#10b981;margin:0 0 8px;font-size:18px}p{color:#a0a0a0;font-size:13px;margin:4px 0}</style>
</head><body><div>
<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>
<h1>Connecté</h1>
<p>Compte ${connection.account_email || "lié"} associé au connecteur <code>${connection.connector_slug}</code>.</p>
<p>Cette fenêtre va se fermer automatiquement.</p>
</div>
<script>
try {
  if (window.opener) {
    window.opener.postMessage({ type: "aibox-oauth-result", ok: true, connection: ${data} }, window.location.origin);
  }
} catch (e) {}
setTimeout(() => { try { window.close(); } catch (e) {} }, 1500);
</script>
</body></html>`;
}

function errorPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>Erreur OAuth</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1115;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{text-align:center;max-width:500px;padding:24px}h1{color:#ef4444;margin:0 0 8px;font-size:18px}p{color:#a0a0a0;font-size:13px;margin:4px 0}code{display:block;background:#1f2228;padding:8px;border-radius:4px;margin-top:12px;font-size:11px;text-align:left}</style>
</head><body><div>
<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/></svg>
<h1>Échec de la connexion OAuth</h1>
<p>Détails côté provider :</p>
<code>${error.replace(/</g, "&lt;")}</code>
<p style="margin-top:16px">Tu peux fermer cette fenêtre et réessayer.</p>
</div>
<script>
try {
  if (window.opener) {
    window.opener.postMessage({ type: "aibox-oauth-result", ok: false, error: ${JSON.stringify(error)} }, window.location.origin);
  }
} catch (e) {}
</script>
</body></html>`;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlPage(errorPage(`${error}: ${errorDescription || ""}`), 400);
  }
  if (!code || !state) {
    return htmlPage(errorPage("missing code or state in callback"), 400);
  }

  // Lire le cookie state
  const cookieHeader = req.headers.get("cookie") || "";
  const cookieMatch = cookieHeader
    .split(/;\s*/)
    .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
  if (!cookieMatch) {
    return htmlPage(errorPage("missing state cookie (cookie expired or browser blocked it)"), 400);
  }
  const cookieValue = decodeURIComponent(cookieMatch.split("=")[1] || "");

  const result = await handleOIDCCallback(cookieValue, state, code);
  if (!result.ok) {
    return htmlPage(errorPage(result.error), 400);
  }

  await logAction(
    "settings.update",
    `oauth_oidc_connected:${result.connection.provider_id}:${result.connection.connector_slug}`,
    {
      ip: ipFromHeaders(req),
      account_email: result.connection.account_email,
    },
  );

  // Clear le cookie state (one-shot)
  const resp = htmlPage(
    successPage({
      id: result.connection.id,
      account_email: result.connection.account_email,
      account_name: result.connection.account_name,
      provider_id: result.connection.provider_id,
      connector_slug: result.connection.connector_slug,
    }),
  );
  resp.cookies.set(OAUTH_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: req.url.startsWith("https://"),
    maxAge: 0,
    path: "/api/oauth",
  });
  return resp;
}
