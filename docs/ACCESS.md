# Comment accéder à la BoxIA depuis un autre poste

Ce guide couvre les 3 scénarios courants pour qu'un employé/admin
accède à la box depuis son ordinateur, son téléphone, ou en télétravail.

---

## Scénario 1 — Tous les postes sont dans le LAN du bureau

C'est le cas le plus simple : la BoxIA et les utilisateurs sont sur le
même réseau (Wi-Fi ou Ethernet du bureau).

### Sans HTTPS (test rapide)

Sur n'importe quel poste, ouvrir un navigateur :

```
http://192.168.15.210:3100
```

(remplacer par l'IP réelle du serveur — visible dans les paramètres
réseau de la box ou via `ip addr` côté admin).

**Limites** : URL moche, pas de HTTPS, le port `:3100` doit être tapé.

### Avec HTTPS et URL propre (recommandé)

Le **service edge** (Caddy reverse proxy) expose tout sur des
sous-domaines propres :

| URL | Service |
|---|---|
| `https://aibox.local` | App principale (chat) |
| `https://auth.aibox.local` | Authentik (login admin) |
| `https://agents.aibox.local` | Console Dify (agents builder) |
| `https://flows.aibox.local` | n8n (workflows) |
| `https://chat.aibox.local` | Open WebUI (chat alternatif) |
| `https://admin.aibox.local` | Portainer (Docker) |
| `https://status.aibox.local` | Uptime Kuma |

#### Activer le edge sur la box (admin)

```bash
# Sur le serveur, dans /srv/ai-stack
# 1. Ajouter au .env :
DOMAIN=aibox.local
ACME_CA=internal       # cert auto-signé par Caddy
ADMIN_EMAIL=admin@entreprise.fr

# 2. Stopper NPM s'il occupe :80/:443 (cf. README de services/edge/)
docker stop nginx-proxy-manager   # adapter selon le nom

# 3. Démarrer Caddy
cd services/edge
docker compose --env-file ../../.env up -d

# 4. Vérifier
curl http://192.168.15.210/healthz   # doit répondre "OK"
```

#### Côté chaque poste utilisateur (admin du LAN)

**Option A — via Avahi/mDNS (Mac/Linux/iPhone — fonctionne tout seul)**

Le hostname `aibox.local` se résout automatiquement grâce à Bonjour /
Avahi. **Aucune configuration côté poste**.

Sur Mac/iPhone : ça marche d'origine.
Sur Linux : si `avahi-daemon` est installé (le cas par défaut sur Ubuntu/
Debian/Fedora), ça marche.

**Option B — via fichier hosts (Windows / fallback)**

Sur Windows, éditer `C:\Windows\System32\drivers\etc\hosts` (en admin) :

```
192.168.15.210  aibox.local
192.168.15.210  auth.aibox.local
192.168.15.210  agents.aibox.local
192.168.15.210  flows.aibox.local
192.168.15.210  chat.aibox.local
192.168.15.210  admin.aibox.local
192.168.15.210  status.aibox.local
```

Sur Linux/Mac sans mDNS : `/etc/hosts` (besoin de `sudo`).

**Option C — DNS local du routeur (entreprise structurée)**

Si l'entreprise a un serveur DNS interne (Active Directory, pfSense,
serveur DNS Linux, etc.), ajouter une zone qui pointe `aibox.local` et
ses sous-domaines vers `192.168.15.210`. Tous les postes du domaine
profitent automatiquement.

#### Premier accès : warning de sécurité

Caddy en mode `internal` génère un **certificat auto-signé**. Au
premier accès, le navigateur affichera un warning « Connexion non
sécurisée ». Cliquer sur **« Avancé » → « Continuer vers aibox.local »**.

**Pour faire disparaître le warning définitivement** : installer le
certificat racine de Caddy sur chaque poste.

```bash
# Sur la box, récupérer le cert racine
docker exec aibox-edge-caddy cat /data/caddy/pki/authorities/local/root.crt > caddy_root.crt
```

Puis sur Windows : double-clic sur `caddy_root.crt` → « Installer le
certificat » → « Ordinateur local » → « Autorités de certification
racines de confiance ». Sur Mac : double-clic, ouvrir dans Keychain
Access, marquer "Always Trust". Le warning disparaît.

---

## Scénario 2 — Télétravail / nomade (Tailscale)

