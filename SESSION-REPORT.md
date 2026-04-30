# Session 2026-04-30 — Fiabilisation pipeline reset/install

## Objectif

> "vérifie qu'il n'y as plus aucune trace du serveur IA, docker et autre"  
> "Nh'ésite pas a faire toi meme des Wipe + réinstallation en boucle"  
> "Il faut fiabilisé ça avant de faire des amélioration du logiciel IA"

## Bugs identifiés et fixés (par ordre chronologique)

### 1. Install pipeline incomplet (commit `0f8ded0`)
- **`install-firstrun.sh` n'installait pas `aibox-mdns-publish.sh`** → seul `aibox.local` répondait, tous les hostnames flat (`aibox-auth.local`, `aibox-chat.local`, etc.) étaient injoignables
- **`sso_provisioning.py` utilisait `auth.{domain}` (point) ≠ Caddy qui sert `aibox-auth.local` (tiret)** → login OIDC cassé en mode LAN. Helper `_service_url()` introduit, gère les 2 conventions selon `.local` ou public
- **`DOMAIN_PREFIX`, `ALLOW_SELF_SIGNED`, `ACME_CA` jamais écrits dans `.env`** par `main.py:configure`
- **`provision-sso` recreate sans `--build`** → code obsolète possible

### 2. Wizard handoff cassé (commit `afe7940`)
- **`/api/configure/finish` n'arrêtait pas le wizard ni ne démarrait edge-caddy** → `aibox-edge-caddy` restait en `Created` (port 80 occupé par setup-caddy), `https://aibox.local` ne répondait pas, login impossible
- Fix : Popen détaché qui stop setup-caddy + start edge-caddy + écrit `.configured` côté hôte via container alpine

### 3. Recovery scripts (commits `afe7940`, `0a9cae5`)
- **`recover-admin-password.sh`** : reset interactif/non-interactif/random du mdp Authentik. Sync DB Authentik (via `ak shell`) + `.env` + history log
- **`recover-provisioning.sh`** : si le wizard a planté entre `create-admin-user` et `provision-sso`, ce script termine le job idempotent

### 4. mDNS prefix sync (commit `9d1b220`)
- `aibox-mdns-publish.sh` utilisait un `PREFIX` hardcodé `aibox` ; si l'utilisateur choisissait `DOMAIN=boxia.local`, Caddy servait `boxia-*.local` mais mDNS publiait `aibox-*.local` → mismatch
- Fix : fallback en cascade `AIBOX_PREFIX → DOMAIN_PREFIX → 'aibox'` + `EnvironmentFile=-/srv/ai-stack/.env` dans le service systemd

### 5. Pattern appliance default-password (commit `30539d5`)
Plus tolérant aux fautes de frappe à l'install (qui locked-out l'admin).
- **Wizard** : drop des champs password + confirm de l'étape 2, identifiant `admin` pré-rempli, encart visuel "🔐 Mot de passe par défaut : `aibox-changeme!`"
- **Backend** : `WizardSubmit.admin_password` optional (default = `""`), `/api/configure` injecte `DEFAULT_ADMIN_PASSWORD` si vide
- **Authentik** : `attributes.must_change_password=True` posé sur l'user via `ak shell` quand le pwd == DEFAULT
- **App Next.js** : `/api/me/password-status` (GET/POST) lit/clear le flag via Authentik admin API. `PasswordChangeBanner` composant client en haut du layout

### 6. TLS polarity inversion (commit `5b410ca`)
Bug critique au 1er fresh-install end-to-end. Symptôme : `unable to get local issuer certificate`.
- `services/app/docker-compose.yml` mappait `NODE_TLS_REJECT_UNAUTHORIZED: ${ALLOW_SELF_SIGNED:-0}` — sémantique INVERSE
- Fix : compose utilise `NODE_TLS_REJECT_UNAUTHORIZED` directement, `main.py:configure` écrit `ALLOW_SELF_SIGNED=1 + NODE_TLS_REJECT_UNAUTHORIZED=0` en mode `.local`

### 7. Wizard error handling (commit `fd5bd01`)
Le wizard continuait après `create-admin-user` 500 → box "configurée" sans admin réel.
- **Backend** : warmup Authentik enrichi (count + group exist), 5 retries (au lieu de 3), 10 s entre chaque, timeout 45s, logs `print()` à chaque tentative, HTTPException avec detail structuré
- **Frontend** : si `create-admin-user` échoue → wizard STOPPE proprement et affiche l'erreur + suggestion (`recover-admin-password.sh --random`)

