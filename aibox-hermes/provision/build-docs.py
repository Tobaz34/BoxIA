#!/usr/bin/env python3
# =============================================================================
# Génère la doc Hermes EN LOCAL pour le lecteur AI Box (offline, update-safe).
# Lit la doc Docusaurus de Hermes (website/docs) et produit, dans le web-root :
#   <out>/content/<chemin>.md   copie brute (arbo préservée → liens relatifs OK)
#   <out>/index.json            arbre de navigation (catégories/sous-cat/pages)
# Ne modifie JAMAIS la source. Snapshot reproductible : rejouer après une MAJ
# Hermes pour rafraîchir la doc embarquée.
#
# Usage : build-docs.py [<docs_dir>] [<out_dir>]
#   docs_dir def. ~/hermes-agent/website/docs
#   out_dir  def. /opt/aibox-web/docs
# =============================================================================
import json, os, re, shutil, sys

DOCS = os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else "~/hermes-agent/website/docs")
OUT  = sys.argv[2] if len(sys.argv) > 2 else "/opt/aibox-web/docs"

FM = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.S)

def parse_fm(text):
    m = FM.match(text)
    d = {}
    if m:
        for line in m.group(1).splitlines():
            mm = re.match(r"\s*([A-Za-z_]+)\s*:\s*(.+?)\s*$", line)
            if mm:
                d[mm.group(1)] = mm.group(2).strip().strip("\"'")
    return d

def humanize(name):
    return name.replace("-", " ").replace("_", " ").strip().title() or "Accueil"

def h1_title(text, fallback):
    for line in text.splitlines():
        h = re.match(r"#\s+(.+)", line)
        if h:
            return h.group(1).strip()
    return fallback

# --- catégories (_category_.json) -------------------------------------------
cat_meta = {}  # rel dir -> {label, position}

# --- pages -------------------------------------------------------------------
content_out = os.path.join(OUT, "content")
if os.path.isdir(content_out):
    shutil.rmtree(content_out)
os.makedirs(content_out, exist_ok=True)

pages = []
for root, _dirs, files in os.walk(DOCS):
    rel = os.path.relpath(root, DOCS)
    rel = "" if rel == "." else rel.replace(os.sep, "/")
    cj = os.path.join(root, "_category_.json")
    if os.path.exists(cj):
        try:
            j = json.load(open(cj, encoding="utf-8"))
            cat_meta[rel] = {"label": j.get("label", humanize(os.path.basename(root))),
                             "position": float(j.get("position", 999))}
        except Exception:
            pass
    for f in files:
        if not (f.endswith(".md") or f.endswith(".mdx")):
            continue
        src = os.path.join(root, f)
        text = open(src, encoding="utf-8", errors="replace").read()
        fm = parse_fm(text)
        relid = (rel + "/" + f) if rel else f
        relid = relid[:-4] if relid.endswith(".mdx") else relid[:-3]
        docid = "index" if fm.get("slug") == "/" else relid
        title = fm.get("title") or fm.get("sidebar_label") or h1_title(text, humanize(os.path.basename(relid)))
        try:
            pos = float(fm.get("sidebar_position", 999))
        except Exception:
            pos = 999.0
        dst = os.path.join(content_out, docid + ".md")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(src, dst)
        pages.append({"id": docid, "title": title, "position": pos})

# --- arbre de navigation (récursif, profondeur quelconque) -------------------
root_node = {"label": "Documentation", "position": -1, "path": "", "dirs": {}, "pages": []}

def get_dir(parts):
    node, acc = root_node, ""
    for p in parts:
        acc = (acc + "/" + p) if acc else p
        if p not in node["dirs"]:
            meta = cat_meta.get(acc, {})
            node["dirs"][p] = {"label": meta.get("label", humanize(p)),
                               "position": meta.get("position", 999.0),
                               "path": acc, "dirs": {}, "pages": []}
        node = node["dirs"][p]
    return node

for pg in pages:
    if pg["id"] == "index":
        continue  # = page d'accueil, pas dans la nav
    parts = pg["id"].split("/")
    node = get_dir(parts[:-1]) if len(parts) > 1 else root_node
    node["pages"].append(pg)

def serialize(node):
    dirs = sorted(node["dirs"].values(), key=lambda d: (d["position"], d["label"]))
    pgs = sorted(node["pages"], key=lambda p: (p["position"], p["title"]))
    return {
        "pages": [{"id": p["id"], "title": p["title"]} for p in pgs],
        "dirs": [dict(label=d["label"], **serialize(d)) for d in dirs],
    }

index = dict(home="index", title="Documentation Hermes", **serialize(root_node))
os.makedirs(OUT, exist_ok=True)
json.dump(index, open(os.path.join(OUT, "index.json"), "w", encoding="utf-8"),
          ensure_ascii=False)

# compte
n_pages = len(pages)
n_cats = len(cat_meta)
print(f"build-docs: {n_pages} pages, {n_cats} catégories -> {OUT}")
