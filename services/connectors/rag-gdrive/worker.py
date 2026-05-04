"""
RAG Google Drive — indexe Drive (My Drive ou Shared Drive) dans Qdrant.

Auth : 2 modes via AUTH_MODE :
  - "service_account" (legacy, default) : Service Account avec domain-wide
    delegation. Variables GOOGLE_SERVICE_ACCOUNT_JSON + GOOGLE_SUBJECT_EMAIL
    requises. Adapté à un déploiement admin centralisé.
  - "oauth" (recommandé prod multi-user) : utilise le token OAuth user
    saisi via /connectors UI (cf services/app/src/lib/oauth-oidc.ts).
    Variables OAUTH_API_BASE + CONNECTOR_INTERNAL_TOKEN requises. Le worker
    indexe alors le Drive du user qui a autorisé.

Sync : Drive Changes API (token de page persisté → diff incrémental).

Variables communes :
  TENANT_ID                    ID isolation par tenant pour la collection Qdrant
  OLLAMA_URL, LLM_EMBED, QDRANT_URL, QDRANT_API_KEY
  SYNC_INTERVAL_MINUTES (default 30)
  INCLUDE_MIME             default = whitelist standard

Variables mode service_account :
  GOOGLE_SERVICE_ACCOUNT_JSON  chemin du JSON SA monté
  GOOGLE_SUBJECT_EMAIL         user dont le drive est indexé (DWD)
  GOOGLE_DRIVE_ID              optionnel (Shared Drive)

Variables mode oauth :
  OAUTH_API_BASE               ex: http://aibox-app:3100 (depuis container)
                                ou http://localhost:3100 (host mode)
  CONNECTOR_INTERNAL_TOKEN     shared secret avec aibox-app .env
  OAUTH_CONNECTOR_SLUG         défaut "google-drive"
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import sys
import time
import traceback
from pathlib import Path

import httpx
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm
from tenacity import retry, stop_after_attempt, wait_exponential
from unstructured.partition.auto import partition

# Chemin vers _lib partagé. Bind-mount défini dans docker-compose.yml du
# connector. Cf services/connectors/_lib/oauth.py pour OAuthTokenSource.
sys.path.insert(0, "/lib_shared")

# ---- Config ----
AUTH_MODE = os.environ.get("AUTH_MODE", "service_account").strip().lower()

DRIVE_ID = os.environ.get("GOOGLE_DRIVE_ID", "")  # vide = "My Drive" du subject

# En mode service_account, ces vars sont obligatoires. En mode oauth on
# n'y touche pas (TENANT_ID prend la valeur ou un fallback dérivé du email).
SA_JSON = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON", "")
SUBJECT_EMAIL = os.environ.get("GOOGLE_SUBJECT_EMAIL", "")

if AUTH_MODE == "service_account" and (not SA_JSON or not SUBJECT_EMAIL):
    raise RuntimeError(
        "AUTH_MODE=service_account requires GOOGLE_SERVICE_ACCOUNT_JSON and "
        "GOOGLE_SUBJECT_EMAIL env vars",
    )

TENANT_ID = os.environ.get("TENANT_ID", "default")
COLLECTION = f"rag_gdrive_{TENANT_ID}"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.environ.get("LLM_EMBED", "bge-m3")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://aibox-qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY") or None
SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "30"))

INCLUDE_MIME = set(filter(None, os.environ.get(
    "INCLUDE_MIME",
    "application/pdf,"
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document,"
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,"
    "application/vnd.openxmlformats-officedocument.presentationml.presentation,"
    "text/plain,text/markdown,text/html,"
    # Google Docs natifs (export en docx/xlsx/pdf)
    "application/vnd.google-apps.document,"
    "application/vnd.google-apps.spreadsheet,"
    "application/vnd.google-apps.presentation"
).split(",")))

EXPORT_MAP = {
    "application/vnd.google-apps.document": ("application/pdf", ".pdf"),
    "application/vnd.google-apps.spreadsheet": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx"
    ),
    "application/vnd.google-apps.presentation": ("application/pdf", ".pdf"),
}

STATE_DIR = Path(os.environ.get("STATE_DIR", "/data"))
STATE_DIR.mkdir(parents=True, exist_ok=True)
PAGE_TOKEN_FILE = STATE_DIR / "page_token.txt"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rag-gdrive")

SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
]


# Source de tokens partagée (mode oauth uniquement). Initialisée lazy pour
# ne pas planter en mode service_account si OAUTH_API_BASE absent.
_oauth_source = None


def _get_oauth_source():
    global _oauth_source
    if _oauth_source is None:
        from oauth import OAuthTokenSource  # services/connectors/_lib/oauth.py
        _oauth_source = OAuthTokenSource(
            provider="google",
            connector_slug=os.environ.get("OAUTH_CONNECTOR_SLUG", "google-drive"),
        )
    return _oauth_source


def drive_service():
    """Retourne un client googleapiclient.Drive v3 selon AUTH_MODE.

    En mode oauth, on rebuild le client à chaque appel pour avoir un token
    frais (le helper cache 60s côté worker). googleapiclient ne support pas
    nativement les credentials qui se rafraîchissent côté serveur, on
    contourne en passant le bearer token chaque fois.
    """
    if AUTH_MODE == "oauth":
        from google.oauth2.credentials import Credentials
        access_token = _get_oauth_source().token()
        creds = Credentials(token=access_token)
        return build("drive", "v3", credentials=creds, cache_discovery=False)
    # service_account legacy
    from google.oauth2 import service_account
    creds = service_account.Credentials.from_service_account_file(
        SA_JSON, scopes=SCOPES,
    ).with_subject(SUBJECT_EMAIL)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
def get_start_page_token(svc) -> str:
    args = {"supportsAllDrives": True}
    if DRIVE_ID:
        args["driveId"] = DRIVE_ID
    return svc.changes().getStartPageToken(**args).execute()["startPageToken"]


def list_changes(svc, page_token: str | None):
    args = {
        "pageToken": page_token,
        "spaces": "drive",
        "fields": "newStartPageToken,nextPageToken,changes(removed,fileId,file(id,name,mimeType,modifiedTime,webViewLink,permissions(emailAddress,role,type),size,driveId))",
        "supportsAllDrives": True,
        "includeItemsFromAllDrives": True,
        "pageSize": 100,
    }
    if DRIVE_ID:
        args["driveId"] = DRIVE_ID
        args["includeRemoved"] = True
    return svc.changes().list(**args).execute()


def list_initial(svc):
    """Premier scan : liste tous les fichiers (depuis 1970)."""
    args = {
        "spaces": "drive",
        "fields": "nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink,permissions(emailAddress,role,type),size,driveId)",
        "supportsAllDrives": True,
        "includeItemsFromAllDrives": True,
        "pageSize": 100,
    }
    if DRIVE_ID:
        args["driveId"] = DRIVE_ID
        args["corpora"] = "drive"
    page_token = None
    while True:
        if page_token:
            args["pageToken"] = page_token
        res = svc.files().list(**args).execute()
        for f in res.get("files", []):
            yield f
        page_token = res.get("nextPageToken")
        if not page_token:
            break


def download_file(svc, file_id: str, mime: str) -> tuple[bytes, str]:
    """Retourne (raw, ext) — exporte si Google Doc natif."""
    if mime in EXPORT_MAP:
        export_mime, ext = EXPORT_MAP[mime]
        request = svc.files().export_media(fileId=file_id, mimeType=export_mime)
    else:
        ext = ""
        request = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
    buf = io.BytesIO()
    downloader = MediaIoBaseDownload(buf, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buf.getvalue(), ext


def chunk_text(text: str, target=3200, overlap=400) -> list[str]:
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
        log.warning("parse %s: %s", filename, e)
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


def ensure_collection(qd, dim: int) -> None:
    if not qd.collection_exists(COLLECTION):
        qd.create_collection(
            collection_name=COLLECTION,
            vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE),
        )
        qd.create_payload_index(COLLECTION, "file_id", qm.PayloadSchemaType.KEYWORD)
        qd.create_payload_index(COLLECTION, "acl_users", qm.PayloadSchemaType.KEYWORD)
        log.info("Collection créée : %s", COLLECTION)


def stable_id(file_id: str, idx: int, h: str) -> str:
    return hashlib.sha256(f"{file_id}|{idx}|{h}".encode()).hexdigest()


def delete_file(qd, file_id: str) -> None:
    qd.delete(
        collection_name=COLLECTION,
        points_selector=qm.FilterSelector(filter=qm.Filter(must=[
            qm.FieldCondition(key="file_id", match=qm.MatchValue(value=file_id))
        ])),
    )


def index_file(qd, svc, f: dict) -> int:
    if f.get("mimeType") not in INCLUDE_MIME:
        return 0
    fid = f["id"]
    try:
        raw, _ = download_file(svc, fid, f["mimeType"])
    except Exception as e:
        log.warning("download %s : %s", f.get("name"), e)
        return 0
    if not raw:
        return 0

    chunks = parse_to_chunks(f.get("name", "file"), raw)
    if not chunks:
        return 0

    embeds = embed_batch(chunks)
    if not embeds:
        return 0

    file_hash = hashlib.sha256(raw).hexdigest()
    ensure_collection(qd, len(embeds[0]))
    delete_file(qd, fid)

    acl_users = [
        p["emailAddress"]
        for p in (f.get("permissions") or [])
        if p.get("type") == "user" and p.get("emailAddress")
    ]

    points = [
        qm.PointStruct(
            id=stable_id(fid, i, file_hash),
            vector=v,
            payload={
                "tenant_id": TENANT_ID,
                "source": "gdrive",
                "file_id": fid,
                "name": f.get("name", ""),
                "web_url": f.get("webViewLink", ""),
                "modified_at": f.get("modifiedTime", ""),
                "file_hash": file_hash,
                "chunk_idx": i,
                "text": chunks[i],
                "acl_users": acl_users,
            },
        )
        for i, v in enumerate(embeds)
    ]
    qd.upsert(collection_name=COLLECTION, points=points)
    log.info("indexé: %s (%d chunks)", f.get("name"), len(points))
    return len(points)


def sync_once() -> dict:
    log.info("=== Sync GDrive start ===")
    qd = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
    svc = drive_service()

    if not PAGE_TOKEN_FILE.exists():
        # Premier run : full scan, puis on enregistre le startPageToken pour la suite
        log.info("Premier run — full scan")
        added, errors = 0, 0
        for f in list_initial(svc):
            try:
                added += index_file(qd, svc, f)
            except Exception as e:
                errors += 1
                log.error("err %s : %s", f.get("name"), e)
        token = get_start_page_token(svc)
        PAGE_TOKEN_FILE.write_text(token)
        return {"mode": "initial", "chunks_added": added, "errors": errors}

    # Mode incrémental
    page_token = PAGE_TOKEN_FILE.read_text().strip()
    added, errors, removed = 0, 0, 0
    while page_token:
        res = list_changes(svc, page_token)
        for ch in res.get("changes", []):
            if ch.get("removed"):
                delete_file(qd, ch["fileId"])
                removed += 1
                continue
            f = ch.get("file") or {}
            try:
                added += index_file(qd, svc, f)
            except Exception as e:
                errors += 1
                log.error("err %s : %s", f.get("name"), e)
        if "newStartPageToken" in res:
            PAGE_TOKEN_FILE.write_text(res["newStartPageToken"])
            page_token = None
        else:
            page_token = res.get("nextPageToken", "")
    return {"mode": "delta", "chunks_added": added, "removed": removed, "errors": errors}


def main() -> None:
    log.info("rag-gdrive démarré (subject=%s, collection=%s)", SUBJECT_EMAIL, COLLECTION)
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
