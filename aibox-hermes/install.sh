#!/usr/bin/env bash
# =============================================================================
# AI Box — installeur one-command pour VPS Ubuntu. IDEMPOTENT.
#
#   sudo ./install.sh            # installe tout
#   ./install.sh --check         # dry-run (n'exécute rien)
#
# Variables (env ; sinon défauts) :
#   COMPANY_SLUG, COMPANY_NAME
#   ANTHROPIC_API_KEY            # RECOMMANDÉ sur VPS (cloud-primary, pas de GPU)
#   WITH_LOCAL_MODEL=1           # optionnel : installe Ollama + un modèle local (lent sans GPU)
#   AIBOX_DOMAIN                 # ex: aibox.mon-domaine.fr → HTTPS auto (Caddy) pour la PWA
#   FIRST_USER_SLUG, FIRST_USER_NAME
#   TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS   # canal du 1er user
#   USER_CONNECTORS                              # RBAC connecteurs du 1er user
#   HERMES_WEBUI_REPO           # dépôt hermes-webui (déf. nesquena/hermes-webui)
#   AIBOX_DEMO=1                # mode démo : garde les mots de passe faibles par défaut
#                              #   (sinon, en PROD, mots de passe forts auto-générés)
# =============================================================================
set -euo pipefail

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1
if [ "$CHECK" != 1 ] && [ "$(id -u)" != 0 ]; then
  echo "À lancer en root : sudo ./install.sh"; exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # = aibox-hermes/
WITH_WEB_PORTAL="${WITH_WEB_PORTAL:-1}"   # portail web multi-user (Authentik+Caddy+chat) — défaut LAN
AIBOX_OWNER="${AIBOX_OWNER:-$(logname 2>/dev/null || echo clikinfo)}"
# Home réel de l'owner (getent → robuste si home ≠ /home/owner) : sert à substituer
# __OWNER_HOME__ dans les units systemd (plus de /home/clikinfo en dur).
# `|| true` : sous set -e + pipefail, un getent absent/en échec ne doit pas abort.
OWNER_HOME="$( { getent passwd "$AIBOX_OWNER" 2>/dev/null || true; } | cut -d: -f6)"; OWNER_HOME="${OWNER_HOME:-/home/$AIBOX_OWNER}"
# Le portail web tourne sous le compte de l'owner (dashboards systemd, HERMES_HOME).
if [ "$WITH_WEB_PORTAL" = 1 ]; then AIBOX_ROOT="${AIBOX_ROOT:-/home/$AIBOX_OWNER/aibox}"; else AIBOX_ROOT="${AIBOX_ROOT:-/opt/aibox}"; fi
COMPANY_SLUG="${COMPANY_SLUG:-demo}"
# Dépôt de l'interface web hermes-webui (l'app servie par aibox-webui@.service).
# Configurable pour pointer un fork ; défaut = l'upstream utilisé par l'extension.
HERMES_WEBUI_REPO="${HERMES_WEBUI_REPO:-https://github.com/nesquena/hermes-webui.git}"

