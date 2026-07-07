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
from urllib.parse import quote

import httpx
import msal
from fastmcp import FastMCP


def _q(v: Any) -> str:
    """Encode un id (message/pièce jointe/dossier) pour un segment d'URL Graph.
    Les id Graph contiennent souvent /, + ou = → sinon 400 Bad Request."""
    return quote(str(v), safe="")

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


def _recent_one(mb: str, limit: int, unread_only: bool, folder: str) -> list[dict[str, Any]]:
    params: dict[str, Any] = {
        "$top": max(1, min(int(limit), 50)),
        "$orderby": "receivedDateTime desc",
        "$select": "id,subject,from,receivedDateTime,isRead,hasAttachments,bodyPreview",
    }
    if unread_only:
        params["$filter"] = "isRead eq false"
    # folder bien connu (inbox…) utilisable tel quel ; sinon résoudre le NOM → id
    # (nécessaire pour lire les dossiers custom de routage AI-<métier>).
    fkey = (folder or "inbox").strip()
    fref = fkey if fkey.lower() in _WELL_KNOWN else _resolve_folder_id(mb, fkey)
    data = _req("GET", f"/users/{mb}/mailFolders/{fref}/messages", params)
    out = []
    for m in data.get("value", []):
        e = _envelope(m)
        e["mailbox"] = mb
        out.append(e)
    return out


@mcp.tool
def list_recent_emails(mailbox: str = "", limit: int = 10, unread_only: bool = False,
                       folder: str = "inbox") -> list[dict[str, Any]]:
    """Liste les derniers emails M365 (enveloppes : sujet, expéditeur, date, aperçu, boîte).

    mailbox : adresse de la boîte. SI VIDE → toutes les boîtes autorisées (idéal
    pour un « compte rendu par boîte »). Sinon la boîte doit être dans l'allowlist.
    folder : inbox (défaut), sentitems, drafts, deleteditems. unread_only : non-lus.
    Lecture seule.
    """
    if not mailbox.strip():
        if not ALLOWED:
            raise RuntimeError("MSGRAPH_ALLOWED_MAILBOXES vide")
        results: list[dict[str, Any]] = []
        for mb in ALLOWED:
            try:
                results.extend(_recent_one(mb, limit, unread_only, folder))
            except Exception as exc:
                results.append({"mailbox": mb, "error": str(exc)[:160]})
        return results
    return _recent_one(_check_mailbox(mailbox), limit, unread_only, folder)


