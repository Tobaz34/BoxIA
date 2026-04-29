"""
RAG Nextcloud — indexe Nextcloud via WebDAV.

Variables :
  NEXTCLOUD_URL         https://cloud.acme.fr
  NEXTCLOUD_USER
  NEXTCLOUD_PASSWORD    (mot de passe ou app password)
  NEXTCLOUD_PATH        chemin de départ (/Documents par défaut)
  + standard (TENANT_ID, OLLAMA_URL, LLM_EMBED, QDRANT_URL, QDRANT_API_KEY)
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
import traceback
from pathlib import Path

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm
from tenacity import retry, stop_after_attempt, wait_exponential
from unstructured.partition.auto import partition
from webdav3.client import Client as WebDAVClient

NC_URL = os.environ["NEXTCLOUD_URL"].rstrip("/")
NC_USER = os.environ["NEXTCLOUD_USER"]
NC_PASS = os.environ["NEXTCLOUD_PASSWORD"]
NC_PATH = os.environ.get("NEXTCLOUD_PATH", "/")

TENANT_ID = os.environ.get("TENANT_ID", "default")
COLLECTION = f"rag_nextcloud_{TENANT_ID}"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.environ.get("LLM_EMBED", "bge-m3")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://aibox-qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY") or None
SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "60"))
INCLUDE_EXT = {e.strip().lower() for e in os.environ.get(
    "INCLUDE_EXT", ".pdf,.docx,.xlsx,.pptx,.txt,.md,.html"
).split(",") if e.strip()}
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "50"))

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("rag-nextcloud")


def webdav_client() -> WebDAVClient:
    return WebDAVClient({
        "webdav_hostname": f"{NC_URL}/remote.php/dav/files/{NC_USER}",
        "webdav_login": NC_USER,
        "webdav_password": NC_PASS,
    })


def walk_files(client: WebDAVClient, path: str = "/"):
    try:
        items = client.list(path, get_info=True)
    except Exception as e:
        log.warning("list %s: %s", path, e)
        return
    for it in items:
        rel = it.get("path", "")
        if rel in (path, path + "/", ""):
            continue
        if it.get("isdir"):
            yield from walk_files(client, rel)
        else:
            ext = Path(rel).suffix.lower()
            if ext not in INCLUDE_EXT:
                continue
            size = int(it.get("size") or 0)
            if size and size > MAX_FILE_MB * 1024 * 1024:
                continue
            yield it


def chunk_text(text: str, target=3200, overlap=400) -> list[str]:
    if len(text) <= target:
        return [text] if text.strip() else []
    chunks, i = [], 0
    while i < len(text):
        chunks.append(text[i:i + target])
        i += target - overlap
    return chunks


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
        qd.create_payload_index(COLLECTION, "path", qm.PayloadSchemaType.KEYWORD)


def index_one(qd: QdrantClient, client: WebDAVClient, item: dict) -> int:
    path = item["path"]
    local_tmp = Path("/tmp") / Path(path).name
    try:
        client.download_sync(remote_path=path, local_path=str(local_tmp))
    except Exception as e:
        log.warning("download %s: %s", path, e)
        return 0
    try:
        raw = local_tmp.read_bytes()
        elements = partition(filename=str(local_tmp))
        text = "\n".join(str(el) for el in elements if str(el).strip())
        chunks = chunk_text(text)
    finally:
        local_tmp.unlink(missing_ok=True)

    if not chunks:
        return 0

    file_hash = hashlib.sha256(raw).hexdigest()
    embeds = embed_batch(chunks)
    if not embeds:
        return 0

    ensure_collection(qd, len(embeds[0]))
    qd.delete(collection_name=COLLECTION, points_selector=qm.FilterSelector(
        filter=qm.Filter(must=[qm.FieldCondition(key="path", match=qm.MatchValue(value=path))])
    ))

    points = [
        qm.PointStruct(
            id=hashlib.sha256(f"{path}|{i}|{file_hash}".encode()).hexdigest(),
            vector=v,
            payload={
                "tenant_id": TENANT_ID,
                "source": "nextcloud",
                "path": path,
                "file_hash": file_hash,
                "chunk_idx": i,
                "text": chunks[i],
            },
        )
        for i, v in enumerate(embeds)
    ]
    qd.upsert(collection_name=COLLECTION, points=points)
    log.info("indexé: %s (%d chunks)", path, len(points))
    return len(points)


def sync_once() -> dict:
    log.info("=== Sync Nextcloud start ===")
    qd = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)
    client = webdav_client()
    added, errors = 0, 0
    for item in walk_files(client, NC_PATH):
        try:
            added += index_one(qd, client, item)
        except Exception as e:
            errors += 1
            log.error("err %s : %s", item.get("path"), e)
            log.debug(traceback.format_exc())
    return {"chunks_added": added, "errors": errors}


def main() -> None:
    log.info("rag-nextcloud démarré (host=%s, path=%s)", NC_URL, NC_PATH)
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