# --- Mots de passe (P1 #6) -------------------------------------------------
# En démo (AIBOX_DEMO=1) on garde des défauts faibles mémorisables. En PROD
# (défaut), si l'appelant n'a pas fourni de mot de passe, on en génère un FORT
# et aléatoire — jamais un défaut en clair du repo public — et on l'affiche UNE
# fois en fin d'install. gen_pw : 24 caractères base64 url-safe.
gen_pw() { openssl rand -base64 18 2>/dev/null | tr '+/' '-_' | tr -d '\n' || head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n'; }
AIBOX_DEMO="${AIBOX_DEMO:-0}"
AKADMIN_PASSWORD_GENERATED=0
USER_PASSWORD_GENERATED=0
if [ -z "${AKADMIN_PASSWORD:-}" ]; then
  if [ "$AIBOX_DEMO" = 1 ]; then AKADMIN_PASSWORD="AiBoxAdmin2026!Change"; else AKADMIN_PASSWORD="$(gen_pw)"; AKADMIN_PASSWORD_GENERATED=1; fi
fi
if [ -z "${USER_PASSWORD:-}" ]; then
  if [ "$AIBOX_DEMO" = 1 ]; then USER_PASSWORD="1234"; else USER_PASSWORD="$(gen_pw)"; USER_PASSWORD_GENERATED=1; fi
fi

run()  { if [ "$CHECK" = 1 ]; then echo "  [check] $*"; else eval "$@"; fi; }
step() { printf '\n== %s ==\n' "$*"; }
# Exécute en tant que propriétaire du portail : Hermes, HERMES_HOME et les données
# lui appartiennent (le dashboard tourne sous ce compte) — pas root. bash -lc → PATH
# (~/.local/bin pour uv/hermes). En portail web l'owner = clikinfo ; sinon = invoquant.
OWNER_RUN="$AIBOX_OWNER"
asowner() { if [ "$CHECK" = 1 ]; then echo "  [check][$OWNER_RUN] $*"; else sudo -u "$OWNER_RUN" -H bash -lc "$*"; fi; }
have_hermes() { sudo -u "$OWNER_RUN" -H bash -lc 'command -v hermes >/dev/null 2>&1' 2>/dev/null; }

step "1/7  Dépendances système"
run "export DEBIAN_FRONTEND=noninteractive"
run "apt-get update -qq"
run "apt-get install -y -qq python3 python3-venv python3-pip git curl jq"

step "2/7  Hermes Agent (installé pour $OWNER_RUN, jamais modifié)"
# Vraie méthode (vérifiée live) : clone + setup-hermes.sh via uv (non-interactif),
# EN TANT QUE l'owner → ~/.local/bin/hermes et ~/hermes-agent lui appartiennent.
if [ "$CHECK" = 1 ] || ! have_hermes; then
  asowner 'command -v uv >/dev/null 2>&1 || curl -LsSf https://astral.sh/uv/install.sh | sh'
  asowner '[ -d ~/hermes-agent/.git ] || git clone --depth 1 https://github.com/nousresearch/hermes-agent.git ~/hermes-agent'
  asowner 'cd ~/hermes-agent && yes n | ./setup-hermes.sh'
else
  echo "  hermes déjà présent ($OWNER_RUN)."
fi
# Recherche web sans clé (DuckDuckGo) : le backend `ddgs` du config.yaml a besoin du
# paquet `ddgs` dans le venv Hermes. Hermes le lazy-installe au 1er appel, mais on le
# pré-installe pour que la 1re recherche soit instantanée. Le venv Hermes est créé par
# uv (pas de `pip` dedans) → on installe via `uv pip --python <venv>`.
asowner 'uv pip install -q --python ~/hermes-agent/venv/bin/python ddgs 2>/dev/null || true'
# Frontend du dashboard web : setup-hermes ne le build PAS → sans ça, le service
# `hermes dashboard --skip-build` échoue (« no web dist »). On installe node + build.
if [ "$WITH_WEB_PORTAL" = 1 ]; then
  command -v node >/dev/null 2>&1 || run "curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y -qq nodejs"
  asowner 'cd ~/hermes-agent && npm install --workspace web && npm run build -w web'
  echo "  dashboard web buildé (hermes_cli/web_dist)"

  # hermes-webui : l'app servie par aibox-webui@.service (bootstrap.py). RIEN
  # d'autre ne la clone → sur une machine neuve tous les services webui
  # crash-loopent « No such file ». On la clone dans le home de l'OWNER (comme
  # hermes-agent) pour que WorkingDirectory=~/hermes-webui existe. Idempotent :
  # on ne re-clone pas si le dépôt est déjà là.
  asowner "[ -d ~/hermes-webui/.git ] || git clone --depth 1 '$HERMES_WEBUI_REPO' ~/hermes-webui"
  # Dépendances Python de hermes-webui (si un requirements.txt est fourni). Best-effort :
  # bootstrap.py peut aussi lazy-installer. On installe dans le venv Hermes partagé.
  asowner 'if [ -f ~/hermes-webui/requirements.txt ]; then uv pip install -q --python ~/hermes-agent/venv/bin/python -r ~/hermes-webui/requirements.txt 2>/dev/null || true; fi'
  echo "  hermes-webui cloné (~/hermes-webui) pour $OWNER_RUN"
fi

step "3/7  Modèle IA"
if [ "${WITH_LOCAL_MODEL:-0}" = 1 ]; then
  command -v ollama >/dev/null 2>&1 || run "curl -fsSL https://ollama.com/install.sh | sh"
  run "sudo systemctl enable --now ollama 2>/dev/null || true"   # l'install laisse le service désactivé
  # NB : on N'active PAS le cache KV q8_0 — c'était pour faire tenir un 14B sur 12 Go,
  # mais le 14B a été rejeté (trop lent sur 12 Go, voir cookbook/recommend.py). Le 8B
  # tient à 64K en fp16. Pour un GPU >=18 Go visant le 14B, ajouter à la main :
  #   /etc/systemd/system/ollama.service.d/*.conf : OLLAMA_KV_CACHE_TYPE=q8_0 + FLASH_ATTENTION=1
  MODEL="$(python3 "$SCRIPT_DIR/cookbook/cookbook.py" --json 2>/dev/null | sed -n 's/.*"recommended": *"\([^"]*\)".*/\1/p')"
  MODEL="${MODEL:-qwen3:4b}"
  echo "  Cookbook recommande : $MODEL"
  run "ollama pull '$MODEL'"
  export OLLAMA_MODEL="$MODEL"
  # Modèle vision (pièces jointes image — « analyse cette facture/photo »)
  VISION_MODEL="${VISION_MODEL:-qwen2.5vl:7b}"
  [ -n "$VISION_MODEL" ] && run "ollama pull '$VISION_MODEL'"
else
  echo "  Mode cloud-primary (pas de modèle local — conseillé sur VPS sans GPU)."
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "  ⚠ ANTHROPIC_API_KEY non fournie : l'assistant ne pourra pas répondre tant qu'une clé n'est pas configurée."
  fi
fi

step "4/7  Config entreprise (wizard-company)"
# NB : sudo -u ... bash -lc (asowner) NE propage PAS l'env de l'appelant → on doit
# passer explicitement chaque variable inline, sinon COMPANY_NAME/clés sont perdues.
asowner "AIBOX_ROOT='$AIBOX_ROOT' COMPANY_NAME='${COMPANY_NAME:-}' OLLAMA_MODEL='${OLLAMA_MODEL:-}' ENABLED_CONNECTORS='${ENABLED_CONNECTORS:-}' ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}' bash '$SCRIPT_DIR/provision/wizard-company.sh' '$COMPANY_SLUG' $([ "$CHECK" = 1 ] && echo --check)"

step "5/7  Premier utilisateur"
if [ -n "${FIRST_USER_SLUG:-}" ]; then
  # Idem : propage explicitement le nom, le canal Telegram et les droits RBAC du
  # 1er user au wizard (sinon Telegram jamais configuré, USER_NAME = slug).
  asowner "AIBOX_ROOT='$AIBOX_ROOT' USER_NAME='${FIRST_USER_NAME:-}' USER_CONNECTORS='${USER_CONNECTORS:-}' TELEGRAM_BOT_TOKEN='${TELEGRAM_BOT_TOKEN:-}' TELEGRAM_ALLOWED_USERS='${TELEGRAM_ALLOWED_USERS:-}' bash '$SCRIPT_DIR/provision/wizard-user.sh' '$COMPANY_SLUG' '$FIRST_USER_SLUG' $([ "$CHECK" = 1 ] && echo --check)"
  # Hors portail web : service gateway (Telegram/CLI). En portail, c'est aibox-webui@ (étape 7).
  if [ "$WITH_WEB_PORTAL" != 1 ]; then
    INSTANCE="${COMPANY_SLUG}-${FIRST_USER_SLUG}"
    if [ "$CHECK" = 1 ]; then echo "  [check] instance systemd aibox-hermes@$INSTANCE (unit substitué: owner=$AIBOX_OWNER home=$OWNER_HOME root=$AIBOX_ROOT)"; else
      asowner "mkdir -p '$AIBOX_ROOT/instances' && echo \"HERMES_HOME=$AIBOX_ROOT/companies/$COMPANY_SLUG/users/$FIRST_USER_SLUG/hermes\" > '$AIBOX_ROOT/instances/$INSTANCE.env'"
      # Unit = gabarit : substituer owner/home/root réels (plus de root ni /opt/aibox en dur).
      sed -e "s#__AIBOX_OWNER__#$AIBOX_OWNER#g" -e "s#__OWNER_HOME__#$OWNER_HOME#g" -e "s#__AIBOX_ROOT__#$AIBOX_ROOT#g" \
        "$SCRIPT_DIR/provision/aibox-hermes@.service" > /etc/systemd/system/aibox-hermes@.service
      chmod 644 /etc/systemd/system/aibox-hermes@.service
      systemctl daemon-reload; systemctl enable --now "aibox-hermes@$INSTANCE"
    fi
  fi
else
  echo "  (aucun FIRST_USER_SLUG — ajoute des employés ensuite, voir ci-dessous)"
fi

step "6/7  PWA + HTTPS (Caddy)"
if [ -n "${AIBOX_DOMAIN:-}" ]; then
  command -v caddy >/dev/null 2>&1 || run "apt-get install -y -qq caddy"
  if [ "$CHECK" = 1 ]; then
    echo "  [check] render Caddyfile pour $AIBOX_DOMAIN (PWA: $SCRIPT_DIR/pwa)"
  else
    sed -e "s#__DOMAIN__#$AIBOX_DOMAIN#g" -e "s#__PWA_DIR__#$SCRIPT_DIR/pwa#g" \
      "$SCRIPT_DIR/provision/Caddyfile.template" > /etc/caddy/Caddyfile
    systemctl reload caddy 2>/dev/null || systemctl restart caddy
  fi
  echo "  PWA : https://$AIBOX_DOMAIN"
else
  echo "  (pas de AIBOX_DOMAIN — canal Telegram suffit ; la PWA web nécessite un domaine + HTTPS)"
fi

step "7/7  Portail web multi-utilisateur (Authentik + Caddy + dashboards + chat)"
if [ "$WITH_WEB_PORTAL" = 1 ]; then
  # `|| true` : hostname -I peut échouer (pipefail) sur certains OS → ne pas abort.
  AIBOX_HOST="${AIBOX_HOST:-${AIBOX_DOMAIN:-$( { hostname -I 2>/dev/null || true; } | awk '{print $1}')}}"
  run "command -v caddy >/dev/null 2>&1 || apt-get install -y -qq caddy"
  run "command -v docker >/dev/null 2>&1 || curl -fsSL https://get.docker.com | sh"
  # Pare-feu (P1 #5) : `ufw allow` seul est inutile tant que ufw est INACTIF (défaut
  # Ubuntu) → les dashboards `--insecure` bind 0.0.0.0 restent réellement exposés au
  # LAN. On pose les règles PUIS on ACTIVE ufw. ORDRE CRITIQUE : autoriser SSH (22)
  # AVANT `enable`, sinon on se verrouille hors du VPS. On n'ouvre QUE 22/80/443/9443 ;
  # tous les ports internes (webui 9130+, dash, Authentik 9000) restent fermés au LAN.
  if command -v ufw >/dev/null 2>&1; then
    run "ufw allow 22/tcp 2>/dev/null || true"
    run "ufw allow 80/tcp 2>/dev/null || true"
    run "ufw allow 443/tcp 2>/dev/null || true"
    run "ufw allow 9443/tcp 2>/dev/null || true"
    run "ufw --force enable 2>/dev/null || true"
  else
    echo "  ⚠ ufw absent — les ports internes ne sont pas filtrés. Installe/active un pare-feu."
  fi
  # AIBOX_ADMINS : liste des users admin de l'UI (droits complets). Sur une install
  # fraîche avec un seul employé, si personne n'est admin, roles.json les met tous en
  # « client » → 403 sur l'UI droits, personne ne peut promouvoir : DEADLOCK. On fait
  # donc du 1er user un admin par défaut (surchargé par AIBOX_ADMINS si fourni).
  AIBOX_ADMINS="${AIBOX_ADMINS:-${FIRST_USER_SLUG:-}}"
  # 7a) Authentik (login) — secrets auto-générés (mdp résolu plus haut : démo ou fort)
  run "AIBOX_OWNER='$AIBOX_OWNER' AKADMIN_PASSWORD='$AKADMIN_PASSWORD' bash '$SCRIPT_DIR/provision/authentik/deploy-authentik.sh' $([ "$CHECK" = 1 ] && echo --check)"
  # 7b) Portail : dashboards par user + Caddy + contenu web + config Authentik
  run "AIBOX_ROOT='$AIBOX_ROOT' AIBOX_OWNER='$AIBOX_OWNER' COMPANY='$COMPANY_SLUG' AIBOX_HOST='$AIBOX_HOST' USER_PASSWORD='$USER_PASSWORD' AIBOX_ADMINS='$AIBOX_ADMINS' bash '$SCRIPT_DIR/provision/setup-portal.sh' $([ "$CHECK" = 1 ] && echo --check)"
  # 7c) Les données du portail dans le home de l'owner doivent lui appartenir
  #     (webui env + roles.json sont écrits par root ; le dashboard/plugin droits écrit en tant qu'owner).
  run "chown -R '$AIBOX_OWNER':'$AIBOX_OWNER' '$AIBOX_ROOT/webui' 2>/dev/null; [ -f '$AIBOX_ROOT/roles.json' ] && chown '$AIBOX_OWNER':'$AIBOX_OWNER' '$AIBOX_ROOT/roles.json'; true"
  echo "  Portail : https://$AIBOX_HOST/  (login Authentik akadmin + employés, chat en page d'accueil)"
else
  echo "  (WITH_WEB_PORTAL=0 — portail web non installé)"
fi

cat <<EOF

== AI Box installée ==
  Entreprise : $COMPANY_SLUG
  Données    : $AIBOX_ROOT/companies/$COMPANY_SLUG/

Ajouter un employé (portail web) :
  sudo bash $SCRIPT_DIR/provision/wizard-user.sh $COMPANY_SLUG <user>
  sudo -E AIBOX_ROOT='$AIBOX_ROOT' AIBOX_HOST='${AIBOX_HOST:-<ip>}' bash $SCRIPT_DIR/provision/setup-portal.sh
  # (setup-portal est idempotent : il crée le dashboard du nouvel user, son token,
  #  l'ajoute au routage Caddy et le crée dans Authentik.)

Voir INSTALL-VPS.md pour le détail (bot Telegram, domaine, dépannage).
EOF

# Affichage UNIQUE des mots de passe auto-générés (P1 #6). Non stockés en clair
# ailleurs : à noter maintenant. En mode démo, les défauts faibles sont connus.
if [ "$CHECK" != 1 ] && [ "$WITH_WEB_PORTAL" = 1 ]; then
  if [ "$AKADMIN_PASSWORD_GENERATED" = 1 ] || [ "$USER_PASSWORD_GENERATED" = 1 ]; then
    printf '\n== Identifiants générés (à noter — affichés une seule fois) ==\n'
    [ "$AKADMIN_PASSWORD_GENERATED" = 1 ] && printf '  Admin Authentik  : akadmin / %s\n' "$AKADMIN_PASSWORD"
    [ "$USER_PASSWORD_GENERATED" = 1 ]   && printf '  Mot de passe employé(s) portail : %s\n' "$USER_PASSWORD"
    printf '  (relancer avec AIBOX_DEMO=1 pour des mots de passe de démo faibles.)\n'
  elif [ "$AIBOX_DEMO" = 1 ]; then
    printf '\n⚠ Mode démo (AIBOX_DEMO=1) : mots de passe FAIBLES par défaut. NE PAS utiliser en production.\n'
  fi
fi
