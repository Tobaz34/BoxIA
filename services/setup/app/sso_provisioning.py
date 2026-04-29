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

        # Application liée
        r = c.get(f"{base}/core/applications/", params={"slug": app_slug})
        r.raise_for_status()
        existing_apps = r.json().get("results", [])

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
            r = c.patch(f"{base}/core/applications/{existing_apps[0]['slug']}/", json=app_payload)
        else:
            r = c.post(f"{base}/core/applications/", json=app_payload)
        r.raise_for_status()

        return {
            "client_id": provider["client_id"],
            "client_secret": provider["client_secret"],
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
    return {
        "open_webui": setup_owui_oidc(env, host),
        "dify":       setup_dify_admin(env),
        "n8n":        setup_n8n_owner(env, host),
        "portainer":  setup_portainer_admin(env, host),
        "uptime_kuma": setup_uptime_kuma_admin(env, host),
    }
