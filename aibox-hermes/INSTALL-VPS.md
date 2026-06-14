# Installer AI Box sur un VPS

Guide pour déployer une AI Box complète sur un VPS Ubuntu. Modèle :
**1 entreprise = 1 VPS**, **1 Hermes par employé**, canal **Telegram** (+ PWA web en option).

## Hypothèses / défauts
- **OS** : Ubuntu 22.04 ou 24.04, accès root (sudo).
- **Pas de GPU** (cas normal d'un VPS) → **cloud-primary** : le moteur par défaut est
  **Claude Haiku** (BYOK). Le local Ollama est *optionnel* (`WITH_LOCAL_MODEL=1`) mais
  **lent sans GPU** — à réserver aux gros VPS ou aux données ultra-sensibles.
- **Canal principal** : Telegram (chaque Hermes se connecte *sortant* à Telegram → aucun
  port entrant requis par user). La **PWA web** est en option (nécessite un domaine + HTTPS,
  et le routage API par user — voir « Limites »).

## Pré-requis avant de lancer
1. Un VPS Ubuntu avec accès root.
2. Une **clé Anthropic** : https://console.anthropic.com/settings/keys
3. Un **bot Telegram** par employé (via @BotFather → `/newbot` → noter le token), et le
   `chat_id` de l'employé (lui faire envoyer un message au bot).
4. (Option PWA) un **domaine** pointant vers l'IP du VPS.

## Installation (une commande)
```bash
git clone https://github.com/Tobaz34/BoxIA.git /opt/aibox-repo
cd /opt/aibox-repo/aibox-hermes

sudo COMPANY_SLUG=ma-boite COMPANY_NAME="Ma Boîte" \
     ANTHROPIC_API_KEY="sk-ant-..." \
     FIRST_USER_SLUG=sophie FIRST_USER_NAME="Sophie" \
     TELEGRAM_BOT_TOKEN="8076...:AA..." TELEGRAM_ALLOWED_USERS="123456789" \
     ./install.sh
```
Pour tester sans rien installer : `./install.sh --check`.

Le script : dépendances → Hermes → (modèle) → wizard entreprise → 1er user + **service systemd**
→ (option) PWA/HTTPS Caddy si `AIBOX_DOMAIN` est fourni.

## Ajouter un employé
```bash
sudo TELEGRAM_BOT_TOKEN="<token-de-cet-employé>" TELEGRAM_ALLOWED_USERS="<chat_id>" \
     USER_NAME="Marc" USER_CONNECTORS="pennylane" \
     bash provision/wizard-user.sh ma-boite marc
echo "HERMES_HOME=/opt/aibox/companies/ma-boite/users/marc/hermes" \
  | sudo tee /opt/aibox/instances/ma-boite-marc.env
sudo systemctl enable --now aibox-hermes@ma-boite-marc
```
`USER_CONNECTORS` = **RBAC** : la liste des connecteurs autorisés pour ce user
(ou `all`). Un connecteur non listé n'apparaît même pas dans sa config.

## Vérifier
```bash
systemctl status 'aibox-hermes@ma-boite-sophie'
journalctl -u 'aibox-hermes@ma-boite-sophie' -f
# Puis : écrire au bot Telegram → l'assistant répond.
```

## Mise à jour
```bash
cd /opt/aibox-repo && git pull
sudo systemctl restart 'aibox-hermes@*'
```

## Limites connues / à finaliser
- **Invocation gateway** : le service utilise `hermes gateway` — vérifier la sous-commande
  exacte de votre version (`hermes gateway --help`) et ajuster `aibox-hermes@.service` si besoin.
- **PWA web par user** : la PWA est servie en HTTPS, mais le **routage API par utilisateur**
  (exposer l'API du bon Hermes, avec auth) reste à câbler dans le `Caddyfile` (exemple commenté
  fourni). Tant que ce n'est pas fait, **utiliser Telegram**.
- **Sécurité réseau** : fermer les ports inutiles (ufw), n'exposer que 443 (Caddy). Voir
  `docs/SECURITY-NETWORK-TODO.md`.
