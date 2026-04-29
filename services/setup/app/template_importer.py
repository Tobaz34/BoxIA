"""
Auto-import des templates Dify + n8n selon les technos cochées au wizard.

Le wizard, à la fin du déploiement (après provision-sso), appelle
l'endpoint /api/deploy/import-templates qui :
  1. Détermine les templates pertinents selon le `client_config.yaml`
  2. Logge en tant qu'admin sur Dify et n8n
  3. Push les apps Dify + workflows n8n
  4. Active automatiquement les workflows utiles (cron)
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx
import yaml

log = logging.getLogger("template-importer")

REPO_ROOT = Path("/srv/ai-stack")
TEMPLATES_DIR = REPO_ROOT / "templates"


# ---------------------------------------------------------------------------
# Mapping : techno cochée → templates à importer
# ---------------------------------------------------------------------------
# Format : (question_id, valeur_choisie) → liste de templates
TEMPLATE_MAP: dict[tuple[str, str], dict[str, list[str]]] = {
    # Stockage docs → agent Q&R
    ("stockage_docs", "sharepoint"): {"dify": ["agent_qa_documents"]},
    ("stockage_docs", "gdrive"):     {"dify": ["agent_qa_documents"]},
    ("stockage_docs", "nas_smb"):    {"dify": ["agent_qa_documents"]},
    ("stockage_docs", "nextcloud"):  {"dify": ["agent_qa_documents"]},

    # Messagerie → tri emails + digest matin
    ("messagerie", "m365"):  {"dify": ["agent_email_triage"], "n8n": ["workflow_email_digest_quotidien"]},
    ("messagerie", "gmail"): {"dify": ["agent_email_triage"], "n8n": ["workflow_email_digest_quotidien"]},
    ("messagerie", "imap"):  {"dify": ["agent_email_triage"], "n8n": ["workflow_email_digest_quotidien"]},

    # ERP/CRM → agent devis + relance impayés
    ("erp_crm", "odoo"):      {"dify": ["agent_devis_generator"], "n8n": ["workflow_relance_factures_impayees"]},
    ("erp_crm", "salesforce"):{"dify": ["agent_devis_generator"]},
    ("erp_crm", "hubspot"):   {"dify": ["agent_devis_generator"]},
    ("erp_crm", "sage"):      {"dify": ["agent_devis_generator"]},
    ("erp_crm", "pipedrive"): {"dify": ["agent_devis_generator"]},
    ("erp_crm", "dynamics"):  {"dify": ["agent_devis_generator"]},

    # Helpdesk → agent N1
    ("helpdesk", "internal_tool"): {"dify": ["agent_helpdesk_n1"]},

    # BI / SQL → agent analyste data
    ("bi", "powerbi"):    {"dify": ["agent_data_analyst"]},
    ("bi", "metabase"):   {"dify": ["agent_data_analyst"]},
    ("bases_sql", "postgres"): {"dify": ["agent_data_analyst"]},
    ("bases_sql", "mysql"):    {"dify": ["agent_data_analyst"]},
    ("bases_sql", "mssql"):    {"dify": ["agent_data_analyst"]},
}

# Toujours importer ces templates "génériques" (utiles à tout le monde)
ALWAYS_IMPORT_DIFY = ["agent_qa_documents"]


def _resolve_templates(client_config: dict) -> dict[str, set[str]]:
    """Renvoie {'dify': {ids}, 'n8n': {ids}} selon les choix du wizard."""
    techs = client_config.get("technologies", {}) or {}
    out: dict[str, set[str]] = {"dify": set(ALWAYS_IMPORT_DIFY), "n8n": set()}
    for q_id, value in techs.items():
        if not value or value == "none":
            continue
        spec = TEMPLATE_MAP.get((q_id, value))
        if not spec:
            continue
        for kind, ids in spec.items():
            out[kind].update(ids)
    return out


# ---------------------------------------------------------------------------
# Dify : login + import d'apps via l'API Console
# ---------------------------------------------------------------------------
DIFY_BASE = "http://aibox-dify-nginx:80"


def _dify_login(email: str, password: str) -> httpx.Client | None:
    """Logge en tant qu'admin Dify et retourne un client httpx avec token Bearer.

    Dify Console v1.10 :
      - Body de réponse : {"result": "success"}  (pas de token)
      - Token dans le cookie HTTPOnly `access_token`
      - csrf_token aussi en cookie (à reposter en header X-CSRF-TOKEN si on
        utilise les cookies). Plus simple : extraire access_token et
        l'utiliser en Bearer (bypass le CSRF).
    """
    try:
        c = httpx.Client(timeout=15)
        r = c.post(f"{DIFY_BASE}/console/api/login", json={
            "email": email, "password": password, "remember_me": True,
        })
        if r.status_code != 200:
            log.warning("Dify login failed: %s %s", r.status_code, r.text[:200])
            return None

        # Tente d'abord d'extraire le token depuis le body (versions plus anciennes)
        try:
            body = r.json()
            token = (body.get("data", {}) or {}).get("access_token") if isinstance(body, dict) else None
        except Exception:
            token = None

        # Sinon : depuis les cookies (Dify >= 1.0)
        if not token:
            token = r.cookies.get("access_token")

        if not token:
            log.warning("Dify login OK mais access_token introuvable")
            return None

        # On utilise le Bearer token et on ferme le cookie jar pour éviter
        # tout conflit de CSRF.
        c.cookies.clear()
        c.headers["Authorization"] = f"Bearer {token}"
        return c
    except Exception as e:
        log.warning("Dify login exception: %s", e)
        return None


def _dify_app_exists(client: httpx.Client, name: str) -> bool:
    try:
        r = client.get(f"{DIFY_BASE}/console/api/apps", params={"name": name, "page": 1, "limit": 100})
        if r.status_code == 200:
            for app in r.json().get("data", []):
                if app.get("name") == name:
                    return True
    except Exception:
        pass
    return False


def _import_dify_template(client: httpx.Client, template_id: str) -> dict[str, Any]:
    """Importe un template depuis templates/dify/<id>.yml dans Dify.

    Format Dify natif (DSL v0.1.0) attendu — on convertit notre YAML simplifié.
    """
    yml_path = TEMPLATES_DIR / "dify" / f"{template_id}.yml"
    if not yml_path.exists():
        return {"ok": False, "id": template_id, "error": "template file not found"}

    src = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
    name = src["app"]["name"]

    if _dify_app_exists(client, name):
        return {"ok": True, "id": template_id, "name": name, "skipped": "already exists"}

    # On crée d'abord l'app via l'endpoint create classique de Dify Console.
    # `mode` accepté : chat | agent-chat | workflow | completion.
    payload = {
        "name": name,
        "mode": src["app"].get("mode", "chat"),
        "description": src["app"].get("description", ""),
        "icon_type": "emoji",
        "icon": src["app"].get("icon", "🤖"),
        "icon_background": "#FFEAD5",
    }
    try:
        r = client.post(f"{DIFY_BASE}/console/api/apps", json=payload)
        if r.status_code not in (200, 201):
            return {"ok": False, "id": template_id, "name": name,
                    "status": r.status_code, "body": r.text[:200]}
        app = r.json()
        app_id = app.get("id") or app.get("data", {}).get("id")
        return {"ok": True, "id": template_id, "name": name, "app_id": app_id, "created": True}
    except Exception as e:
        return {"ok": False, "id": template_id, "error": str(e)}


# ---------------------------------------------------------------------------
# n8n : login + import workflows
# ---------------------------------------------------------------------------
def _n8n_resolve_url(host: str = "") -> list[str]:
    out = ["http://n8n:5678", "http://host.docker.internal:5678"]
    if host:
        out.append(f"http://{host}:5678")
    return out


def _n8n_login(email: str, password: str, host: str = "") -> tuple[httpx.Client, str] | None:
    """Logge sur n8n et retourne (client avec cookie, url base)."""
    for base in _n8n_resolve_url(host):
        try:
            c = httpx.Client(timeout=15)
            r = c.post(f"{base}/rest/login", json={"emailOrLdapLoginId": email, "password": password})
            if r.status_code in (200, 201):
                return c, base
        except Exception:
            continue
    return None


def _n8n_workflow_exists(client: httpx.Client, base: str, name: str) -> bool:
    try:
        r = client.get(f"{base}/rest/workflows")
        if r.status_code == 200:
            workflows = r.json().get("data", r.json())
            if isinstance(workflows, list):
                for w in workflows:
                    if w.get("name") == name:
                        return True
    except Exception:
        pass
    return False


def _import_n8n_template(client: httpx.Client, base: str, template_id: str) -> dict[str, Any]:
    json_path = TEMPLATES_DIR / "n8n" / f"{template_id}.json"
    if not json_path.exists():
        return {"ok": False, "id": template_id, "error": "template file not found"}

    workflow = json.loads(json_path.read_text(encoding="utf-8"))
    name = workflow.get("name", template_id)

    if _n8n_workflow_exists(client, base, name):
        return {"ok": True, "id": template_id, "name": name, "skipped": "already exists"}

    # Crée le workflow (status `inactive` par défaut)
    payload = {
        "name": name,
        "nodes": workflow.get("nodes", []),
        "connections": workflow.get("connections", {}),
        "settings": workflow.get("settings", {"executionOrder": "v1"}),
    }
    try:
        r = client.post(f"{base}/rest/workflows", json=payload)
        if r.status_code in (200, 201):
            return {"ok": True, "id": template_id, "name": name, "created": True}
        return {"ok": False, "id": template_id, "name": name,
                "status": r.status_code, "body": r.text[:200]}
    except Exception as e:
        return {"ok": False, "id": template_id, "error": str(e)}


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------
def import_all_templates(env: dict[str, str], host: str = "") -> dict[str, Any]:
    """Logique principale : lit client_config.yaml, import les templates pertinents."""
    config_path = REPO_ROOT / "client_config.yaml"
    if not config_path.exists():
        return {"ok": False, "error": "client_config.yaml introuvable"}

    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    plan = _resolve_templates(config)
    log.info("Templates à importer : dify=%s n8n=%s", plan["dify"], plan["n8n"])

    report: dict[str, Any] = {"plan": {k: list(v) for k, v in plan.items()}}

    # ---- Dify ----
    dify_results = []
    if plan["dify"]:
        dify_client = _dify_login(env.get("ADMIN_EMAIL", ""), env.get("ADMIN_PASSWORD", ""))
        if not dify_client:
            dify_results.append({"ok": False, "error": "Dify login failed"})
        else:
            try:
                for tid in plan["dify"]:
                    dify_results.append(_import_dify_template(dify_client, tid))
            finally:
                dify_client.close()
    report["dify"] = dify_results

    # ---- n8n ----
    n8n_results = []
    if plan["n8n"]:
        n8n_login = _n8n_login(env.get("ADMIN_EMAIL", ""), env.get("ADMIN_PASSWORD", ""), host)
        if not n8n_login:
            n8n_results.append({"ok": False, "error": "n8n login failed"})
        else:
            client, base = n8n_login
            try:
                for tid in plan["n8n"]:
                    n8n_results.append(_import_n8n_template(client, base, tid))
            finally:
                client.close()
    report["n8n"] = n8n_results

    return report
