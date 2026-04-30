"""
Helpdesk GLPI — wrapper de l'API REST GLPI consommable par Dify.

Endpoints :
  GET  /healthz
  GET  /tickets?status=&assigned_to=&limit=
  GET  /tickets/{id}
  POST /tickets             {title, content, urgency?, requester_id?}
  POST /tickets/{id}/reply  {content, private?}

Auth GLPI :
  - App-Token : token applicatif (à créer côté GLPI Admin)
  - User-Token : token utilisateur de l'agent IA (créer un user dédié 'aibox')
"""
from __future__ import annotations

import logging
import os
from typing import Annotated

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

GLPI_URL = os.environ["GLPI_URL"].rstrip("/")
GLPI_APP_TOKEN = os.environ["GLPI_APP_TOKEN"]
GLPI_USER_TOKEN = os.environ["GLPI_USER_TOKEN"]
TOOL_API_KEY = os.environ["GLPI_TOOL_API_KEY"]

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("helpdesk-glpi")

app = FastAPI(title="AI Box — GLPI Tool", version="0.1.0")
_session_token: str | None = None


def init_session() -> str:
    global _session_token
    with httpx.Client(timeout=15.0) as c:
        r = c.get(
            f"{GLPI_URL}/apirest.php/initSession",
            headers={
                "App-Token": GLPI_APP_TOKEN,
                "Authorization": f"user_token {GLPI_USER_TOKEN}",
            },
        )
        r.raise_for_status()
        _session_token = r.json()["session_token"]
        return _session_token


def session_token() -> str:
    return _session_token or init_session()


def call(method: str, path: str, **kwargs) -> dict:
    headers = kwargs.pop("headers", {})
    headers.update({
        "App-Token": GLPI_APP_TOKEN,
        "Session-Token": session_token(),
    })
    with httpx.Client(timeout=30.0) as c:
        r = c.request(method, f"{GLPI_URL}/apirest.php{path}", headers=headers, **kwargs)
        if r.status_code == 401:
            init_session()
            headers["Session-Token"] = session_token()
            r = c.request(method, f"{GLPI_URL}/apirest.php{path}", headers=headers, **kwargs)
        r.raise_for_status()
        return r.json() if r.content else {}


def auth(authorization: str | None) -> None:
    if not authorization or authorization.removeprefix("Bearer ").strip() != TOOL_API_KEY:
        raise HTTPException(401, "Auth required")


@app.get("/healthz")
def healthz() -> dict:
    try:
        init_session()
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.get("/tickets")
def list_tickets(
    status: str | None = None,
    assigned_to: int | None = None,
    limit: int = 20,
    authorization: Annotated[str | None, Header()] = None,
) -> list[dict]:
    auth(authorization)
    params = {"range": f"0-{limit - 1}", "expand_dropdowns": "true"}
    # GLPI status: 1=New, 2=Pending, 3=Solved, 4=Closed, 5=Open, 6=Waiting
    if status:
        params["searchText[status]"] = status
    if assigned_to:
        params["searchText[users_id_assign]"] = str(assigned_to)
    return call("GET", "/Ticket", params=params)


class TicketCreate(BaseModel):
    title: str
    content: str
    urgency: int = 3   # 1=very low, 5=very high
    requester_id: int | None = None


@app.post("/tickets")
def create_ticket(
    body: TicketCreate,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    auth(authorization)
    payload = {"input": {"name": body.title, "content": body.content, "urgency": body.urgency}}
    if body.requester_id:
        payload["input"]["_users_id_requester"] = body.requester_id
    res = call("POST", "/Ticket", json=payload)
    return res


class TicketReply(BaseModel):
    content: str
    private: bool = False


@app.post("/tickets/{ticket_id}/reply")
def reply_ticket(
    ticket_id: int,
    body: TicketReply,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    auth(authorization)
    payload = {"input": {
        "tickets_id": ticket_id,
        "content": body.content,
        "is_private": 1 if body.private else 0,
    }}
    return call("POST", "/TicketFollowup", json=payload)


@app.get("/tickets/{ticket_id}")
def get_ticket(
    ticket_id: int,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    auth(authorization)
    return call("GET", f"/Ticket/{ticket_id}", params={"expand_dropdowns": "true"})


# ===========================================================================
# Use case "tickets en retard SLA"
# ===========================================================================

@app.get("/tickets/sla_overdue")
def list_sla_overdue(
    days: int = 7,
    authorization: Annotated[str | None, Header()] = None,
) -> list[dict]:
    """Tickets ouverts (status 1=New, 2=Pending, 5=Open, 6=Waiting) plus vieux que N jours.

    GLPI ne fournit pas de "SLA breached" en API simple — on calcule avec date d'ouverture.
    Pour vraie SLA breach, utiliser searchOptions[SLA].
    """
    from datetime import datetime, timedelta
    cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
    # GLPI search v2 : criteria
    params = {
        "range": "0-49",
        "expand_dropdowns": "true",
        "criteria[0][link]": "AND",
        "criteria[0][field]": "12",  # status
        "criteria[0][searchtype]": "morethan",
        "criteria[0][value]": "0",
        # Filtrer status ouverts (1, 2, 5, 6 — pas 3=Solved, 4=Closed)
        "criteria[1][link]": "AND",
        "criteria[1][field]": "12",
        "criteria[1][searchtype]": "lessthan",
        "criteria[1][value]": "3",
        # Date opening avant cutoff
        "criteria[2][link]": "AND",
        "criteria[2][field]": "15",  # date opening
        "criteria[2][searchtype]": "lessthan",
        "criteria[2][value]": cutoff,
    }
    res = call("GET", "/search/Ticket", params=params)
    if not isinstance(res, dict):
        return []
    return res.get("data", [])


@app.get("/searchOptions")
def search_options(
    item_type: str = "Ticket",
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """Renvoie la liste des champs searchables par GLPI pour un item type.

    Utile pour debug + savoir quel field (ID numérique) utiliser dans /search/Ticket.
    Référence : https://github.com/glpi-project/glpi/blob/main/src/Ticket.php
    """
    auth(authorization)
    return call("GET", f"/listSearchOptions/{item_type}")


# ===========================================================================
# Stats : tickets par catégorie / status / urgence (dashboard)
# ===========================================================================

@app.get("/stats/by_status")
def stats_by_status(authorization: Annotated[str | None, Header()] = None) -> dict:
    auth(authorization)
    out: dict[str, int] = {}
    STATUS_LABELS = {
        1: "Nouveau", 2: "En cours", 3: "Résolu", 4: "Clos", 5: "Ouvert", 6: "En attente",
    }
    for status_id, label in STATUS_LABELS.items():
        params = {
            "range": "0-0",
            "criteria[0][field]": "12",
            "criteria[0][searchtype]": "equals",
            "criteria[0][value]": str(status_id),
        }
        try:
            res = call("GET", "/search/Ticket", params=params)
            if isinstance(res, dict):
                out[label] = res.get("totalcount", 0)
        except Exception:
            out[label] = 0
    return out
