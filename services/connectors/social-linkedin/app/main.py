"""Connecteur LinkedIn (Pages entreprise) — wrapper REST.

Endpoints exposés (FastAPI, port 8000) :
  GET  /healthz
  GET  /v1/info
  GET  /v1/organization                 infos de la Page entreprise (nom, follower count)
  GET  /v1/posts                        N derniers posts publiés (UGC)
  POST /v1/posts                        publier un post texte (avec lien optionnel)
  GET  /v1/posts/{post_urn}/stats       stats engagement d'un post (likes, commentaires, partages)
  GET  /v1/insights                     followers + impressions / engagement 28j

Sécurité :
  - Bearer token (LINKEDIN_TOOL_API_KEY) requis sur tous endpoints sauf /healthz
  - Bind 127.0.0.1 par défaut (compose)

Notes API LinkedIn (très différente de Meta) :
  - Versionnée par header `Linkedin-Version: 202410` (YYYYMM)
  - Header `X-Restli-Protocol-Version: 2.0.0` requis
  - URN partout : `urn:li:organization:1234`, `urn:li:share:7234567890`
  - Scopes requis : w_organization_social (publier),
                    r_organization_social (lire posts),
                    r_organization_admin  (lire stats followers).
  - L'API "Posts" remplace l'ancien UGC depuis 202310 — on l'utilise.
"""
from __future__ import annotations

import logging
import sys
from datetime import datetime
from functools import lru_cache
from typing import Any
from urllib.parse import quote

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

    access_token: str = Field(..., alias="LINKEDIN_ACCESS_TOKEN")
    organization_urn: str = Field(..., alias="LINKEDIN_ORGANIZATION_URN")
    tool_api_key: str = Field(..., alias="LINKEDIN_TOOL_API_KEY")
    api_version: str = Field("202410", alias="LINKEDIN_API_VERSION")
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
# LinkedIn API client
# ===========================================================================

class LinkedInError(Exception):
    pass


BASE_URL = "https://api.linkedin.com"


def _headers() -> dict[str, str]:
    s = get_settings()
    return {
        "Authorization": f"Bearer {s.access_token}",
        "Linkedin-Version": s.api_version,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, LinkedInError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=8),
    reraise=True,
)
def _get(path: str, params: dict | None = None) -> dict:
    s = get_settings()
    with httpx.Client(timeout=s.http_timeout_seconds) as c:
        r = c.get(f"{BASE_URL}{path}", headers=_headers(), params=params or {})
        if r.status_code >= 400:
            raise LinkedInError(f"LinkedIn {r.status_code}: {r.text[:300]}")
        return r.json() if r.content else {}


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, LinkedInError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=8),
    reraise=True,
)
def _post(path: str, json_body: dict) -> tuple[dict, dict]:
    """Retourne (body, headers) — LinkedIn renvoie les nouveaux URN dans `x-restli-id`."""
    s = get_settings()
    with httpx.Client(timeout=s.http_timeout_seconds) as c:
        r = c.post(f"{BASE_URL}{path}", headers=_headers(), json=json_body)
        if r.status_code >= 400:
            raise LinkedInError(f"LinkedIn {r.status_code}: {r.text[:300]}")
        body = r.json() if r.content else {}
        return body, dict(r.headers)


# ===========================================================================
# Schemas (sortie normalisée)
# ===========================================================================

class Organization(BaseModel):
    urn: str
    name: str
    vanity_name: str | None = None
    follower_count: int | None = None


class LinkedInPost(BaseModel):
    urn: str
    text: str | None = None
    created_at: datetime | None = None
    likes: int | None = None
    comments: int | None = None
    shares: int | None = None


class PostStats(BaseModel):
    urn: str
    likes: int | None = None
    comments: int | None = None
    shares: int | None = None
    impressions: int | None = None
    unique_impressions: int | None = None
    clicks: int | None = None


class OrgInsights(BaseModel):
    organization_urn: str
    follower_count: int | None = None
    impressions_28d: int | None = None
    engagement_28d: int | None = None
    raw: dict = Field(default_factory=dict)


class PublishResult(BaseModel):
    urn: str
    raw: dict = Field(default_factory=dict)


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
    title="AI Box — LinkedIn Tool (Pages entreprise)",
    version=__version__,
    description="Wrapper REST API LinkedIn consommable par Dify / n8n.",
)


@app.exception_handler(LinkedInError)
async def linkedin_error_handler(request: Request, exc: LinkedInError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": f"LinkedIn upstream error: {exc}"})


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
        "service": "aibox-conn-social-linkedin",
        "version": __version__,
        "tenant": s.tenant_id,
        "api_version": s.api_version,
        "organization_urn": s.organization_urn,
    }


# ---------------------------------------------------------------------------
# Organization
# ---------------------------------------------------------------------------

def _org_id_from_urn(urn: str) -> str:
    """`urn:li:organization:1234567` → `1234567`."""
    return urn.rsplit(":", 1)[-1]


@app.get("/v1/organization", dependencies=[Depends(require_api_key)])
def get_organization() -> Organization:
    s = get_settings()
    org_id = _org_id_from_urn(s.organization_urn)
    org = _get(f"/rest/organizations/{org_id}")
    name = (org.get("localizedName")
            or (org.get("name", {}).get("localized", {}) or {}).get("en_US")
            or "Unknown")
    vanity = org.get("vanityName")
    # Followers comptés sur un autre endpoint
    fc = None
    try:
        f = _get(
            "/rest/networkSizes/" + quote(s.organization_urn, safe=""),
            params={"edgeType": "CompanyFollowedByMember"},
        )
        fc = f.get("firstDegreeSize")
    except LinkedInError:
        pass
    return Organization(
        urn=s.organization_urn,
        name=name,
        vanity_name=vanity,
        follower_count=fc,
    )


