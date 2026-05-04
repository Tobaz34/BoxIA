"""
RAG MS Graph — indexe SharePoint / OneDrive dans Qdrant.

Authentification : 2 modes via AUTH_MODE :
  - "client_credentials" (legacy, default) : OAuth2 client_credentials
    (App Registration Azure AD avec admin consent). Variables MS_TENANT_ID
    + MS_CLIENT_ID + MS_CLIENT_SECRET + scope ".default". Adapté à un
    déploiement admin centralisé indexant un drive partagé.
  - "oauth" (recommandé prod multi-user) : utilise le token OAuth user
    saisi via /connectors UI (cf services/app/src/lib/oauth-oidc.ts).
    Variables OAUTH_API_BASE + CONNECTOR_INTERNAL_TOKEN. Le worker
    indexe le OneDrive perso du user qui a autorisé.

Sync : delta queries Microsoft Graph → ne re-traite que les changements.
ACL : récupère les permissions de chaque item → propage dans le payload Qdrant
      pour permettre le filtrage par user au moment du retrieval.

Variables communes :
  TENANT_ID            slug du client AI Box (ex: nom court)
  OLLAMA_URL           http://ollama:11434
  LLM_EMBED            bge-m3
  QDRANT_URL           http://aibox-qdrant:6333
  QDRANT_API_KEY
  SYNC_INTERVAL_MINUTES (default 30)
  INCLUDE_EXT          .pdf,.docx,.xlsx,.pptx,.txt,.md,.html
  MAX_FILE_MB          (default 50)

Variables mode client_credentials :
  MS_TENANT_ID         GUID du tenant
  MS_CLIENT_ID         Application (client) ID
  MS_CLIENT_SECRET     Secret client
  MS_DRIVE_ID          (mode OneDrive User) ID du drive à indexer
  MS_SITE_ID           (mode SharePoint) ID du site (alternative)

Variables mode oauth :
  OAUTH_API_BASE               http://aibox-app:3100 (réseau docker)
  CONNECTOR_INTERNAL_TOKEN     shared secret avec aibox-app .env
  OAUTH_CONNECTOR_SLUG         défaut "onedrive"
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
import traceback
from pathlib import Path
from typing import Iterator

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm
from tenacity import retry, stop_after_attempt, wait_exponential
from unstructured.partition.auto import partition

# Chemin vers _lib partagé. Bind-mount défini dans docker-compose.yml du
# connector. Cf services/connectors/_lib/oauth.py.
sys.path.insert(0, "/lib_shared")

# ---------------------------------------------------------------- Config
AUTH_MODE = os.environ.get("AUTH_MODE", "client_credentials").strip().lower()

MS_TENANT_ID = os.environ.get("MS_TENANT_ID", "")
MS_CLIENT_ID = os.environ.get("MS_CLIENT_ID", "")
MS_CLIENT_SECRET = os.environ.get("MS_CLIENT_SECRET", "")
MS_DRIVE_ID = os.environ.get("MS_DRIVE_ID", "")
MS_SITE_ID = os.environ.get("MS_SITE_ID", "")

if AUTH_MODE == "client_credentials" and (
    not MS_TENANT_ID or not MS_CLIENT_ID or not MS_CLIENT_SECRET
):
    raise RuntimeError(
        "AUTH_MODE=client_credentials requires MS_TENANT_ID + MS_CLIENT_ID + "
        "MS_CLIENT_SECRET env vars",
    )

TENANT_ID = os.environ.get("TENANT_ID", "default")
COLLECTION = f"rag_msgraph_{TENANT_ID}"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.environ.get("LLM_EMBED", "bge-m3")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://aibox-qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY") or None

SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "30"))
INCLUDE_EXT = {e.strip().lower() for e in os.environ.get(
    "INCLUDE_EXT", ".pdf,.docx,.xlsx,.pptx,.txt,.md,.html"
).split(",") if e.strip()}
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "50"))
CHUNK_TOKENS = int(os.environ.get("CHUNK_TOKENS", "800"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "100"))

# Persiste le delta token entre les runs (pour ne pas tout retraiter)
DELTA_FILE = Path(os.environ.get("DELTA_FILE", "/data/delta.token"))
DELTA_FILE.parent.mkdir(parents=True, exist_ok=True)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rag-msgraph")


# ---------------------------------------------------------------- Auth
_msal_app = None
_oauth_source = None


def _get_msal_app():
    global _msal_app
    if _msal_app is None:
        from msal import ConfidentialClientApplication
        _msal_app = ConfidentialClientApplication(
            client_id=MS_CLIENT_ID,
            client_credential=MS_CLIENT_SECRET,
            authority=f"https://login.microsoftonline.com/{MS_TENANT_ID}",
        )
    return _msal_app


def _get_oauth_source():
    global _oauth_source
    if _oauth_source is None:
        from oauth import OAuthTokenSource  # services/connectors/_lib/oauth.py
        _oauth_source = OAuthTokenSource(
            provider="microsoft",
            connector_slug=os.environ.get("OAUTH_CONNECTOR_SLUG", "onedrive"),
        )
    return _oauth_source


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=20))
def get_access_token() -> str:
    if AUTH_MODE == "oauth":
        return _get_oauth_source().token()
    res = _get_msal_app().acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in res:
        raise RuntimeError(f"Token acquisition failed: {res.get('error_description')}")
    return res["access_token"]


def graph_get(path: str, params: dict | None = None) -> dict:
    token = get_access_token()
    with httpx.Client(timeout=60.0) as c:
        r = c.get(f"{GRAPH_BASE}{path}", headers={"Authorization": f"Bearer {token}"}, params=params)
        if r.status_code == 429:
            wait = int(r.headers.get("Retry-After", "10"))
            log.warning("Rate-limited, sleep %ds", wait)
            time.sleep(wait)
            return graph_get(path, params)
        r.raise_for_status()
        return r.json()


def graph_get_url(url: str) -> dict:
    """Pour suivre `@odata.nextLink` qui contient l'URL absolue."""
    token = get_access_token()
    with httpx.Client(timeout=60.0) as c:
        r = c.get(url, headers={"Authorization": f"Bearer {token}"})
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "10")))
            return graph_get_url(url)
        r.raise_for_status()
        return r.json()


