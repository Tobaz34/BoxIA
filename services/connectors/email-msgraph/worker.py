"""
Email MS Graph — agent de tri + résumé + suggestion réponse pour Outlook 365.

Mode opératoire :
  1. Toutes les SYNC_INTERVAL_MINUTES, scan les emails reçus depuis le dernier run
  2. Pour chaque email :
       - Classifie via LLM (catégories: action, info, spam, automatique, perso)
       - Détecte priorité (haute / normale / basse)
       - Si action requise : génère un brouillon de réponse en français
       - Tag l'email côté Outlook avec une catégorie colorée (categories[])
       - Stocke un résumé + brouillon en JSON dans /data/digests/<message_id>.json
  3. Une fois par jour à 08:00 (configurable), génère un digest hebdo
     synthétique → pousse vers une boîte (DIGEST_TARGET_EMAIL).

Variables :
  MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET    (App Registration delegated)
  MS_USER_ID                                       (Object ID du user surveillé)
  TENANT_ID                                        (slug client)
  OLLAMA_URL, LLM_MAIN                             (default: qwen2.5:7b)
  SYNC_INTERVAL_MINUTES (default 5)
  DIGEST_TARGET_EMAIL                              (optionnel)
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from msal import ConfidentialClientApplication
from tenacity import retry, stop_after_attempt, wait_exponential

# ---- Config -----
MS_TENANT_ID = os.environ["MS_TENANT_ID"]
MS_CLIENT_ID = os.environ["MS_CLIENT_ID"]
MS_CLIENT_SECRET = os.environ["MS_CLIENT_SECRET"]
MS_USER_ID = os.environ["MS_USER_ID"]
TENANT_ID = os.environ.get("TENANT_ID", "default")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
LLM_MAIN = os.environ.get("LLM_MAIN", "qwen2.5:7b")

SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "5"))
DIGEST_TARGET_EMAIL = os.environ.get("DIGEST_TARGET_EMAIL", "")

STATE_DIR = Path(os.environ.get("STATE_DIR", "/data"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
LAST_RUN_FILE = STATE_DIR / "last_run.iso"
DIGESTS_DIR = STATE_DIR / "digests"
DIGESTS_DIR.mkdir(exist_ok=True)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("email-msgraph")

_msal = ConfidentialClientApplication(
    client_id=MS_CLIENT_ID,
    client_credential=MS_CLIENT_SECRET,
    authority=f"https://login.microsoftonline.com/{MS_TENANT_ID}",
)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=20))
def token() -> str:
    res = _msal.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in res:
        raise RuntimeError(res.get("error_description", "auth failed"))
    return res["access_token"]


def graph(method: str, path: str, **kwargs) -> dict:
    headers = kwargs.pop("headers", {})
    headers["Authorization"] = f"Bearer {token()}"
    with httpx.Client(timeout=60.0) as c:
        r = c.request(method, f"{GRAPH_BASE}{path}", headers=headers, **kwargs)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "10")))
            return graph(method, path, headers=headers, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else {}


# ---- LLM helpers ----
@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=1, max=10))
def llm_json(prompt: str, system: str = "") -> dict:
    """Appelle Ollama et force une réponse JSON (mode `format: json`)."""
    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN,
            "prompt": prompt,
            "system": system,
            "format": "json",
            "stream": False,
            "options": {"temperature": 0.1},
        })
        r.raise_for_status()
        return json.loads(r.json()["response"])


def llm_text(prompt: str, system: str = "", temperature: float = 0.3) -> str:
    with httpx.Client(base_url=OLLAMA_URL, timeout=120.0) as c:
        r = c.post("/api/generate", json={
            "model": LLM_MAIN,
            "prompt": prompt,
            "system": system,
            "stream": False,
            "options": {"temperature": temperature},
        })
        r.raise_for_status()
        return r.json()["response"].strip()


CLASSIFY_SYSTEM = """Tu es un assistant de tri d'emails pour un employé français.
Classe l'email en JSON avec les clés suivantes :
- category: "action" | "info" | "spam" | "automatique" | "perso"
- priority: "haute" | "normale" | "basse"
- summary: résumé en 1 phrase, en français
- needs_reply: bool (true si l'email attend une réponse de l'utilisateur)
- key_actions: liste de strings (actions à faire si category=action, sinon [])
Retourne UNIQUEMENT le JSON, rien d'autre."""

