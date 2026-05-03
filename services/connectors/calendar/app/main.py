"""Connecteur Agenda — wrapper REST unifié pour Outlook (MS Graph), Google
Calendar et CalDAV.

Endpoints exposés (FastAPI, port 8000) :
  GET  /healthz
  GET  /v1/info

  GET  /v1/events?from=&to=&calendar_id=
  GET  /v1/today
  POST /v1/events
  GET  /v1/freebusy?from=&to=&attendees=alice@x,bob@y

Sécurité :
  - Bearer token (CALENDAR_TOOL_API_KEY) requis sur tous endpoints sauf /healthz
  - Bind 127.0.0.1 par défaut (compose)

Sélection backend :
  CALENDAR_BACKEND=outlook | google | caldav
  Variables spécifiques par backend (cf manifest.yaml).

Notes :
  - Outlook (M365) en mode "application permission" via client_credentials.
    Nécessite un user cible (`MS_TARGET_USER`).
  - Google Calendar via service account + domain-wide delegation
    (impersonation `GOOGLE_DELEGATED_USER`).
  - CalDAV via la lib `caldav` (Nextcloud, Baïkal, iCloud, OVH…).
"""
from __future__ import annotations

import abc
import json
import logging
import sys
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from typing import Any

import httpx
import structlog
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.requests import Request
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from app import __version__


# ===========================================================================
# Settings
# ===========================================================================

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    backend: str = Field(..., alias="CALENDAR_BACKEND")  # outlook|google|caldav
    tool_api_key: str = Field(..., alias="CALENDAR_TOOL_API_KEY")

    # Outlook
    ms_tenant_id: str = Field("", alias="MS_TENANT_ID")
    ms_client_id: str = Field("", alias="MS_CLIENT_ID")
    ms_client_secret: str = Field("", alias="MS_CLIENT_SECRET")
    ms_target_user: str = Field("", alias="MS_TARGET_USER")

    # Google
    google_service_account_json: str = Field("", alias="GOOGLE_SERVICE_ACCOUNT_JSON")
    google_delegated_user: str = Field("", alias="GOOGLE_DELEGATED_USER")

    # CalDAV
    caldav_url: str = Field("", alias="CALDAV_URL")
    caldav_username: str = Field("", alias="CALDAV_USERNAME")
    caldav_password: str = Field("", alias="CALDAV_PASSWORD")

    tenant_id: str = Field("default", alias="TENANT_ID")
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    http_timeout_seconds: int = Field(30, alias="HTTP_TIMEOUT_SECONDS")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


# ===========================================================================
# Logging
# ===========================================================================

def _setup_logging() -> None:
    s = get_settings()
    level = getattr(logging, s.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, stream=sys.stdout, format="%(message)s")
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
    )


# ===========================================================================
# Schemas (modèle commun)
# ===========================================================================

class Attendee(BaseModel):
    email: str
    name: str | None = None
    response: str | None = None  # accepted | declined | tentative | needs_action


class Event(BaseModel):
    id: str | None = None
    title: str
    description: str | None = None
    location: str | None = None
    start: datetime
    end: datetime
    all_day: bool = False
    organizer: str | None = None
    attendees: list[Attendee] = Field(default_factory=list)
    web_link: str | None = None


class FreeBusyWindow(BaseModel):
    start: datetime
    end: datetime


class FreeBusyResult(BaseModel):
    attendee: str
    busy: list[FreeBusyWindow]


# ===========================================================================
# Backends
# ===========================================================================

class CalendarError(Exception):
    pass


class CalendarBackend(abc.ABC):
    name: str = "abstract"

    @abc.abstractmethod
    def list_events(self, time_min: datetime, time_max: datetime, calendar_id: str | None = None) -> list[Event]:
        ...

    @abc.abstractmethod
    def create_event(self, ev: Event, calendar_id: str | None = None) -> Event:
        ...

    @abc.abstractmethod
    def free_busy(self, time_min: datetime, time_max: datetime, attendees: list[str]) -> list[FreeBusyResult]:
        ...


# ---- Outlook (MS Graph) ---------------------------------------------------

