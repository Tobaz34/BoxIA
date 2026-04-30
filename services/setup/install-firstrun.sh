#!/usr/bin/env bash
# =============================================================================
# AI Box — Installation du portail de setup embarqué (first-run)
# =============================================================================
# À exécuter UNE FOIS lors de la préparation de l'image disque AI Box, AVANT
# livraison au client. Au premier démarrage chez le client :
#   - Avahi annonce 'aibox.local' sur le LAN
#   - Le service systemd lance le container du wizard sur :80
#   - Le client visite http://aibox.local → wizard → installation
#   - Une fois le setup terminé, le service se désactive
# =============================================================================
set -euo pipefail

c_blue()   { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green()  { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_red()    { printf "\033[1;31m%s\033[0m\n" "$*"; }

[[ "$EUID" -eq 0 ]] || { c_red "Doit être exécuté en root (sudo)"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"

c_blue "=== Installation portail first-run ==="

# ---- 1. Hostname → aibox -----------------------------------------------
c_blue "[1/5] Configuration du hostname → aibox"
hostnamectl set-hostname aibox
grep -q '^127.0.1.1.*aibox' /etc/hosts || echo "127.0.1.1 aibox" >> /etc/hosts

# ---- 2. Avahi (mDNS) ---------------------------------------------------
c_blue "[2/5] Installation Avahi pour aibox.local"
apt-get update -qq
apt-get install -y -qq avahi-daemon avahi-utils libnss-mdns

cp -f "$HERE/aibox.avahi.service" /etc/avahi/services/aibox.service
systemctl enable --now avahi-daemon
systemctl reload avahi-daemon || true

# ---- 3. mDNS aliases plats (aibox-auth.local, aibox-chat.local, ...) ---
# Indispensable : Bonjour Windows ne résout que les hostnames mono-label,
# donc l'edge Caddy doit pouvoir répondre sur aibox-auth.local etc.
c_blue "[3/5] Installation publication mDNS aliases plats"
install -m 0755 "$HERE/aibox-mdns-publish.sh" /usr/local/bin/aibox-mdns-publish.sh
cp -f "$HERE/aibox-mdns-aliases.service" /etc/systemd/system/aibox-mdns-aliases.service
systemctl daemon-reload
systemctl enable --now aibox-mdns-aliases.service || \
  c_red "  ⚠ aibox-mdns-aliases.service n'a pas démarré — vérifier 'systemctl status aibox-mdns-aliases'"

# ---- 4. Service systemd firstrun ---------------------------------------
c_blue "[4/5] Installation service systemd"
cp -f "$HERE/aibox-firstrun.service" /etc/systemd/system/aibox-firstrun.service
mkdir -p /var/lib/aibox
systemctl daemon-reload
systemctl enable aibox-firstrun.service

# ---- 5. Démarrer maintenant si pas déjà configuré ----------------------
c_blue "[5/5] Démarrage du wizard (si pas encore configuré)"
if [[ ! -f /var/lib/aibox/.configured ]]; then
  systemctl start aibox-firstrun.service || true
  c_green "✓ Wizard démarré → http://aibox.local"
else
  c_green "✓ Box déjà configurée — wizard non démarré"
fi

c_green ""
c_green "=== Installation terminée ==="
c_green "Au prochain démarrage chez le client :"
c_green "  - 'aibox.local' sera annoncé sur le LAN"
c_green "  - Le wizard sera disponible sur http://aibox.local"
c_green ""
c_green "Pour réinitialiser et relancer le wizard :"
c_green "  sudo rm -f /var/lib/aibox/.configured"
c_green "  sudo docker volume rm aibox_setup_state || true"
c_green "  sudo systemctl restart aibox-firstrun.service"