REPLY_SYSTEM = """Tu rédiges un brouillon de réponse pour un email professionnel français.
- Ton : poli, concis, factuel
- Pas de "j'espère que vous allez bien"
- Si tu manques d'info pour répondre, indique clairement les points à clarifier (entre crochets [TBD: ...])
- Ne signe PAS l'email
Réponds en français, format texte simple."""


def fetch_recent_emails(since: datetime) -> list[dict]:
    """Récupère les mails reçus depuis `since` (sans pagination basique pour MVP)."""
    iso = since.strftime("%Y-%m-%dT%H:%M:%SZ")
    data = graph("GET",
        f"/users/{MS_USER_ID}/mailFolders/inbox/messages",
        params={
            "$filter": f"receivedDateTime ge {iso}",
            "$orderby": "receivedDateTime desc",
            "$top": "50",
            "$select": "id,subject,from,receivedDateTime,bodyPreview,body,categories,isRead",
        },
    )
    return data.get("value", [])


def categorize_email(msg: dict) -> dict:
    body = msg.get("body", {}).get("content", "") or msg.get("bodyPreview", "")
    body = body[:4000]
    sender = msg.get("from", {}).get("emailAddress", {})
    prompt = (
        f"Sujet: {msg.get('subject', '')}\n"
        f"Expéditeur: {sender.get('name', '')} <{sender.get('address', '')}>\n"
        f"Reçu le: {msg.get('receivedDateTime', '')}\n\n"
        f"Corps:\n{body}\n"
    )
    try:
        return llm_json(prompt, system=CLASSIFY_SYSTEM)
    except Exception as e:
        log.warning("classify failed for %s: %s", msg.get("id"), e)
        return {"category": "info", "priority": "normale", "summary": "[non classé]",
                "needs_reply": False, "key_actions": []}


def draft_reply(msg: dict, classification: dict) -> str:
    if not classification.get("needs_reply"):
        return ""
    body = msg.get("body", {}).get("content", "")[:3000]
    actions = ", ".join(classification.get("key_actions", []))
    prompt = (
        f"Email reçu de {msg.get('from', {}).get('emailAddress', {}).get('name', '')}:\n"
        f"Sujet: {msg.get('subject', '')}\n\n{body}\n\n"
        f"Points à adresser dans la réponse: {actions or 'répondre au fond'}\n\n"
        f"Rédige le brouillon."
    )
    return llm_text(prompt, system=REPLY_SYSTEM)


def tag_email(msg_id: str, categories: list[str]) -> None:
    """Tague l'email côté Outlook avec les catégories (visible côté user)."""
    try:
        graph("PATCH", f"/users/{MS_USER_ID}/messages/{msg_id}",
              json={"categories": categories})
    except Exception as e:
        log.warning("tag failed: %s", e)


def store_digest(msg_id: str, payload: dict) -> None:
    (DIGESTS_DIR / f"{msg_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def process_one(msg: dict) -> dict:
    classification = categorize_email(msg)
    suggested_reply = draft_reply(msg, classification)
    cats = [f"AI-{classification['priority']}", f"AI-{classification['category']}"]
    tag_email(msg["id"], cats)
    payload = {
        "id": msg["id"],
        "subject": msg.get("subject"),
        "from": msg.get("from", {}).get("emailAddress", {}),
        "received_at": msg.get("receivedDateTime"),
        "classification": classification,
        "suggested_reply": suggested_reply,
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    store_digest(msg["id"], payload)
    return payload


def get_last_run() -> datetime:
    if LAST_RUN_FILE.exists():
        return datetime.fromisoformat(LAST_RUN_FILE.read_text().strip())
    return datetime.now(timezone.utc) - timedelta(hours=24)


def set_last_run(ts: datetime) -> None:
    LAST_RUN_FILE.write_text(ts.isoformat())


def sync_once() -> dict:
    last = get_last_run()
    log.info("=== Email sync (since %s) ===", last.isoformat())
    msgs = fetch_recent_emails(last)
    if not msgs:
        log.info("Aucun nouveau mail")
        return {"processed": 0}

    new_last = last
    processed = 0
    for m in msgs:
        try:
            received = datetime.fromisoformat(m["receivedDateTime"].replace("Z", "+00:00"))
            if received > new_last:
                new_last = received
            process_one(m)
            processed += 1
        except Exception as e:
            log.error("err on %s : %s", m.get("id"), e)
            log.debug(traceback.format_exc())

    set_last_run(new_last + timedelta(seconds=1))
    return {"processed": processed, "last_run": new_last.isoformat()}


def main() -> None:
    log.info("email-msgraph démarré (user=%s, interval=%dmin)", MS_USER_ID, SYNC_INTERVAL_MINUTES)
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