class OutlookBackend(CalendarBackend):
    name = "outlook"

    def __init__(self, s: Settings) -> None:
        if not (s.ms_tenant_id and s.ms_client_id and s.ms_client_secret and s.ms_target_user):
            raise CalendarError(
                "Outlook backend requires MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TARGET_USER",
            )
        self.s = s
        self._token: str | None = None
        self._token_exp: datetime = datetime.min.replace(tzinfo=timezone.utc)

    def _get_token(self) -> str:
        now = datetime.now(timezone.utc)
        if self._token and now < self._token_exp - timedelta(seconds=60):
            return self._token
        url = f"https://login.microsoftonline.com/{self.s.ms_tenant_id}/oauth2/v2.0/token"
        with httpx.Client(timeout=self.s.http_timeout_seconds) as c:
            r = c.post(url, data={
                "client_id": self.s.ms_client_id,
                "client_secret": self.s.ms_client_secret,
                "grant_type": "client_credentials",
                "scope": "https://graph.microsoft.com/.default",
            })
            if r.status_code >= 400:
                raise CalendarError(f"MS token error {r.status_code}: {r.text[:200]}")
            data = r.json()
        self._token = data["access_token"]
        self._token_exp = now + timedelta(seconds=int(data.get("expires_in", 3600)))
        return self._token

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._get_token()}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        }

    @retry(retry=retry_if_exception_type(httpx.HTTPError),
           stop=stop_after_attempt(3),
           wait=wait_exponential(min=1, max=8),
           reraise=True)
    def _graph(self, method: str, path: str, **kwargs: Any) -> dict:
        url = f"https://graph.microsoft.com/v1.0{path}"
        with httpx.Client(timeout=self.s.http_timeout_seconds) as c:
            r = c.request(method, url, headers=self._headers(), **kwargs)
            if r.status_code >= 400:
                raise CalendarError(f"Graph {r.status_code}: {r.text[:300]}")
            return r.json() if r.content else {}

    def list_events(self, time_min: datetime, time_max: datetime, calendar_id: str | None = None) -> list[Event]:
        params = {
            "startDateTime": time_min.astimezone(timezone.utc).isoformat(),
            "endDateTime": time_max.astimezone(timezone.utc).isoformat(),
            "$top": 50,
            "$orderby": "start/dateTime",
        }
        path = f"/users/{self.s.ms_target_user}/calendarView"
        data = self._graph("GET", path, params=params)
        out: list[Event] = []
        for e in data.get("value") or []:
            out.append(Event(
                id=e.get("id"),
                title=e.get("subject", "(sans titre)"),
                description=(e.get("bodyPreview") or None),
                location=((e.get("location") or {}).get("displayName") or None),
                start=_parse_graph_dt(e.get("start", {})),
                end=_parse_graph_dt(e.get("end", {})),
                all_day=bool(e.get("isAllDay")),
                organizer=((e.get("organizer") or {}).get("emailAddress", {}) or {}).get("address"),
                attendees=[
                    Attendee(
                        email=(a.get("emailAddress") or {}).get("address", ""),
                        name=(a.get("emailAddress") or {}).get("name"),
                        response=(a.get("status") or {}).get("response"),
                    )
                    for a in (e.get("attendees") or [])
                ],
                web_link=e.get("webLink"),
            ))
        return out

    def create_event(self, ev: Event, calendar_id: str | None = None) -> Event:
        body = {
            "subject": ev.title,
            "body": {"contentType": "HTML", "content": ev.description or ""},
            "start": {"dateTime": ev.start.isoformat(), "timeZone": "UTC"},
            "end":   {"dateTime": ev.end.isoformat(),   "timeZone": "UTC"},
            "isAllDay": ev.all_day,
        }
        if ev.location:
            body["location"] = {"displayName": ev.location}
        if ev.attendees:
            body["attendees"] = [
                {"emailAddress": {"address": a.email, "name": a.name or a.email},
                 "type": "required"}
                for a in ev.attendees
            ]
        path = f"/users/{self.s.ms_target_user}/events"
        created = self._graph("POST", path, json=body)
        return Event(
            id=created.get("id"),
            title=created.get("subject", ev.title),
            description=ev.description,
            location=ev.location,
            start=_parse_graph_dt(created.get("start", {})),
            end=_parse_graph_dt(created.get("end", {})),
            all_day=ev.all_day,
            organizer=((created.get("organizer") or {}).get("emailAddress", {}) or {}).get("address"),
            attendees=ev.attendees,
            web_link=created.get("webLink"),
        )

    def free_busy(self, time_min: datetime, time_max: datetime, attendees: list[str]) -> list[FreeBusyResult]:
        body = {
            "schedules": attendees,
            "startTime": {"dateTime": time_min.isoformat(), "timeZone": "UTC"},
            "endTime":   {"dateTime": time_max.isoformat(), "timeZone": "UTC"},
            "availabilityViewInterval": 30,
        }
        path = f"/users/{self.s.ms_target_user}/calendar/getSchedule"
        data = self._graph("POST", path, json=body)
        out: list[FreeBusyResult] = []
        for sched in data.get("value") or []:
            email = sched.get("scheduleId") or ""
            busy = [
                FreeBusyWindow(
                    start=_parse_graph_dt(item.get("start", {})),
                    end=_parse_graph_dt(item.get("end", {})),
                )
                for item in (sched.get("scheduleItems") or [])
                if item.get("status", "").lower() in ("busy", "oof", "tentative")
            ]
            out.append(FreeBusyResult(attendee=email, busy=busy))
        return out


