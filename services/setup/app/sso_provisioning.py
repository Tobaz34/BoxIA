"""
Module de provisioning post-déploiement.

Branche les apps sur Authentik via OIDC quand c'est possible, sinon crée un
compte admin local avec les mêmes credentials.

Idempotent : peut être relancé sans casser l'existant.

Apps gérées :
  - Open WebUI    : OIDC (Provider + Application Authentik + variables OWUI)
  - Dify          : compte admin local via API (Community ne supporte pas OIDC)
  - n8n           : compte owner local via API (Community ne supporte pas OIDC)
  - Portainer     : créé au 1er accès, on injecte juste le user/mdp via env si possible
"""
from __future__ import annotations

import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("sso-provisioning")

AUTHENTIK_INTERNAL = "http://aibox-authentik-server:9000"


# ---------------------------------------------------------------------------
# Helpers Authentik
# ---------------------------------------------------------------------------
def _ak_admin_token(env: dict[str, str]) -> str | None:
    """Crée un token API admin pour akadmin via Django shell.

    Retourne None si Authentik n'est pas prêt ou si la création échoue.
    """
    script = (
        "from authentik.core.models import User, Token, TokenIntents\n"
        "u = User.objects.filter(username='akadmin').first()\n"
        "if not u: print('NO_AKADMIN'); raise SystemExit(1)\n"
        "t, _ = Token.objects.update_or_create(\n"
        "    identifier='aibox-provisioning',\n"
        "    defaults={'user': u, 'intent': TokenIntents.INTENT_API, 'expiring': False})\n"
        "print('TOKEN=' + t.key)\n"
    )
    try:
        out = subprocess.run(
            ["docker", "exec", "aibox-authentik-server", "ak", "shell", "-c", script],
            capture_output=True, text=True, timeout=30,
        )
        for line in out.stdout.splitlines():
            if line.startswith("TOKEN="):
                return line.split("=", 1)[1].strip()
    except Exception as e:
        log.warning("akadmin token creation failed: %s", e)
    return None


def _ak_get_uuids(token: str) -> dict[str, str]:
    """Récupère les UUIDs de Authentik nécessaires pour créer un Provider OIDC.

    Les flows par défaut sont créés par les blueprints Authentik au boot.
    Sur un fresh install, ils peuvent ne pas être encore présents au moment
    où provision-sso s'exécute → on retry pendant max 60s avant de raiser.
    """
    import time as _t
    H = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    base = f"{AUTHENTIK_INTERNAL}/api/v3"
    out = {}
    required_flows = [
        ("default-provider-authorization-implicit-consent", "authz_flow"),
        ("default-authentication-flow",                     "auth_flow"),
        ("default-provider-invalidation-flow",              "invalidation_flow"),
    ]
    with httpx.Client(headers=H, timeout=30) as c:
        # Wait for all flows to exist (max 60s)
        for attempt in range(30):
            out = {}
            for slug, key in required_flows:
                try:
                    r = c.get(f"{base}/flows/instances/", params={"slug": slug})
                    r.raise_for_status()
                    res = r.json().get("results", [])
                    if res:
                        out[key] = res[0]["pk"]
                except Exception:
                    pass
            if all(k in out for _, k in required_flows):
                break
            _t.sleep(2)
        else:
            missing = [k for _, k in required_flows if k not in out]
            raise RuntimeError(
                f"Flows Authentik introuvables après 60s: {missing}"
            )

        # Première clé crypto signing disponible
        r = c.get(f"{base}/crypto/certificatekeypairs/")
        r.raise_for_status()
        res = r.json().get("results", [])
        if res:
            # Préfère "authentik Self-signed Certificate"
            ak_signed = [k for k in res if "authentik" in k["name"].lower()]
            out["signing_key"] = (ak_signed or res)[0]["pk"]

        # Scope mappings (openid, email, profile)
        r = c.get(f"{base}/propertymappings/provider/scope/")
        r.raise_for_status()
        scopes = []
        for m in r.json().get("results", []):
            if m.get("scope_name") in ("openid", "email", "profile"):
                scopes.append(m["pk"])
        out["scopes"] = scopes
    return out


def _ak_upsert_oidc_app(
    token: str,
    *,
    app_name: str,
    app_slug: str,
    client_id: str,
    redirect_uris: list[str],
    icon: str = "",
    description: str = "",
) -> dict[str, str]:
    """Crée (ou MAJ) un Provider OIDC + Application dans Authentik. Idempotent.

    Retourne {client_id, client_secret} pour configurer l'app cliente.
    """
    H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    base = f"{AUTHENTIK_INTERNAL}/api/v3"
    uuids = _ak_get_uuids(token)

    redirect_payload = [{"matching_mode": "strict", "url": u} for u in redirect_uris]

    with httpx.Client(headers=H, timeout=30) as c:
        # Provider — recherche par client_id (unique par convention)
        r = c.get(f"{base}/providers/oauth2/", params={"client_id": client_id})
        r.raise_for_status()
        existing = r.json().get("results", [])

        provider_payload = {
            "name": app_name,
            "authorization_flow": uuids["authz_flow"],
            "invalidation_flow": uuids["invalidation_flow"],
            "client_type": "confidential",
            "client_id": client_id,
            "access_code_validity": "minutes=1",
            "access_token_validity": "hours=24",
            "refresh_token_validity": "days=30",
            "include_claims_in_id_token": True,
            "signing_key": uuids["signing_key"],
            "property_mappings": uuids["scopes"],
            "redirect_uris": redirect_payload,
            "sub_mode": "hashed_user_id",
            "issuer_mode": "per_provider",
        }

        if existing:
            pk = existing[0]["pk"]
            r = c.patch(f"{base}/providers/oauth2/{pk}/", json=provider_payload)
            r.raise_for_status()
            provider = r.json()
        else:
            r = c.post(f"{base}/providers/oauth2/", json=provider_payload)
            r.raise_for_status()
            provider = r.json()

        # Application liée — filtre strict par slug
        r = c.get(f"{base}/core/applications/", params={"slug": app_slug})
        r.raise_for_status()
        all_apps = r.json().get("results", [])
        # Filtrage côté code car l'API peut retourner des matchs partiels
        existing_apps = [a for a in all_apps if a.get("slug") == app_slug]

        app_payload = {
            "name": app_name,
            "slug": app_slug,
            "provider": provider["pk"],
            "meta_launch_url": redirect_uris[0].rsplit("/oauth/", 1)[0] if redirect_uris else "",
            "meta_description": description,
            "meta_icon": icon,
            "open_in_new_tab": False,
        }
        if existing_apps:
            # On utilise le slug existant pour l'URL PATCH
            existing_slug = existing_apps[0]["slug"]
            r = c.patch(f"{base}/core/applications/{existing_slug}/", json=app_payload)
        else:
            r = c.post(f"{base}/core/applications/", json=app_payload)
        if r.status_code >= 400:
            log.warning("upsert app %s failed: %s %s", app_slug, r.status_code, r.text[:200])
            # Ne pas raise — on a déjà le provider créé, c'est suffisant
            return {
                "client_id": provider["client_id"],
                "client_secret": provider["client_secret"],
                "warning": f"app {app_slug} not linked: HTTP {r.status_code}",
            }

        return {
            "client_id": provider["client_id"],
            "client_secret": provider["client_secret"],
        }


# ---------------------------------------------------------------------------
# AI Box App (front unifié custom) : OIDC via Authentik
# ---------------------------------------------------------------------------
def _gen_secret(n: int) -> str:
    import secrets as _s, string
    return "".join(_s.choice(string.ascii_letters + string.digits) for _ in range(n))


def _dns_resolves(hostname: str) -> bool:
    """Teste si le hostname résout en IP routable (best-effort, sync)."""
    import socket
    try:
        socket.setdefaulttimeout(2)
        socket.gethostbyname(hostname)
        return True
    except Exception:
        return False


def _service_url(service: str, domain: str) -> tuple[str, str]:
    """Construit l'URL HTTPS d'un service derrière le edge Caddy.

    Retourne (browser_url, hostname).

    - DOMAIN se termine en `.local` → convention PLATE `<prefix>-<service>.local`
      (compatible Bonjour Windows mono-label, servie par Caddy edge avec
      certs auto-signés). Le service `app` (root) sort comme `<prefix>.local`.
    - DOMAIN public → multi-label `<service>.<domain>` (Caddy + Let's Encrypt).
    - DOMAIN vide → string vide ; le caller doit fallback sur http://host:port.

    `service` doit être l'un de :  app, auth, agents, flows, chat, admin,
    status, qdrant. (Les autres sont acceptés mais non garantis servis par
    Caddy.)
    """
    if not domain:
        return "", ""
    if domain.endswith(".local"):
        prefix = domain.removesuffix(".local") or "aibox"
        host = f"{prefix}.local" if service == "app" else f"{prefix}-{service}.local"
        return f"https://{host}", host
    # Domaine public : on suppose que `app` est sur le domaine racine
    # (ex: DOMAIN=ai.client.fr → app sur https://ai.client.fr).
    host = domain if service == "app" else f"{service}.{domain}"
    return f"https://{host}", host


