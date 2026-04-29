#!/usr/bin/env bash
# =============================================================================
# AI Box — Hardening OS de base
# =============================================================================
# À exécuter UNE FOIS sur l'image disque maître (avant clonage chez le client).
# Idempotent : peut être relancé.
# =============================================================================
set -euo pipefail

c_blue()  { printf "\033[1;34m%s\033[0m\n" "$*"; }
c_green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
c_red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }

[[ "$EUID" -eq 0 ]] || { c_red "Doit être exécuté en root (sudo)"; exit 1; }

c_blue "=== AI Box — Hardening OS ==="

# 1. Mises à jour critiques
c_blue "[1/8] Mises à jour"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq

# 2. Unattended-upgrades pour patches sécu auto
c_blue "[2/8] Unattended-upgrades pour les patches sécu"
apt-get install -y -qq unattended-upgrades apt-listchanges
cat > /etc/apt/apt.conf.d/50unattended-upgrades <<'EOF'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades

# 3. UFW (firewall)
c_blue "[3/8] UFW firewall"
apt-get install -y -qq ufw
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "HTTP (Caddy)"
ufw allow 443/tcp comment "HTTPS (Caddy)"
# Tailscale interface
if command -v tailscale >/dev/null 2>&1; then
    ufw allow in on tailscale0 comment "Tailscale"
fi
ufw --force enable

# 4. CrowdSec (anti-bruteforce + anti-bots)
c_blue "[4/8] CrowdSec"
if ! command -v cscli >/dev/null 2>&1; then
    curl -s https://install.crowdsec.net | sh
    apt-get install -y -qq crowdsec
    cscli collections install crowdsecurity/sshd crowdsecurity/linux crowdsecurity/base-http-scenarios
fi
systemctl enable --now crowdsec

# 5. Bouncer Caddy CrowdSec (à activer après Caddy installé — laissé manuel)
c_blue "[5/8] Bouncer CrowdSec (à activer manuellement après installation Caddy)"
echo "  → Voir docs/HARDENING.md pour activer le bouncer Caddy"

# 6. SSH durci
c_blue "[6/8] Durcissement SSH"
SSH_CFG=/etc/ssh/sshd_config.d/99-aibox.conf
cat > "$SSH_CFG" <<'EOF'
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
ClientAliveInterval 600
ClientAliveCountMax 3
MaxAuthTries 3
LoginGraceTime 30
AllowAgentForwarding no
AllowTcpForwarding yes
X11Forwarding no
EOF
systemctl restart ssh

# 7. AppArmor profiles Docker
c_blue "[7/8] AppArmor"
apt-get install -y -qq apparmor apparmor-utils
systemctl enable --now apparmor

# 8. auditd (logs sécu OS)
c_blue "[8/8] auditd"
apt-get install -y -qq auditd
systemctl enable --now auditd

c_green ""
c_green "=== Hardening terminé ==="
c_green "Vérifications :"
c_green "  ufw status verbose"
c_green "  cscli decisions list"
c_green "  systemctl status crowdsec"
c_green "  ss -tlnp"
c_green ""
c_green "TODO manuel :"
c_green "  - LUKS sur le disque (à faire à l'install OS, pas après)"
c_green "  - Activer bouncer Caddy + CrowdSec (voir docs/HARDENING.md)"