def _parse_graph_dt(d: dict) -> datetime:
    val = d.get("dateTime")
    if not val:
        return datetime.now(timezone.utc)
    # MS Graph renvoie sans 'Z' parfois — on force UTC si naïf
    dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


# ---- Google Calendar ------------------------------------------------------

class GoogleBackend(CalendarBackend):
    name = "google"

    def __init__(self, s: Settings) -> None:
        if not (s.google_service_account_json and s.google_delegated_user):
            raise CalendarError(
                "Google backend requires GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DELEGATED_USER",
            )
        self.s = s
        self._service = None  # lazy

    def _get_service(self):
        if self._service is not None:
            return self._service
        # Imports paresseux : si l'utilisateur ne choisit pas Google,
        # pas la peine de payer le coût.
        from google.oauth2 import service_account  # type: ignore
        from googleapiclient.discovery import build  # type: ignore

        # Le secret peut être soit un JSON inline, soit un chemin fichier
        raw = self.s.google_service_account_json.strip()
        if raw.startswith("{"):
            info = json.loads(raw)
        else:
            with open(raw, encoding="utf-8") as f:
                info = json.load(f)
        creds = service_account.Credentials.from_service_account_info(
            info,
            scopes=["https://www.googleapis.com/auth/calendar"],
        ).with_subject(self.s.google_delegated_user)
        self._service = build("calendar", "v3", credentials=creds, cache_discovery=False)
        return self._service

    def list_events(self, time_min: datetime, time_max: datetime, calendar_id: str | None = None) -> list[Event]:
        svc = self._get_service()
        events_result = svc.events().list(
            calendarId=calendar_id or "primary",
            timeMin=time_min.astimezone(timezone.utc).isoformat(),
            timeMax=time_max.astimezone(timezone.utc).isoformat(),
            singleEvents=True,
            orderBy="startTime",
            maxResults=50,
        ).execute()
        out: list[Event] = []
        for e in events_result.get("items", []):
            start = _parse_google_dt(e.get("start", {}))
            end = _parse_google_dt(e.get("end", {}))
            all_day = "date" in (e.get("start") or {}) and "dateTime" not in (e.get("start") or {})
            out.append(Event(
                id=e.get("id"),
                title=e.get("summary", "(sans titre)"),
                description=e.get("description"),
                location=e.get("location"),
                start=start,
                end=end,
                all_day=all_day,
                organizer=(e.get("organizer") or {}).get("email"),
                attendees=[
                    Attendee(
                        email=a.get("email", ""),
                        name=a.get("displayName"),
                        response=a.get("responseStatus"),
                    )
                    for a in (e.get("attendees") or [])
                ],
                web_link=e.get("htmlLink"),
            ))
        return out

    def create_event(self, ev: Event, calendar_id: str | None = None) -> Event:
        svc = self._get_service()
        body: dict[str, Any] = {
            "summary": ev.title,
            "description": ev.description or "",
            "start": _to_google_dt(ev.start, ev.all_day),
            "end":   _to_google_dt(ev.end,   ev.all_day),
        }
        if ev.location:
            body["location"] = ev.location
        if ev.attendees:
            body["attendees"] = [{"email": a.email} for a in ev.attendees]
        created = svc.events().insert(
            calendarId=calendar_id or "primary",
            body=body,
            sendUpdates="all" if ev.attendees else "none",
        ).execute()
        return Event(
            id=created.get("id"),
            title=created.get("summary", ev.title),
            description=ev.description,
            location=ev.location,
            start=_parse_google_dt(created.get("start", {})),
            end=_parse_google_dt(created.get("end", {})),
            all_day=ev.all_day,
            organizer=(created.get("organizer") or {}).get("email"),
            attendees=ev.attendees,
            web_link=created.get("htmlLink"),
        )

    def free_busy(self, time_min: datetime, time_max: datetime, attendees: list[str]) -> list[FreeBusyResult]:
        svc = self._get_service()
        body = {
            "timeMin": time_min.astimezone(timezone.utc).isoformat(),
            "timeMax": time_max.astimezone(timezone.utc).isoformat(),
            "items": [{"id": a} for a in attendees],
        }
        result = svc.freebusy().query(body=body).execute()
        out: list[FreeBusyResult] = []
        for email, info in (result.get("calendars") or {}).items():
            busy = [
                FreeBusyWindow(
                    start=datetime.fromisoformat(b["start"].replace("Z", "+00:00")),
                    end=datetime.fromisoformat(b["end"].replace("Z", "+00:00")),
                )
                for b in (info.get("busy") or [])
            ]
            out.append(FreeBusyResult(attendee=email, busy=busy))
        return out


