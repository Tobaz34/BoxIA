# Runbook — restaurer les automatisations « patron » après un reset/re-provisioning

Un (re-)provisioning régénère le `HERMES_HOME` d'un tenant et **efface** l'état runtime
(crons, scripts, allowlist Telegram, choix de modèle). Ce qui EST déjà durable (dans git,
sur `claude/gateway`) : le code des connecteurs (dont le fix email `09f8469`), les skills,
l'unit dashboard corrigée (`--host 127.0.0.1`), et les scripts `tenant-scripts/`.

## Rejouer les automatisations (idempotent)
```bash
HERMES_HOME=/home/clikinfo/aibox/companies/demo/users/andre/hermes \
AIBOX_TELEGRAM_CHAT=8196716694 \
bash ~/BoxIA/aibox-hermes/provision/setup-aibox-automations.sh
```
Installe les scripts `rapport-equipe`/`veilleur-urgence`, (re)crée les crons
(rapport 9/12/15/18/21 lun-ven ; veilleur `*/2` 7-22 ; revue-incidents 17h) avec
livraison Telegram, et pose `TELEGRAM_ALLOWED_USERS`. Re-lançable sans risque.

## Ce qui reste manuel après reset
1. **Token Telegram** : `TELEGRAM_BOT_TOKEN` doit être dans `HERMES_HOME/.env`
   (fourni au provisioning via `TELEGRAM_BOT_TOKEN=…`), sinon le bot @Clikinfo_bot
   n'envoie rien.
2. **Codex (ChatGPT/OpenAI)** — OAuth navigateur, non automatisable :
   ```bash
   HERMES_HOME=… hermes auth add openai-codex --type oauth --no-browser
   # ouvrir l'URL device-code, se connecter ChatGPT, valider
   ```
   puis re-sélectionner `gpt-5.4` (dashboard) + fallback local `qwen3:8b-64k`.
3. **Restart** des services du user : `sudo systemctl restart aibox-gateway@<user> aibox-webui@<user> aibox-dash@<user>`.

## TODO durabilité (non fait)
- Auto-appeler `setup-aibox-automations.sh` depuis `wizard-user.sh` pour le user "patron".
- Rendre le choix Codex portable dans `render_config.py` (le config, pas l'auth).
- Paramétrer les chemins codés en dur des `tenant-scripts` (owner/company) pour la franchise.
