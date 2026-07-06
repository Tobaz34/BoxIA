"""AI Box — serveur MCP email IMAP/SMTP via himalaya (CLI).

Pour les boîtes IMAP/SMTP classiques qui ne passent NI par Graph NI par EWS —
ici Gmail (clikinfo34@gmail.com) et RideQuest (contact@ridequest.fr). On
enveloppe le binaire `himalaya` (v1.x) déjà configuré sur le serveur
(~/.config/himalaya/config.toml ; mots de passe dans des fichiers .pass 600,
jamais dans la config ni ici).

Multi-comptes : chaque outil prend `account` (gmail|ridequest). Pour la liste,
account="" itère TOUS les comptes (HIMALAYA_ACCOUNTS).

Interface alignée sur email-msgraph / email-ews (mêmes verbes) pour que l'agent
traite les 6 boîtes de façon uniforme :
  health / list_recent_emails / read_email / list_mail_folders /
  create_draft_email / send_draft_email  (+ tri : move_email / mark_email_read)

Sécurité : `create_draft_email` (.*_create.*) et `send_draft_email` (.*_send.*)
matchent AIBOX_MUTATING_TOOLS_REGEX → approval-gate. move/mark_read sont
réversibles et non gated (tri auto fluide).

Env :
  HIMALAYA_BIN       chemin du binaire (def: auto / ~/.local/bin/himalaya)
  HIMALAYA_CONFIG    chemin config.toml explicite (def: config par défaut du HOME)
  HIMALAYA_ACCOUNTS  csv des comptes (def: "gmail,ridequest")

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import make_msgid
from typing import Any

from fastmcp import FastMCP

mcp = FastMCP("himalaya")

HIMALAYA = (os.getenv("HIMALAYA_BIN") or shutil.which("himalaya")
            or "/home/clikinfo/.local/bin/himalaya")
CONFIG = os.getenv("HIMALAYA_CONFIG", "")
ACCOUNTS = [a.strip() for a in os.getenv("HIMALAYA_ACCOUNTS", "gmail,ridequest").split(",") if a.strip()]

# Dossiers logiques (les alias himalaya de la config résolvent le vrai nom IMAP).
DRAFTS = "drafts"
TRASH = "trash"


def _run(args: list[str], stdin: bytes | None = None, timeout: int = 90) -> subprocess.CompletedProcess:
    """Lance himalaya. -c (config) est une option PAR sous-commande en v1.x :
    on l'insère juste après la 1re sous-commande (args[0])."""
    cmd = [HIMALAYA]
    if CONFIG and args:
        cmd += [args[0], "-c", CONFIG] + args[1:]
    else:
        cmd += args
    return subprocess.run(cmd, input=stdin, capture_output=True, timeout=timeout)


def _json(args: list[str], timeout: int = 90) -> Any:
    """Lance une commande himalaya en sortie JSON (stdout only ; les WARN vont en stderr).

    IMPORTANT : `args` DOIT déjà contenir `-o json` AVANT toute requête (la query
    de `envelope list` est variadique et absorberait un `-o json` placé après)."""
    p = _run(args, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[:400] or "himalaya a échoué")
    out = p.stdout.decode("utf-8", "replace").strip()
    return json.loads(out) if out else []


def _accounts_arg(account: str) -> list[str]:
    if not account:
        raise RuntimeError(f"account requis (un parmi : {', '.join(ACCOUNTS)})")
    if account not in ACCOUNTS:
        raise RuntimeError(f"compte inconnu '{account}' (connus : {', '.join(ACCOUNTS)})")
    return ["-a", account]


def _envelope(e: dict[str, Any], account: str) -> dict[str, Any]:
    frm = e.get("from") or {}
    flags = e.get("flags") or []
    return {
        "id": str(e.get("id", "")),
        "account": account,
        "subject": e.get("subject") or "(sans objet)",
        "from": frm.get("addr") or frm.get("name") or "",
        "from_name": frm.get("name") or "",
        "date": e.get("date"),
        "is_read": "Seen" in flags or "seen" in flags,
        "has_attachment": bool(e.get("has_attachment")),
    }


