"""
Helper commun aux workers connecteurs : récupère un access_token frais
auprès de aibox-app `/api/oauth/internal/token` (qui gère le refresh
automatique côté Next.js).

Utilisation typique dans un worker :

    from connectors_lib.oauth import OAuthTokenSource

    src = OAuthTokenSource(
        provider="google",            # ou "microsoft"
        connector_slug="google-drive",
    )
    access_token = src.token()        # fresh, refreshed si <2 min de l'exp
    # Utiliser dans Authorization: Bearer pour le SDK fournisseur

Variables d'environnement requises :
    OAUTH_API_BASE              ex: http://aibox-app:3100 (host network) ou
                                http://localhost:3100 (host mode)
    CONNECTOR_INTERNAL_TOKEN    shared secret (>=16 chars), même valeur
                                que côté .env de aibox-app

Cache local : 60s pour ne pas hammer Next.js. Re-fetch automatique si la
réponse précédente expire dans <120s (Next.js refresh side garantit que
le token retourné est valide encore au moins 2 min).
"""
from __future__ import annotations

import os
import time
from typing import Optional

import httpx


class OAuthTokenSource:
    def __init__(
        self,
        provider: str,
        connector_slug: str,
        api_base: Optional[str] = None,
        internal_token: Optional[str] = None,
        cache_ttl_seconds: int = 60,
    ):
        self.provider = provider
        self.connector_slug = connector_slug
        self.api_base = (api_base or os.environ.get("OAUTH_API_BASE", "")).rstrip("/")
        self.internal_token = internal_token or os.environ.get("CONNECTOR_INTERNAL_TOKEN", "")
        self.cache_ttl = cache_ttl_seconds
        if not self.api_base or not self.internal_token:
            raise RuntimeError(
                "OAUTH_API_BASE and CONNECTOR_INTERNAL_TOKEN env vars required",
            )
        self._cache_value: Optional[str] = None
        self._cache_until: float = 0.0
        self._account_email: Optional[str] = None
        self._scopes: list[str] = []

    def token(self) -> str:
        now = time.time()
        if self._cache_value and now < self._cache_until:
            return self._cache_value
        url = f"{self.api_base}/api/oauth/internal/token"
        params = {"provider": self.provider, "connector_slug": self.connector_slug}
        headers = {"X-Connector-Token": self.internal_token}
        r = httpx.get(url, params=params, headers=headers, timeout=10.0)
        if r.status_code == 404:
            raise OAuthNotConnected(
                f"No OAuth connection for {self.provider}:{self.connector_slug}. "
                "Admin must connect via /connectors UI first."
            )
        if r.status_code == 401:
            raise OAuthInternalAuthError(
                "CONNECTOR_INTERNAL_TOKEN mismatch between worker and aibox-app",
            )
        r.raise_for_status()
        data = r.json()
        self._cache_value = data["access_token"]
        # On rafraîchit au plus tôt à mid-life (cache_ttl) ou avant expiration côté
        # provider, à -120s pour avoir une marge.
        provider_exp = data.get("expires_at", 0) or 0
        provider_remaining = max(0, (provider_exp / 1000) - now)
        # provider_remaining est l'espérance de vie restante du token chez le provider.
        # On prend le min entre notre TTL local et provider_remaining-120s.
        self._cache_until = now + min(self.cache_ttl, max(0, provider_remaining - 120))
        self._account_email = data.get("account_email")
        self._scopes = data.get("scopes") or []
        return self._cache_value

    @property
    def account_email(self) -> Optional[str]:
        return self._account_email

    @property
    def scopes(self) -> list[str]:
        return list(self._scopes)


class OAuthNotConnected(RuntimeError):
    """L'admin n'a pas encore connecté ce provider via /connectors UI."""


class OAuthInternalAuthError(RuntimeError):
    """CONNECTOR_INTERNAL_TOKEN ne match pas — config worker incorrecte."""
