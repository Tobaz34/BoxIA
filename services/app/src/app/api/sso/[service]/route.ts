/**
 * GET /api/sso/<service> — admin only.
 *
 * Renvoie une page HTML qui auto-soumet un formulaire de login vers la
 * console du service cible (Dify, n8n, Portainer…), avec les credentials
 * admin pré-remplis (lus côté serveur depuis l'env).
 *
 * Le mot de passe ne quitte JAMAIS le browser de l'admin (il est inclus
 * dans la response HTML mais immédiatement consommé puis la page redirige).
 *
 * Sécurité :
 *   - Auth NextAuth + check `isAdmin` strict.
 *   - Cache-Control: no-store + Pragma: no-cache (la page ne doit JAMAIS
 *     être servie depuis un cache intermédiaire).
 *   - Cookies de session du service cible posés directement par le browser
 *     (réception du Set-Cookie depuis le service, pas via aibox-app).
 *
 * Services supportés :
 *   - dify       : POST /console/api/login {email, password, language, remember_me}
 *   - n8n        : POST /rest/login {email, emailOrLdapLoginId, password}
 *   - portainer  : POST /api/auth {Username, Password}  (Bearer JWT en réponse)
 *   - grafana    : POST /login {user, password}  (cookie classique)
 *
 * Routes inconnues : 404.
 */
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ServiceConfig {
  loginUrl: string;
  payloadType: "json" | "form";
  /** Champs hidden du form. La fonction reçoit (email, pwd) et renvoie l'objet. */
  buildPayload: (email: string, pwd: string) => Record<string, string>;
  /** URL vers laquelle rediriger après login réussi. */
  redirectAfterLogin: string;
  /** Override password si différent de ADMIN_PASSWORD (ex: N8N_PASSWORD). */
  passwordEnvVar?: string;
}

const PUBLIC_BASES: Record<string, string> = {
  // URL publique vers laquelle le browser doit POSTer (le browser est
  // sur le réseau du client, pas sur aibox_net Docker).
  // On dérive depuis Host header au runtime, valeurs par défaut ici.
  dify: process.env.DIFY_PUBLIC_URL || "",
  n8n: process.env.N8N_PUBLIC_URL || "",
  portainer: process.env.PORTAINER_PUBLIC_URL || "",
  grafana: process.env.GRAFANA_PUBLIC_URL || "",
};

const SERVICES: Record<string, ServiceConfig> = {
  dify: {
    loginUrl: "/console/api/login",
    payloadType: "json",
    buildPayload: (email, pwd) => ({
      email,
      password: pwd,
      language: "fr-FR",
      remember_me: "true",
    }),
    redirectAfterLogin: "/apps",
  },
  n8n: {
    loginUrl: "/rest/login",
    payloadType: "json",
    buildPayload: (email, pwd) => ({
      email,
      emailOrLdapLoginId: email,
      password: pwd,
    }),
    redirectAfterLogin: "/workflows",
    passwordEnvVar: "N8N_PASSWORD",
  },
  portainer: {
    loginUrl: "/api/auth",
    payloadType: "json",
    buildPayload: (email, pwd) => ({ Username: email, Password: pwd }),
    redirectAfterLogin: "/",
  },
  grafana: {
    loginUrl: "/login",
    payloadType: "form",
    buildPayload: (email, pwd) => ({ user: email, password: pwd }),
    redirectAfterLogin: "/",
  },
};

