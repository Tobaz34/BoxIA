# Passation — Donner à un Claude interactif l'accès aux 6 boîtes email (sur le VPS Odoo prod)

> **À lire par la session Claude cible.** Objectif : te permettre de faire de la
> **gestion d'emails ponctuelle** (lire, trier, brouillon, répondre) sur les 6 boîtes
> de CLIKINFO/XEFI, via des **serveurs MCP** que tu enregistres dans ton client Claude.
> Ces connecteurs existent déjà (utilisés par l'« AI Box » sur le serveur xefia) — tu
> les réutilises tels quels. **Ne commite jamais les secrets.**

## Contexte
- **Cible** : le VPS de prod Odoo (`srv838763`, `69.62.107.121`, Hostinger, `odoo.clikinfo.fr`).
- **6 boîtes**, couvertes par **3 connecteurs MCP** (Python / FastMCP, transport stdio) :
  | Connecteur | Boîtes | Techno |
  |---|---|---|
  | `email-msgraph` | a.ladurelle@, contact@, support@**clikinfo.fr** | Microsoft Graph app-only (MSAL) |
  | `email-ews` | a.ladurelle@**xefi.fr** | Exchange on-prem (EWS/NTLM, `outlook.xefi.fr`) |
  | `himalaya` | clikinfo34@**gmail.com**, contact@**ridequest.fr** | CLI himalaya (IMAP/SMTP) |
- Chaque connecteur expose : `*_health`, `list_recent_emails`, `read_email`,
  `list_mail_folders`, `create_draft_email`, `send_draft_email`, `mark_email_read`,
  `move_email` (+ msgraph : `list_attachments`, `save_attachment`, `create_mail_folder`).

## Étape 0 — Récupérer le code des connecteurs
Source de vérité : le dépôt **BoxIA** (dossiers `aibox-hermes/mcp-connectors/{email-msgraph,email-ews,himalaya}`), présent sur **xefia** (`/home/clikinfo/BoxIA`).
Copie les 3 dossiers sur le VPS, p.ex. (adapter l'accès xefia) :
```bash
mkdir -p ~/claude-email/connectors
scp -r clikinfo@192.168.15.210:/home/clikinfo/BoxIA/aibox-hermes/mcp-connectors/{email-msgraph,email-ews,himalaya} ~/claude-email/connectors/
```
> Si le VPS n'atteint pas xefia : récupérer les 3 dossiers depuis le dépôt git BoxIA
> par un autre canal. Chaque dossier = un `server.py` + `requirements.txt` autonomes.

## Étape 1 — Environnements Python (un venv par connecteur)
```bash
for c in email-msgraph email-ews himalaya; do
  python3 -m venv ~/claude-email/connectors/$c/.venv
  ~/claude-email/connectors/$c/.venv/bin/pip install -q -r ~/claude-email/connectors/$c/requirements.txt
done
```
(`himalaya` nécessite en plus le **binaire himalaya v1.x** + sa config — voir étape 2c.)

## Étape 2 — Renseigner les identifiants (⚠️ secrets — à obtenir, jamais commités)

### 2a. Microsoft 365 (`email-msgraph`)
App Entra **« AI Box Email »** (déjà créée, permissions Application accordées :
Mail.ReadWrite, Mail.Send). Variables d'environnement du connecteur :
- `MSGRAPH_TENANT_ID` = `af045e72-feb6-4981-9485-b4f58c0a7ab7`
- `MSGRAPH_CLIENT_ID` = `7a395224-fe42-4dd2-b7e6-aac87fc0df20`
- `MSGRAPH_CLIENT_SECRET` = **à récupérer** (Entra → App registrations → AI Box Email →
  Certificates & secrets ; ou réutiliser la valeur du `.env` xefia). *Si expiré : générer
  un nouveau secret.*
- `MSGRAPH_ALLOWED_MAILBOXES` = `a.ladurelle@clikinfo.fr,contact@clikinfo.fr,support@clikinfo.fr`

### 2b. Exchange on-prem (`email-ews`)
- `EWS_ENDPOINT` = `https://outlook.xefi.fr/EWS/Exchange.asmx`
- `EWS_EMAIL` = `a.ladurelle@xefi.fr`
- `EWS_USERNAME` = `a.ladurelle@xefi.fr` (ou `DOMAINE\\user`)
- `EWS_PASSWORD` = **à saisir** (mot de passe du compte xefi)
- `EWS_VERIFY_TLS` = `0` (cert interne toléré)

### 2c. Gmail + RideQuest (`himalaya`)
- Installer le binaire **himalaya v1.x** sur le VPS (`~/.local/bin/himalaya`).
- Copier la config depuis xefia : `~/.config/himalaya/config.toml` **+ les fichiers de
  mots de passe** référencés (`gmail.pass`, `ridequest.pass`, chmod 600). Les mots de
  passe (app-password Gmail, mdp Hostinger) ne sont **pas** dans la config, mais dans
  ces fichiers `.pass`.
- Variables du connecteur : `HIMALAYA_BIN=~/.local/bin/himalaya`, `HIMALAYA_ACCOUNTS=gmail,ridequest`, `HOME=<home du VPS>`.

## Étape 3 — Enregistrer les connecteurs comme serveurs MCP

### Si Claude Code (CLI, recommandé sur un VPS headless)
```bash
C=~/claude-email/connectors
claude mcp add email-msgraph -- $C/email-msgraph/.venv/bin/python $C/email-msgraph/server.py \
  -e MSGRAPH_TENANT_ID=… -e MSGRAPH_CLIENT_ID=… -e MSGRAPH_CLIENT_SECRET=… -e MSGRAPH_ALLOWED_MAILBOXES=…
claude mcp add email-ews -- $C/email-ews/.venv/bin/python $C/email-ews/server.py \
  -e EWS_ENDPOINT=… -e EWS_EMAIL=… -e EWS_USERNAME=… -e EWS_PASSWORD=… -e EWS_VERIFY_TLS=0
claude mcp add himalaya -- $C/himalaya/.venv/bin/python $C/himalaya/server.py \
  -e HIMALAYA_BIN=$HOME/.local/bin/himalaya -e HIMALAYA_ACCOUNTS=gmail,ridequest -e HOME=$HOME
```
*(Vérifie la syntaxe exacte de `claude mcp add` de ta version ; les secrets peuvent aussi
être mis dans un fichier d'env hors du dépôt plutôt qu'en ligne de commande.)*

### Si Claude Desktop
Ajouter dans `claude_desktop_config.json` → `mcpServers` un bloc par connecteur :
`{ "command": "<venv>/bin/python", "args": ["<...>/server.py"], "env": { … } }`.

## Étape 4 — Vérifier
Demande à Claude : *« appelle msgraph_email_health / ews_email_health / himalaya_email_health »*
puis *« liste mes 5 derniers emails non lus de a.ladurelle@clikinfo.fr »*. Tu dois obtenir
les enveloppes sans erreur.

## Sécurité — à respecter
- **Les 3 connecteurs donnent lecture + écriture + envoi** sur toutes ces boîtes (Graph est
  **tenant-wide**). Traite ce VPS comme un système sensible. Restreins l'accès au fichier d'env.
- **Ne commite aucun secret** (client secret, mdp EWS, `.pass`). Utilise un fichier d'env
  chmod 600 hors dépôt.
- **Envoi d'emails** : `send_draft_email` envoie réellement. En usage ponctuel/interactif,
  garde la main : prépare des **brouillons** (`create_draft_email`) et n'envoie qu'après relecture.
- Pas de suppression définitive : au plus déplacer (`move_email` vers la corbeille).
- Ces connecteurs sont **indépendants** de l'AI Box autonome (xefia) : les monter ici
  n'affecte pas les routines existantes. (Exception : Telegram n'est pas concerné ici — un
  seul process peut détenir un bot ; ne mets pas de token Telegram sur ce setup.)

## Résumé de ce que la session cible doit obtenir de toi (André)
1. `MSGRAPH_CLIENT_SECRET` (Entra, ou `.env` xefia).
2. `EWS_PASSWORD` (compte xefi).
3. La config + fichiers `.pass` himalaya (Gmail app-password, mdp RideQuest).
4. Un accès pour copier les 3 dossiers connecteurs (xefia ou dépôt).
