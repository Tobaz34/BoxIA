"""AI Box — serveur MCP email Microsoft 365 (Graph API, app-only).

Expose les boîtes Exchange Online (M365) en tools MCP pour Hermes Agent.
Pourquoi Graph et pas IMAP : Microsoft a désactivé l'auth par mot de passe
en IMAP sur Exchange Online — himalaya ne peut pas s'y connecter. Le flux
client-credentials (MSAL) est headless et couvre plusieurs boîtes avec une
seule App Registration.

Sécurité :
- ALLOWLIST obligatoire (MSGRAPH_ALLOWED_MAILBOXES) : les permissions
  application Graph sont TENANT-WIDE ; ce shim refuse toute boîte hors liste.
  (Compléter côté Exchange Online par une ApplicationAccessPolicy.)
- Lecture + brouillons seulement par défaut ; `send_draft_email` est nommé
  pour matcher AIBOX_MUTATING_TOOLS_REGEX (.*_send.*) → approval-gate.

Env :
  MSGRAPH_TENANT_ID           ID du tenant Entra
  MSGRAPH_CLIENT_ID           ID de l'App Registration
  MSGRAPH_CLIENT_SECRET       secret client (App Registration)
  MSGRAPH_ALLOWED_MAILBOXES   csv des boîtes autorisées (obligatoire)
  MSGRAPH_TIMEOUT             timeout HTTP en secondes (def: 30)

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
"""
from __future__ import annotations

import os
from typing import Any

import httpx
import msal
from fastmcp import FastMCP

mcp = FastMCP("email-msgraph")

