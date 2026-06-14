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

# NB : Brand.default_locale est une property en lecture seule ; la locale vit dans
# attributes["settings"]["locale"] (JSONField). branding_title est un vrai champ.
docker exec -i "$AK_CONTAINER" ak shell <<PYEOF
from authentik.brands.models import Brand
title = "${TITLE}"
n = 0
for b in Brand.objects.all():
    settings = b.attributes.setdefault("settings", {})
    changed = False
    if settings.get("locale") != "fr":
        settings["locale"] = "fr"; changed = True
    if title and b.branding_title != title:
        b.branding_title = title; changed = True
    if changed:
        b.save(); n += 1
    print("brand:", b.domain, "| locale=", b.default_locale, "| title=", b.branding_title)
print("updated:", n)
PYEOF
echo "== Authentik FR appliqué (idempotent) =="
