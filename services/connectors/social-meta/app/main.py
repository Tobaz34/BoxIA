"""Connecteur Meta (Facebook Pages + Instagram Business) — wrapper REST.

Endpoints exposés (FastAPI, port 8000) :
  GET  /healthz
  GET  /v1/info

  --- Facebook Pages ---
  GET  /v1/fb/pages                     liste les Pages accessibles avec ce token
  GET  /v1/fb/pages/{page_id}/posts     N derniers posts d'une Page
  POST /v1/fb/pages/{page_id}/posts     publier un post texte (et lien optionnel)
  GET  /v1/fb/pages/{page_id}/insights  stats d'audience

  --- Instagram Business ---
  GET  /v1/ig/users/{ig_user_id}/media       liste les posts récents
  POST /v1/ig/users/{ig_user_id}/media       publier (image_url + caption)
  GET  /v1/ig/users/{ig_user_id}/insights    stats compte

Sécurité :
  - Bearer token (META_TOOL_API_KEY) requis sur tous endpoints sauf /healthz
  - Bind 127.0.0.1 par défaut (compose)

Notes Graph API :
  - Token requis = Page Access Token long-lived (Meta for Developers).
  - Pour Instagram, le compte doit être Business + lié à une Page Facebook ;
    le même Page Access Token est valide pour les endpoints IG.
  - Publication IG = 2-step (POST /media → POST /media_publish).
"""
from __future__ import annotations

import logging
import sys
from datetime import datetime, timezone
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

    page_access_token: str = Field(..., alias="META_PAGE_ACCESS_TOKEN")
    tool_api_key: str = Field(..., alias="META_TOOL_API_KEY")
    default_page_id: str = Field("", alias="META_PAGE_ID")
    default_ig_user_id: str = Field("", alias="META_IG_USER_ID")
    graph_version: str = Field("v21.0", alias="META_GRAPH_VERSION")
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
# Graph API client
# ===========================================================================

class MetaError(Exception):
    pass


def _base_url() -> str:
    return f"https://graph.facebook.com/{get_settings().graph_version}"


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, MetaError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=8),
    reraise=True,
)
def _graph_get(path: str, params: dict | None = None) -> dict:
    s = get_settings()
    url = f"{_base_url()}{path}"
    p = dict(params or {})
    p.setdefault("access_token", s.page_access_token)
    with httpx.Client(timeout=s.http_timeout_seconds) as c:
        r = c.get(url, params=p)
        if r.status_code >= 400:
            raise MetaError(f"Meta {r.status_code}: {r.text[:300]}")
        return r.json()


@retry(
    retry=retry_if_exception_type((httpx.HTTPError, MetaError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(min=1, max=8),
    reraise=True,
)
def _graph_post(path: str, data: dict | None = None) -> dict:
    s = get_settings()
    url = f"{_base_url()}{path}"
    payload = dict(data or {})
    payload.setdefault("access_token", s.page_access_token)
    with httpx.Client(timeout=s.http_timeout_seconds) as c:
        r = c.post(url, data=payload)
        if r.status_code >= 400:
            raise MetaError(f"Meta {r.status_code}: {r.text[:300]}")
        return r.json()


# ===========================================================================
# Schemas (sortie normalisée)
# ===========================================================================

class FbPage(BaseModel):
    id: str
    name: str
    category: str | None = None
    fan_count: int | None = None


class FbPost(BaseModel):
    id: str
    message: str | None = None
    created_time: datetime | None = None
    permalink_url: str | None = None
    likes: int | None = None
    comments: int | None = None


class FbInsights(BaseModel):
    page_id: str
    fans: int | None = None
    reach_28d: int | None = None
    impressions_28d: int | None = None
    raw: dict = Field(default_factory=dict)


class IgMedia(BaseModel):
    id: str
    caption: str | None = None
    media_type: str | None = None  # IMAGE | VIDEO | CAROUSEL_ALBUM
    media_url: str | None = None
    permalink: str | None = None
    timestamp: datetime | None = None
    like_count: int | None = None
    comments_count: int | None = None


class IgInsights(BaseModel):
    ig_user_id: str
    follower_count: int | None = None
    reach_28d: int | None = None
    impressions_28d: int | None = None
    raw: dict = Field(default_factory=dict)


class PublishResult(BaseModel):
    id: str
    permalink_url: str | None = None
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
    title="AI Box — Meta Tool (Facebook + Instagram)",
    version=__version__,
    description="Wrapper REST Graph API consommable par Dify / n8n.",
)


@app.exception_handler(MetaError)
async def meta_error_handler(request: Request, exc: MetaError) -> JSONResponse:
    return JSONResponse(status_code=502, content={"detail": f"Meta upstream error: {exc}"})


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
        "service": "aibox-conn-social-meta",
        "version": __version__,
        "tenant": s.tenant_id,
        "graph_version": s.graph_version,
        "default_page_id": s.default_page_id or None,
        "default_ig_user_id": s.default_ig_user_id or None,
    }


# ---------------------------------------------------------------------------
# Facebook Pages
# ---------------------------------------------------------------------------

@app.get("/v1/fb/pages", dependencies=[Depends(require_api_key)])
def list_pages() -> list[FbPage]:
    """Liste les Pages accessibles avec le token courant."""
    data = _graph_get("/me/accounts", {"fields": "id,name,category,fan_count"})
    items = data.get("data") or []
    return [FbPage(**p) for p in items]