# ---------------------------------------------------------------------------
# Posts (lecture)
# ---------------------------------------------------------------------------

@app.get("/v1/posts", dependencies=[Depends(require_api_key)])
def list_posts(
    limit: int = Query(10, ge=1, le=50),
) -> list[LinkedInPost]:
    """Liste les posts publiés par la Page entreprise.

    Endpoint /rest/posts avec author=urn:li:organization:...
    """
    s = get_settings()
    data = _get(
        "/rest/posts",
        params={
            "q": "author",
            "author": s.organization_urn,
            "count": limit,
            "sortBy": "LAST_MODIFIED",
        },
    )
    items = data.get("elements") or []
    out: list[LinkedInPost] = []
    for p in items:
        commentary = p.get("commentary") or ""
        created_ms = (p.get("createdAt") or 0)
        created = datetime.fromtimestamp(created_ms / 1000) if created_ms else None
        out.append(LinkedInPost(
            urn=p.get("id", ""),
            text=commentary,
            created_at=created,
            # Les compteurs ne sont PAS dans /rest/posts ; il faut /v1/posts/{urn}/stats
            likes=None,
            comments=None,
            shares=None,
        ))
    return out


# ---------------------------------------------------------------------------
# Posts (publication)
# ---------------------------------------------------------------------------

class PublishLinkedInBody(BaseModel):
    text: str = Field(..., min_length=1, max_length=3000,
                      description="Texte du post (max 3 000 caractères, recommandé < 1 300)")
    link: str | None = Field(None, description="URL à attacher au post (preview auto)")


@app.post("/v1/posts", dependencies=[Depends(require_api_key)])
def publish_post(body: PublishLinkedInBody) -> PublishResult:
    """Publie un post sur la Page entreprise (UGC API moderne)."""
    s = get_settings()
    payload: dict[str, Any] = {
        "author": s.organization_urn,
        "commentary": body.text,
        "visibility": "PUBLIC",
        "distribution": {
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        },
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }
    if body.link:
        payload["content"] = {"article": {"source": body.link}}

    body_resp, headers = _post("/rest/posts", payload)
    # LinkedIn retourne le nouvel URN dans le header `x-restli-id`
    new_urn = (
        headers.get("x-restli-id")
        or headers.get("X-RestLi-Id")
        or body_resp.get("id", "")
    )
    return PublishResult(urn=new_urn, raw=body_resp)


# ---------------------------------------------------------------------------
# Stats par post
# ---------------------------------------------------------------------------

@app.get("/v1/posts/{post_urn:path}/stats", dependencies=[Depends(require_api_key)])
def post_stats(post_urn: str) -> PostStats:
    """Retourne les compteurs d'engagement pour un post donné.

    `post_urn` doit être encodé tel quel : `urn:li:share:7234567890` ou
    `urn:li:ugcPost:...`
    """
    encoded = quote(post_urn, safe="")
    # /rest/socialActions/{share}
    actions = _get(f"/rest/socialActions/{encoded}")
    likes = (actions.get("likesSummary") or {}).get("totalLikes")
    comments = (actions.get("commentsSummary") or {}).get("aggregatedTotalComments")

    # Stats orga sur ce share précis (impressions, clicks)
    s = get_settings()
    impressions = unique_impressions = clicks = shares = None
    try:
        org_id = _org_id_from_urn(s.organization_urn)
        share_stats = _get(
            "/rest/organizationalEntityShareStatistics",
            params={
                "q": "organizationalEntity",
                "organizationalEntity": s.organization_urn,
                "shares[0]": post_urn,
            },
        )
        elements = share_stats.get("elements") or []
        if elements:
            ts = (elements[0] or {}).get("totalShareStatistics") or {}
            impressions = ts.get("impressionCount")
            unique_impressions = ts.get("uniqueImpressionsCount")
            clicks = ts.get("clickCount")
            shares = ts.get("shareCount")
        _ = org_id  # silence linter — utilisé pour debug si besoin
    except LinkedInError:
        pass

    return PostStats(
        urn=post_urn,
        likes=likes,
        comments=comments,
        shares=shares,
        impressions=impressions,
        unique_impressions=unique_impressions,
        clicks=clicks,
    )


# ---------------------------------------------------------------------------
# Insights organisation
# ---------------------------------------------------------------------------

@app.get("/v1/insights", dependencies=[Depends(require_api_key)])
def org_insights() -> OrgInsights:
    """Stats consolidées Page : followers + impressions/engagement 28j."""
    s = get_settings()
    # Followers
    fc = None
    try:
        f = _get(
            "/rest/networkSizes/" + quote(s.organization_urn, safe=""),
            params={"edgeType": "CompanyFollowedByMember"},
        )
        fc = f.get("firstDegreeSize")
    except LinkedInError:
        pass

    # Impressions/engagement agrégés 28j
    impressions = engagement = None
    raw_stats: dict = {}
    try:
        raw_stats = _get(
            "/rest/organizationalEntityShareStatistics",
            params={
                "q": "organizationalEntity",
                "organizationalEntity": s.organization_urn,
            },
        )
        elements = raw_stats.get("elements") or []
        if elements:
            ts = (elements[0] or {}).get("totalShareStatistics") or {}
            impressions = ts.get("impressionCount")
            engagement = ts.get("engagement")
    except LinkedInError:
        pass

    return OrgInsights(
        organization_urn=s.organization_urn,
        follower_count=fc,
        impressions_28d=impressions,
        engagement_28d=engagement,
        raw=raw_stats,
    )