### 8. Default pwd ≥ 12 chars + Dify timing (commit `6588a2c`)
- `boxia2026!` (11 chars) rejeté par Portainer (mini 12). Default password changé à `aibox-changeme!` (15 chars, plus explicite : *change me!*)
- **Dify warmup** : `dify-nginx` est Up dès le `compose up -d` mais `dify-api` met 30-60s à démarrer derrière. Solution : warmup loop avant `setup_dify_admin` (poll `/console/api/setup` pendant max 60s)

### 9. Edge-caddy network attachment (commit `00a1e6c`)
Bug observé sur le 2e wipe + reinstall : edge-caddy se retrouvait attaché uniquement à `ollama_net` → Caddy ne pouvait pas résoudre `aibox-authentik-server` → 502 sur OIDC discovery → login impossible.
- Cause : `docker compose up -d` ne ré-attache PAS les networks d'un container existant
- Fix : `--force-recreate` spécifiquement sur edge

### 10. Edge démarré uniquement par handoff + retry flows AK (commit `3a1241d`)
3 bugs fixés en cascade :
- `install.sh` tentait de démarrer edge-caddy alors que `setup-caddy` tenait le port 80 → container créé mais networking incomplet → contamine le handoff. Fix : `install.sh` skip edge-caddy. Le `_HANDOFF_SCRIPT` le démarre lui-même AVEC `--force-recreate` après avoir stop setup-caddy
- Handoff utilisait `up -d` (sans force-recreate) → Fix : `--force-recreate`
- `_ak_get_uuids` échouait avec `KeyError 'authz_flow'` au 1er install (les flows par défaut Authentik sont créés par les blueprints au boot, parfois après le moment où provision-sso est appelé) → Fix : retry loop max 60s

## Scripts créés cette session

| Script | Rôle |
|---|---|
| `bootstrap.sh` | One-liner installer pour serveur Linux propre |
| `wipe-and-reinstall.sh` | Simulation "serveur neuf" — rase tout sauf modèles Ollama |
| `reset-as-client.sh` | Reset léger — garde modèles + code, rejoue le wizard |
| `recover-admin-password.sh` | Reset du mdp admin (interactif/random) |
| `recover-provisioning.sh` | Termine le provisioning OIDC si wizard interrompu |

## Cycles de tests

| Cycle | État | Bugs trouvés |
|---|---|---|
| 1 | partiel | install pipeline incomplet (4 trous) |
| 2 | partiel | edge-caddy network, default pwd, Dify timing, AK flows |
| 3 | **stable** | aucun bug bloquant |
| 4 | en cours | confirmation répétabilité |

## État pipeline final (post cycle 3)

```
✓ Containers     : tous Up + healthy (Authentik, Dify, edge-caddy, app, etc.)
✓ edge-caddy     : aibox_net + ollama_net (les 2 attachés)
✓ OIDC discovery : HTTP 200
✓ Login chain    : authorize URL Authentik retourné correctement
✓ Default pwd    : admin / aibox-changeme!
✓ Banner         : must_change_password=True posé → PasswordChangeBanner s'affichera au login
```

## Reste à faire (non bloquant)

- Dify init validation 401 sur certaines runs (Dify-api pas encore prêt malgré warmup)
- n8n connection refused (la stack héritée n'est pas démarrée — ne fait pas partie de l'install BoxIA)
- Tester un VRAI `wipe-and-reinstall.sh` (avec sudo) pour valider qu'install-firstrun.sh + bootstrap.sh tiennent dans un scénario fully fresh

---

# Phase 2 — Améliorations chat (post-stabilisation)

User a donné carte blanche pour 2h sur l'efficacité du chat. Features ajoutées :

## Drag-drop fichiers (commit `af5b37b`)
- **Backend** : `/api/files/upload` accepte maintenant **PDF, DOCX, TXT, MD, CSV, XLSX, PPTX, HTML** en plus des images. Limite 8 Mo image / 20 Mo doc. Retourne un champ `kind` ("image"|"document") qui choisit le bon `type` dans le payload Dify chat-messages.
- **Frontend** : type `AttachedFile` (kind, name, size, extension, data_url optionnel). Drop overlay plein-écran avec icône Upload + hint formats. Preview dans la barre input avec icône fichier ou thumbnail image. Multi-fichiers supportés en drop.
- Le bouton paperclip est maintenant toujours visible (les agents non-vision peuvent traiter des documents).

