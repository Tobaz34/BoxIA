"""AI Box — serveur MCP Odoo (API externe XML-RPC).

Expose un Odoo (self-hosted ou Odoo.sh) en tools MCP pour Hermes Agent, via
l'API externe XML-RPC standard (`/xmlrpc/2/common` + `/xmlrpc/2/object`).
Aucune dépendance lourde : xmlrpc.client est dans la stdlib.

Sécurité :
- Lecture par défaut ; `create_lead` / `log_note` sont nommés pour matcher
  AIBOX_MUTATING_TOOLS_REGEX (.*create.*/.*_create.*) → approval-gate.
- `odoo_search_read` est générique mais LECTURE SEULE (execute_kw + search_read).
- Les droits réels sont ceux du compte technique Odoo (ODOO_USERNAME) : limiter
  ses accès côté Odoo est la vraie barrière (principe du moindre privilège).

Env :
  ODOO_URL        ex: https://odoo.example.com  (sans / final)
  ODOO_DB         nom de la base
  ODOO_USERNAME   login du compte technique
  ODOO_API_KEY    clé API Odoo (Préférences → Sécurité du compte) ou mot de passe
  ODOO_TIMEOUT    timeout HTTP en secondes (def: 30)

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
"""
from __future__ import annotations

import os
import xmlrpc.client
from typing import Any
from urllib.parse import urlparse

from fastmcp import FastMCP

mcp = FastMCP("odoo")


def _rpc_base(url: str) -> str:
    """Base des endpoints XML-RPC = ORIGINE du domaine (scheme://host[:port]).
    L'API externe d'Odoo est toujours à la racine (/xmlrpc/2/...), même si l'UI
    est servie sous un chemin (ex: https://odoo.exemple.fr/odoo → on ignore /odoo)."""
    p = urlparse(url.strip())
    if p.scheme and p.netloc:
        return f"{p.scheme}://{p.netloc}"
    return url.strip().rstrip("/")


URL = _rpc_base(os.getenv("ODOO_URL", ""))
DB = os.getenv("ODOO_DB", "")
USERNAME = os.getenv("ODOO_USERNAME", "")
API_KEY = os.getenv("ODOO_API_KEY", "")
TIMEOUT = float(os.getenv("ODOO_TIMEOUT", "30"))

_uid = None
_models = None


def _connect():
    """Authentifie (une fois) et renvoie (uid, proxy models). Lève sur erreur."""
    global _uid, _models
    if _uid and _models is not None:
        return _uid, _models
    if not (URL and DB and USERNAME and API_KEY):
        raise RuntimeError("ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY manquants")
    common = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common", allow_none=True)
    uid = common.authenticate(DB, USERNAME, API_KEY, {})
    if not uid:
        raise RuntimeError("Authentification Odoo refusée (db / user / clé API ?)")
    _uid = uid
    _models = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/object", allow_none=True)
    return _uid, _models


def _kw(model: str, method: str, args: list, kwargs: dict | None = None) -> Any:
    uid, models = _connect()
    return models.execute_kw(DB, uid, API_KEY, model, method, args, kwargs or {})


@mcp.tool
def odoo_health() -> dict[str, Any]:
    """Vérifie la connexion à Odoo (auth + version). Renvoie l'utilisateur et la version serveur."""
    common = xmlrpc.client.ServerProxy(f"{URL}/xmlrpc/2/common", allow_none=True)
    ver = common.version()
    uid, _ = _connect()
    return {"ok": True, "url": URL, "db": DB, "uid": uid,
            "server_version": ver.get("server_version")}


@mcp.tool
def odoo_search_read(model: str, domain: list | None = None, fields: list | None = None,
                     limit: int = 20, order: str = "") -> list[dict[str, Any]]:
    """Recherche générique LECTURE SEULE sur n'importe quel modèle Odoo.

    model : nom technique (ex: 'res.partner', 'crm.lead', 'account.move').
    domain : filtre Odoo (ex: [['is_company','=',True]]). Défaut : tout.
    fields : champs à renvoyer (défaut : jeu raisonnable). limit : max 200.
    """
    kwargs: dict[str, Any] = {"limit": max(1, min(int(limit), 200))}
    if fields:
        kwargs["fields"] = fields
    if order:
        kwargs["order"] = order
    return _kw(model, "search_read", [domain or []], kwargs)


@mcp.tool
def find_partner(query: str, limit: int = 10) -> list[dict[str, Any]]:
    """Cherche un contact/société (res.partner) par nom, email ou téléphone. Lecture seule."""
    domain = ["|", "|", ["name", "ilike", query], ["email", "ilike", query], ["phone", "ilike", query]]
    return _kw("res.partner", "search_read", [domain],
               {"fields": ["name", "email", "phone", "city", "is_company", "vat"],
                "limit": max(1, min(int(limit), 50))})