@mcp.tool
def read_email(mailbox: str, message_id: str) -> dict[str, Any]:
    """Lit un email complet (corps en texte). Lecture seule."""
    mb = _check_mailbox(mailbox)
    m = _req("GET", f"/users/{mb}/messages/{_q(message_id)}",
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
        draft = _req("POST", f"/users/{mb}/messages/{_q(reply_to_message_id)}/createReply", json_body={})
        _req("PATCH", f"/users/{mb}/messages/{_q(draft['id'])}",
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
    _req("POST", f"/users/{mb}/messages/{_q(draft_id)}/send")
    return {"sent": True, "draft_id": draft_id}


# Noms de dossiers « bien connus » Graph acceptés directement comme destination.
_WELL_KNOWN = {"inbox", "archive", "deleteditems", "junkemail", "drafts",
               "sentitems", "clutter", "conflicts", "outbox"}


def _resolve_folder_id(mb: str, name: str) -> str:
    """Résout un nom de dossier en destinationId Graph : nom bien connu tel quel,
    sinon recherche par displayName (insensible à la casse)."""
    key = (name or "").strip()
    if key.lower() in _WELL_KNOWN:
        return key.lower()
    data = _req("GET", f"/users/{mb}/mailFolders", {"$top": 100, "$select": "id,displayName"})
    for f in data.get("value", []):
        if (f.get("displayName") or "").lower() == key.lower():
            return f.get("id")
    raise RuntimeError(f"Dossier '{name}' introuvable (ni bien connu, ni par nom)")


@mcp.tool
def mark_email_read(mailbox: str, message_id: str, read: bool = True) -> dict[str, Any]:
    """Marque un email lu (read=True) ou non-lu (read=False). Tri léger, réversible."""
    mb = _check_mailbox(mailbox)
    _req("PATCH", f"/users/{mb}/messages/{_q(message_id)}", json_body={"isRead": bool(read)})
    return {"ok": True, "mailbox": mb, "id": message_id, "read": bool(read)}


@mcp.tool
def create_mail_folder(mailbox: str, name: str) -> dict[str, Any]:
    """Crée un dossier à la racine de la boîte (idempotent : renvoie l'existant si déjà là).
    Sert au dispatcher pour créer les dossiers de routage AI-<métier>. Action mutative."""
    mb = _check_mailbox(mailbox)
    # idempotent : cherche d'abord un dossier de même nom
    data = _req("GET", f"/users/{mb}/mailFolders", {"$top": 100, "$select": "id,displayName"})
    for f in data.get("value", []):
        if (f.get("displayName") or "").lower() == name.strip().lower():
            return {"created": False, "exists": True, "id": f.get("id"), "name": f.get("displayName")}
    res = _req("POST", f"/users/{mb}/mailFolders", json_body={"displayName": name})
    return {"created": True, "id": res.get("id"), "name": res.get("displayName")}


@mcp.tool
def move_email(mailbox: str, message_id: str, target_folder: str) -> dict[str, Any]:
    """Déplace un email vers un dossier (tri automatique). Réversible.

    target_folder : nom bien connu (archive, deleteditems, junkemail…) OU nom exact
    d'un dossier existant de la boîte (résolu automatiquement).
    """
    mb = _check_mailbox(mailbox)
    dest = _resolve_folder_id(mb, target_folder)
    res = _req("POST", f"/users/{mb}/messages/{_q(message_id)}/move", json_body={"destinationId": dest})
    return {"ok": True, "mailbox": mb, "id": res.get("id", message_id), "moved_to": target_folder}


# --- Pièces jointes (pour le module factures fournisseurs) ---
# Les octets ne transitent PAS par le LLM : on écrit la PJ dans un dossier
# partagé du serveur et on renvoie son CHEMIN (+ le texte extrait si PDF).
# Les connecteurs msfiles/odoo lisent ce chemin pour uploader/attacher.
_ATT_DIR = os.getenv("AIBOX_ATT_DIR", "/tmp/aibox_attachments")


def _pdf_text(path: str, max_chars: int = 12000) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(path)
        parts = []
        for pg in reader.pages[:15]:
            parts.append(pg.extract_text() or "")
        return ("\n".join(parts)).strip()[:max_chars]
    except Exception as e:
        return f"(extraction PDF impossible: {str(e)[:120]})"


@mcp.tool
def list_attachments(mailbox: str, message_id: str) -> list[dict[str, Any]]:
    """Liste les pièces jointes d'un email (id, nom, type, taille). Lecture seule."""
    mb = _check_mailbox(mailbox)
    data = _req("GET", f"/users/{mb}/messages/{_q(message_id)}/attachments",
                {"$select": "id,name,contentType,size"})
    return [{"id": a.get("id"), "name": a.get("name"),
             "content_type": a.get("contentType"), "size": a.get("size")}
            for a in data.get("value", [])]


@mcp.tool
def save_attachment(mailbox: str, message_id: str, attachment_id: str) -> dict[str, Any]:
    """Télécharge une pièce jointe sur le serveur (dossier partagé) et renvoie son
    CHEMIN LOCAL (pas les octets) + le texte extrait si c'est un PDF. À utiliser
    avec upload_local_file (msfiles) et attach_file (odoo) pour classer une facture.
    """
    import base64
    mb = _check_mailbox(mailbox)
    a = _req("GET", f"/users/{mb}/messages/{_q(message_id)}/attachments/{_q(attachment_id)}")
    b64 = a.get("contentBytes")
    if not b64:
        raise RuntimeError("Pièce jointe sans contenu (type non-fichier ?)")
    os.makedirs(_ATT_DIR, exist_ok=True)
    name = (a.get("name") or "piece_jointe").replace("/", "_").replace("\\", "_")
    # nom déterministe (évite les collisions entre mails) : <msgid court>_<nom>
    safe = f"{str(message_id)[-8:]}_{name}"
    path = os.path.join(_ATT_DIR, safe)
    with open(path, "wb") as f:
        f.write(base64.b64decode(b64))
    out = {"path": path, "name": a.get("name"), "content_type": a.get("contentType"),
           "size": a.get("size")}
    if (a.get("name") or "").lower().endswith(".pdf") or "pdf" in (a.get("contentType") or "").lower():
        out["pdf_text"] = _pdf_text(path)
    return out


if __name__ == "__main__":
    mcp.run()