@mcp.tool
def himalaya_email_health() -> dict[str, Any]:
    """Vérifie que himalaya répond et liste les comptes IMAP/SMTP configurés (Gmail, RideQuest)."""
    accts = _json(["account", "list", "-o", "json"])
    names = [a.get("name") for a in accts] if isinstance(accts, list) else ACCOUNTS
    return {"ok": True, "bin": HIMALAYA, "accounts": names}


def _list_one(account: str, limit: int, unread_only: bool, folder: str) -> list[dict[str, Any]]:
    n = max(1, min(int(limit), 50))
    # On NE PASSE PAS par la requête serveur `not flag seen` : sur Gmail l'IMAP
    # SEARCH renvoie des réponses non-standard qui font boucler/échouer himalaya.
    # On sur-échantillonne les enveloppes récentes puis on filtre les non-lus
    # côté client (flag "Seen" absent) — rapide et uniforme sur tous les comptes.
    fetch = min(50, n * 5) if unread_only else n
    args = ["envelope", "list", "-a", account, "-f", folder or "inbox", "-s", str(fetch), "-o", "json"]
    try:
        env = _json(args)
    except Exception as e:
        return [{"account": account, "error": str(e)}]
    rows = [_envelope(x, account) for x in (env or [])]
    if unread_only:
        rows = [r for r in rows if not r["is_read"]]
    return rows[:n]


@mcp.tool
def list_recent_emails(account: str = "", limit: int = 10, unread_only: bool = False,
                       folder: str = "inbox") -> list[dict[str, Any]]:
    """Liste les derniers emails (enveloppes : id, sujet, expéditeur, date, lu/non-lu, compte).

    account : gmail | ridequest. Vide = TOUTES les boîtes IMAP.
    unread_only : ne renvoyer que les non-lus. folder : inbox (défaut), sent, drafts…
    Lecture seule.
    """
    targets = [account] if account else ACCOUNTS
    out: list[dict[str, Any]] = []
    for a in targets:
        out += _list_one(a, limit, unread_only, folder)
    return out


@mcp.tool
def read_email(account: str, message_id: str, folder: str = "inbox") -> dict[str, Any]:
    """Lit un email complet (corps texte). account = gmail|ridequest, folder = dossier. Lecture seule."""
    _accounts_arg(account)
    p = _run(["message", "read", str(message_id), "-a", account, "-f", folder or "inbox", "--no-headers"])
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[:400])
    body = p.stdout.decode("utf-8", "replace")
    return {"account": account, "id": str(message_id), "folder": folder or "inbox", "body": body[:20000]}


@mcp.tool
def list_mail_folders(account: str) -> list[dict[str, Any]]:
    """Liste les dossiers d'un compte (nom). account = gmail|ridequest. Lecture seule."""
    _accounts_arg(account)
    folders = _json(["folder", "list", "-a", account, "-o", "json"])
    out = []
    for f in (folders or []):
        if isinstance(f, dict):
            out.append({"name": f.get("name"), "desc": f.get("desc", "")})
        else:
            out.append({"name": str(f)})
    return out


def _orig_message_id(account: str, item_id: str, folder: str) -> str:
    """Récupère le Message-ID d'un mail (pour le threading d'une réponse)."""
    try:
        p = _run(["message", "export", str(item_id), "-a", account, "-f", folder or "inbox"])
        if p.returncode == 0 and p.stdout:
            msg = BytesParser().parsebytes(p.stdout)
            return msg.get("Message-ID", "") or ""
    except Exception:
        pass
    return ""


def _build_raw(account: str, to: str, subject: str, body: str,
               in_reply_to: str = "") -> bytes:
    m = EmailMessage()
    m["To"] = to
    m["Subject"] = subject
    m["Message-ID"] = make_msgid()
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
        m["References"] = in_reply_to
    m.set_content(body)
    return m.as_bytes()


