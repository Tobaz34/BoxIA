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


def _dns_resolves(hostname: str) -> bool:
    """Teste si le hostname résout en IP routable (best-effort, sync)."""
    import socket
    try:
        socket.setdefaulttimeout(2)
        socket.gethostbyname(hostname)
        return True
    except Exception:
        return False


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
    prod_url = f"https://app.{domain}" if has_real_domain else None
    lan_url = f"http://{host}:3100"
    prod_resolves = bool(prod_url) and _dns_resolves(f"app.{domain}")

    redirect_uris: list[str] = [f"{lan_url}/api/auth/callback/authentik"]
    if prod_url:
        redirect_uris.append(f"{prod_url}/api/auth/callback/authentik")

    # URL utilisée par le navigateur pour les redirects login
    if prod_resolves and prod_url:
        active_app_url = prod_url
        ak_url_browser = f"https://auth.{domain}"
    else:
        active_app_url = lan_url
        ak_url_browser = f"http://{host}:9000"

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


def _set_app_default_model(c: httpx.Client, base: str, app_id: str,
                           model_name: str,
                           pre_prompt: str | None = None,
                           opening_statement: str | None = None,
                           dataset_ids: list[str] | None = None) -> dict[str, Any]:
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
        "agent_mode": {"enabled": False, "tools": []},
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
            r = c.post(
                f"{base}/console/api/apps",
                json={
                    "name": name,
                    "mode": "chat",
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

        # 3. Configure le modèle + pre_prompt + opening_statement + datasets
        cfg = _set_app_default_model(
            c, base, app_id, model_name,
            pre_prompt=agent["pre_prompt"],
            opening_statement=agent["opening_statement"],
            dataset_ids=dataset_ids,
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
        # Phase D : token + groupes pour la gestion users depuis aibox-app
        "ak_management": setup_authentik_management(env),
        "n8n":         setup_n8n_owner(env, host),
        "portainer":   setup_portainer_admin(env, host),
        "uptime_kuma": setup_uptime_kuma_admin(env, host),
    }