def _parse_google_dt(d: dict) -> datetime:
    if "dateTime" in d:
        return datetime.fromisoformat(d["dateTime"].replace("Z", "+00:00"))
    if "date" in d:
        return datetime.combine(date.fromisoformat(d["date"]), time.min, tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


def _to_google_dt(dt: datetime, all_day: bool) -> dict:
    if all_day:
        return {"date": dt.date().isoformat()}
    return {"dateTime": dt.isoformat(), "timeZone": "UTC"}


# ---- CalDAV ---------------------------------------------------------------

class CalDavBackend(CalendarBackend):
    name = "caldav"

    def __init__(self, s: Settings) -> None:
        if not (s.caldav_url and s.caldav_username and s.caldav_password):
            raise CalendarError(
                "CalDAV backend requires CALDAV_URL, CALDAV_USERNAME, CALDAV_PASSWORD",
            )
        self.s = s
        self._principal = None

    def _get_principal(self):
        if self._principal is not None:
            return self._principal
        import caldav  # type: ignore
        client = caldav.DAVClient(
            url=self.s.caldav_url,
            username=self.s.caldav_username,
            password=self.s.caldav_password,
        )
        self._principal = client.principal()
        return self._principal

    def _get_calendar(self, calendar_id: str | None):
        principal = self._get_principal()
        cals = principal.calendars()
        if not cals:
            raise CalendarError("Aucun calendrier CalDAV trouvé")
        if calendar_id:
            for c in cals:
                if c.name == calendar_id or str(c.url).rstrip("/").endswith(calendar_id):
                    return c
        return cals[0]

    def list_events(self, time_min: datetime, time_max: datetime, calendar_id: str | None = None) -> list[Event]:
        cal = self._get_calendar(calendar_id)
        results = cal.search(start=time_min, end=time_max, event=True, expand=True)
        out: list[Event] = []
        for r in results:
            ical = getattr(r, "icalendar_component", None)
            if ical is None:
                continue
            start = _ical_dt(ical.get("dtstart"))
            end = _ical_dt(ical.get("dtend") or ical.get("dtstart"))
            out.append(Event(
                id=str(ical.get("uid", "")),
                title=str(ical.get("summary", "(sans titre)")),
                description=str(ical.get("description") or "") or None,
                location=str(ical.get("location") or "") or None,
                start=start,
                end=end,
                all_day=isinstance(ical.get("dtstart").dt, date) and not isinstance(ical.get("dtstart").dt, datetime),
                organizer=str(ical.get("organizer") or "") or None,
                attendees=[],
                web_link=None,
            ))
        return out

    def create_event(self, ev: Event, calendar_id: str | None = None) -> Event:
        cal = self._get_calendar(calendar_id)
        from datetime import datetime as _dt  # local import for clarity
        ical = (
            "BEGIN:VCALENDAR\r\n"
            "VERSION:2.0\r\n"
            "PRODID:-//AI Box//EN\r\n"
            "BEGIN:VEVENT\r\n"
            f"UID:{ev.id or _dt.utcnow().strftime('%Y%m%dT%H%M%SZ')}-aibox\r\n"
            f"DTSTAMP:{_dt.utcnow().strftime('%Y%m%dT%H%M%SZ')}\r\n"
            f"DTSTART:{ev.start.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}\r\n"
            f"DTEND:{ev.end.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}\r\n"
            f"SUMMARY:{ev.title}\r\n"
            + (f"DESCRIPTION:{ev.description}\r\n" if ev.description else "")
            + (f"LOCATION:{ev.location}\r\n" if ev.location else "")
            + "END:VEVENT\r\n"
            "END:VCALENDAR\r\n"
        )
        cal.save_event(ical)
        return ev  # CalDAV ne renvoie pas l'objet enrichi proprement

    def free_busy(self, time_min: datetime, time_max: datetime, attendees: list[str]) -> list[FreeBusyResult]:
        # CalDAV freebusy multi-attendee = REPORT VFREEBUSY peu portable.
        # Pour Phase 1 : on applique uniquement à l'utilisateur courant.
        cal = self._get_calendar(None)
        events = cal.search(start=time_min, end=time_max, event=True, expand=True)
        busy: list[FreeBusyWindow] = []
        for e in events:
            ical = getattr(e, "icalendar_component", None)
            if ical is None:
                continue
            busy.append(FreeBusyWindow(
                start=_ical_dt(ical.get("dtstart")),
                end=_ical_dt(ical.get("dtend") or ical.get("dtstart")),
            ))
        return [FreeBusyResult(attendee=self.s.caldav_username, busy=busy)]


def _ical_dt(field: Any) -> datetime:
    if field is None:
        return datetime.now(timezone.utc)
    val = getattr(field, "dt", field)
    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)
    if isinstance(val, date):
        return datetime.combine(val, time.min, tzinfo=timezone.utc)
    return datetime.now(timezone.utc)