@mcp.tool
def list_open_invoices(limit: int = 20) -> list[dict[str, Any]]:
    """Liste les factures clients NON payées (account.move, posté, résiduel > 0). Lecture seule."""
    domain = [["move_type", "=", "out_invoice"], ["state", "=", "posted"],
              ["payment_state", "in", ["not_paid", "partial"]]]
    return _kw("account.move", "search_read", [domain],
               {"fields": ["name", "partner_id", "invoice_date", "invoice_date_due",
                           "amount_total", "amount_residual", "payment_state"],
                "limit": max(1, min(int(limit), 100)), "order": "invoice_date_due asc"})


@mcp.tool
def list_leads(limit: int = 20, only_open: bool = True) -> list[dict[str, Any]]:
    """Liste les pistes/opportunités CRM (crm.lead). only_open = pistes actives. Lecture seule."""
    domain: list = []
    if only_open:
        domain = [["active", "=", True]]
    return _kw("crm.lead", "search_read", [domain],
               {"fields": ["name", "partner_id", "email_from", "stage_id",
                           "expected_revenue", "user_id", "create_date"],
                "limit": max(1, min(int(limit), 100)), "order": "create_date desc"})


@mcp.tool
def create_lead(name: str, contact_name: str = "", email: str = "",
                description: str = "", expected_revenue: float = 0.0) -> dict[str, Any]:
    """Crée une piste CRM (crm.lead). Action mutative → approval-gate obligatoire."""
    vals: dict[str, Any] = {"name": name}
    if contact_name:
        vals["contact_name"] = contact_name
    if email:
        vals["email_from"] = email
    if description:
        vals["description"] = description
    if expected_revenue:
        vals["expected_revenue"] = expected_revenue
    lead_id = _kw("crm.lead", "create", [vals])
    return {"created": True, "model": "crm.lead", "id": lead_id, "name": name}


@mcp.tool
def log_note(model: str, record_id: int, body: str) -> dict[str, Any]:
    """Ajoute une note interne au chatter d'un enregistrement. Action mutative → approval-gate."""
    msg_id = _kw(model, "message_post", [[record_id]], {"body": body})
    return {"posted": True, "model": model, "record_id": record_id, "message_id": msg_id}


@mcp.tool
def odoo_fields(model: str, attributes: list | None = None) -> dict[str, Any]:
    """Décrit les champs d'un modèle Odoo (fields_get) : libellé, type, requis, relation.

    À appeler AVANT un `odoo_create` pour connaître les champs obligatoires et les
    noms techniques (ex: sur 'helpdesk.ticket' ou 'sale.order'). Lecture seule.
    """
    attrs = attributes or ["string", "type", "required", "relation", "selection"]
    return _kw(model, "fields_get", [], {"attributes": attrs})


@mcp.tool
def odoo_create(model: str, values: dict) -> dict[str, Any]:
    """Crée UN enregistrement dans n'importe quel modèle Odoo. Action mutative → approval-gate.

    model : nom technique (ex: 'helpdesk.ticket', 'sale.order', 'ir.attachment').
    values : dict des champs (ex: {'name': 'Incident serveur', 'partner_id': 42}).
    Pour une pièce jointe : model='ir.attachment', values={'name','res_model','res_id',
    'datas': <base64>}. Renvoie l'id créé. Barrière réelle = droits du compte technique Odoo.
    """
    if not isinstance(values, dict) or not values:
        raise RuntimeError("values doit être un dict non vide")
    rec_id = _kw(model, "create", [values])
    return {"created": True, "model": model, "id": rec_id}


@mcp.tool
def odoo_update(model: str, record_id: int, values: dict) -> dict[str, Any]:
    """Met à jour UN enregistrement Odoo (write). Action mutative sensible → approval-gate.

    model, record_id : cible précise (un seul id — pas de mise à jour de masse).
    values : dict des champs à modifier (ex: {'stage_id': 3, 'user_id': 75}).
    """
    if not isinstance(values, dict) or not values:
        raise RuntimeError("values doit être un dict non vide")
    ok = _kw(model, "write", [[int(record_id)], values])
    return {"updated": bool(ok), "model": model, "id": int(record_id)}


@mcp.tool
def attach_file(model: str, record_id: int, local_path: str, filename: str = "") -> dict[str, Any]:
    """Joint un fichier LOCAL du serveur à un enregistrement Odoo (crée un ir.attachment
    lié). Ex: joindre le PDF d'une facture au vendor bill (account.move). Les octets ne
    passent pas par le LLM (lecture disque + base64 côté connecteur). Action mutative."""
    import os as _os, base64 as _b64
    if not _os.path.isfile(local_path):
        raise RuntimeError(f"fichier introuvable: {local_path}")
    fn = filename or _os.path.basename(local_path)
    with open(local_path, "rb") as f:
        datas = _b64.b64encode(f.read()).decode()
    att_id = _kw("ir.attachment", "create", [{
        "name": fn, "datas": datas, "res_model": model, "res_id": int(record_id)}])
    return {"attached": True, "attachment_id": att_id, "model": model,
            "record_id": int(record_id), "filename": fn}


if __name__ == "__main__":
    mcp.run()
