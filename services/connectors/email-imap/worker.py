"""
Connecteur Email IMAP générique (OVH, Ionos, Gandi, Bluemind, etc.).

Pareil que email-msgraph mais via IMAP. Pas d'API d'écriture côté serveur
(IMAP ne permet pas vraiment de "tagger" facilement) — on stocke les digests
dans un dossier IMAP `AIBox/Tries/<categorie>` via APPEND/MOVE, ou on se
contente de générer des digests JSON consommables par Dify.

Variables :
  IMAP_HOST, IMAP_PORT (993), IMAP_USER, IMAP_PASSWORD
  IMAP_USE_TLS=true|false
  IMAP_FOLDER=INBOX
  IMAP_MOVE_TO_FOLDER=AIBox/Tries  (optionnel — créé si manquant)
  + LLM_MAIN, OLLAMA_URL, SYNC_INTERVAL_MINUTES
"""
from __future__ import annotations

import email
import imaplib
import json
import logging
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path

import httpx
from tenacity import retry, stop_after_attempt, wait_exponential

# ---- Config ----
IMAP_HOST = os.environ["IMAP_HOST"]
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
IMAP_USER = os.environ["IMAP_USER"]
IMAP_PASSWORD = os.environ["IMAP_PASSWORD"]
IMAP_USE_TLS = os.environ.get("IMAP_USE_TLS", "true").lower() == "true"
IMAP_FOLDER = os.environ.get("IMAP_FOLDER", "INBOX")
IMAP_MOVE_TO = os.environ.get("IMAP_MOVE_TO_FOLDER", "")  # vide = pas de move

TENANT_ID = os.environ.get("TENANT_ID", "default")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
LLM_MAIN = os.environ.get("LLM_MAIN", "qwen2.5:7b")
SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "10"))

STATE_DIR = Path(os.environ.get("STATE_DIR", "/data"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
LAST_UID_FILE = STATE_DIR / "last_uid.txt"
DIGESTS_DIR = STATE_DIR / "digests"
DIGESTS_DIR.mkdir(exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("email-imap")


CLASSIFY_SYSTEM = """Tu classes un email pour un employé français.
Retourne UNIQUEMENT un JSON :
{"category": "action"|"info"|"spam"|"automatique"|"perso",
 "priority": "haute"|"normale"|"basse",
 "summary": "1 phrase",
 "needs_reply": true|false,
 "key_actions": ["..."]}"""

REPLY_SYSTEM = """Rédige un brouillon de réponse pro français, ton concis et factuel.
Si info manquante : note [TBD: ...]. Ne signe pas."""


def imap_connect() -> imaplib.IMAP4:
    if IMAP_USE_TLS:
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    else:
        imap = imaplib.IMAP4(IMAP_HOST, IMAP_PORT)
    imap.login(IMAP_USER, IMAP_PASSWORD)
    return imap


def get_last_uid() -> int:
    if LAST_UID_FILE.exists():
        try:
            return int(LAST_UID_FILE.read_text().strip())
        except Exception:
            return 0
    return 0


def set_last_uid(uid: int) -> None:
    LAST_UID_FILE.write_text(str(uid))


def fetch_new_messages(imap: imaplib.IMAP4) -> list[tuple[int, dict]]:
    imap.select(f'"{IMAP_FOLDER}"')
    last = get_last_uid()
    crit = f"UID {last + 1}:*" if last > 0 else "(SINCE \"%s\")" % (
        (datetime.now(timezone.utc) - timedelta(hours=24)).strftime("%d-%b-%Y")
    )
    typ, data = imap.uid("SEARCH", None, crit)
    uids = data[0].split() if data and data[0] else []
    out: list[tuple[int, dict]] = []
    for uid_b in uids:
        uid = int(uid_b)
        typ, msg_data = imap.uid("FETCH", uid_b, "(RFC822)")
        if typ != "OK" or not msg_data or not msg_data[0]:
            continue
        msg = email.message_from_bytes(msg_data[0][1])
        out.append((uid, msg_to_dict(msg)))
    return out


def msg_to_dict(msg: email.message.Message) -> dict:
    body_text = ""
    if msg.is_multipart():
        for part in msg.walk():
            ct = part.get_content_type()
            cd = str(part.get("Content-Disposition", ""))
            if ct == "text/plain" and "attachment" not in cd:
                try:
                    body_text += part.get_payload(decode=True).decode(
                        part.get_content_charset() or "utf-8", errors="replace"
                    )
                except Exception:
                    pass
    else:
        try:
            body_text = (msg.get_payload(decode=True) or b"").decode(
                msg.get_content_charset() or "utf-8", errors="replace"
            )
        except Exception:
            body_text = msg.get_payload() or ""

    name, addr = parseaddr(msg.get("From", ""))
    try:
        rcv = parsedate_to_datetime(msg.get("Date", "")).isoformat()
    except Exception:
        rcv = datetime.now(timezone.utc).isoformat()
    return {
        "subject": str(msg.get("Subject", "")),
        "from": {"name": name, "address": addr},
        "received_at": rcv,
        "body": body_text[:6000],
    }


@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=1, max=10))
def llm_json(prompt: str, system: str) -> dict:
    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN, "prompt": prompt, "system": system,
            "format": "json", "stream": False, "options": {"temperature": 0.1},
        })
        r.raise_for_status()
        return json.loads(r.json()["response"])