# ===========================================================================
# Backend factory
# ===========================================================================

@lru_cache
def get_backend() -> CalendarBackend:
    s = get_settings()
    name = s.backend.lower().strip()
    if name == "outlook":
        return OutlookBackend(s)
    if name == "google":
        return GoogleBackend(s)
    if name == "caldav":
        return CalDavBackend(s)
    raise CalendarError(f"Backend inconnu : {s.backend!r} (attendu : outlook|google|caldav)")


# ===========================================================================
# Auth
# ===========================================================================

bearer = HTTPBearer(auto_error=False)


def require_api_key(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> None:
    s = get_settings()
    if creds is None or creds.scheme.lower() != "bearer" or creds.credentials != s.tool_api_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="API key invalide ou manquante",
            headers={"WWW-Authenticate": "Bearer"},
        )


# ===========================================================================
# App
# ===========================================================================

_setup_logging()
app = FastAPI(
    title="AI Box — Calendar Tool (Outlook + Google + CalDAV)",
    version=__version__,
    description="Wrapper REST agenda unifié consommable par Dify / n8n.",
)


@app.exception_handler(CalendarError)
async def calendar_error_handler(request: Request, exc: CalendarError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(httpx.HTTPError)
async def httpx_error_handler(request: Request, exc: httpx.HTTPError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": f"HTTP error: {exc}"})


@app.get("/healthz", response_class=PlainTextResponse)
def healthz() -> str:
    return "OK"


@app.get("/v1/info")
def info() -> dict:
    s = get_settings()
    return {
        "service": "aibox-conn-calendar",
        "version": __version__,
        "tenant": s.tenant_id,
        "backend": s.backend,
    }


@app.get("/v1/events", dependencies=[Depends(require_api_key)])
def list_events(
    from_: datetime = Query(..., alias="from", description="ISO datetime"),
    to: datetime = Query(..., description="ISO datetime"),
    calendar_id: str | None = Query(None),
) -> list[Event]:
    return get_backend().list_events(from_, to, calendar_id)


@app.get("/v1/today", dependencies=[Depends(require_api_key)])
def today() -> list[Event]:
    """Use case principal : « qu'est-ce que j'ai aujourd'hui ? »."""
    now = datetime.now(timezone.utc)
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + timedelta(days=1)
    return get_backend().list_events(start, end)


@app.post("/v1/events", dependencies=[Depends(require_api_key)])
def create_event(ev: Event) -> Event:
    return get_backend().create_event(ev)


@app.get("/v1/freebusy", dependencies=[Depends(require_api_key)])
def free_busy(
    from_: datetime = Query(..., alias="from"),
    to: datetime = Query(...),
    attendees: str = Query(..., description="Liste séparée par virgules"),
) -> list[FreeBusyResult]:
    emails = [a.strip() for a in attendees.split(",") if a.strip()]
    if not emails:
        raise HTTPException(400, "Au moins un attendee requis")
    return get_backend().free_busy(from_, to, emails)