@app.get("/v1/fb/pages/{page_id}/posts", dependencies=[Depends(require_api_key)])
def list_page_posts(
    page_id: str,
    limit: int = Query(10, ge=1, le=50),
) -> list[FbPost]:
    fields = "id,message,created_time,permalink_url,likes.summary(true),comments.summary(true)"
    data = _graph_get(f"/{page_id}/posts", {"fields": fields, "limit": limit})
    items = data.get("data") or []
    out: list[FbPost] = []
    for p in items:
        likes = (p.get("likes") or {}).get("summary", {}).get("total_count")
        comments = (p.get("comments") or {}).get("summary", {}).get("total_count")
        out.append(FbPost(
            id=p["id"],
            message=p.get("message"),
            created_time=p.get("created_time"),
            permalink_url=p.get("permalink_url"),
            likes=likes,
            comments=comments,
        ))
    return out


class PublishFbBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=63206,
                         description="Texte du post (max 63 206 caractères)")
    link: str | None = Field(None, description="URL à attacher au post (preview auto)")


@app.post("/v1/fb/pages/{page_id}/posts", dependencies=[Depends(require_api_key)])
def publish_fb_post(page_id: str, body: PublishFbBody) -> PublishResult:
    """Publie un post texte sur la Page Facebook.

    Pour images : utilise un endpoint séparé /photos (pas implémenté Phase 1
    pour rester simple — la grosse majorité des posts TPE/PME sont du texte
    + lien partagé).
    """
    payload: dict[str, Any] = {"message": body.message}
    if body.link:
        payload["link"] = body.link
    res = _graph_post(f"/{page_id}/feed", payload)
    post_id = res.get("id", "")
    # Récupère le permalink pour confort UX
    permalink = None
    try:
        meta = _graph_get(f"/{post_id}", {"fields": "permalink_url"})
        permalink = meta.get("permalink_url")
    except MetaError:
        pass
    return PublishResult(id=post_id, permalink_url=permalink, raw=res)


@app.get("/v1/fb/pages/{page_id}/insights", dependencies=[Depends(require_api_key)])
def fb_insights(page_id: str) -> FbInsights:
    """Stats simples : fans + reach 28j + impressions 28j."""
    page = _graph_get(f"/{page_id}", {"fields": "fan_count"})
    fans = page.get("fan_count")
    metrics = "page_impressions,page_impressions_unique"
    ins = _graph_get(f"/{page_id}/insights", {"metric": metrics, "period": "days_28"})
    reach = impressions = None
    for m in ins.get("data") or []:
        name = m.get("name")
        values = m.get("values") or []
        v = values[-1].get("value") if values else None
        if name == "page_impressions_unique":
            reach = v
        elif name == "page_impressions":
            impressions = v
    return FbInsights(
        page_id=page_id,
        fans=fans,
        reach_28d=reach,
        impressions_28d=impressions,
        raw={"page": page, "insights": ins},
    )


# ---------------------------------------------------------------------------
# Instagram Business
# ---------------------------------------------------------------------------

@app.get("/v1/ig/users/{ig_user_id}/media", dependencies=[Depends(require_api_key)])
def list_ig_media(
    ig_user_id: str,
    limit: int = Query(10, ge=1, le=50),
) -> list[IgMedia]:
    fields = "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count"
    data = _graph_get(f"/{ig_user_id}/media", {"fields": fields, "limit": limit})
    items = data.get("data") or []
    return [IgMedia(**p) for p in items]


class PublishIgBody(BaseModel):
    image_url: str = Field(..., description="URL publique de l'image (HTTPS, accessible par Meta)")
    caption: str | None = Field(None, max_length=2200,
                                description="Légende du post (max 2 200 caractères)")


@app.post("/v1/ig/users/{ig_user_id}/media", dependencies=[Depends(require_api_key)])
def publish_ig_post(ig_user_id: str, body: PublishIgBody) -> PublishResult:
    """Publie une image sur Instagram Business.

    Flow Meta en 2 étapes :
      1. POST /media → créé un container, retourne creation_id
      2. POST /media_publish avec creation_id → publie réellement
    """
    # Étape 1 : créer le container
    create_payload: dict[str, Any] = {"image_url": body.image_url}
    if body.caption:
        create_payload["caption"] = body.caption
    container = _graph_post(f"/{ig_user_id}/media", create_payload)
    creation_id = container.get("id")
    if not creation_id:
        raise MetaError(f"Meta n'a pas renvoyé d'ID de container : {container}")

    # Étape 2 : publier
    published = _graph_post(
        f"/{ig_user_id}/media_publish",
        {"creation_id": creation_id},
    )
    media_id = published.get("id", "")
    # Récupère le permalink
    permalink = None
    try:
        meta = _graph_get(f"/{media_id}", {"fields": "permalink"})
        permalink = meta.get("permalink")
    except MetaError:
        pass
    return PublishResult(id=media_id, permalink_url=permalink, raw=published)


@app.get("/v1/ig/users/{ig_user_id}/insights", dependencies=[Depends(require_api_key)])
def ig_insights(ig_user_id: str) -> IgInsights:
    user = _graph_get(f"/{ig_user_id}", {"fields": "followers_count"})
    metrics = "reach,impressions"
    ins = _graph_get(
        f"/{ig_user_id}/insights",
        {"metric": metrics, "period": "days_28"},
    )
    reach = impressions = None
    for m in ins.get("data") or []:
        name = m.get("name")
        values = m.get("values") or []
        v = values[-1].get("value") if values else None
        if name == "reach":
            reach = v
        elif name == "impressions":
            impressions = v
    return IgInsights(
        ig_user_id=ig_user_id,
        follower_count=user.get("followers_count"),
        reach_28d=reach,
        impressions_28d=impressions,
        raw={"user": user, "insights": ins},
    )
