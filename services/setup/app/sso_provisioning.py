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
    """Récupère les UUIDs de Authentik nécessaires pour créer un Provider OIDC."""
    H = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    base = f"{AUTHENTIK_INTERNAL}/api/v3"
    out = {}
    with httpx.Client(headers=H, timeout=30) as c:
        for slug, key in [
            ("default-provider-authorization-implicit-consent", "authz_flow"),
            ("default-authentication-flow",                     "auth_flow"),
            ("default-provider-invalidation-flow",              "invalidation_flow"),
        ]:
            r = c.get(f"{base}/flows/instances/", params={"slug": slug})
            r.raise_for_status()
            res = r.json().get("results", [])
            if res:
                out[key] = res[0]["pk"]

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


def setup_aibox_app_oidc(env: dict[str, str], host: str) -> dict[str, Any]:
    """Crée le provider OIDC pour l'app principale Next.js (services/app)."""
    token = _ak_admin_token(env)
    if not token:
        return {"ok": False, "reason": "Authentik admin token unavailable"}

    domain = env.get("DOMAIN", "")
    if domain and domain != "xefia.local" and "." in domain:
        app_url = f"https://app.{domain}"
    else:
        app_url = f"http://{host}:3100"

    creds = _ak_upsert_oidc_app(
        token,
        app_name="AI Box App",
        app_slug="aibox-app",
        client_id="aibox-app",
        redirect_uris=[f"{app_url}/api/auth/callback/authentik"],
        description="Application principale AI Box (chat, agents, workflows)",
    )

    env_path = Path("/srv/ai-stack/.env")
    if env_path.exists():
        existing_secret = env.get("APP_NEXTAUTH_SECRET", "") or _gen_secret(48)
        # IMPORTANT : AUTHENTIK_APP_ISSUER doit être l'URL utilisée par le NAVIGATEUR
        # (NextAuth fait redirect côté browser). Le hostname Docker interne
        # `aibox-authentik-server` n'est pas résolvable par le browser → ERR_NAME_NOT_RESOLVED.
        if app_url.startswith("https://"):
            ak_url_browser = f"https://auth.{domain}"
        else:
            ak_url_browser = f"http://{host}:9000"
        keys = {
            "AUTHENTIK_APP_CLIENT_ID":     f"AUTHENTIK_APP_CLIENT_ID={creds['client_id']}",
            "AUTHENTIK_APP_CLIENT_SECRET": f"AUTHENTIK_APP_CLIENT_SECRET={creds['client_secret']}",
            "AUTHENTIK_APP_ISSUER":        f"AUTHENTIK_APP_ISSUER={ak_url_browser}/application/o/aibox-app/",
            "NEXTAUTH_URL":                f"NEXTAUTH_URL={app_url}",
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

    return {"ok": True, "client_id": creds["client_id"], "app_url": app_url}


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
        owui_url = f"https://chat.{domain}"
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
        return f"https://auth.{domain}/application/o/open-webui/.well-known/openid-configuration"
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

    try:
        # IMPORTANT : Dify utilise une session Flask (cookie-based) pour propager
        # `is_init_validated` entre POST /init et POST /setup. Le httpx.Client
        # garde les cookies par défaut.
        with httpx.Client(timeout=30, follow_redirects=False) as c:
            # Étape 0 : check si déjà setup
            s = c.get(f"{base}/console/api/setup")
            if s.status_code == 200 and s.json().get("step") == "finished":
                return {"ok": True, "created": False, "note": "déjà initialisé"}

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
def _dify_login(base: str, email: str, password: str) -> tuple[str, str] | None:
    """Login console Dify → renvoie (access_token, refresh_token) ou None."""
    try:
        with httpx.Client(timeout=10) as c:
            r = c.post(
                f"{base}/console/api/login",
                json={"email": email, "password": password, "language": "fr-FR",
                      "remember_me": True},
            )
            if r.status_code != 200:
                log.warning("Dify login HTTP %s : %s", r.status_code, r.text[:200])
                return None
            data = r.json().get("data", {}) or r.json()
            tok = data.get("access_token")
            rtok = data.get("refresh_token", "")
            if not tok:
                return None
            return (tok, rtok)
    except Exception as e:
        log.warning("Dify login error: %s", e)
        return None


def setup_dify_default_agent(env: dict[str, str]) -> dict[str, Any]:
    """Provisionne (ou retrouve) un agent Dify "par défaut" et renvoie sa clé API.

    Étapes :
      1. Login console avec ADMIN_EMAIL / ADMIN_PASSWORD
      2. Liste des apps existantes ; si "Assistant général" existe → réutilise
         son ID. Sinon → POST /console/api/apps pour le créer (mode=chat)
      3. POST /console/api/apps/{id}/api-keys → récupère la clé "app-..."
      4. Écrit DIFY_DEFAULT_APP_API_KEY=... dans /srv/ai-stack/.env (idempotent)

    Idempotent : si l'app existe déjà avec une clé valide, ne recrée rien.
    """
    base = "http://aibox-dify-nginx:80"
    email = env.get("ADMIN_EMAIL", "")
    pwd = env.get("ADMIN_PASSWORD", "")
    if not email or not pwd:
        return {"ok": False, "error": "ADMIN_EMAIL / ADMIN_PASSWORD requis"}

    login = _dify_login(base, email, pwd)
    if not login:
        return {"ok": False, "error": "login Dify impossible (admin pas encore créé ?)"}
    access_tok, _refresh = login
    auth_headers = {"Authorization": f"Bearer {access_tok}"}

    APP_NAME = "Assistant général"

    try:
        with httpx.Client(timeout=15, headers=auth_headers) as c:
            # 1. Cherche l'app par nom
            app_id: str | None = None
            r = c.get(f"{base}/console/api/apps", params={"page": 1, "limit": 50})
            if r.status_code == 200:
                for app in r.json().get("data", []):
                    if app.get("name") == APP_NAME:
                        app_id = app.get("id")
                        break

            # 2. Sinon, crée l'app (mode chat = chatbot simple)
            if not app_id:
                r = c.post(
                    f"{base}/console/api/apps",
                    json={
                        "name": APP_NAME,
                        "mode": "chat",
                        "icon_type": "emoji",
                        "icon": "🤖",
                        "icon_background": "#FFEAD5",
                        "description": "Assistant par défaut de la AI Box (créé automatiquement).",
                    },
                )
                if r.status_code not in (200, 201):
                    return {"ok": False, "step": "create_app",
                            "status": r.status_code, "body": r.text[:300]}
                app_id = r.json().get("id")
                if not app_id:
                    return {"ok": False, "error": "no app id returned"}

            # 3. Liste des clés API existantes ; sinon en crée une
            api_key: str | None = None
            r = c.get(f"{base}/console/api/apps/{app_id}/api-keys")
            if r.status_code == 200:
                keys = r.json().get("data", [])
                if keys:
                    # On a une clé mais Dify ne renvoie le token complet qu'à la création.
                    # Si la clé existe déjà, on doit en créer une nouvelle pour avoir le token.
                    api_key = keys[0].get("token")  # peut être tronqué (****abcd)
                    if api_key and api_key.startswith("app-") and "*" not in api_key:
                        pass  # on a la vraie clé
                    else:
                        api_key = None  # force creation

            if not api_key:
                r = c.post(f"{base}/console/api/apps/{app_id}/api-keys", json={})
                if r.status_code not in (200, 201):
                    return {"ok": False, "step": "create_key",
                            "status": r.status_code, "body": r.text[:300]}
                api_key = r.json().get("token")
                if not api_key:
                    return {"ok": False, "error": "no token returned"}

        # 4. Écrit la clé dans /srv/ai-stack/.env (montage host)
        env_path = Path("/srv/ai-stack/.env")
        if env_path.exists():
            txt = env_path.read_text()
            if "DIFY_DEFAULT_APP_API_KEY=" in txt:
                # Remplace ligne existante
                lines = []
                for line in txt.splitlines():
                    if line.startswith("DIFY_DEFAULT_APP_API_KEY="):
                        lines.append(f"DIFY_DEFAULT_APP_API_KEY={api_key}")
                    else:
                        lines.append(line)
                env_path.write_text("\n".join(lines) + "\n")
            else:
                with env_path.open("a") as f:
                    f.write(f"\nDIFY_DEFAULT_APP_API_KEY={api_key}\n")

        return {"ok": True, "app_id": app_id, "api_key_prefix": api_key[:10] + "…"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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


def setup_n8n_owner(env: dict[str, str], host: str = "") -> dict[str, Any]:
    """Crée le compte owner n8n (1er user) via leur API.

    n8n Community expose POST /rest/owner/setup pour le 1er compte.
    Essaye plusieurs URLs au cas où le DNS interne ne résoud pas (n8n peut
    être sur un réseau différent du nôtre, comme `stack_xefia_ollama_net`).
    """
    full = env.get("ADMIN_FULLNAME", "Admin").split()
    first = full[0] if full else "Admin"
    last  = " ".join(full[1:]) or "User"
    payload = {
        "email":     env.get("ADMIN_EMAIL", "admin@example.com"),
        "firstName": first,
        "lastName":  last,
        "password":  env.get("ADMIN_PASSWORD", ""),
    }

    last_err = "no candidate URL succeeded"
    for base in _resolve_n8n_url(host):
        try:
            with httpx.Client(timeout=10) as c:
                r = c.post(f"{base}/rest/owner/setup", json=payload)
                if r.status_code in (200, 201):
                    return {"ok": True, "created": True, "via": base}
                if r.status_code in (400, 403, 409):
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
    Idempotent : 409 si déjà initialisé.
    """
    payload = {
        "Username": env.get("ADMIN_USERNAME", "admin"),
        "Password": env.get("ADMIN_PASSWORD", ""),
    }
    if len(payload["Password"]) < 12:
        return {"ok": False, "error": "Portainer exige un mdp ≥ 12 caractères"}

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
    return {"ok": False, "error": last_err}


# ---------------------------------------------------------------------------
# Uptime Kuma : compte admin via Socket.IO (1er user à l'install)
# ---------------------------------------------------------------------------
def setup_uptime_kuma_admin(env: dict[str, str], host: str = "") -> dict[str, Any]:
    """Uptime Kuma utilise Socket.IO (pas REST) pour le setup, pas trivial.
    Pour le POC : on note que c'est manuel. À l'utilisateur de créer le compte
    au 1er accès avec les mêmes credentials.
    """
    return {
        "ok": True,
        "created": False,
        "note": "à créer manuellement au 1er accès (Socket.IO setup, pas d'API REST)",
        "credentials_to_use": {
            "username": env.get("ADMIN_USERNAME", ""),
            "password": "(celui du wizard)",
        },
    }


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def provision_all(env: dict[str, str], host: str) -> dict[str, Any]:
    """Exécute tous les provisioning. Renvoie un rapport par app."""
    dify_admin = setup_dify_admin(env)
    # On ne provisionne l'agent par défaut que si l'admin Dify est OK
    # (sinon le login console échouerait).
    dify_agent: dict[str, Any] = {"ok": False, "error": "skipped (admin failed)"}
    if dify_admin.get("ok"):
        dify_agent = setup_dify_default_agent(env)

    return {
        "aibox_app":   setup_aibox_app_oidc(env, host),
        "open_webui":  setup_owui_oidc(env, host),
        "dify":        dify_admin,
        "dify_agent":  dify_agent,
        "n8n":         setup_n8n_owner(env, host),
        "portainer":   setup_portainer_admin(env, host),
        "uptime_kuma": setup_uptime_kuma_admin(env, host),
    }