def setup_aibox_app_oidc(env: dict[str, str], host: str) -> dict[str, Any]:
    """Crée le provider OIDC pour l'app principale Next.js (services/app).

    IMPORTANT : on enregistre TOUJOURS DEUX redirect URIs dans Authentik :
      - L'URL de prod (https://app.<DOMAIN>/...) si DOMAIN est valide ET résolvable
      - L'URL LAN (http://<host_ip>:3100/...)
    Cela permet au login de fonctionner aussi bien depuis le LAN
    (testing) que depuis Internet (prod) sans avoir à reprovisionner.

    Pour NEXTAUTH_URL et AUTHENTIK_APP_ISSUER (uniques), on sélectionne :
      - prod si DOMAIN résout
      - LAN sinon (fallback safe — ne casse pas si DNS pas configuré)
    """
    token = _ak_admin_token(env)
    if not token:
        return {"ok": False, "reason": "Authentik admin token unavailable"}

    domain = env.get("DOMAIN", "")
    has_real_domain = bool(domain and domain != "xefia.local" and "." in domain)
    is_lan_mdns = has_real_domain and domain.endswith(".local")

    prod_url, prod_dns = _service_url("app", domain) if has_real_domain else ("", "")
    lan_url = f"http://{host}:3100"
    # En mode `.local`, on fait confiance à mDNS+Caddy AU NIVEAU des
    # redirect_uris (on enregistre les 2). Mais pour le NEXTAUTH_URL
    # (= URL active utilisée pour construire les callbacks), on PRÉFÈRE
    # l'IP LAN — plus universellement accessible (Windows corporate sans
    # Bonjour, terminaux mobiles, etc.). Le client Bonjour-compatible
    # accédera quand même au site via mDNS, et NextAuth tolère le hop.
    prod_resolves_dns = bool(prod_dns) and _dns_resolves(prod_dns)

    # On enregistre TOUJOURS les 2 redirect_uris dans Authentik :
    #   - http://<ip>:3100/api/auth/callback/authentik  (LAN, universel)
    #   - https://aibox.local/api/auth/callback/authentik  (mDNS, .local)
    #   - https://app.<domaine.fr>/api/auth/callback/authentik  (prod)
    redirect_uris: list[str] = [f"{lan_url}/api/auth/callback/authentik"]
    if prod_url:
        redirect_uris.append(f"{prod_url}/api/auth/callback/authentik")

    # URL active pour NEXTAUTH_URL :
    #   - mode prod (.fr/.com etc. avec DNS résolvant) → prod_url
    #   - mode .local OU mode IP brute → lan_url (IP LAN détectée)
    # Cette stratégie corrige l'ancien comportement où `.local` choisissait
    # `https://aibox.local` même quand le client n'avait pas Bonjour mDNS.
    if has_real_domain and not is_lan_mdns and prod_resolves_dns and prod_url:
        active_app_url = prod_url
        ak_url_browser, _ = _service_url("auth", domain)
        prod_resolves = True
    else:
        active_app_url = lan_url
        ak_url_browser = f"http://{host}:9000"
        prod_resolves = False

    creds = _ak_upsert_oidc_app(
        token,
        app_name="AI Box App",
        app_slug="aibox-app",
        client_id="aibox-app",
        redirect_uris=redirect_uris,
        description="Application principale AI Box (chat, agents, workflows)",
    )

    env_path = Path("/srv/ai-stack/.env")
    if env_path.exists():
        existing_secret = env.get("APP_NEXTAUTH_SECRET", "") or _gen_secret(48)
        keys = {
            "AUTHENTIK_APP_CLIENT_ID":     f"AUTHENTIK_APP_CLIENT_ID={creds['client_id']}",
            "AUTHENTIK_APP_CLIENT_SECRET": f"AUTHENTIK_APP_CLIENT_SECRET={creds['client_secret']}",
            "AUTHENTIK_APP_ISSUER":        f"AUTHENTIK_APP_ISSUER={ak_url_browser}/application/o/aibox-app/",
            "NEXTAUTH_URL":                f"NEXTAUTH_URL={active_app_url}",
            "APP_NEXTAUTH_SECRET":         f"APP_NEXTAUTH_SECRET={existing_secret}",
        }
        lines = env_path.read_text().splitlines()
        seen: set[str] = set()
        new: list[str] = []
        for line in lines:
            k = line.split("=", 1)[0] if "=" in line else ""
            if k in keys:
                new.append(keys[k])
                seen.add(k)
            else:
                new.append(line)
        for k, v in keys.items():
            if k not in seen:
                new.append(v)
        env_path.write_text("\n".join(new) + "\n")

    return {
        "ok": True,
        "client_id": creds["client_id"],
        "active_app_url": active_app_url,
        "redirect_uris": redirect_uris,
        "prod_resolves": prod_resolves,
    }


# ---------------------------------------------------------------------------
# Open WebUI : OIDC complet via Authentik
# ---------------------------------------------------------------------------
def setup_owui_oidc(env: dict[str, str], host: str) -> dict[str, Any]:
    """Crée le provider OIDC OWUI dans Authentik et écrit les credentials dans .env.

    `host` = host vu par le navigateur (ex: 192.168.15.210 ou ai.client.fr).
    """
    token = _ak_admin_token(env)
    if not token:
        return {"ok": False, "reason": "Authentik admin token unavailable"}

    # OWUI redirige vers <WEBUI_URL>/oauth/oidc/callback
    domain = env.get("DOMAIN", "")
    if domain and domain != "xefia.local":
        owui_url, _ = _service_url("chat", domain)
    else:
        owui_url = f"http://{host}:3000"

    creds = _ak_upsert_oidc_app(
        token,
        app_name="Open WebUI",
        app_slug="open-webui",
        client_id="open-webui",
        redirect_uris=[f"{owui_url}/oauth/oidc/callback"],
        description="Chat IA — interface utilisateur principale",
    )

    # Ecrit (ou met à jour) les variables OIDC dans le .env de la box
    env_path = Path("/srv/ai-stack/.env")
    if env_path.exists():
        lines = env_path.read_text().splitlines()
        new = []
        keys_handled = {
            "OWUI_OIDC_CLIENT_ID":      f"OWUI_OIDC_CLIENT_ID={creds['client_id']}",
            "OWUI_OIDC_CLIENT_SECRET":  f"OWUI_OIDC_CLIENT_SECRET={creds['client_secret']}",
            "OWUI_OPENID_PROVIDER_URL": f"OWUI_OPENID_PROVIDER_URL={host_provider_url(host, domain)}",
            "OPEN_WEBUI_URL":           f"OPEN_WEBUI_URL={owui_url}",
        }
        seen: set[str] = set()
        for line in lines:
            k = line.split("=", 1)[0] if "=" in line else ""
            if k in keys_handled:
                new.append(keys_handled[k])
                seen.add(k)
            else:
                new.append(line)
        for k, v in keys_handled.items():
            if k not in seen:
                new.append(v)
        env_path.write_text("\n".join(new) + "\n")

    return {"ok": True, "client_id": creds["client_id"], "owui_url": owui_url}


def host_provider_url(host: str, domain: str) -> str:
    if domain and domain != "xefia.local":
        auth_url, _ = _service_url("auth", domain)
        return f"{auth_url}/application/o/open-webui/.well-known/openid-configuration"
    return f"http://{host}:9000/application/o/open-webui/.well-known/openid-configuration"


# ---------------------------------------------------------------------------
# Dify : compte admin local via setup endpoint
# ---------------------------------------------------------------------------
def _ensure_dify_storage_writable() -> None:
    """Dify 1.10 a un bug de perms sur le volume storage (privkeys/).
    On force chmod 777 avant le setup pour éviter le PermissionDenied.
    """
    for container in ("aibox-dify-api", "aibox-dify-worker"):
        try:
            subprocess.run(
                ["docker", "exec", "-u", "root", container,
                 "sh", "-c", "mkdir -p /app/api/storage && chmod -R 777 /app/api/storage"],
                capture_output=True, timeout=15,
            )
        except Exception as e:
            log.warning("chmod Dify storage %s: %s", container, e)