function deriveServiceUrl(service: string, host: string | null): string {
  // Override ENV en priorité
  const envOverride = PUBLIC_BASES[service];
  if (envOverride) return envOverride;

  // Si pas de Host header (impossible normalement), fallback localhost
  if (!host) {
    const ports: Record<string, number> = {
      dify: 8081, n8n: 5678, portainer: 9443, grafana: 3001,
    };
    return `http://localhost:${ports[service]}`;
  }

  // Stratégie : on dérive depuis le Host header de aibox-app
  const hostname = host.split(":")[0];
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isLocal = hostname === "localhost";
  const isMdns = hostname.endsWith(".local");

  if (isIp || isLocal) {
    // Mode IP brute / localhost : ports différents sur même IP
    const ports: Record<string, number> = {
      dify: 8081, n8n: 5678, portainer: 9443, grafana: 3001,
    };
    return `http://${hostname}:${ports[service]}`;
  }
  if (isMdns) {
    // Mode flat-mDNS : aibox.local → aibox-<svc>.local
    const prefix = hostname.split(".")[0].split("-")[0];
    const subs: Record<string, string> = {
      dify: "agents", n8n: "flows", portainer: "admin", grafana: "metrics",
    };
    return `https://${prefix}-${subs[service]}.local`;
  }
  // Mode prod multi-label : foo.client.fr → <svc>.client.fr
  const parts = hostname.split(".");
  if (parts.length >= 2) {
    const subs: Record<string, string> = {
      dify: "agents", n8n: "flows", portainer: "admin", grafana: "metrics",
    };
    parts[0] = subs[service];
    return `https://${parts.join(".")}`;
  }
  return `http://${hostname}:8081`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function escapeJsonForScript(s: string): string {
  // Échappe pour que le JSON puisse être inline dans <script> sans casser la balise
  return s.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ service: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return NextResponse.redirect(
      new URL("/api/auth/signin", req.url),
      { status: 307 },
    );
  }
  if (!(session.user as { isAdmin?: boolean }).isAdmin) {
    return NextResponse.json({ error: "forbidden_admin_only" }, { status: 403 });
  }

  const { service } = await params;
  const cfg = SERVICES[service];
  if (!cfg) {
    return NextResponse.json({ error: "unknown_service" }, { status: 404 });
  }

  const adminEmail = process.env.ADMIN_EMAIL || "";
  const adminPwd =
    (cfg.passwordEnvVar && process.env[cfg.passwordEnvVar]) ||
    process.env.ADMIN_PASSWORD ||
    "";

  if (!adminEmail || !adminPwd) {
    return NextResponse.json(
      { error: "missing_admin_credentials", service },
      { status: 500 },
    );
  }

  const host = req.headers.get("host");
  const serviceBase = deriveServiceUrl(service, host);
  const loginUrl = `${serviceBase}${cfg.loginUrl}`;

  // Support du deep-link via ?to=<path-relative>
  // Ex : /api/sso/n8n?to=/workflow/abc → redirect vers <n8n>/workflow/abc
  const url = new URL(req.url);
  const toParam = url.searchParams.get("to");
  let redirectPath = cfg.redirectAfterLogin;
  if (toParam && toParam.startsWith("/") && !toParam.startsWith("//")) {
    redirectPath = toParam;
  }
  const redirectUrl = `${serviceBase}${redirectPath}`;
  const payload = cfg.buildPayload(adminEmail, adminPwd);

  // Stratégie POST cross-origin :
  //
  // Dify >= 1.10 accepte UNIQUEMENT application/json sur /console/api/login
  // (form-urlencoded → 400 "Missing required parameter in the JSON body").
  // → on doit utiliser fetch() avec Content-Type: application/json.
  //
  // JSON déclenche un preflight CORS. Pour qu'il passe :
  // - Dify a CONSOLE_CORS_ALLOW_ORIGINS=* dans son compose (cf. services/dify/docker-compose.yml).
  // - n8n par défaut accepte * (configurable via N8N_PUSH_BACKEND si besoin).
  // - Grafana et Portainer acceptent form-urlencoded (cas plus simple).
  //
  // Le code essaie fetch JSON d'abord, fallback form-urlencoded si payloadType=form.
  const formFields = Object.entries(payload)
    .map(([k, v]) =>
      `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`,
    )
    .join("\n        ");

  const useJson = cfg.payloadType === "json";

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>Connexion à ${escapeHtml(service)}…</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #e2e8f0; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .box { text-align: center; max-width: 480px; padding: 0 24px; }
  .spinner { border: 3px solid rgba(255,255,255,0.1); border-top-color: #3b82f6; border-radius: 50%; width: 32px; height: 32px; animation: spin 0.8s linear infinite; margin: 0 auto 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { color: #f87171; padding: 12px; background: rgba(248,113,113,0.1); border-radius: 6px; }
  iframe { display: none; }
  a { color: #60a5fa; }
  .hint { font-size: 12px; color: #94a3b8; margin-top: 8px; }
</style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <div id="msg">Connexion à ${escapeHtml(service)}…</div>
    <div class="hint">Auto-login admin via aibox-app.</div>
  </div>

  <!-- Fallback form (utilisé pour Grafana/Portainer en form-urlencoded). -->
  <iframe name="ssoFrame" id="ssoFrame"></iframe>
  <form id="ssoForm" action="${escapeHtml(loginUrl)}" method="POST"
        target="ssoFrame" enctype="application/x-www-form-urlencoded">
        ${formFields}
  </form>

<script>
(function() {
  const useJson = ${JSON.stringify(useJson)};
  const loginUrl = ${JSON.stringify(loginUrl)};
  const payload = ${JSON.stringify(payload)};
  const redirectUrl = ${JSON.stringify(redirectUrl)};
  let done = false;

  function finish() {
    if (done) return;
    done = true;
    setTimeout(function() {
      window.location.replace(redirectUrl);
    }, 200);
  }

  // Fallback timer : si rien n'aboutit en 5s, on redirect quand même
  // (au pire l'admin verra le login normal du service).
  setTimeout(function() {
    if (done) return;
    document.querySelector(".spinner").style.display = "none";
    document.getElementById("msg").innerHTML =
      'La connexion automatique met du temps. <br><br>' +
      '<a href="' + redirectUrl + '">Ouvrir ${escapeHtml(service)} maintenant</a>';
  }, 5000);

  if (useJson) {
    // fetch JSON cross-origin avec credentials:include pour que les
    // Set-Cookie de la response soient écrits sur l'origin du service.
    fetch(loginUrl, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function(r) {
      // 200 = login OK. Cookies posés. On redirect.
      // Autre code = login KO → redirect quand même, l'utilisateur verra
      // le formulaire de login du service.
      finish();
    }).catch(function(e) {
      // CORS bloqué ou réseau down → retombe sur le form classique.
      console.warn("SSO fetch failed:", e);
      document.getElementById("ssoForm").submit();
    });
  } else {
    // Form path : iframe load = login soumis (succès ou échec).
    document.getElementById("ssoFrame").addEventListener("load", finish);
    document.getElementById("ssoForm").submit();
  }
})();
</script>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "no-referrer",
    },
  });
}