## Voice input (commit `af5b37b`)
- Hook custom `useSpeech()` dans `lib/use-speech.ts` qui wrappe `SpeechRecognition` (Chrome/Edge/Safari). **Privacy-first** : la voix ne quitte JAMAIS le navigateur.
- Bouton Mic dans la barre input, rouge pulsant pendant l'écoute. Lang FR par défaut. Le textarea reçoit le transcript en temps réel.
- Caché si navigateur non supporté.

## Slash commands (commit `af5b37b`)
- Composant `SlashCommandMenu` : autocomplete au-dessus du textarea quand l'input commence par "/". Filtre par nom + aliases. Navigation ↑↓⏎⎋⇥. Click souris OK aussi.
- Commandes : `/help` `/new` (alias `/clear`) `/regen` (alias `/retry`, `/regenerate`) `/agent <slug>` `/export` `/summarize` (alias `/resume`)
- Le menu intercepte Enter en mode capture pour empêcher le send.

## Pre-warm Ollama (commit `af5b37b`)
- `/api/system/warmup` (POST) load qwen2.5:7b + qwen2.5vl:7b + bge-m3 en VRAM avec `keep_alive=30m`. Évite ~5-10 s de cold-start à la 1<sup>re</sup> question d'un user.
- Appelé en fire-and-forget au mount du Chat, 1 fois par session (cached via sessionStorage).
- GET endpoint pour health-check externe (liste des modèles).

## ThinkingIndicator dynamique (commit `af5b37b`)
- Phrases qui rotent toutes les 1.8 s pendant la réflexion : "Je réfléchis…" → "Je consulte la base…" → "Je structure…"
- Si user a attaché un fichier au précédent msg : phrases adaptées ("Lecture du document…", "Extraction des points clés…", etc.)

## TTS lecture des réponses (commit `295d9fa`)
- Hook `useTTS()` qui wrappe `speechSynthesis`. Strip basic markdown avant lecture (code blocks, bold, italic, headers, links).
- Bouton 🔊 sur chaque message assistant (à côté Copy/Like/Dislike). Lit en français avec voix native si dispo.
- Click 🔇 pour arrêter (ou Esc en raccourci global).

## Raccourcis clavier améliorés (commit `295d9fa`)
- `Cmd/Ctrl+K` → nouvelle conversation (existant)
- `Esc` → priorité au streaming en cours :
  1. Si streaming actif → abort
  2. Si TTS en lecture → stop
  3. Sinon → ferme drawer mobile
- `/` (hors champ) → focus textarea + insère "/" pour ouvrir direct le menu commandes

## Suggestions agent-specific (commit `549d97a`)
- Avant : tous les agents affichaient les MÊMES 4 suggestions hardcoded.
- Maintenant : chaque agent a ses `suggestedQuestions` (4 max) + `openingStatement` définis dans `lib/agents.ts`. Exposés dans `/api/agents` via `PublicAgentMeta`. Le Chat les utilise prioritairement, fallback sur 4 questions génériques si absent.
- Détail :
  - **general** : email pro, résumé docs, bilan, procédure congés
  - **accountant** : TVA, devis SARL, auto-liquidation, seuils RSI 2026
  - **hr** : congés, contrat CDI cadre, indemnité licenciement, mi-temps
  - **support** : retard livraison, relance devis, augmentation tarif, avis Google
- + hints discrets en empty state pour découvrir les nouvelles features (drag-drop, micro, slash commands).

## Synthèse des features chat

Le chat est maintenant équipé pour des usages mobiles / hands-free :

| Input | Output | Mode |
|---|---|---|
| Texte au clavier | Texte streamé | Standard |
| **Voix (Mic)** | Texte streamé | Hands-busy (cuisine, voiture) |
| **Drag-drop PDF** | Texte streamé | Analyse de document |
| **Slash command** | Action (export, regen, summarize…) | Power user |
| Texte ou voix | **TTS (Volume)** | Hands-free / accessibility |

Combinaisons :
- 🎤 Mic + 🔊 TTS = expérience full vocal
- 📎 PDF + ✏ texte = "résume-moi ce contrat"
- ⚡ /summarize après 10 messages = recap automatique