def download_file(item_id: str, drive_id: str) -> bytes:
    token = get_access_token()
    url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}/content"
    with httpx.Client(timeout=300.0, follow_redirects=True) as c:
        r = c.get(url, headers={"Authorization": f"Bearer {token}"})
        r.raise_for_status()
        return r.content


# ---------------------------------------------------------------- Drive resolution
def resolve_drive_id() -> str:
    if MS_DRIVE_ID:
        return MS_DRIVE_ID
    if MS_SITE_ID:
        # Drive par défaut du site SharePoint
        d = graph_get(f"/sites/{MS_SITE_ID}/drive")
        return d["id"]
    raise RuntimeError("Configure MS_DRIVE_ID ou MS_SITE_ID")


# ---------------------------------------------------------------- Delta walk
def iter_delta_changes(drive_id: str) -> Iterator[dict]:
    """Itère les changements depuis le dernier delta token (ou full scan si premier run)."""
    if DELTA_FILE.exists():
        url = DELTA_FILE.read_text().strip()
        log.info("Reprise delta depuis %s", url[:80])
    else:
        url = f"{GRAPH_BASE}/drives/{drive_id}/root/delta"
        log.info("Premier run — full scan via delta")

    while True:
        data = graph_get_url(url)
        for item in data.get("value", []):
            yield item

        if "@odata.nextLink" in data:
            url = data["@odata.nextLink"]
        elif "@odata.deltaLink" in data:
            DELTA_FILE.write_text(data["@odata.deltaLink"])
            log.info("Delta token sauvegardé pour la prochaine sync")
            return
        else:
            return


def get_item_acl_groups(drive_id: str, item_id: str) -> list[str]:
    """Liste les groupes/users autorisés sur cet item (pour propagation ACL)."""
    try:
        perms = graph_get(f"/drives/{drive_id}/items/{item_id}/permissions")
        acls = []
        for p in perms.get("value", []):
            if "grantedToV2" in p:
                g = p["grantedToV2"]
                if "group" in g and "id" in g["group"]:
                    acls.append(f"group:{g['group']['id']}")
                elif "user" in g and "id" in g["user"]:
                    acls.append(f"user:{g['user']['id']}")
        return acls
    except Exception as e:
        log.warning("ACL lookup failed for %s: %s", item_id, e)
        return []


# ---------------------------------------------------------------- Indexation
def chunk_text(text: str) -> list[str]:
    target = CHUNK_TOKENS * 4
    overlap = CHUNK_OVERLAP * 4
    if len(text) <= target:
        return [text] if text.strip() else []
    chunks, i = [], 0
    while i < len(text):
        chunks.append(text[i:i + target])
        i += target - overlap
    return chunks