TENANT_ID = os.getenv("MSGRAPH_TENANT_ID", "")
CLIENT_ID = os.getenv("MSGRAPH_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("MSGRAPH_CLIENT_SECRET", "")
ALLOWED = [m.strip().lower() for m in os.getenv("MSGRAPH_ALLOWED_MAILBOXES", "").split(",") if m.strip()]
TIMEOUT = float(os.getenv("MSGRAPH_TIMEOUT", "30"))
GRAPH = "https://graph.microsoft.com/v1.0"

_app: msal.ConfidentialClientApplication | None = None


def _token() -> str:
    global _app
    if not (TENANT_ID and CLIENT_ID and CLIENT_SECRET):
        raise RuntimeError("MSGRAPH_TENANT_ID / MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET manquants")
    if _app is None:
        _app = msal.ConfidentialClientApplication(
            CLIENT_ID,
            authority=f"https://login.microsoftonline.com/{TENANT_ID}",
            client_credential=CLIENT_SECRET,
        )
    result = _app.acquire_token_silent(["https://graph.microsoft.com/.default"], account=None) \
        or _app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in result:
        raise RuntimeError(f"Auth Graph échouée: {result.get('error_description', result)}")
    return result["access_token"]


def _check_mailbox(mailbox: str) -> str:
    mb = mailbox.strip().lower()
    if not ALLOWED:
        raise RuntimeError("MSGRAPH_ALLOWED_MAILBOXES vide — aucune boîte autorisée")
    if mb not in ALLOWED:
        raise RuntimeError(f"Boîte '{mailbox}' hors allowlist ({', '.join(ALLOWED)})")
    return mb


def _req(method: str, path: str, params: dict[str, Any] | None = None,
         json_body: dict[str, Any] | None = None) -> Any:
    url = f"{GRAPH}{path}"
    headers = {"Authorization": f"Bearer {_token()}", "Accept": "application/json"}
    with httpx.Client(timeout=TIMEOUT, headers=headers) as c:
        r = c.request(method, url, params=params or None, json=json_body)
        r.raise_for_status()
        return r.json() if r.content else {}


def _envelope(m: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": m.get("id"),
        "subject": m.get("subject"),
        "from": ((m.get("from") or {}).get("emailAddress") or {}).get("address"),
        "received": m.get("receivedDateTime"),
        "is_read": m.get("isRead"),
        "has_attachments": m.get("hasAttachments"),
        "preview": (m.get("bodyPreview") or "")[:200],
    }


@mcp.tool
def msgraph_email_health() -> dict[str, Any]:
    """Vérifie l'auth Microsoft Graph et liste les boîtes mail autorisées."""
    _token()
    return {"ok": True, "allowed_mailboxes": ALLOWED}


@mcp.tool
def list_recent_emails(mailbox: str, limit: int = 10, unread_only: bool = False,
                       folder: str = "inbox") -> list[dict[str, Any]]:
    """Liste les derniers emails d'une boîte M365 (enveloppes : sujet, expéditeur, date, aperçu).

    mailbox : adresse de la boîte (doit être dans l'allowlist).
    folder : inbox (défaut), sentitems, drafts, deleteditems, ou l'id d'un dossier.
    unread_only : ne renvoyer que les non-lus. Lecture seule.
    """
    mb = _check_mailbox(mailbox)
    params: dict[str, Any] = {
        "$top": max(1, min(int(limit), 50)),
        "$orderby": "receivedDateTime desc",
        "$select": "id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview",
    }
    if unread_only:
        params["$filter"] = "isRead eq false"
    data = _req("GET", f"/users/{mb}/mailFolders/{folder}/messages", params)
    return [_envelope(m) for m in data.get("value", [])]


@mcp.tool
def read_email(mailbox: str, message_id: str) -> dict[str, Any]:
    """Lit un email complet (corps en texte). Lecture seule."""
    mb = _check_mailbox(mailbox)
    m = _req("GET", f"/users/{mb}/messages/{message_id}",
             {"$select": "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments"})
    body = (m.get("body") or {})
    out = _envelope(m)
    out["to"] = [((r.get("emailAddress") or {}).get("address")) for r in m.get("toRecipients", [])]
    out["body"] = body.get("content", "")
    out["body_type"] = body.get("contentType", "text")
    return out


@mcp.tool
def list_mail_folders(mailbox: str) -> list[dict[str, Any]]:
    """Liste les dossiers d'une boîte M365 (nom, nombre de non-lus). Lecture seule."""
    mb = _check_mailbox(mailbox)
    data = _req("GET", f"/users/{mb}/mailFolders", {"$top": 50})
    return [{"id": f.get("id"), "name": f.get("displayName"),
             "unread": f.get("unreadItemCount"), "total": f.get("totalItemCount")}
            for f in data.get("value", [])]


@mcp.tool
def create_draft_email(mailbox: str, to: str, subject: str, body: str,
                       reply_to_message_id: str = "") -> dict[str, Any]:
    """Crée un BROUILLON dans la boîte (rien n'est envoyé). Action mutative → approval-gate.

    reply_to_message_id : si fourni, crée un brouillon de RÉPONSE à ce message.
    """
    mb = _check_mailbox(mailbox)
    if reply_to_message_id:
        draft = _req("POST", f"/users/{mb}/messages/{reply_to_message_id}/createReply", json_body={})
        _req("PATCH", f"/users/{mb}/messages/{draft['id']}",
             json_body={"body": {"contentType": "Text", "content": body}})
        return {"draft_id": draft["id"], "type": "reply", "subject": draft.get("subject")}
    draft = _req("POST", f"/users/{mb}/messages", json_body={
        "subject": subject,
        "body": {"contentType": "Text", "content": body},
        "toRecipients": [{"emailAddress": {"address": a.strip()}} for a in to.split(",") if a.strip()],
    })
    return {"draft_id": draft["id"], "type": "new", "subject": subject}


@mcp.tool
def send_draft_email(mailbox: str, draft_id: str) -> dict[str, Any]:
    """ENVOIE un brouillon existant. Action mutative sensible → approval-gate obligatoire."""
    mb = _check_mailbox(mailbox)
    _req("POST", f"/users/{mb}/messages/{draft_id}/send")
    return {"sent": True, "draft_id": draft_id}