def llm_text(prompt: str, system: str) -> str:
    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN, "prompt": prompt, "system": system,
            "stream": False, "options": {"temperature": 0.3},
        })
        r.raise_for_status()
        return r.json()["response"].strip()


def process(uid: int, msg: dict) -> None:
    prompt = (
        f"Sujet: {msg['subject']}\n"
        f"Expéditeur: {msg['from'].get('name')} <{msg['from'].get('address')}>\n"
        f"Reçu: {msg['received_at']}\n\n"
        f"Corps:\n{msg['body']}\n"
    )
    classification = llm_json(prompt, CLASSIFY_SYSTEM)
    reply = ""
    if classification.get("needs_reply"):
        actions = ", ".join(classification.get("key_actions", []))
        reply = llm_text(
            f"Email reçu de {msg['from'].get('name')}:\n"
            f"Sujet: {msg['subject']}\n\n{msg['body']}\n\n"
            f"Points à adresser: {actions or 'répondre au fond'}\n\n"
            "Rédige le brouillon.",
            REPLY_SYSTEM,
        )

    payload = {
        "uid": uid,
        "subject": msg["subject"],
        "from": msg["from"],
        "received_at": msg["received_at"],
        "classification": classification,
        "suggested_reply": reply,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    (DIGESTS_DIR / f"{uid}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def sync_once() -> dict:
    imap = imap_connect()
    try:
        msgs = fetch_new_messages(imap)
        if not msgs:
            return {"processed": 0}
        max_uid = get_last_uid()
        for uid, m in msgs:
            try:
                process(uid, m)
                if uid > max_uid:
                    max_uid = uid
            except Exception as e:
                log.error("process uid=%d: %s", uid, e)
        set_last_uid(max_uid)
        return {"processed": len(msgs), "last_uid": max_uid}
    finally:
        try:
            imap.close()
        except Exception:
            pass
        imap.logout()


def main() -> None:
    log.info("email-imap démarré (host=%s, user=%s, interval=%dmin)",
             IMAP_HOST, IMAP_USER, SYNC_INTERVAL_MINUTES)
    while True:
        try:
            stats = sync_once()
            log.info("=== Sync OK : %s ===", stats)
        except Exception as e:
            log.error("Sync KO : %s", e)
            log.debug(traceback.format_exc())
        time.sleep(SYNC_INTERVAL_MINUTES * 60)


if __name__ == "__main__":
    sys.exit(main())