def parse_to_chunks(filename: str, raw: bytes) -> list[str]:
    tmp = Path("/tmp") / Path(filename).name
    tmp.write_bytes(raw)
    try:
        elements = partition(filename=str(tmp))
        text = "\n".join(str(el) for el in elements if str(el).strip())
        return chunk_text(text)
    except Exception as e:
        log.warning("parse %s : %s", filename, e)
        return []
    finally:
        tmp.unlink(missing_ok=True)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
def embed_batch(texts: list[str]) -> list[list[float]]:
    out = []
    with httpx.Client(base_url=OLLAMA_URL, timeout=60.0) as c:
        for t in texts:
            r = c.post("/api/embeddings", json={"model": EMBED_MODEL, "prompt": t})
            r.raise_for_status()
            out.append(r.json()["embedding"])
    return out


def ensure_collection(qd: QdrantClient, dim: int) -> None:
    if not qd.collection_exists(COLLECTION):
        qd.create_collection(
            collection_name=COLLECTION,
            vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE),
        )
        # Index sur les ACL pour filtrage rapide
        qd.create_payload_index(COLLECTION, "acl_groups", qm.PayloadSchemaType.KEYWORD)
        qd.create_payload_index(COLLECTION, "item_id", qm.PayloadSchemaType.KEYWORD)
        log.info("Collection créée : %s", COLLECTION)


def stable_id(item_id: str, chunk_idx: int, h: str) -> str:
    return hashlib.sha256(f"{item_id}|{chunk_idx}|{h}".encode()).hexdigest()


def delete_item(qd: QdrantClient, item_id: str) -> None:
    qd.delete(
        collection_name=COLLECTION,
        points_selector=qm.FilterSelector(filter=qm.Filter(must=[
            qm.FieldCondition(key="item_id", match=qm.MatchValue(value=item_id))
        ])),
    )


def index_item(qd: QdrantClient, drive_id: str, item: dict) -> int:
    if "deleted" in item:
        delete_item(qd, item["id"])
        log.info("supprimé: %s", item.get("name", item["id"]))
        return 0
    if item.get("folder"):
        return 0
    name = item.get("name", "")
    ext = Path(name).suffix.lower()
    if ext not in INCLUDE_EXT:
        return 0
    size = item.get("size", 0)
    if size > MAX_FILE_MB * 1024 * 1024:
        log.debug("trop gros: %s", name)
        return 0

    raw = download_file(item["id"], drive_id)
    chunks = parse_to_chunks(name, raw)
    if not chunks:
        return 0

    file_hash = hashlib.sha256(raw).hexdigest()
    embeds = embed_batch(chunks)
    if not embeds:
        return 0

    ensure_collection(qd, len(embeds[0]))
    delete_item(qd, item["id"])  # remplace l'ancienne version

    acl_groups = get_item_acl_groups(drive_id, item["id"])
    web_url = item.get("webUrl", "")

    points = [
        qm.PointStruct(
            id=stable_id(item["id"], i, file_hash),
            vector=v,
            payload={
                "tenant_id": TENANT_ID,
                "source": "msgraph",
                "item_id": item["id"],
                "name": name,
                "web_url": web_url,
                "file_hash": file_hash,
                "chunk_idx": i,
                "text": chunks[i],
                "acl_groups": acl_groups,
                "modified_at": item.get("lastModifiedDateTime", ""),
            },
        )
        for i, v in enumerate(embeds)
    ]
    qd.upsert(collection_name=COLLECTION, points=points)
    log.info("indexé: %s (%d chunks, %d ACLs)", name, len(points), len(acl_groups))
    return len(points)


def sync_once() -> dict:
    log.info("=== Sync MS Graph start ===")
    qd = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
    drive_id = resolve_drive_id()
    log.info("Drive: %s", drive_id)

    total_items, added, errors = 0, 0, 0
    for item in iter_delta_changes(drive_id):
        total_items += 1
        try:
            added += index_item(qd, drive_id, item)
        except Exception as e:
            errors += 1
            log.error("erreur item %s : %s", item.get("name", item.get("id")), e)
            log.debug(traceback.format_exc())
    return {"items": total_items, "chunks_added": added, "errors": errors}


def main() -> None:
    log.info("rag-msgraph démarré (interval=%dmin, collection=%s)", SYNC_INTERVAL_MINUTES, COLLECTION)
    while True:
        try:
            stats = sync_once()
            log.info("=== Sync OK : %s ===", stats)
        except Exception as e:
            log.error("Erreur sync : %s", e)
            log.debug(traceback.format_exc())
        time.sleep(SYNC_INTERVAL_MINUTES * 60)


if __name__ == "__main__":
    sys.exit(main())