[Tailscale](https://tailscale.com) construit un VPN mesh privé entre
tous les appareils d'une organisation. **Gratuit jusqu'à 100 utilisateurs**
et 3 admins, plus que suffisant pour une TPE/PME.

### Sur la box (admin)

```bash
# Installation Tailscale sur le serveur Ubuntu
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=aibox

# Récupérer le hostname Tailscale assigné
tailscale status
# → 100.64.0.1   aibox.tail42b8c.ts.net   linux  -
```

Ensuite, MagicDNS de Tailscale fait que `aibox` (hostname court) ou
`aibox.tail42b8c.ts.net` résout chez tous les membres de l'organisation.

### Sur chaque poste employé

1. Installer le client Tailscale ([download](https://tailscale.com/download))
2. Login avec le compte de l'organisation (Google / Microsoft / GitHub /
   email)
3. C'est tout — `https://aibox` marche depuis n'importe où dans le monde

### URL d'accès

```
https://aibox.tail42b8c.ts.net          (URL stable, MagicDNS)
https://aibox                           (court, si MagicDNS activé)
http://100.64.0.1:3100                  (IP directe, fallback)
```

**Avantages** :
- Pas d'ouverture de port firewall (Tailscale crée un tunnel sortant)
- HTTPS automatique avec certs valides (via `tailscale serve` ou Funnel)
- Pas besoin de DNS public, ni de domaine, ni de Let's Encrypt
- ACL fines : qui peut voir quoi
- Reste accessible même quand l'IP du bureau change

### Pour HTTPS sans warning

Tailscale fournit des certs valides via `tailscale serve` :

```bash
sudo tailscale serve --bg --tls-terminated-tcp 443 tcp://localhost:443
```

(la box doit être configurée pour servir HTTP sur localhost:443, ce que
Caddy edge fait déjà).

---

## Scénario 3 — Domaine public + Let's Encrypt (production "exposée")

Pour un client qui veut un vrai domaine accessible depuis Internet
(`https://ai.entreprise.fr`).

**À faire avant** :
- Acheter un domaine
- Pointer DNS A `ai.entreprise.fr` + tous les sous-domaines
  (`auth.ai.entreprise.fr`, `agents.ai.entreprise.fr`, etc.) vers l'IP
  publique du bureau
- Ouvrir les ports 80 et 443 sur la box du FAI

```bash
# .env
DOMAIN=ai.entreprise.fr
ACME_EMAIL=admin@entreprise.fr
ACME_CA=https://acme-v02.api.letsencrypt.org/directory
```

Puis `docker compose up -d` pour services/edge. Caddy obtient
automatiquement les certs Let's Encrypt.

**Attention sécurité** : exposer la box à Internet implique de durcir :
- Activer CrowdSec (déjà dans `scripts/harden.sh`)
- Limiter les login Authentik par IP
- Backups offsite réguliers
- Updates auto via `aibox-updater.sh`

**Alternative plus sûre** : Cloudflare Tunnel — la box pousse une
connexion sortante vers Cloudflare, qui sert l'app derrière sa
protection DDoS. Pas d'ouverture de port.

```bash
# Cloudflare Tunnel
cloudflared service install <token>
# Routes configurées via le dashboard Cloudflare
```

---

## Tableau récapitulatif

| Scénario | URL | Effort install | HTTPS valide | Hors-LAN |
|---|---|---|---|---|
| LAN HTTP brut | `http://IP:3100` | 0 | ❌ | ❌ |
| LAN + edge mDNS | `https://aibox.local` | 5 min admin | ⚠️ self-signed | ❌ |
| LAN + hosts file | `https://aibox.local` | 5 min/poste | ⚠️ self-signed | ❌ |
| **Tailscale** | `https://aibox` | 10 min total | ✅ | ✅ |
| Cloudflare Tunnel | `https://ai.entreprise.fr` | 30 min | ✅ | ✅ |
| Domaine public + LE | `https://ai.entreprise.fr` | 1 h + sécurisation | ✅ | ✅ |

## Recommandation par cas

- **Démo commerciale chez un prospect** → mDNS / hosts file (tu apportes
  ton portable, branche au Wi-Fi, ouvre `https://aibox.local`)
- **Premier client TPE en production** → Tailscale (5 employés, télétravail)
- **PME structurée 20+ employés** → Cloudflare Tunnel + sous-domaine
  (pas d'ouverture de port FAI nécessaire)
- **Entreprise avec VPN existant** → laisser tel quel (le VPN gère l'accès)

## Mobile / tablette

Toutes ces URL marchent dans Safari iOS / Chrome Android. L'app est
**responsive** (sidebar transformée en drawer mobile, chat plein
écran, conv panel en overlay).

Pour une vraie app mobile native sans devoir développer, ajouter
l'icône sur l'écran d'accueil du téléphone : Safari → bouton de
partage → « Sur l'écran d'accueil ». Ça crée un raccourci comme une
PWA, sans la barre du navigateur.

---

Pour des questions ou customisation, voir aussi `docs/SETUP-CLIENT.md`
et `docs/ADMIN-CLIENT.md`.
