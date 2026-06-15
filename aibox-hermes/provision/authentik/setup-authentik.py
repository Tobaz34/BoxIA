# =============================================================================
# Reproduit la config Authentik du portail AI Box, IDEMPOTENT (rejouable).
# À exécuter dans le conteneur : docker exec -i authentik-server ak shell < ce.py
# (le wrapper setup-authentik.sh passe les variables d'env).
#
# Crée/aligne, sur une instance Authentik FRAÎCHE (qui a déjà les flows et
# l'outpost embarqué par défaut) :
#   - la marque par défaut : titre "AI Box" + locale fr
#   - un ProxyProvider "aibox-forward" (forward_single, external_host)
#   - l'application "aibox" (AI Box) liée au provider
#   - le provider ajouté à l'outpost embarqué + authentik_host
#   - les utilisateurs employés (mot de passe par défaut)
#
# Env : AIBOX_HOST (def 192.168.15.210), AIBOX_AUTHENTIK_PORT (def 9443),
#       AIBOX_USER_PASSWORD (def 1234), AIBOX_USERS (csv "andre:Andre,marc:Marc")
# =============================================================================
import os
from authentik.brands.models import Brand
from authentik.core.models import Application, User
from authentik.flows.models import Flow
from authentik.providers.proxy.models import ProxyProvider
from authentik.outposts.models import Outpost

HOST = os.environ.get("AIBOX_HOST", "192.168.15.210")
AK_PORT = os.environ.get("AIBOX_AUTHENTIK_PORT", "9443")
PWD = os.environ.get("AIBOX_USER_PASSWORD", "1234")
USERS = os.environ.get("AIBOX_USERS", "andre:Andre,marc:Marc")
EXT = "https://%s" % HOST
AK_HOST = "https://%s:%s/" % (HOST, AK_PORT)
changed = []

# 1) Marque par défaut : titre + locale FR
b = Brand.objects.filter(default=True).first() or Brand.objects.first()
if b:
    s = b.attributes.setdefault("settings", {})
    if s.get("locale") != "fr" or b.branding_title != "AI Box":
        s["locale"] = "fr"; b.branding_title = "AI Box"; b.save(); changed.append("brand")

# 2) ProxyProvider forward-auth
auth_flow = Flow.objects.get(slug="default-provider-authorization-implicit-consent")
inval_flow = Flow.objects.filter(slug="default-invalidation-flow").first()
prov, created = ProxyProvider.objects.get_or_create(
    name="aibox-forward",
    defaults={"mode": "forward_single", "external_host": EXT, "authorization_flow": auth_flow},
)
dirty = created
for k, v in {"mode": "forward_single", "external_host": EXT, "authorization_flow": auth_flow}.items():
    if getattr(prov, k, None) != v:
        setattr(prov, k, v); dirty = True
if inval_flow and getattr(prov, "invalidation_flow_id", None) != inval_flow.pk:
    prov.invalidation_flow = inval_flow; dirty = True
if dirty:
    prov.save(); changed.append("provider" + (" (créé)" if created else ""))

# 3) Application
app, acreated = Application.objects.get_or_create(
    slug="aibox", defaults={"name": "AI Box", "provider": prov})
if app.provider_id != prov.pk or app.name != "AI Box":
    app.provider = prov; app.name = "AI Box"; app.save(); changed.append("app")
elif acreated:
    changed.append("app (créé)")

# 4) Outpost embarqué : provider + authentik_host
out = Outpost.objects.filter(managed="goauthentik.io/outposts/embedded").first()
if out:
    c = out.config
    if c.authentik_host != AK_HOST or not getattr(c, "authentik_host_insecure", False):
        c.authentik_host = AK_HOST; c.authentik_host_insecure = True
        out.config = c; out.save(); changed.append("outpost.host")
    if prov.pk not in list(out.providers.values_list("pk", flat=True)):
        out.providers.add(prov); changed.append("outpost.provider")

# 5) Utilisateurs employés
for tok in [u for u in USERS.split(",") if u.strip()]:
    parts = tok.split(":")
    un = parts[0].strip(); nm = (parts[1].strip() if len(parts) > 1 else un)
    u = User.objects.filter(username=un).first()
    if not u:
        u = User.objects.create(username=un, name=nm); u.set_password(PWD); u.save()
        changed.append("user:" + un)

print("AIBOX-AUTHENTIK CHANGED:", changed or "rien (déjà conforme, idempotent)")