def setup_dify_admin(env: dict[str, str]) -> dict[str, Any]:
    """Crée le compte admin Dify (1er user) avec le mdp choisi au wizard.

    Dify >= 1.10 demande 2 étapes :
      1. POST /console/api/setup/init-validation avec password=INIT_PASSWORD
         (= ADMIN_PASSWORD dans notre compose)
      2. POST /console/api/setup avec les détails du compte
    Idempotent : si déjà setup, retourne ok=True silencieusement.
    """
    base = "http://aibox-dify-nginx:80"
    admin_password = env.get("ADMIN_PASSWORD", "")
    if not admin_password:
        return {"ok": False, "error": "ADMIN_PASSWORD vide"}

    # Workaround bug Dify 1.10 perms storage
    _ensure_dify_storage_writable()

    # Dify nginx peut renvoyer 502 pendant 30-60 s après docker compose up
    # (le temps que dify-api démarre derrière). On attend qu'il réponde
    # avec un 200 sur /console/api/setup avant de poursuivre.
    import time as _t
    for attempt in range(30):  # max 60s
        try:
            with httpx.Client(timeout=5) as cc:
                s = cc.get(f"{base}/console/api/setup")
                if s.status_code == 200:
                    break
        except Exception:
            pass
        _t.sleep(2)

    try:
        # IMPORTANT : Dify utilise une session Flask (cookie-based) pour propager
        # `is_init_validated` entre POST /init et POST /setup. Le httpx.Client
        # garde les cookies par défaut.
        with httpx.Client(timeout=30, follow_redirects=False) as c:
            # Étape 0 : check si déjà setup
            s = c.get(f"{base}/console/api/setup")
            if s.status_code == 200 and s.json().get("step") == "finished":
                return {"ok": True, "created": False, "note": "déjà initialisé"}
            if s.status_code != 200:
                return {"ok": False, "step": "warmup",
                        "status": s.status_code,
                        "body": f"Dify pas prêt après 60s (HTTP {s.status_code})"}

            # Étape 1 : init validation (POST /console/api/init)
            v = c.post(
                f"{base}/console/api/init",
                json={"password": admin_password},
            )
            if v.status_code not in (200, 201):
                if "already" in v.text.lower():
                    return {"ok": True, "created": False, "note": "déjà initialisé"}
                return {"ok": False, "step": "init", "status": v.status_code, "body": v.text[:300]}

            # Étape 2 : setup (réutilise la session/cookie de l'étape 1)
            payload = {
                "email":    env.get("ADMIN_EMAIL", "admin@example.com"),
                "name":     env.get("ADMIN_FULLNAME", "Admin")[:30],
                "password": admin_password,
            }
            r = c.post(f"{base}/console/api/setup", json=payload)
            if r.status_code in (200, 201):
                return {"ok": True, "created": True}
            if "already" in r.text.lower():
                return {"ok": True, "created": False, "note": "déjà initialisé"}
            return {"ok": False, "step": "setup", "status": r.status_code, "body": r.text[:300]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Dify : agent par défaut + clé API (pour brancher l'app aibox sur Dify)
# ---------------------------------------------------------------------------
def _dify_console_client(base: str, email: str, password: str) -> httpx.Client | None:
    """Authentifie un httpx.Client sur la console Dify.

    Dify 1.10 utilise des cookies pour propager l'auth (access_token httpOnly,
    csrf_token, refresh_token). Le body de /login renvoie juste {"result":"success"}.
    Pour les endpoints protégés, on doit aussi envoyer Authorization: Bearer <token>
    + X-CSRF-TOKEN. On extrait les valeurs des cookies après login.
    Retourne un Client prêt à appeler /console/api/* ou None si login échoue.
    """
    c = httpx.Client(timeout=15)
    try:
        r = c.post(
            f"{base}/console/api/login",
            json={"email": email, "password": password, "language": "fr-FR",
                  "remember_me": True},
        )
        if r.status_code != 200:
            log.warning("Dify login HTTP %s : %s", r.status_code, r.text[:200])
            c.close()
            return None
        access_tok = c.cookies.get("access_token")
        csrf = c.cookies.get("csrf_token", "")
        if not access_tok:
            log.warning("Dify login: pas de cookie access_token")
            c.close()
            return None
        c.headers["Authorization"] = f"Bearer {access_tok}"
        if csrf:
            c.headers["X-CSRF-TOKEN"] = csrf
        return c
    except Exception as e:
        log.warning("Dify login error: %s", e)
        c.close()
        return None


MARKETPLACE_URL = "https://marketplace.dify.ai"


def _fetch_ollama_package_id() -> str | None:
    """Récupère le `latest_package_identifier` (format: langgenius/ollama:X.Y.Z@hash)
    via l'API marketplace publique. Sans ça, l'install Dify retourne 400.
    """
    try:
        r = httpx.get(f"{MARKETPLACE_URL}/api/v1/plugins/langgenius/ollama",
                      timeout=10)
        if r.status_code != 200:
            return None
        return r.json().get("data", {}).get("plugin", {}).get(
            "latest_package_identifier")
    except Exception:
        return None


def _ensure_ollama_plugin(c: httpx.Client, base: str) -> dict[str, Any]:
    """S'assure que le plugin Ollama est installé dans Dify (idempotent).

    Dify 1.x n'a plus les providers en built-in : ils sont packagés en plugins
    (langgenius/ollama). On vérifie la liste des plugins installés ; si Ollama
    est absent, on l'installe depuis le marketplace officiel en passant le
    package_identifier complet (langgenius/ollama:0.1.5@<sha256>).
    """
    try:
        r = c.get(f"{base}/console/api/workspaces/current/plugin/list",
                  params={"page": 1, "page_size": 50})
        if r.status_code == 200:
            for p in r.json().get("plugins", []):
                if "ollama" in str(p.get("plugin_id", "")).lower():
                    return {"ok": True, "installed": True, "already": True}

        # Pas trouvé → résoudre l'identifier puis installer
        pkg_id = _fetch_ollama_package_id()
        if not pkg_id:
            return {"ok": False, "error": "marketplace unreachable for ollama identifier"}

        r = c.post(
            f"{base}/console/api/workspaces/current/plugin/install/marketplace",
            json={"plugin_unique_identifiers": [pkg_id]},
        )
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300],
                    "pkg_id": pkg_id}
        task_id = r.json().get("task_id") or r.json().get("data", {}).get("task_id")

        # Poll jusqu'à 90s : l'install peut prendre du temps (téléchargement +
        # init du venv Python du plugin).
        deadline = time.time() + 90
        while time.time() < deadline:
            time.sleep(3)
            r = c.get(f"{base}/console/api/workspaces/current/plugin/list",
                      params={"page": 1, "page_size": 50})
            if r.status_code == 200:
                for p in r.json().get("plugins", []):
                    if "ollama" in str(p.get("plugin_id", "")).lower():
                        return {"ok": True, "installed": True,
                                "task_id": task_id, "pkg_id": pkg_id}
        return {"ok": False, "error": "timeout waiting for ollama plugin install",
                "task_id": task_id, "pkg_id": pkg_id}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _add_ollama_embedding(c: httpx.Client, base: str, model_name: str,
                          ollama_url: str = "http://ollama:11434") -> dict[str, Any]:
    """Ajoute un modèle d'embedding Ollama (text-embedding) au workspace.

    Pré-requis pour les datasets Dify (chunking + indexation Qdrant).
    Idempotent.
    """
    provider = "langgenius/ollama/ollama"
    try:
        r = c.get(
            f"{base}/console/api/workspaces/current/model-providers/{provider}/models",
        )
        if r.status_code == 200:
            for m in r.json().get("data", []):
                if m.get("model") == model_name and \
                   m.get("model_type") in ("text-embedding", "embeddings"):
                    return {"ok": True, "added": False, "already": True}

        # Note : pas de "mode" ni "max_tokens" pour text-embedding
        r = c.post(
            f"{base}/console/api/workspaces/current/model-providers/{provider}/models/credentials",
            json={
                "model": model_name,
                "model_type": "text-embedding",
                "credentials": {
                    "model": model_name,
                    "context_size": "8192",
                    "base_url": ollama_url,
                },
            },
            timeout=90,
        )
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        return {"ok": True, "added": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _set_default_embedding(c: httpx.Client, base: str, model_name: str) -> dict[str, Any]:
    """Définit le modèle d'embedding par défaut du workspace.
    Sans ça, /datasets refuse de créer une knowledge base.
    """
    try:
        r = c.post(
            f"{base}/console/api/workspaces/current/default-model",
            json={
                "model_settings": [{
                    "model_type": "text-embedding",
                    "provider": "langgenius/ollama/ollama",
                    "model": model_name,
                }],
            },
            timeout=30,
        )
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ensure_default_dataset(c: httpx.Client, base: str,
                            name: str = "Base de connaissances",
                            description: str = "Documents partagés AI Box",
                            ) -> dict[str, Any]:
    """Crée (ou retrouve) un dataset Dify partagé par tous les agents.
    Renvoie {ok, dataset_id}.
    """
    try:
        r = c.get(f"{base}/console/api/datasets",
                  params={"page": 1, "limit": 50})
        if r.status_code == 200:
            for ds in r.json().get("data", []):
                if ds.get("name") == name:
                    return {"ok": True, "dataset_id": ds.get("id"),
                            "already": True}

        # Créer le dataset (mode "high_quality" = embedding-based, le défaut
        # pour les Knowledge Base modernes Dify)
        r = c.post(
            f"{base}/console/api/datasets",
            json={
                "name": name,
                "description": description,
                "indexing_technique": "high_quality",
                "permission": "all_team_members",
                "provider": "vendor",
            },
            timeout=20,
        )
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        ds_id = r.json().get("id")
        if not ds_id:
            return {"ok": False, "error": "no dataset id returned"}
        return {"ok": True, "dataset_id": ds_id, "already": False}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _ensure_dataset_api_key(c: httpx.Client, base: str,
                            dataset_id: str) -> dict[str, Any]:
    """Génère (ou retrouve) une clé API du dataset (Bearer dataset-...)
    pour permettre à l'app aibox-app d'uploader/lister des docs en
    utilisant le Service API Dify (séparé du Console API).
    """
    try:
        # Liste les clés existantes : si une est en clair (non masquée), on
        # la réutilise.
        r = c.get(f"{base}/console/api/datasets/api-keys")
        if r.status_code == 200:
            for k in r.json().get("data", []):
                tok = k.get("token", "")
                if tok.startswith("dataset-") and "*" not in tok:
                    return {"ok": True, "api_key": tok, "already": True}

        # Sinon, en créer une nouvelle (le token complet n'est renvoyé
        # qu'à la création — pas de re-fetch possible après).
        r = c.post(f"{base}/console/api/datasets/api-keys", json={})
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        tok = r.json().get("token", "")
        if not tok:
            return {"ok": False, "error": "no token returned"}
        return {"ok": True, "api_key": tok, "already": False}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _add_ollama_model(c: httpx.Client, base: str, model_name: str,
                      ollama_url: str = "http://ollama:11434") -> dict[str, Any]:
    """Ajoute un modèle Ollama (LLM) dans Dify pour le workspace courant.

    Idempotent : si le modèle existe déjà, ne re-crée pas.
    Note : l'endpoint qui PERSISTE est /models/credentials (pas /models qui
    renvoie 200 mais ne stocke rien). La validation des creds se fait côté
    plugin (timeout possible si Ollama lent à répondre).
    """
    provider = "langgenius/ollama/ollama"
    try:
        # Liste des modèles déjà configurés pour ce provider
        r = c.get(
            f"{base}/console/api/workspaces/current/model-providers/{provider}/models",
        )
        if r.status_code == 200:
            for m in r.json().get("data", []):
                if m.get("model") == model_name:
                    return {"ok": True, "added": False, "already": True}

        # Endpoint qui persiste : .../models/credentials (POST). Timeout long
        # car validation = appel HTTP réel au backend Ollama (peut être lent
        # au cold start si le modèle n'est pas en mémoire).
        r = c.post(
            f"{base}/console/api/workspaces/current/model-providers/{provider}/models/credentials",
            json={
                "model": model_name,
                "model_type": "llm",
                "credentials": {
                    "mode": "chat",
                    "model": model_name,
                    "context_size": "4096",
                    "max_tokens": "4096",
                    "base_url": ollama_url,
                },
            },
            timeout=90,
        )
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        return {"ok": True, "added": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _fetch_concierge_tools(c: httpx.Client, base: str) -> list[dict[str, Any]]:
    """Récupère la liste des tools du provider 'BoxIA Concierge Tools' pour
    pouvoir les attacher à l'agent concierge en mode agent-chat.

    Endpoint Dify (capturé via console devtools) :
        GET /console/api/workspaces/current/tool-provider/api/get?provider=NAME
    Retourne {provider, tools: [{name, description, ...}], ...}.

    Renvoie une liste prête à insérer dans `agent_mode.tools` du
    model-config (format : provider_id, provider_name, provider_type=api,
    tool_name, tool_label, tool_parameters, enabled).
    """
    try:
        get_url = (
            f"{base}/console/api/workspaces/current/tool-provider/api/get"
            f"?provider=BoxIA Concierge Tools"
        )
        r = c.get(get_url)
        if r.status_code != 200:
            return []
        data = r.json()
        # Récupère aussi le provider_id depuis tool-providers (nécessaire
        # pour le format agent_mode.tools)
        provider_id = ""
        try:
            r2 = c.get(f"{base}/console/api/workspaces/current/tool-providers")
            providers = r2.json() if isinstance(r2.json(), list) else r2.json().get("data", [])
            for p in providers:
                if isinstance(p, dict) and (p.get("name") == "BoxIA Concierge Tools"
                                            or p.get("provider") == "BoxIA Concierge Tools"):
                    provider_id = p.get("id", "")
                    break
        except Exception:
            pass

        tools = []
        for t in data.get("tools", []):
            name = t.get("name") or t.get("operation_id")
            if not name:
                continue
            tools.append({
                "provider_id": provider_id or "BoxIA Concierge Tools",
                "provider_name": "BoxIA Concierge Tools",
                "provider_type": "api",
                "tool_name": name,
                "tool_label": t.get("label", {}).get("en_US") if isinstance(t.get("label"), dict) else (t.get("description", "")[:60] or name),
                "tool_parameters": {},
                "enabled": True,
            })
        return tools
    except Exception as e:
        log.warning("fetch concierge tools failed: %s", e)
        return []


def _set_app_default_model(c: httpx.Client, base: str, app_id: str,
                           model_name: str,
                           pre_prompt: str | None = None,
                           opening_statement: str | None = None,
                           dataset_ids: list[str] | None = None,
                           agent_tools: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Configure le modèle par défaut sur une app Dify (mode chat).

    Le endpoint /console/api/apps/{id}/model-config attend toute la
    model_config (model + completion params + opening_statement, etc.).
    pre_prompt et opening_statement sont surchargeables pour permettre
    différents agents spécialisés (comptable, RH, support, ...).
    """
    payload = {
        "pre_prompt": pre_prompt or (
            "Tu es l'assistant IA local de l'AI Box. Réponds en français, "
            "de façon concise et précise."
        ),
        "prompt_type": "simple",
        "chat_prompt_config": {},
        "completion_prompt_config": {},
        "user_input_form": [],
        "dataset_query_variable": "",
        "more_like_this": {"enabled": False},
        "opening_statement": opening_statement or (
            "Bonjour ! Je suis votre assistant IA local. "
            "Que puis-je faire pour vous aujourd'hui ?"
        ),
        "suggested_questions": [],
        "suggested_questions_after_answer": {"enabled": True},
        "speech_to_text": {"enabled": False},
        "text_to_speech": {"enabled": False, "voice": "", "language": "fr"},
        "retriever_resource": {"enabled": True},
        "sensitive_word_avoidance": {"enabled": False, "type": "", "configs": []},
        # Mode agent : si on passe des tools (cas concierge), on active
        # automatiquement le mode agent function-calling. Sinon mode chat.
        "agent_mode": {
            "enabled": bool(agent_tools),
            "max_iteration": 5,
            "strategy": "function_call",
            "tools": agent_tools or [],
        },
        "model": {
            "provider": "langgenius/ollama/ollama",
            "name": model_name,
            "mode": "chat",
            "completion_params": {
                "temperature": 0.7,
                "top_p": 1,
                "max_tokens": 1024,
            },
        },
        "dataset_configs": {
            "retrieval_model": "multiple",
            "datasets": {
                "datasets": [
                    {"dataset": {"enabled": True, "id": did}}
                    for did in (dataset_ids or [])
                ],
            },
            "top_k": 4,
            "score_threshold": 0.5,
            "score_threshold_enabled": False,
        },
        # Image upload activé : si le LLM courant n'est pas vision,
        # Dify renverra une erreur lisible — sinon l'utilisateur peut
        # joindre une image et l'agent la voit.
        "file_upload": {
            "enabled": True,
            "image": {
                "enabled": True,
                "number_limits": 3,
                "transfer_methods": ["local_file"],
            },
        },
    }
    try:
        r = c.post(f"{base}/console/api/apps/{app_id}/model-config", json=payload)
        if r.status_code not in (200, 201):
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Catalogue des agents AI Box.
# Chaque entrée est provisionnée comme une App Dify distincte avec son propre
# pre_prompt → ton et expertise différents. La clé API est écrite dans .env
# sous le nom env_var (consommée par services/app/docker-compose.yml).
# ---------------------------------------------------------------------------
DEFAULT_AGENTS: list[dict[str, str]] = [
    {
        "slug": "general",
        "name": "Assistant général",
        "icon": "🤖",
        "icon_bg": "#FFEAD5",
        "description": "Assistant polyvalent, par défaut de l'AI Box.",
        "pre_prompt": (
            "Tu es l'assistant IA local de l'AI Box. Réponds en français, "
            "de façon concise et précise. Quand on te demande de générer du code, "
            "fournis des blocs ```lang``` correctement formatés."
        ),
        "opening_statement": (
            "Bonjour ! Je suis votre assistant IA local. "
            "Que puis-je faire pour vous aujourd'hui ?"
        ),
        "env_var": "DIFY_DEFAULT_APP_API_KEY",
    },
    {
        "slug": "accountant",
        "name": "Assistant comptable",
        "icon": "📊",
        "icon_bg": "#D4F4DD",
        "description": "Spécialiste comptabilité, factures, TVA, devis.",
        "pre_prompt": (
            "Tu es l'assistant comptable de l'AI Box, expert pour les TPE/PME "
            "françaises. Tu maîtrises : la TVA (taux normal 20 %, intermédiaire 10 %, "
            "réduit 5,5 %), les régimes (réel, micro-BNC, micro-BIC), la "
            "facturation, les écritures comptables, les déclarations courantes "
            "(CFE, DAS2, IS, IR). Réponds en français de façon claire et "
            "structurée. Cite toujours les obligations légales pertinentes. "
            "Pour les calculs, montre les étapes. Tu n'es pas un expert-comptable "
            "agréé : rappelle-le pour les questions complexes."
        ),
        "opening_statement": (
            "Bonjour ! Je suis votre assistant comptable. Je peux vous aider sur "
            "les devis, factures, TVA, écritures, déclarations… Que souhaitez-vous ?"
        ),
        "env_var": "DIFY_AGENT_ACCOUNTANT_API_KEY",
    },
    {
        "slug": "hr",
        "name": "Assistant RH",
        "icon": "👥",
        "icon_bg": "#E0E7FF",
        "description": "Spécialiste droit du travail, paie, contrats, congés.",
        "pre_prompt": (
            "Tu es l'assistant RH de l'AI Box, spécialisé pour les TPE/PME "
            "françaises. Tu connais le Code du travail, les conventions "
            "collectives courantes, la paie (charges sociales, fiches de paie), "
            "les contrats (CDI, CDD, alternance), les congés (payés, RTT, "
            "maladie, maternité), les ruptures (démission, licenciement, "
            "rupture conventionnelle). Réponds en français, de façon claire, "
            "et cite les articles de loi pertinents. Tu n'es pas avocat : "
            "recommande la consultation d'un juriste pour les cas complexes."
        ),
        "opening_statement": (
            "Bonjour ! Je suis votre assistant RH. Posez-moi vos questions "
            "sur les contrats, la paie, les congés, le droit du travail…"
        ),
        "env_var": "DIFY_AGENT_HR_API_KEY",
    },
    {
        "slug": "support",
        "name": "Support clients",
        "icon": "🎧",
        "icon_bg": "#FFE0E9",
        "description": "Rédige des réponses commerciales pour vos clients.",
        "pre_prompt": (
            "Tu es l'assistant de relation client de l'AI Box. Tu rédiges des "
            "réponses professionnelles, courtoises et orientées solution pour "
            "des clients de TPE/PME françaises. Ton ton : empathique, rassurant, "
            "concret. Tu sais : remercier, accuser réception, présenter des "
            "excuses, proposer un geste commercial proportionné, escalader. "
            "Tu signes par défaut « Cordialement, [Votre prénom] ». Tu adaptes "
            "le formalisme au contexte (B2B vs B2C). Si tu as besoin d'infos "
            "(nom client, n° commande), demande-les."
        ),
        "opening_statement": (
            "Bonjour ! Je rédige avec vous vos réponses clients. "
            "Décrivez la situation et je vous propose un message."
        ),
        "env_var": "DIFY_AGENT_SUPPORT_API_KEY",
    },
    {
        # Agent CONCIERGE — orchestre l'admin BoxIA depuis la conversation.
        # Mode "agent-chat" pour avoir accès aux Custom Tools Dify (l'OpenAPI
        # `concierge-tool-openapi.yaml` est provisionné via setup_dify_concierge_tool).
        "slug": "concierge",
        "name": "Concierge BoxIA",
        "icon": "🛎️",
        "icon_bg": "#FEF3C7",
        "description": "Orchestre votre BoxIA : connecteurs, workflows, assistants, MCP. Sans paramétrage manuel.",
        "mode": "agent-chat",  # ← important : mode agent pour les tools
        "pre_prompt": (
            "Tu es le Concierge de la BoxIA, un agent IA qui aide l'utilisateur à "
            "configurer SA box (connecter des sources de données, installer des "
            "workflows d'automatisation, ajouter des assistants spécialisés, "
            "vérifier l'état des services). Tu as accès à des outils HTTP via le "
            "Custom Tool « BoxIA Concierge Tools » qui te permet de lister, "
            "vérifier et installer.\n\n"
            "Règles strictes :\n\n"
            "1. **Confirme TOUJOURS avant d'installer.** Quand l'utilisateur "
            "exprime une intention d'installation (« active mon Pennylane », "
            "« ajoute le workflow GLPI », « installe l'assistant compta »), "
            "réponds d'abord par : « OK, je vais installer X. Tu confirmes ? » "
            "puis attends « oui »/« ok »/« vas-y » avant d'appeler le tool.\n\n"
            "2. **Démarre par lister** quand l'intention est floue. Si l'utilisateur "
            "dit « tu peux automatiser ma compta ? », commence par appeler "
            "`listMarketplaceWorkflows` ou `listMarketplaceAgentsFr` pour montrer "
            "les options disponibles.\n\n"
            "3. **Pour activer un connecteur** (qui demande des credentials sensibles "
            "comme un token Pennylane ou un mdp NAS), tu N'AS PAS l'autorité — "
            "appelle `deepLink` avec target=connectors pour donner à l'utilisateur "
            "l'URL où il va saisir ses credentials lui-même.\n\n"
            "4. **Sois concis.** Réponses courtes, action-oriented. Une phrase pour "
            "résumer ce que tu vas faire, puis exécute, puis confirme le résultat.\n\n"
            "5. **Reste en français** sauf demande explicite contraire.\n\n"
            "6. **Si tu n'es pas sûr de l'identifiant** (slug d'un workflow, fichier "
            "à installer), liste d'abord pour trouver le bon, puis demande à "
            "l'utilisateur de choisir parmi les options."
        ),
        "opening_statement": (
            "🛎️ Bonjour ! Je suis votre Concierge BoxIA.\n\n"
            "Je peux configurer votre box pour vous : connecter vos données "
            "(Outlook, Drive, Pennylane…), installer des workflows d'automatisation "
            "(relances clients, alertes SLA, monitoring…), ajouter des assistants "
            "spécialisés (compta, RH, juridique…). Dites-moi ce que vous voulez faire "
            "en français naturel, je m'occupe du reste."
        ),
        "suggested_questions": [
            "Tu peux automatiser ma comptabilité ?",
            "Quels assistants français sont disponibles ?",
            "Connecte mon NAS pour indexer les documents partagés",
            "Tout fonctionne bien dans la box ?",
        ],
        "env_var": "DIFY_AGENT_CONCIERGE_API_KEY",
    },
]


def _attach_recovery_flow_to_brand(c: httpx.Client, base: str) -> dict[str, Any]:
    """Trouve un recovery flow et l'attache au brand par défaut.

    Authentik génère des liens de récupération de mot de passe uniquement
    si le brand a `flow_recovery` configuré. Par défaut, ce champ est null
    sur une fresh install. On utilise le 1er flow ayant designation=recovery
    (Authentik ships avec un default-recovery-flow via blueprint).

    Si aucun recovery flow n'existe, on laisse tel quel — l'app aibox
    fallback sur un mdp temporaire généré localement.
    """
    try:
        r = c.get(f"{base}/flows/instances/",
                  params={"designation": "recovery"})
        if r.status_code != 200:
            return {"ok": False, "step": "list_flows",
                    "status": r.status_code}
        results = r.json().get("results", [])
        if not results:
            return {"ok": False, "skipped": "no_recovery_flow_in_authentik"}
        flow_pk = results[0]["pk"]
        flow_slug = results[0].get("slug", "")

        # Trouve le brand par défaut
        rb = c.get(f"{base}/core/brands/", params={"default": "true"})
        if rb.status_code != 200:
            return {"ok": False, "step": "list_brands",
                    "status": rb.status_code}
        brands = rb.json().get("results", [])
        if not brands:
            return {"ok": False, "skipped": "no_default_brand"}
        brand = brands[0]
        if brand.get("flow_recovery") == flow_pk:
            return {"ok": True, "already": True, "flow_slug": flow_slug}

        rp = c.patch(f"{base}/core/brands/{brand['pk']}/",
                     json={"flow_recovery": flow_pk})
        if rp.status_code not in (200, 201):
            return {"ok": False, "step": "patch_brand",
                    "status": rp.status_code, "body": rp.text[:200]}
        return {"ok": True, "attached": True, "flow_slug": flow_slug}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def setup_authentik_management(env: dict[str, str]) -> dict[str, Any]:
    """Provisionne les éléments Authentik nécessaires à la gestion users
    depuis l'app aibox-app :
      1. Service token long-lived → écrit dans .env (AUTHENTIK_API_TOKEN)
      2. Groupes par défaut : aibox-manager, aibox-employee
         (le groupe admin est "authentik Admins", déjà présent)
      3. S'assure que le user wizard est bien dans "authentik Admins"
      4. Attache un recovery flow au brand pour les liens cliquables
    """
    token = _ak_admin_token(env)
    if not token:
        return {"ok": False, "error": "akadmin token unavailable"}

    # Persiste le token : aibox-app l'utilise pour les CRUD users.
    _persist_env_var("AUTHENTIK_API_TOKEN", token)

    H = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    base = f"{AUTHENTIK_INTERNAL}/api/v3"
    groups_created: dict[str, str] = {}

    try:
        with httpx.Client(headers=H, timeout=20) as c:
            for slug, name in [
                ("aibox-manager",  "AI Box — Managers"),
                ("aibox-employee", "AI Box — Employés"),
            ]:
                # Cherche par nom (Authentik n'a pas de slug pour les groups)
                r = c.get(f"{base}/core/groups/", params={"name": name})
                if r.status_code == 200 and r.json().get("results"):
                    groups_created[slug] = r.json()["results"][0]["pk"]
                    continue
                r = c.post(f"{base}/core/groups/", json={
                    "name": name,
                    "is_superuser": False,
                    "attributes": {"aibox_role": slug.replace("aibox-", "")},
                })
                if r.status_code in (200, 201):
                    groups_created[slug] = r.json()["pk"]

            # S'assure que le user wizard est dans "authentik Admins"
            admin_username = env.get("ADMIN_USERNAME", "")
            if admin_username:
                r = c.get(f"{base}/core/users/", params={"username": admin_username})
                if r.status_code == 200 and r.json().get("results"):
                    u = r.json()["results"][0]
                    user_pk = u["pk"]
                    user_groups = [g.get("pk") if isinstance(g, dict) else g
                                   for g in u.get("groups", [])]
                    # Get "authentik Admins" group
                    rg = c.get(f"{base}/core/groups/", params={"name": "authentik Admins"})
                    if rg.status_code == 200 and rg.json().get("results"):
                        admin_group_pk = rg.json()["results"][0]["pk"]
                        if admin_group_pk not in user_groups:
                            new_groups = list(user_groups) + [admin_group_pk]
                            c.patch(f"{base}/core/users/{user_pk}/",
                                    json={"groups": new_groups})

            # 4. Recovery flow (best-effort)
            recovery_res = _attach_recovery_flow_to_brand(c, base)

        return {
            "ok": True,
            "token_persisted": True,
            "groups": groups_created,
            "recovery_flow": recovery_res,
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _persist_env_var(name: str, value: str) -> None:
    """Écrit (ou met à jour) une ligne KEY=VALUE dans /srv/ai-stack/.env.
    Idempotent : remplace la ligne existante si présente, sinon append.
    """
    env_path = Path("/srv/ai-stack/.env")
    if not env_path.exists():
        return
    lines = env_path.read_text().splitlines()
    found = False
    out = []
    for line in lines:
        if line.startswith(f"{name}="):
            out.append(f"{name}={value}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"{name}={value}")
    env_path.write_text("\n".join(out) + "\n")


def _setup_one_dify_agent(c: httpx.Client, base: str, agent: dict[str, str],
                          model_name: str,
                          dataset_ids: list[str] | None = None) -> dict[str, Any]:
    """Provisionne (ou retrouve) un agent Dify selon sa spec, et écrit sa
    clé API dans .env. Idempotent.
    """
    name = agent["name"]
    try:
        # 1. Cherche l'app par nom
        app_id: str | None = None
        r = c.get(f"{base}/console/api/apps", params={"page": 1, "limit": 50})
        if r.status_code == 200:
            for app in r.json().get("data", []):
                if app.get("name") == name:
                    app_id = app.get("id")
                    break

        # 2. Sinon, crée l'app
        if not app_id:
            # Mode "agent-chat" pour les agents qui utilisent des tools
            # (ex: Concierge BoxIA), "chat" pour les agents simples.
            agent_mode = agent.get("mode", "chat")
            r = c.post(
                f"{base}/console/api/apps",
                json={
                    "name": name,
                    "mode": agent_mode,
                    "icon_type": "emoji",
                    "icon": agent["icon"],
                    "icon_background": agent["icon_bg"],
                    "description": agent["description"],
                },
            )
            if r.status_code not in (200, 201):
                return {"ok": False, "step": "create_app",
                        "status": r.status_code, "body": r.text[:300]}
            app_id = r.json().get("id")
            if not app_id:
                return {"ok": False, "error": "no app id returned"}

        # 3. Configure le modèle + pre_prompt + opening_statement + datasets.
        # Pour le concierge (slug="concierge"), on attache aussi les tools
        # du provider « BoxIA Concierge Tools » → l'agent peut directement
        # appeler les endpoints /api/agents-tools/* sans setup manuel.
        agent_tools: list[dict[str, Any]] | None = None
        if agent.get("slug") == "concierge":
            agent_tools = _fetch_concierge_tools(c, base)
            if agent_tools:
                log.info("Concierge: %d tools attachés depuis le provider",
                         len(agent_tools))
            else:
                log.warning("Concierge: aucun tool trouvé dans le provider "
                            "« BoxIA Concierge Tools » (vérifie qu'il a été "
                            "provisionné AVANT cet appel)")

        cfg = _set_app_default_model(
            c, base, app_id, model_name,
            pre_prompt=agent["pre_prompt"],
            opening_statement=agent["opening_statement"],
            dataset_ids=dataset_ids,
            agent_tools=agent_tools,
        )
        # On continue même si la config échoue (l'app reste utilisable
        # mais avec le pre_prompt précédent)

        # 4. Clé API : récupère existante (token en clair) ou en crée une
        api_key: str | None = None
        r = c.get(f"{base}/console/api/apps/{app_id}/api-keys")
        if r.status_code == 200:
            for k in r.json().get("data", []):
                tok = k.get("token", "")
                if tok.startswith("app-") and "*" not in tok:
                    api_key = tok
                    break
        if not api_key:
            r = c.post(f"{base}/console/api/apps/{app_id}/api-keys", json={})
            if r.status_code not in (200, 201):
                return {"ok": False, "step": "create_key",
                        "status": r.status_code, "body": r.text[:300]}
            api_key = r.json().get("token")
            if not api_key:
                return {"ok": False, "error": "no token returned"}

        # 5. Persistence dans .env
        _persist_env_var(agent["env_var"], api_key)

        return {
            "ok": True,
            "slug": agent["slug"],
            "app_id": app_id,
            "api_key_prefix": api_key[:10] + "…",
            "model_config_ok": cfg.get("ok", False),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def setup_dify_default_agent(env: dict[str, str]) -> dict[str, Any]:
    """Provisionne TOUS les agents par défaut (général + spécialisés).

    Étapes :
      1. Login console
      2. Plugin Ollama (idempotent)
      3. Modèle Ollama (idempotent)
      4. Pour chaque agent du catalogue : crée/retrouve l'app, configure
         son pre_prompt, génère sa clé API, écrit dans .env
    """
    base = "http://aibox-dify-nginx:80"
    email = env.get("ADMIN_EMAIL", "")
    pwd = env.get("ADMIN_PASSWORD", "")
    if not email or not pwd:
        return {"ok": False, "error": "ADMIN_EMAIL / ADMIN_PASSWORD requis"}

    model_name = env.get("LLM_MAIN", "qwen2.5:7b")
    embed_name = env.get("LLM_EMBED", "bge-m3:latest")

    c = _dify_console_client(base, email, pwd)
    if not c:
        return {"ok": False, "error": "login Dify impossible (admin pas encore créé ?)"}

    report: dict[str, Any] = {}
    try:
        report["ollama_plugin"] = _ensure_ollama_plugin(c, base)
        if not report["ollama_plugin"].get("ok"):
            return {"ok": False, "step": "ollama_plugin", **report}

        report["ollama_model"] = _add_ollama_model(c, base, model_name)
        if not report["ollama_model"].get("ok"):
            return {"ok": False, "step": "ollama_model", **report}

        # ---- Embedding + dataset (Phase C : RAG) ----
        # Best-effort : si une étape échoue, on continue sans datasets pour
        # ne pas bloquer le provisioning des agents.
        report["ollama_embedding"] = _add_ollama_embedding(c, base, embed_name)
        report["default_embedding"] = _set_default_embedding(c, base, embed_name)

        dataset_ids: list[str] = []
        ds_res = _ensure_default_dataset(c, base)
        report["default_dataset"] = ds_res
        if ds_res.get("ok") and ds_res.get("dataset_id"):
            dataset_ids.append(ds_res["dataset_id"])
            _persist_env_var("DIFY_DEFAULT_DATASET_ID", ds_res["dataset_id"])

            # Clé API du Service Dataset API (différente des clés app/agent !)
            kb_key = _ensure_dataset_api_key(c, base, ds_res["dataset_id"])
            report["dataset_api_key"] = {
                "ok": kb_key.get("ok", False),
                "already": kb_key.get("already", False),
            }
            if kb_key.get("ok") and kb_key.get("api_key"):
                _persist_env_var("DIFY_KB_API_KEY", kb_key["api_key"])

        agents_report: dict[str, Any] = {}
        any_ok = False
        for spec in DEFAULT_AGENTS:
            res = _setup_one_dify_agent(c, base, spec, model_name,
                                        dataset_ids=dataset_ids)
            agents_report[spec["slug"]] = res
            if res.get("ok"):
                any_ok = True

        default_ok = agents_report.get("general", {}).get("ok", False)
        return {
            "ok": default_ok or any_ok,
            "model": model_name,
            "embed_model": embed_name,
            "datasets_attached": dataset_ids,
            "agents": agents_report,
            **report,
        }
    finally:
        c.close()


# ---------------------------------------------------------------------------
# n8n : compte owner local via API
# ---------------------------------------------------------------------------
def _resolve_n8n_url(host: str) -> list[str]:
    """Retourne les candidats d'URL n8n à tester (DNS interne d'abord, host gateway en fallback)."""
    candidates = [
        "http://n8n:5678",
        "http://host.docker.internal:5678",
    ]
    if host and host not in ("localhost", "127.0.0.1"):
        candidates.append(f"http://{host}:5678")
    return candidates


def _n8n_strong_password(n: int = 24) -> str:
    """Génère un password fort respectant la policy n8n :
    8+ chars + au moins 1 majuscule + 1 minuscule + 1 chiffre.
    On ajoute aussi un caractère spécial pour robustesse.
    """
    import secrets
    import string
    pools = [
        string.ascii_uppercase,
        string.ascii_lowercase,
        string.digits,
        "!#$%*+-=?@_",
    ]
    pwd = [secrets.choice(p) for p in pools]
    pwd += [secrets.choice("".join(pools)) for _ in range(max(0, n - 4))]
    secrets.SystemRandom().shuffle(pwd)
    return "".join(pwd)


def setup_n8n_owner(env: dict[str, str], host: str = "") -> dict[str, Any]:
    """Crée le compte owner n8n (1er user) via leur API.

    n8n Community expose POST /rest/owner/setup pour le 1er compte.
    Essaye plusieurs URLs au cas où le DNS interne ne résoud pas (n8n peut
    être sur un réseau différent du nôtre, comme `stack_xefia_ollama_net`).

    Le ADMIN_PASSWORD principal (généré par `gen_secret` dans install.sh) ne
    respecte pas toujours la policy n8n (1 majuscule + 1 chiffre). On utilise
    donc un N8N_PASSWORD dédié, auto-généré ici si absent, et persisté dans
    .env par le caller (cf. provision_all → flow d'écriture .env). Le client
    aibox-app lira N8N_PASSWORD en priorité (fallback ADMIN_PASSWORD).
    """
    full = env.get("ADMIN_FULLNAME", "Admin").split()
    first = full[0] if full else "Admin"
    last  = " ".join(full[1:]) or "User"

    # Préfère un N8N_PASSWORD dédié (déjà fort), sinon génère-en un.
    n8n_password = env.get("N8N_PASSWORD") or _n8n_strong_password(24)

    payload = {
        "email":     env.get("ADMIN_EMAIL", "admin@example.com"),
        "firstName": first,
        "lastName":  last,
        "password":  n8n_password,
    }

    last_err = "no candidate URL succeeded"
    for base in _resolve_n8n_url(host):
        try:
            with httpx.Client(timeout=10) as c:
                r = c.post(f"{base}/rest/owner/setup", json=payload)
                if r.status_code in (200, 201):
                    # SUCCÈS : on remonte le password généré pour que le caller
                    # le persiste dans .env (env est passé par référence).
                    env["N8N_PASSWORD"] = n8n_password
                    return {
                        "ok": True, "created": True, "via": base,
                        "n8n_password_persisted": True,
                    }
                # 400 a 2 sens distincts côté n8n :
                #   a) "password too weak" → on retry avec un mdp renforcé.
                #   b) "Instance owner already setup" → idempotent OK
                #      (cas ré-exécution de provision_all après un crash).
                if r.status_code == 400:
                    body_lower = r.text.lower()
                    if "already" in body_lower or "instance owner" in body_lower:
                        return {
                            "ok": True, "created": False,
                            "note": "déjà initialisé (400)", "via": base,
                        }
                    if "password" in body_lower:
                        new_pwd = _n8n_strong_password(24)
                        payload["password"] = new_pwd
                        r2 = c.post(f"{base}/rest/owner/setup", json=payload)
                        if r2.status_code in (200, 201):
                            env["N8N_PASSWORD"] = new_pwd
                            return {
                                "ok": True, "created": True, "via": base,
                                "note": "password renforcé après 400",
                                "n8n_password_persisted": True,
                            }
                        # Le retry peut aussi tomber sur "already setup" si
                        # la 1re requête a abouti côté DB mais renvoyé 400
                        # (race rare mais observée en multi-replicas).
                        if r2.status_code == 400 and (
                            "already" in r2.text.lower()
                            or "instance owner" in r2.text.lower()
                        ):
                            return {
                                "ok": True, "created": False,
                                "note": "déjà initialisé après retry password",
                                "via": base,
                            }
                        last_err = f"retry status={r2.status_code} body={r2.text[:150]}"
                        continue
                if r.status_code in (403, 409):
                    return {"ok": True, "created": False, "note": "déjà initialisé", "via": base}
                last_err = f"status={r.status_code} body={r.text[:150]}"
        except Exception as e:
            last_err = str(e)
            continue
    return {"ok": False, "error": last_err}


# ---------------------------------------------------------------------------
# Portainer : compte admin via API init
# ---------------------------------------------------------------------------
def setup_portainer_admin(env: dict[str, str], host: str = "") -> dict[str, Any]:
    """Crée le compte admin Portainer via /api/users/admin/init.

    Portainer N'EST PAS dans la stack BoxIA core (cf. install.sh — il était
    présent dans la stack héritée /srv/anythingllm/ uniquement). Pour un
    client TPE/PME, la gestion Docker est invisible : tout passe par
    aibox-app /system. Cette fonction reste pour rétro-compat sur xefia
    qui a encore un Portainer démarré, mais elle skip silencieusement si
    aucun container Portainer n'est joignable.

    Idempotent : 409 si déjà initialisé. Skip propre si pas déployé.
    """
    payload = {
        "Username": env.get("ADMIN_USERNAME", "admin"),
        "Password": env.get("ADMIN_PASSWORD", ""),
    }
    if len(payload["Password"]) < 12:
        return {
            "ok": True, "skipped": "portainer_password_too_short",
            "note": "Portainer exige un mdp ≥ 12 chars (default password = 18 OK)",
        }

    candidates = [
        "https://portainer:9443",
        "http://portainer:9000",
    ]
    if host:
        candidates.append(f"https://{host}:9443")

    last_err = "no candidate"
    for base in candidates:
        try:
            with httpx.Client(timeout=10, verify=False) as c:
                r = c.post(f"{base}/api/users/admin/init", json=payload)
                if r.status_code in (200, 201):
                    return {"ok": True, "created": True, "via": base}
                if r.status_code in (409, 400, 403):
                    return {"ok": True, "created": False, "note": "déjà initialisé", "via": base}
                last_err = f"status={r.status_code} body={r.text[:120]}"
        except Exception as e:
            last_err = str(e)
            continue
    # Aucune URL n'a répondu (Portainer pas dans la stack) → skip propre
    # plutôt qu'erreur. Le wizard ne doit pas déclarer le déploiement
    # comme failed pour un service optionnel non déployé.
    if "Connection refused" in last_err or "Name or service not known" in last_err:
        return {"ok": True, "skipped": "portainer_not_deployed", "via": last_err}
    return {"ok": False, "error": last_err}


# ---------------------------------------------------------------------------
# (Uptime Kuma : retiré du produit BoxIA — remplacé par Prometheus +
# Grafana + /system page + workflow healthcheck. Cf. memory/n8n_marketplace.)
# ---------------------------------------------------------------------------
# Dify : provisioning du custom tool "AI Box Agents" (sidecar LangGraph)
# ---------------------------------------------------------------------------
# Pourquoi : le sidecar `aibox-agents` expose 3 agents autonomes via HTTP
# (triage email, génération devis, rapprochement facture). Pour qu'ils soient
# utilisables dans les Workflows Dify, il faut enregistrer un Custom API Tool
# dans la console Dify. Sinon le client devrait le faire à la main = violation
# du principe produit (cf. memory/product_appliance_principle.md).
#
# Idempotent : si le tool existe déjà → update au lieu de create.

# Path standard du YAML OpenAPI dans le repo monté en /srv/ai-stack
_AGENTS_TOOL_OPENAPI_PATHS = [
    "/srv/ai-stack/services/agents-autonomous/dify-integration/openapi-tool.yaml",
    "/app/static/openapi-agents-tool.yaml",  # fallback si copié dans le container
]

# Fallback embedded — version minimale si aucun fichier YAML trouvé.
# Suffit pour exposer les 3 endpoints, sans schemas détaillés.
_AGENTS_TOOL_OPENAPI_FALLBACK = """openapi: 3.0.3
info:
  title: AI Box Agents
  version: 0.1.0
  description: Agents autonomes (triage email, devis, rapprochement facture)
servers:
  - url: http://aibox-agents:8000
paths:
  /v1/triage-email:
    post:
      operationId: triageEmail
      summary: Trie un email entrant
      security: [{bearerAuth: []}]
      requestBody:
        required: true
        content: {application/json: {schema: {type: object}}}
      responses: {"200": {description: OK}}
  /v1/generate-quote:
    post:
      operationId: generateQuote
      summary: Génère un devis depuis un brief client
      security: [{bearerAuth: []}]
      requestBody:
        required: true
        content: {application/json: {schema: {type: object}}}
      responses: {"200": {description: OK}}
  /v1/reconcile-invoice:
    post:
      operationId: reconcileInvoice
      summary: Rapproche une facture avec ses candidats
      security: [{bearerAuth: []}]
      requestBody:
        required: true
        content: {application/json: {schema: {type: object}}}
      responses: {"200": {description: OK}}
components:
  securitySchemes:
    bearerAuth: {type: http, scheme: bearer}
"""

_AGENTS_TOOL_PROVIDER_NAME = "AI Box Agents"


def _load_agents_openapi_schema() -> str:
    """Lit le YAML depuis le repo monté, sinon utilise le fallback embedded."""
    import os
    for p in _AGENTS_TOOL_OPENAPI_PATHS:
        if os.path.isfile(p):
            try:
                return open(p, encoding="utf-8").read()
            except OSError:
                continue
    log.info("YAML OpenAPI agents introuvable dans %s — fallback embedded",
             _AGENTS_TOOL_OPENAPI_PATHS)
    return _AGENTS_TOOL_OPENAPI_FALLBACK


def setup_dify_agents_tool(env: dict[str, str]) -> dict[str, Any]:
    """Provisionne le Custom API Tool "AI Box Agents" dans Dify.

    Idempotent : si le provider existe → update du schéma + credentials.
    Réutilise `_dify_console_client()` qui gère access_token + csrf_token.
    """
    base = "http://aibox-dify-nginx:80"
    admin_email = env.get("ADMIN_EMAIL", "")
    admin_password = env.get("ADMIN_PASSWORD", "")
    agents_api_key = env.get("AGENTS_API_KEY", "")

    if not admin_email or not admin_password:
        return {"ok": False, "error": "ADMIN_EMAIL/ADMIN_PASSWORD manquants"}
    if not agents_api_key:
        return {"ok": False, "error": "AGENTS_API_KEY non défini dans .env"}

    schema_text = _load_agents_openapi_schema()

    c = _dify_console_client(base, admin_email, admin_password)
    if c is None:
        return {"ok": False, "error": "Login Dify console échoué"}

    try:
        # 1. Vérifier si le provider existe déjà (idempotence).
        # Endpoint capturé via Chrome devtools sur Dify 1.10 :
        #   GET /console/api/workspaces/current/tool-provider/api/get?provider=NAME
        # → 200 + {provider, credentials, schema_type, ...} si existe
        # → 404 ou 400 sinon
        get_url = (
            f"{base}/console/api/workspaces/current/tool-provider/api/get"
            f"?provider={_AGENTS_TOOL_PROVIDER_NAME}"
        )
        existing: dict | None = None
        try:
            r = c.get(get_url)
            if r.status_code == 200:
                try:
                    existing = r.json()
                except Exception:
                    existing = None
        except Exception:
            existing = None

        # 2. Construire le payload
        credentials = {
            "auth_type": "api_key",
            "api_key_header": "Authorization",
            "api_key_value": f"Bearer {agents_api_key}",
            "api_key_header_prefix": "no_prefix",
        }
        payload = {
            "provider": _AGENTS_TOOL_PROVIDER_NAME,
            "original_provider": _AGENTS_TOOL_PROVIDER_NAME,
            "icon": {"background": "#3b82f6", "content": "🤖"},
            "credentials": credentials,
            "schema_type": "openapi",
            "schema": schema_text,
            "privacy_policy": "",
            "custom_disclaimer": "Service interne AI Box. Bearer token requis.",
            "labels": ["agents", "aibox"],
        }

        # 3. POST sur l'endpoint correspondant.
        # Endpoints capturés Dify 1.10 :
        #   POST /console/api/workspaces/current/tool-provider/api/add
        #   POST /console/api/workspaces/current/tool-provider/api/update
        if existing:
            ep = "/console/api/workspaces/current/tool-provider/api/update"
            payload["original_provider"] = (
                existing.get("original_provider")
                or existing.get("provider")
                or _AGENTS_TOOL_PROVIDER_NAME
            )
            action = "update"
        else:
            ep = "/console/api/workspaces/current/tool-provider/api/add"
            action = "create"

        try:
            r = c.post(f"{base}{ep}", json=payload)
            if r.status_code in (200, 201):
                return {
                    "ok": True,
                    "action": action,
                    "provider": _AGENTS_TOOL_PROVIDER_NAME,
                    "endpoint": ep,
                }
            return {
                "ok": False,
                "action": action,
                "endpoint": ep,
                "error": f"HTTP {r.status_code} : {r.text[:300]}",
            }
        except Exception as e:
            return {"ok": False, "action": action, "endpoint": ep, "error": str(e)}
    finally:
        c.close()


# ---------------------------------------------------------------------------
# Dify : provisioning du Custom Tool « BoxIA Concierge Tools »
# ---------------------------------------------------------------------------
# Le concierge orchestre l'admin BoxIA depuis le chat (active connecteurs,
# installe workflows/agents, vérifie le healthcheck). Le Custom Tool
# pointe vers /api/agents-tools/* sur aibox-app via host.docker.internal.

_CONCIERGE_TOOL_OPENAPI_PATHS = [
    "/srv/ai-stack/templates/dify/concierge-tool-openapi.yaml",
    "/app/static/concierge-tool-openapi.yaml",
]
_CONCIERGE_TOOL_PROVIDER_NAME = "BoxIA Concierge Tools"


def _load_concierge_openapi_schema() -> str:
    """Lit le YAML concierge tool depuis le repo monté."""
    import os
    for p in _CONCIERGE_TOOL_OPENAPI_PATHS:
        if os.path.isfile(p):
            try:
                return open(p, encoding="utf-8").read()
            except OSError:
                continue
    log.warning("YAML OpenAPI Concierge introuvable dans %s",
                _CONCIERGE_TOOL_OPENAPI_PATHS)
    return ""


def setup_dify_concierge_tool(env: dict[str, str]) -> dict[str, Any]:
    """Provisionne le Custom API Tool « BoxIA Concierge Tools » dans Dify.

    L'agent Concierge BoxIA (`DEFAULT_AGENTS[concierge]`) utilisera ce
    tool pour appeler /api/agents-tools/* sur aibox-app via
    `host.docker.internal:3100`. Auth = Bearer AGENTS_API_KEY.

    Idempotent : si le provider existe → update.
    """
    base = "http://aibox-dify-nginx:80"
    admin_email = env.get("ADMIN_EMAIL", "")
    admin_password = env.get("ADMIN_PASSWORD", "")
    agents_api_key = env.get("AGENTS_API_KEY", "")

    if not admin_email or not admin_password:
        return {"ok": False, "error": "ADMIN_EMAIL/ADMIN_PASSWORD manquants"}
    if not agents_api_key:
        return {"ok": False, "error": "AGENTS_API_KEY non défini dans .env"}

    schema_text = _load_concierge_openapi_schema()
    if not schema_text:
        return {"ok": False, "error": "OpenAPI YAML concierge introuvable"}

    c = _dify_console_client(base, admin_email, admin_password)
    if c is None:
        return {"ok": False, "error": "Login Dify console échoué"}

    try:
        # Idempotence : check si le provider existe déjà
        get_url = (
            f"{base}/console/api/workspaces/current/tool-provider/api/get"
            f"?provider={_CONCIERGE_TOOL_PROVIDER_NAME}"
        )
        existing: dict | None = None
        try:
            r = c.get(get_url)
            if r.status_code == 200:
                existing = r.json()
        except Exception:
            existing = None

        credentials = {
            "auth_type": "api_key",
            "api_key_header": "Authorization",
            "api_key_value": f"Bearer {agents_api_key}",
            "api_key_header_prefix": "no_prefix",
        }
        payload = {
            "provider": _CONCIERGE_TOOL_PROVIDER_NAME,
            "original_provider": _CONCIERGE_TOOL_PROVIDER_NAME,
            "icon": {"background": "#FEF3C7", "content": "🛎️"},
            "credentials": credentials,
            "schema_type": "openapi",
            "schema": schema_text,
            "privacy_policy": "",
            "custom_disclaimer":
                "Outils internes BoxIA. Permet à l'agent Concierge de "
                "lister/installer connecteurs, workflows, agents et MCP.",
            "labels": ["concierge", "aibox", "admin"],
        }

        if existing:
            ep = "/console/api/workspaces/current/tool-provider/api/update"
            payload["original_provider"] = (
                existing.get("original_provider")
                or existing.get("provider")
                or _CONCIERGE_TOOL_PROVIDER_NAME
            )
            action = "update"
        else:
            ep = "/console/api/workspaces/current/tool-provider/api/add"
            action = "create"

        try:
            r = c.post(f"{base}{ep}", json=payload)
            if r.status_code in (200, 201):
                return {
                    "ok": True,
                    "action": action,
                    "provider": _CONCIERGE_TOOL_PROVIDER_NAME,
                    "endpoint": ep,
                }
            return {
                "ok": False,
                "action": action,
                "endpoint": ep,
                "error": f"HTTP {r.status_code} : {r.text[:300]}",
            }
        except Exception as e:
            return {"ok": False, "action": action, "endpoint": ep, "error": str(e)}
    finally:
        c.close()


# ---------------------------------------------------------------------------
# Authentik : branding "AI Box" au lieu de "authentik" sur le login
# ---------------------------------------------------------------------------
def setup_authentik_branding(env: dict[str, str]) -> dict[str, Any]:
    """Customise le brand Authentik pour cacher la marque "authentik"
    et présenter "AI Box" au client (page de login OIDC).

    PATCH le brand par défaut (`/api/v3/core/brands/<uuid>/`) avec :
      - branding_title : "AI Box"
      - branding_custom_css : cache le logo Authentik + remplace par
        un titre "AI Box"
      - (favicon / logo : on garde les SVG par défaut Authentik à défaut
        d'avoir un asset client custom dans le repo)

    Idempotent : si déjà patché, le PATCH retourne 200 sans rien changer.
    """
    token = _ak_admin_token(env)
    if not token:
        return {"ok": False, "reason": "Authentik admin token unavailable"}

    base = "http://aibox-authentik-server:9000"
    headers = {"Authorization": f"Bearer {token}"}

    try:
        with httpx.Client(timeout=10) as c:
            # 1. Récupère le brand par défaut
            r = c.get(f"{base}/api/v3/core/brands/", headers=headers)
            if r.status_code != 200:
                return {"ok": False, "step": "list",
                        "status": r.status_code, "body": r.text[:200]}
            brands = r.json().get("results", [])
            default_brand = next((b for b in brands if b.get("default")), None)
            if not default_brand:
                return {"ok": False, "error": "no default brand found"}

            brand_uuid = default_brand["brand_uuid"]

            # 2. CSS custom pour masquer le logo Authentik et afficher "AI Box"
            # On force le PATCH à chaque appel pour permettre les évolutions
            # du CSS d'être propagées (Authentik PATCH est idempotent au sens
            # « pas d'erreur si valeur identique »).
            # à la place. On cible les éléments du flow par défaut.
            custom_css = """
/* AI Box branding override — remplace "Welcome to authentik!" + logo. */

/* 1. Masque le logo Authentik dans le header de la page */
img[alt="authentik"],
.pf-c-brand img,
ak-brand-link img {
  display: none !important;
}

/* 2. Remplace le texte du H1 "Welcome to authentik!" : on cache le
      contenu (font-size:0) puis on injecte le titre AI Box via ::before. */
.pf-c-login__main-header h1,
ak-flow-executor h1 {
  font-size: 0 !important;        /* cache le contenu enfant */
  line-height: 0 !important;
}
.pf-c-login__main-header h1::before,
ak-flow-executor h1::before {
  content: "Bienvenue sur AI Box";
  display: block;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 1.5rem;
  font-weight: 600;
  line-height: 1.5;
  color: #2563eb;
}

/* 3. Remplace la marque dans le coin haut-gauche par "🤖 AI Box" */
.pf-c-brand,
ak-brand-link {
  font-size: 0 !important;
}
.pf-c-brand::before,
ak-brand-link::before {
  content: "🤖 AI Box";
  display: inline-block;
  font-size: 28px;
  font-weight: 700;
  color: #2563eb;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
""".strip()

            # 3. PATCH le brand
            payload = {
                "branding_title": "AI Box",
                "branding_custom_css": custom_css,
            }
            r = c.patch(
                f"{base}/api/v3/core/brands/{brand_uuid}/",
                headers=headers,
                json=payload,
            )
            if r.status_code in (200, 201):
                return {
                    "ok": True,
                    "brand_uuid": brand_uuid,
                    "branding_title": "AI Box",
                    "css_injected": True,
                }
            return {"ok": False, "status": r.status_code, "body": r.text[:300]}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def provision_all(env: dict[str, str], host: str) -> dict[str, Any]:
    """Exécute tous les provisioning. Renvoie un rapport par app."""
    dify_admin = setup_dify_admin(env)
    # On ne provisionne l'agent par défaut que si l'admin Dify est OK
    # (sinon le login console échouerait).
    dify_agent: dict[str, Any] = {"ok": False, "error": "skipped (admin failed)"}
    dify_tool: dict[str, Any] = {"ok": False, "error": "skipped (admin failed)"}
    dify_concierge_tool: dict[str, Any] = {"ok": False, "error": "skipped"}
    if dify_admin.get("ok"):
        # IMPORTANT — ordre des appels :
        # 1. Tools (providers Dify) AVANT les agents qui les utilisent.
        #    L'agent Concierge attache automatiquement les tools du provider
        #    « BoxIA Concierge Tools » au moment de sa configuration ; il
        #    faut donc que le provider existe déjà.
        # 2. setup_dify_default_agent (crée tous les agents, dont concierge
        #    qui récupère les tools du provider via _fetch_concierge_tools).
        dify_tool = setup_dify_agents_tool(env)
        dify_concierge_tool = setup_dify_concierge_tool(env)
        dify_agent = setup_dify_default_agent(env)

    return {
        "aibox_app":   setup_aibox_app_oidc(env, host),
        "open_webui":  setup_owui_oidc(env, host),
        "authentik_branding": setup_authentik_branding(env),
        "dify":        dify_admin,
        "dify_agent":  dify_agent,
        "dify_concierge_tool": dify_concierge_tool,
        "dify_agents_tool": dify_tool,
        # Phase D : token + groupes pour la gestion users depuis aibox-app
        "ak_management": setup_authentik_management(env),
        "n8n":         setup_n8n_owner(env, host),
        "portainer":   setup_portainer_admin(env, host),
    }
