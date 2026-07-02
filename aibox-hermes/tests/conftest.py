"""Rend les modules purs des plugins importables par leur nom de fichier.

Les dossiers de plugins ont des noms à tiret (non importables tels quels) ;
on injecte leur chemin dans sys.path pour pouvoir faire `import pii_patterns`
et `import approval_store` (ces modules n'ont pas d'import relatif).
"""
import os
import sys

_HERE = os.path.dirname(__file__)
_ROOT = os.path.dirname(_HERE)

for _p in ("plugins/aibox-rgpd", "plugins/aibox-approval", "plugins/aibox-audit", "cookbook",
           "skills/aibox-email-triage", "provision",
           "plugins/aibox-rights/dashboard"):
    sys.path.insert(0, os.path.join(_ROOT, _p))
