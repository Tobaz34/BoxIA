# 🧪 Test Fresh Install A→Z (BoxIA v2 OSS-inspired)

> Procédure pour valider que `reset-as-client.sh` → wizard → `install.sh`
> remet la box dans un état 100% fonctionnel jusqu'à l'accès à l'interface
> de travail. **Sans intervention manuelle sur le `.env`.**
>
> ⚠️ Détruit toutes les data utilisateur du précédent client. Ne pas
> lancer en prod si tu n'es pas prêt à perdre les comptes Authentik /
> agents Dify / vectors Qdrant / chats / mem0.

---

## ✅ Pré-flight (déjà fait par moi avant)

| Check | Résultat |
|---|---|
| `.env` actuel a `APP_NEXTAUTH_SECRET` | restauré depuis `.env.bak-20260504-135141` |
| Wizard `sso_provisioning.py` génère `APP_NEXTAUTH_SECRET` | ✅ L320 (étape `/api/deploy/provision-sso`) |
| Wizard génère `AGENTS_API_KEY` | ✅ `main.py:300` |
| Port 8086 (scheduler) libre | ✅ |
| Port 8088 (sandbox) libre | ✅ (corrigé — était 8087, conflit mem0) |
| `bash -n install.sh` / `reset-as-client.sh` | ✅ |
| STOP_LIST inclut tous les containers actifs | ✅ (10 containers ajoutés) |

---

## 🚀 Procédure (à lancer par toi sur ta machine)

### Étape 1 — Sync code à jour sur xefia

```bash
# Depuis ta machine (Windows / Git Bash) :
cd D:/IA_TPE_PME_POWER
tools/deploy-to-xefia.sh claude/v2-oss-inspired
```

Cela :
- `git fetch + reset --hard origin/claude/v2-oss-inspired` sur xefia
- Rebuild aibox-app (peut crash sur le `.env` actuel — pas grave, va être reset après)
- Re-joue migrations (no-op si déjà appliquées)
- Smoke test (peut fail — pas grave non plus)

L'objectif est juste que `/srv/ai-stack/` ait mon code à jour avant le reset.

### Étape 2 — Reset complet (sur xefia, en SSH interactif)

```bash
ssh -t clikinfo@192.168.15.210
# (saisir mot de passe SSH si demandé)

cd /srv/ai-stack
sudo ./reset-as-client.sh --yes
# (saisir mot de passe sudo si demandé)
```

Le `-t` force un tty pour que sudo puisse demander le mdp.

Ce que reset-as-client.sh fait :
1. Backup préventif (`./backup.sh quick`, best-effort)
2. **Stop 30+ containers** (Authentik, Dify, Qdrant, mem0, agents, monitoring,
   scheduler, sandbox, etc.)
3. **Supprime ~25 volumes** (data Authentik, Dify DB, Qdrant vectors,
   scheduler SQLite, monitoring, etc.)
4. **Purge fichiers éphémères** `/srv/ai-stack/data/{concierge-approvals,
   safety_audits.jsonl, pending-reviews.jsonl}`
5. Sauvegarde `.env` actuel en `.env.reset-<ts>.bak`
6. Recrée un `.env` minimal (juste `NETWORK_NAME=aibox_net`)
7. Recrée le réseau Docker `aibox_net`
8. Restart UNIQUEMENT le wizard `aibox-setup` sur port `:8090`

Output attendu en fin de script :
```
════════════════════════════════════════════════════════════════════
  ✓ Reset terminé — la box est repartie en mode 'premier démarrage'
════════════════════════════════════════════════════════════════════

🌐 Wizard de setup disponible sur :
    http://<ip>:8090
```

### Étape 3 — Wizard (sur Chrome)

Ouvrir : `http://192.168.15.210:8090` (depuis ton VPN) ou
`https://demo.ialocal.pro:8090` (si Cloudflare tunnel mappé).

Le wizard fait 4-5 étapes (selon version) :
1. **Identité client** : CLIENT_NAME, secteur, taille
2. **Réseau & domaine** : DOMAIN, AIBOX_PUBLIC_DOMAIN (si Cloudflare)
3. **Hardware** : HW_PROFILE (tpe / pme / pme-plus)
4. **OAuth providers** (optionnel) : Google + Microsoft client IDs
5. **Déploiement** : clic "Lancer le déploiement" → write `.env` + lance
   `install.sh AIBOX_NONINTERACTIVE=1`

