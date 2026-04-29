"""
RAG SMB worker — indexe un partage SMB/CIFS dans Qdrant.

Boucle :
1. Liste les fichiers du partage SMB (récursif)
2. Compare aux empreintes connues (hash + mtime) → diff
3. Pour chaque fichier nouveau/modifié :
   - download
   - parse (PDF, DOCX, XLSX, MD, TXT…) via Unstructured
   - chunk (par ~800 tokens avec overlap 100)
   - embed via Ollama bge-m3
   - upsert dans Qdrant (collection rag_smb_<TENANT_ID>)
4. Sleep `SYNC_INTERVAL_MINUTES` minutes, recommence.

Idempotent : les chunks déjà indexés (même hash) sont skippés.
Tolerant aux pannes : reprend où il s'est arrêté.
"""
from __future__ import annotations

import hashlib
import logging
import os
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import httpx
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm
from smbprotocol.connection import Connection
from smbprotocol.session import Session
from smbprotocol.tree import TreeConnect
from smbprotocol.open import (
    Open, CreateDisposition, CreateOptions, FilePipePrinterAccessMask,
    ImpersonationLevel, ShareAccess,
)
from smbprotocol.exceptions import SMBException
from tenacity import retry, stop_after_attempt, wait_exponential
from unstructured.partition.auto import partition

# ---------------------------------------------------------------- Configuration
SMB_HOST = os.environ["SMB_HOST"]
SMB_SHARE = os.environ["SMB_SHARE"]
SMB_USER = os.environ["SMB_USER"]
SMB_PASSWORD = os.environ["SMB_PASSWORD"]
SMB_DOMAIN = os.environ.get("SMB_DOMAIN", "")
SMB_SUBPATH = os.environ.get("SMB_SUBPATH", "").strip("/").replace("/", "\\")

TENANT_ID = os.environ.get("TENANT_ID", "default")
COLLECTION = f"rag_smb_{TENANT_ID}"

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.environ.get("LLM_EMBED", "bge-m3")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://aibox-qdrant:6333")
QDRANT_API_KEY = os.environ.get("QDRANT_API_KEY") or None

SYNC_INTERVAL_MINUTES = int(os.environ.get("SYNC_INTERVAL_MINUTES", "60"))
INCLUDE_EXT = {e.strip().lower() for e in os.environ.get(
    "INCLUDE_EXT", ".pdf,.docx,.xlsx,.pptx,.txt,.md,.html"
).split(",") if e.strip()}
MAX_FILE_MB = int(os.environ.get("MAX_FILE_MB", "50"))
CHUNK_TOKENS = int(os.environ.get("CHUNK_TOKENS", "800"))
CHUNK_OVERLAP = int(os.environ.get("CHUNK_OVERLAP", "100"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("rag-smb")


# ---------------------------------------------------------------- Helpers
@dataclass
class SmbFile:
    path: str               # chemin relatif depuis la racine du share
    size: int
    mtime: int              # epoch seconds


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=2, max=20))
def smb_session() -> tuple[Connection, Session, TreeConnect]:
    """Connexion SMB avec retry exponentiel."""
    conn = Connection(uuid=os.urandom(16), server_name=SMB_HOST, port=445)
    conn.connect(timeout=30)
    sess = Session(conn, username=SMB_USER, password=SMB_PASSWORD, domain=SMB_DOMAIN)
    sess.connect()
    tree = TreeConnect(sess, fr"\\{SMB_HOST}\{SMB_SHARE}")
    tree.connect()
    return conn, sess, tree