@mcp.tool
def create_draft_email(account: str, to: str, subject: str, body: str,
                       reply_to_item_id: str = "", reply_in_folder: str = "inbox") -> dict[str, Any]:
    """Crée un BROUILLON dans la boîte (rien n'est envoyé). Action mutative → approval-gate.

    account = gmail|ridequest. reply_to_item_id : si fourni, sujet préfixé « RE: » et
    threading conservé (In-Reply-To). reply_in_folder : dossier du mail d'origine.
    Renvoie draft_id (utilisable par send_draft_email).
    """
    _accounts_arg(account)
    subj = subject
    in_reply_to = ""
    if reply_to_item_id:
        if not subj.lower().startswith("re:"):
            subj = f"RE: {subject}"
        in_reply_to = _orig_message_id(account, reply_to_item_id, reply_in_folder)
    raw = _build_raw(account, to, subj, body, in_reply_to)
    p = _run(["message", "save", "-a", account, "-f", DRAFTS], stdin=raw)
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[:400])
    # Récupère l'id du brouillon fraîchement créé (le plus récent au sujet identique).
    draft_id = ""
    try:
        env = _json(["envelope", "list", "-a", account, "-f", DRAFTS, "-s", "10", "-o", "json"])
        for e in (env or []):
            if (e.get("subject") or "") == subj:
                draft_id = str(e.get("id")); break
    except Exception:
        pass
    return {"account": account, "draft_id": draft_id, "folder": DRAFTS, "subject": subj, "to": to}


@mcp.tool
def send_draft_email(account: str, draft_id: str) -> dict[str, Any]:
    """ENVOIE un brouillon existant (par son id) puis le retire des brouillons.
    Action mutative sensible → approval-gate obligatoire. account = gmail|ridequest."""
    _accounts_arg(account)
    exp = _run(["message", "export", str(draft_id), "-a", account, "-f", DRAFTS])
    if exp.returncode != 0 or not exp.stdout:
        raise RuntimeError("brouillon introuvable : " +
                           (exp.stderr or exp.stdout).decode("utf-8", "replace").strip()[:300])
    snd = _run(["message", "send", "-a", account], stdin=exp.stdout)
    if snd.returncode != 0:
        raise RuntimeError("envoi échoué : " + (snd.stderr or snd.stdout).decode("utf-8", "replace").strip()[:300])
    # Nettoie le brouillon (best-effort).
    _run(["message", "delete", str(draft_id), "-a", account, "-f", DRAFTS])
    return {"sent": True, "account": account, "draft_id": str(draft_id)}


@mcp.tool
def mark_email_read(account: str, message_id: str, folder: str = "inbox",
                    read: bool = True) -> dict[str, Any]:
    """Marque un email lu (read=True) ou non-lu (read=False). Tri léger, réversible.
    account = gmail|ridequest."""
    _accounts_arg(account)
    verb = "add" if read else "remove"
    p = _run(["flag", verb, str(message_id), "seen", "-a", account, "-f", folder or "inbox"])
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[:300])
    return {"ok": True, "account": account, "id": str(message_id), "read": read}


@mcp.tool
def move_email(account: str, message_id: str, target_folder: str,
               source_folder: str = "inbox") -> dict[str, Any]:
    """Déplace un email vers un dossier (tri automatique). Réversible.
    account = gmail|ridequest. target_folder : nom exact du dossier destination."""
    _accounts_arg(account)
    p = _run(["message", "move", target_folder, str(message_id), "-a", account, "-f", source_folder or "inbox"])
    if p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode("utf-8", "replace").strip()[:300])
    return {"ok": True, "account": account, "id": str(message_id),
            "from": source_folder or "inbox", "to": target_folder}


if __name__ == "__main__":
    mcp.run()