L'install.sh va :
- Pull les images Docker
- Démarrer Authentik / Dify / Qdrant / Ollama / aibox-app / n8n / TTS / SearXNG
- **Démarrer aibox-scheduler + aibox-sandbox** (mes nouveaux services — sandbox
  va probablement échouer sur runtime gVisor mais c'est capturé en yellow)
- Lancer `provision-sso` qui enrichit le `.env` avec :
  - `APP_NEXTAUTH_SECRET` ← critique pour ne pas crasher
  - `AUTHENTIK_APP_CLIENT_ID/SECRET/ISSUER`
  - `DIFY_*_API_KEY` (pour les 6 agents)
  - `OWUI_OIDC_*`
  - `NEXTAUTH_URL`
- Re-up `aibox-app` avec le `.env` enrichi → l'app démarre clean
- Re-joue les migrations 0001-0015 (toutes idempotentes)

Durée typique : **3-8 minutes** sur xefia (selon bande passante pour le
pull des images).

### Étape 4 — Validation accès interface

Une fois le wizard terminé :

```bash
# Sur ta machine, ouvre Chrome :
https://demo.ialocal.pro/
# (ou http://192.168.15.210/ depuis VPN)
```

Tu dois voir :
- Page de login Authentik (avec branding "AI Box")
- Login avec `a.ladurelle@xefi.fr` / mdp wizard
- Redirect vers UI BoxIA principale
- Sidebar avec **"Approbations"** visible (si admin)
- Telemetry top bar : CPU/RAM/Disk/GPU + modèle Ollama chargé

---

## 🚦 Si ça plante

### Crash NextAuth `MissingSecretError digest 836006584`

Le wizard n'a pas terminé l'étape `provision-sso`. Recharger la page wizard
sur :8090 et continuer le flow. Si le bouton "Provision SSO" est manquant,
forcer manuellement :

```bash
ssh clikinfo@192.168.15.210 \
  "curl -s -X POST http://localhost:8090/api/deploy/provision-sso \
       -H 'Content-Type: application/json' -d '{}'"
```

### Sandbox container "unknown runtime: runsc"

**Attendu** si gVisor n'est pas installé. install.sh capture en yellow.
L'app fonctionne sans le sandbox, le tool `bash_exec` retournera 502
quand appelé.

Pour activer le sandbox plus tard :
```bash
ssh clikinfo@192.168.15.210
sudo apt install runsc
sudo runsc install
sudo systemctl restart docker
cd /srv/ai-stack/services/sandbox
docker compose --env-file ../../.env up -d
```

### Scheduler container échoue au build

Vérifier les logs : `docker logs aibox-scheduler 2>&1 | tail -50`.
Cause probable : pip install timeout ou `AGENTS_API_KEY` manquant dans `.env`.

### `aibox-mem0` toujours up après reset

Bug détecté pré-test (résolu commit `2be3b55`) — STOP_LIST n'incluait pas
mem0. Si tu vois ce comportement, vérifier que tu as bien sync le code à
jour avec `tools/deploy-to-xefia.sh claude/v2-oss-inspired` avant le reset.

### Le wizard `:8090` ne répond pas

```bash
ssh clikinfo@192.168.15.210
docker ps | grep setup
# Si pas listé :
cd /srv/ai-stack/services/setup
docker compose --env-file ../../.env up -d --build
# Attendre 10s puis re-tenter :8090
```

---

## ✅ Checklist post-install

| Check | Comment |
|---|---|
| Page de login Authentik | https://demo.ialocal.pro/ (ou IP) |
| Login admin OK | `a.ladurelle@xefi.fr` |
| UI principale chargée | Sidebar + chat input |
| Sidebar a "Approbations" | (livré dans v2 OSS-inspired) |
| 6 agents disponibles | dropdown agent picker |
| Concierge accessible (admin) | Click "Concierge AI Box" dans picker |
| Marketplace IA fonctionnelle | /agents/marketplace charge la liste |
| RAG state | /rag affiche les collections Qdrant (vides au reset) |
| Migrations OK | `cat /srv/ai-stack/tools/migrations/_state.json` contient 0001-0015 |
| aibox-scheduler healthcheck | `docker exec aibox-scheduler curl -s localhost:8000/healthz` → `{"ok":true}` |
| aibox-sandbox (si gVisor) | `docker exec aibox-sandbox curl -s localhost:8000/healthz` → `{"ok":true,"runtime":"gvisor"}` |

---

## 🔧 Bonus — si tu veux reset SANS sudo interactif

Tu peux mettre `clikinfo` en NOPASSWD sur `reset-as-client.sh` :

```bash
ssh clikinfo@192.168.15.210
sudo visudo -f /etc/sudoers.d/aibox-reset
# Ajouter :
#   clikinfo ALL=(ALL) NOPASSWD: /srv/ai-stack/reset-as-client.sh
# Sauvegarder + sortir
sudo chmod 0440 /etc/sudoers.d/aibox-reset
```

Après ça, je pourrai lancer le reset moi-même via SSH non-interactif.
À toi de voir si tu veux donner ce pouvoir à l'agent (sécurité vs commodité).
