"""AI Box — serveur MCP SharePoint / OneDrive (Microsoft Graph, app-only).

Réutilise la même App Registration Entra que le connecteur email-msgraph
(mêmes MSGRAPH_TENANT_ID/CLIENT_ID/CLIENT_SECRET) ; nécessite en plus les
permissions application Sites.Read.All + Files.Read.All (consentement admin).

Lecture seule (aucun tool mutatif). Attention : Files.Read.All / Sites.Read.All
sont TENANT-WIDE — l'agent peut lire tous les sites/fichiers du tenant ; c'est
le compte d'app qui porte le périmètre. À restreindre côté M365 si besoin
(sites-selected + Sites.Selected serait plus fin, mais plus complexe).

Env :
  MSGRAPH_TENANT_ID / MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET
  MSGRAPH_TIMEOUT   timeout HTTP (def: 30)

Test local :
  pip install -r requirements.txt
  fastmcp inspect server.py:mcp
"""
from __future__ import annotations

import os
from typing import Any

import httpx
import msal
from fastmcp import FastMCP

mcp = FastMCP("msfiles")

TENANT_ID = os.getenv("MSGRAPH_TENANT_ID", "")
CLIENT_ID = os.getenv("MSGRAPH_CLIENT_ID", "")
CLIENT_SECRET = os.getenv("MSGRAPH_CLIENT_SECRET", "")
TIMEOUT = float(os.getenv("MSGRAPH_TIMEOUT", "30"))
GRAPH = "https://graph.microsoft.com/v1.0"

_app: msal.ConfidentialClientApplication | None = None


def _token() -> str:
    global _app
    if not (TENANT_ID and CLIENT_ID and CLIENT_SECRET):
        raise RuntimeError("MSGRAPH_TENANT_ID / MSGRAPH_CLIENT_ID / MSGRAPH_CLIENT_SECRET manquants")
    if _app is None:
        _app = msal.ConfidentialClientApplication(
            CLIENT_ID, authority=f"https://login.microsoftonline.com/{TENANT_ID}",
            client_credential=CLIENT_SECRET,
        )
    r = _app.acquire_token_silent(["https://graph.microsoft.com/.default"], account=None) \
        or _app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
    if "access_token" not in r:
        raise RuntimeError(f"Auth Graph échouée: {r.get('error_description', r)}")
    return r["access_token"]


def _get(path: str, params: dict[str, Any] | None = None) -> Any:
    url = path if path.startswith("http") else f"{GRAPH}{path}"
    headers = {"Authorization": f"Bearer {_token()}", "Accept": "application/json"}
    with httpx.Client(timeout=TIMEOUT, headers=headers) as c:
        r = c.get(url, params=params or None)
        r.raise_for_status()
        return r.json() if r.content else {}


def _item(it: dict) -> dict[str, Any]:
    return {
        "id": it.get("id"),
        "name": it.get("name"),
        "is_folder": "folder" in it,
        "size": it.get("size"),
        "modified": it.get("lastModifiedDateTime"),
        "web_url": it.get("webUrl"),
        "drive_id": (it.get("parentReference") or {}).get("driveId"),
    }


@mcp.tool
def msfiles_health() -> dict[str, Any]:
    """Vérifie l'accès Graph fichiers/sites (auth + 1 site listé)."""
    _token()
    data = _get("/sites", {"search": "*", "$top": 1})
    return {"ok": True, "sample_site": (data.get("value") or [{}])[0].get("displayName")}


@mcp.tool
def list_sharepoint_sites(query: str = "", limit: int = 20) -> list[dict[str, Any]]:
    """Liste les sites SharePoint (nom, url, id). query filtre par nom. Lecture seule."""
    data = _get("/sites", {"search": query or "*", "$top": max(1, min(int(limit), 50))})
    return [{"id": s.get("id"), "name": s.get("displayName") or s.get("name"),
             "web_url": s.get("webUrl")} for s in data.get("value", [])]


@mcp.tool
def list_site_drives(site_id: str) -> list[dict[str, Any]]:
    """Liste les bibliothèques de documents (drives) d'un site SharePoint. Lecture seule."""
    data = _get(f"/sites/{site_id}/drives")
    return [{"id": d.get("id"), "name": d.get("name"), "web_url": d.get("webUrl")}
            for d in data.get("value", [])]


@mcp.tool
def list_files(drive_id: str, folder_path: str = "", limit: int = 50) -> list[dict[str, Any]]:
    """Liste fichiers/dossiers d'un drive. folder_path vide = racine. Lecture seule."""
    fp = folder_path.strip("/")
    base = f"/drives/{drive_id}/root/children" if not fp else f"/drives/{drive_id}/root:/{fp}:/children"
    data = _get(base, {"$top": max(1, min(int(limit), 200))})
    return [_item(it) for it in data.get("value", [])]


@mcp.tool
def search_files(query: str, drive_id: str = "", site_id: str = "", limit: int = 25) -> list[dict[str, Any]]:
    """Recherche des fichiers par nom/contenu. Fournir drive_id OU site_id. Lecture seule."""
    if drive_id:
        base = f"/drives/{drive_id}/root/search(q='{query}')"
    elif site_id:
        base = f"/sites/{site_id}/drive/root/search(q='{query}')"
    else:
        raise RuntimeError("Fournir drive_id ou site_id.")
    data = _get(base, {"$top": max(1, min(int(limit), 100))})
    return [_item(it) for it in data.get("value", [])]


@mcp.tool
def list_onedrive(user_email: str, folder_path: str = "", limit: int = 50) -> list[dict[str, Any]]:
    """Liste le OneDrive d'un utilisateur (par email). folder_path vide = racine. Lecture seule."""
    fp = folder_path.strip("/")
    base = f"/users/{user_email}/drive/root/children" if not fp else f"/users/{user_email}/drive/root:/{fp}:/children"
    data = _get(base, {"$top": max(1, min(int(limit), 200))})
    return [_item(it) for it in data.get("value", [])]


@mcp.tool
def read_file(drive_id: str, item_id: str, max_chars: int = 8000) -> dict[str, Any]:
    """Lit le contenu texte d'un fichier (drive_id + item_id). Renvoie métadonnées +
    contenu tronqué pour les fichiers texte ; sinon un lien de téléchargement. Lecture seule."""
    meta = _get(f"/drives/{drive_id}/items/{item_id}")
    out = _item(meta)
    name = (meta.get("name") or "").lower()
    texty = name.endswith((".txt", ".md", ".csv", ".json", ".log", ".xml", ".html", ".htm"))
    if texty:
        headers = {"Authorization": f"Bearer {_token()}"}
        with httpx.Client(timeout=TIMEOUT, headers=headers) as c:
            r = c.get(f"{GRAPH}/drives/{drive_id}/items/{item_id}/content", follow_redirects=True)
            r.raise_for_status()
            out["content"] = r.text[:max_chars]
    else:
        out["download_url"] = meta.get("@microsoft.graph.downloadUrl")
        out["note"] = "Fichier non-texte : utiliser download_url (Office/PDF nécessitent un traitement dédié)."
    return out


if __name__ == "__main__":
    mcp.run()
