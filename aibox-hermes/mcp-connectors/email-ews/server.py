"""AI Box — serveur MCP email Exchange on-premise (EWS, NTLM).

Pour les boîtes hébergées sur un Exchange on-premise qui n'expose NI IMAP/SMTP
NI Microsoft Graph (cloud only), mais seulement EWS (Exchange Web Services) en
NTLM — cas de a.ladurelle@xefi.fr (outlook.xefi.fr, ports 993/587 fermés,
/EWS/Exchange.asmx en 401 Negotiate/NTLM).

Mono-boîte : les identifiants sont ceux du compte lui-même (accès délégué à sa
propre boîte). Pas d'allowlist tenant-wide comme email-msgraph — un jeu
d'identifiants = une boîte.

Sécurité : lecture + brouillons par défaut ; `send_draft_email` est nommé pour
matcher AIBOX_MUTATING_TOOLS_REGEX (.*_send.*) → approval-gate.

Env :
  EWS_ENDPOINT   URL EWS (def: https://outlook.xefi.fr/EWS/Exchange.asmx)
  EWS_EMAIL      adresse SMTP principale de la boîte
  EWS_USERNAME   login NTLM (souvent = EWS_EMAIL ; sinon DOMAINE\\user)
  EWS_PASSWORD   mot de passe
  EWS_VERIFY_TLS "1" pour vérifier le certificat (def: 0 — cert interne toléré)

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
"""
from __future__ import annotations

import os
import warnings
from typing import Any

warnings.filterwarnings("ignore")

from fastmcp import FastMCP

mcp = FastMCP("email-ews")

ENDPOINT = os.getenv("EWS_ENDPOINT", "https://outlook.xefi.fr/EWS/Exchange.asmx")
EMAIL = os.getenv("EWS_EMAIL", "")
USERNAME = os.getenv("EWS_USERNAME", "") or EMAIL
PASSWORD = os.getenv("EWS_PASSWORD", "")
VERIFY_TLS = os.getenv("EWS_VERIFY_TLS", "0") == "1"

_account = None


def _acct():
    global _account
    if _account is not None:
        return _account
    if not (EMAIL and USERNAME and PASSWORD):
        raise RuntimeError("EWS_EMAIL / EWS_USERNAME / EWS_PASSWORD manquants")
    from exchangelib import Credentials, Account, Configuration, DELEGATE, NTLM
    from exchangelib.protocol import BaseProtocol, NoVerifyHTTPAdapter
    if not VERIFY_TLS:
        BaseProtocol.HTTP_ADAPTER_CLS = NoVerifyHTTPAdapter
    creds = Credentials(username=USERNAME, password=PASSWORD)
    cfg = Configuration(service_endpoint=ENDPOINT, credentials=creds, auth_type=NTLM)
    _account = Account(primary_smtp_address=EMAIL, config=cfg,
                       access_type=DELEGATE, autodiscover=False)
    return _account


def _folder(name: str):
    a = _acct()
    return {
        "inbox": a.inbox, "sent": a.sent, "drafts": a.drafts,
        "trash": a.trash, "junk": a.junk,
    }.get((name or "inbox").lower(), a.inbox)


def _envelope(m: Any) -> dict[str, Any]:
    sender = getattr(m, "sender", None)
    return {
        "id": m.id,
        "subject": m.subject,
        "from": getattr(sender, "email_address", None) if sender else None,
        "received": str(m.datetime_received)[:19] if m.datetime_received else None,
        "is_read": bool(getattr(m, "is_read", True)),
        "has_attachments": bool(getattr(m, "has_attachments", False)),
        "preview": (getattr(m, "text_body", None) or m.body or "")[:200],
    }


@mcp.tool
def ews_email_health() -> dict[str, Any]:
    """Vérifie l'auth EWS/NTLM et renvoie l'adresse + le nombre de mails en boîte de réception."""
    a = _acct()
    return {"ok": True, "email": EMAIL, "inbox_total": a.inbox.total_count}


@mcp.tool
def list_recent_emails(limit: int = 10, unread_only: bool = False,
                       folder: str = "inbox") -> list[dict[str, Any]]:
    """Liste les derniers emails (enveloppes : sujet, expéditeur, date, aperçu).

    folder : inbox (défaut), sent, drafts, trash, junk.
    unread_only : ne renvoyer que les non-lus. Lecture seule.
    """
    f = _folder(folder)
    qs = f.all()
    if unread_only:
        qs = qs.filter(is_read=False)
    n = max(1, min(int(limit), 50))
    return [_envelope(m) for m in qs.order_by("-datetime_received")[:n]]


@mcp.tool
def read_email(item_id: str, folder: str = "inbox") -> dict[str, Any]:
    """Lit un email complet (corps en texte). folder = dossier où il se trouve. Lecture seule."""
    m = _folder(folder).get(id=item_id)
    out = _envelope(m)
    out["to"] = [mb.email_address for mb in (m.to_recipients or [])]
    out["body"] = getattr(m, "text_body", None) or (m.body or "")
    return out


@mcp.tool
def list_mail_folders() -> list[dict[str, Any]]:
    """Liste les dossiers de la boîte (nom, non-lus, total). Lecture seule."""
    a = _acct()
    out = []
    for f in (a.inbox, a.sent, a.drafts, a.trash, a.junk):
        try:
            out.append({"name": f.name, "unread": f.unread_count, "total": f.total_count})
        except Exception:
            pass
    return out


@mcp.tool
def create_draft_email(to: str, subject: str, body: str,
                       reply_to_item_id: str = "") -> dict[str, Any]:
    """Crée un BROUILLON dans la boîte (rien n'est envoyé). Action mutative → approval-gate.

    reply_to_item_id : si fourni, le sujet est préfixé « RE: » (réponse au message).
    """
    from exchangelib import Message, Mailbox
    a = _acct()
    subj = subject
    if reply_to_item_id and not subj.lower().startswith("re:"):
        subj = f"RE: {subject}"
    m = Message(
        account=a, folder=a.drafts, subject=subj, body=body,
        to_recipients=[Mailbox(email_address=x.strip()) for x in to.split(",") if x.strip()],
    )
    m.save()
    return {"draft_id": m.id, "subject": subj, "to": to}


@mcp.tool
def send_draft_email(draft_id: str) -> dict[str, Any]:
    """ENVOIE un brouillon existant (par son id). Action mutative sensible → approval-gate obligatoire."""
    a = _acct()
    m = a.drafts.get(id=draft_id)
    m.send()
    return {"sent": True, "draft_id": draft_id}