def list_smb_files(tree: TreeConnect, prefix: str = "") -> Iterator[SmbFile]:
    """Walk récursif d'un share SMB."""
    open_dir = Open(tree, prefix or "")
    open_dir.create(
        impersonation_level=ImpersonationLevel.Impersonation,
        desired_access=FilePipePrinterAccessMask.GENERIC_READ,
        file_attributes=0,
        share_access=ShareAccess.FILE_SHARE_READ,
        create_disposition=CreateDisposition.FILE_OPEN,
        create_options=CreateOptions.FILE_DIRECTORY_FILE,
    )
    try:
        entries = open_dir.query_directory("*", file_information_class=37)  # FileBothDirectoryInformation
    finally:
        open_dir.close()

    for e in entries:
        name = e["file_name"].get_value().decode("utf-16-le")
        if name in (".", ".."):
            continue
        full = f"{prefix}\\{name}" if prefix else name
        is_dir = bool(e["file_attributes"].get_value() & 0x10)
        if is_dir:
            yield from list_smb_files(tree, full)
        else:
            ext = Path(name).suffix.lower()
            if INCLUDE_EXT and ext not in INCLUDE_EXT:
                continue
            size = int(e["end_of_file"].get_value())
            if size > MAX_FILE_MB * 1024 * 1024:
                log.debug("skip too big: %s (%d MB)", full, size // 1024 // 1024)
                continue
            mtime = int(e["last_write_time"].get_value().timestamp())
            yield SmbFile(path=full, size=size, mtime=mtime)


def smb_read_file(tree: TreeConnect, smb_path: str) -> bytes:
    f = Open(tree, smb_path)
    f.create(
        impersonation_level=ImpersonationLevel.Impersonation,
        desired_access=FilePipePrinterAccessMask.GENERIC_READ,
        file_attributes=0,
        share_access=ShareAccess.FILE_SHARE_READ,
        create_disposition=CreateDisposition.FILE_OPEN,
        create_options=CreateOptions.FILE_NON_DIRECTORY_FILE,
    )
    try:
        size = f.end_of_file
        return f.read(0, size) if size > 0 else b""
    finally:
        f.close()


def parse_to_chunks(filename: str, raw: bytes) -> list[str]:
    """Parse un fichier (PDF, DOCX, etc.) → liste de chunks de texte."""
    tmp = Path("/tmp") / Path(filename).name
    tmp.write_bytes(raw)
    try:
        elements = partition(filename=str(tmp))
    except Exception as e:
        log.warning("Parse impossible %s : %s", filename, e)
        return []
    finally:
        tmp.unlink(missing_ok=True)

    text = "\n".join(str(el) for el in elements if str(el).strip())
    return chunk_text(text)


def chunk_text(text: str) -> list[str]:
    """Chunking simple par caractères (proxy ~4 chars/token)."""
    target = CHUNK_TOKENS * 4
    overlap = CHUNK_OVERLAP * 4
    if len(text) <= target:
        return [text] if text else []
    chunks, i = [], 0
    while i < len(text):
        chunks.append(text[i:i + target])
        i += target - overlap
    return chunks


@retry(stop=stop_after_attempt(3), wait=wait_exponential(min=1, max=10))
def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embeddings via Ollama (bge-m3 par défaut)."""
    out = []
    with httpx.Client(base_url=OLLAMA_URL, timeout=60.0) as client:
        for t in texts:
            r = client.post("/api/embeddings", json={"model": EMBED_MODEL, "prompt": t})
            r.raise_for_status()
            out.append(r.json()["embedding"])
    return out


def ensure_collection(qd: QdrantClient, dim: int) -> None:
    if not qd.collection_exists(COLLECTION):
        qd.create_collection(
            collection_name=COLLECTION,
            vectors_config=qm.VectorParams(size=dim, distance=qm.Distance.COSINE),
        )
        log.info("Collection Qdrant créée : %s (dim=%d)", COLLECTION, dim)


def stable_id(path: str, chunk_idx: int, h: str) -> str:
    return hashlib.sha256(f"{path}|{chunk_idx}|{h}".encode()).hexdigest()


def already_indexed_hashes(qd: QdrantClient, path: str) -> set[str]:
    """Retourne les hashes connus pour ce fichier (pour skip si pas changé)."""
    try:
        records, _ = qd.scroll(
            collection_name=COLLECTION,
            scroll_filter=qm.Filter(must=[qm.FieldCondition(
                key="path", match=qm.MatchValue(value=path)
            )]),
            limit=1,
            with_payload=["file_hash"],
            with_vectors=False,
        )
        return {r.payload.get("file_hash") for r in records if r.payload.get("file_hash")}
    except Exception:
        return set()


def index_file(qd: QdrantClient, tree: TreeConnect, f: SmbFile) -> int:
    """Indexe un fichier — retourne le nombre de chunks ajoutés."""
    raw = smb_read_file(tree, f.path)
    if not raw:
        return 0
    file_hash = hashlib.sha256(raw).hexdigest()
    known = already_indexed_hashes(qd, f.path)
    if file_hash in known:
        log.debug("inchangé: %s", f.path)
        return 0

    # Si fichier modifié : supprimer ses anciens chunks
    if known:
        qd.delete(
            collection_name=COLLECTION,
            points_selector=qm.FilterSelector(filter=qm.Filter(must=[
                qm.FieldCondition(key="path", match=qm.MatchValue(value=f.path))
            ])),
        )

    chunks = parse_to_chunks(f.path, raw)
    if not chunks:
        return 0

    embeds = embed_batch(chunks)
    if not embeds:
        return 0

    ensure_collection(qd, len(embeds[0]))

    points = [
        qm.PointStruct(
            id=stable_id(f.path, i, file_hash),
            vector=v,
            payload={
                "tenant_id": TENANT_ID,
                "source": "smb",
                "host": SMB_HOST,
                "share": SMB_SHARE,
                "path": f.path,
                "file_hash": file_hash,
                "chunk_idx": i,
                "text": chunks[i],
                "size": f.size,
                "mtime": f.mtime,
            },
        )
        for i, v in enumerate(embeds)
    ]
    qd.upsert(collection_name=COLLECTION, points=points)
    log.info("indexé: %s (%d chunks)", f.path, len(points))
    return len(points)


# ---------------------------------------------------------------- Main loop
def sync_once() -> dict:
    log.info("=== Sync start (host=%s share=%s) ===", SMB_HOST, SMB_SHARE)
    qd = QdrantClient(url=QDRANT_URL, api_key=QDRANT_API_KEY)

    conn, sess, tree = smb_session()
    try:
        files = list(list_smb_files(tree, SMB_SUBPATH))
        log.info("Fichiers candidats: %d", len(files))
        added = 0
        errors = 0
        for f in files:
            try:
                added += index_file(qd, tree, f)
            except Exception as e:
                errors += 1
                log.error("Erreur sur %s : %s", f.path, e)
                log.debug(traceback.format_exc())
        return {"files": len(files), "chunks_added": added, "errors": errors}
    finally:
        try: tree.disconnect()
        except: pass
        try: sess.disconnect()
        except: pass
        try: conn.disconnect()
        except: pass


def main() -> None:
    log.info("rag-smb démarrage — interval=%dmin collection=%s", SYNC_INTERVAL_MINUTES, COLLECTION)
    while True:
        try:
            stats = sync_once()
            log.info("=== Sync OK : %s ===", stats)
        except SMBException as e:
            log.error("Erreur SMB : %s", e)
        except Exception as e:
            log.error("Erreur fatale : %s", e)
            log.debug(traceback.format_exc())
        time.sleep(SYNC_INTERVAL_MINUTES * 60)


if __name__ == "__main__":
    sys.exit(main())
