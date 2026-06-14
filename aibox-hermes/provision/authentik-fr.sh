#!/usr/bin/env bash
# =============================================================================
# Force la locale FR sur Authentik (page de login / reset mdp / création user
# côté client, en anglais par défaut). IDEMPOTENT, reproductible : à rejouer
# après un reset. Met le `default_locale=fr` sur toutes les marques (Brand) et,
# en option, fixe le titre de marque à "AI Box".
#
# Usage : authentik-fr.sh [--title "AI Box"]
# Env   : AK_CONTAINER (def. authentik-server-1)
# =============================================================================
set -euo pipefail
AK_CONTAINER="${AK_CONTAINER:-authentik-server-1}"
TITLE=""
[ "${1:-}" = "--title" ] && TITLE="${2:-AI Box}"

docker exec -i "$AK_CONTAINER" ak shell <<PYEOF
from authentik.brands.models import Brand
title = "${TITLE}"
n = 0
for b in Brand.objects.all():
    changed = False
    if getattr(b, "default_locale", None) != "fr":
        b.default_locale = "fr"; changed = True
    if title and getattr(b, "branding_title", None) != title:
        b.branding_title = title; changed = True
    if changed:
        b.save(); n += 1
    print("brand:", b.domain, "locale=", b.default_locale, "title=", getattr(b, "branding_title", "?"))
print("updated:", n)
PYEOF
echo "== Authentik FR appliqué (idempotent) =="
