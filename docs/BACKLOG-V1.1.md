# Backlog V1.1 — état au 2026-05-01

Suivi des features hors-scope du sprint « BoxIA Standard 2026 » qui
avaient été listées comme V1.1.

## ✅ Mémoire long-terme (mem0) — DÉJÀ FAIT

Découverte pendant la validation : `mem0` est déjà 100 % wiré dans
BoxIA depuis un sprint précédent.

- Sidecar `aibox-mem0` (FastAPI) running, healthy.
- Client JS : `services/app/src/lib/memory.ts`
  (`searchUserMemory` / `addUserMemory` / `deleteUserMemory`).
- Hook chat : `services/app/src/app/api/chat/route.ts:46-90` —
  recherche pré-prompt + ajout post-stream via `tee()`.
- RGPD : `services/app/src/app/api/me/delete-conversations/route.ts`.
- UI utilisateur : `services/app/src/app/me/page.tsx:208`.

Smoke test 2026-05-01 :
- `POST /memory/add` (2 messages user/assistant) → 2 facts extraits.
- `GET /memory/search?query=...` → top-K avec score de pertinence.
- `DELETE /memory/user/{id}` → cleanup.

## ✅ Canvas / Artifacts — LIVRÉ ce sprint

Inspiré de Claude Artifacts. Tout block code dont le langage est
`html`, `svg` ou `mermaid` reçoit un bouton « Voir » à côté de
« Copier ». Ouvre un drawer plein hauteur à droite avec preview
sandboxée :

- HTML → `<iframe sandbox>` (allow-scripts + allow-forms).
- SVG → render inline après sanitize basique (strip script + on*).
- Mermaid → iframe avec import dynamique de `mermaid@10` depuis esm.sh
  (pas de dep npm 600 KB en plus).

Fichiers : `lib/artifacts.ts`, `components/ArtifactPanel.tsx`,
`components/MessageMarkdown.tsx`.

Validé live : block `html` avec bouton `<button>Salut</button>` →
preview fonctionnelle dans le drawer.

**Limites V1** : pas de React/JSX live (sandpack 3 MB de bundle =
trop). Pas de Python/SQL execution. Cf section Code Interpreter.

## 🔶 TTS Piper — INFRASTRUCTURE PRÊTE, déploiement à finir

Code et endpoint OK, mais le container `synesthesiam/opentts:fr` n'est
pas encore pulled/started (image ~1.5 GB + 4-6 modèles voix à
télécharger au premier run).

- Compose : `services/tts/docker-compose.yml`
  (image `synesthesiam/opentts:fr`, voix par défaut `larynx2:fr_FR/upmc-jessica-medium`).
- Endpoint : `services/app/src/app/api/tts/route.ts`
  (GET → backend dispo / POST → text → audio/wav stream).
- Hook : `services/app/src/lib/use-speech.ts` — auto-détecte le
  backend au mount via `GET /api/tts`. Si `backend === "piper"` →
  utilise `<audio>` avec le stream serveur. Sinon Web Speech API
  natif (fallback gracieux). Si Piper down au runtime → bascule
  automatique sur Web Speech.

**Pour activer en prod** :

```bash
cd /srv/ai-stack
docker compose -f services/tts/docker-compose.yml up -d
# Première fois : ~5 min (image + modèles)
# Ajouter dans .env :
echo "TTS_BACKEND_URL=http://aibox-tts:5500" >> .env
echo "TTS_DEFAULT_VOICE=larynx2:fr_FR/upmc-jessica-medium" >> .env
# Recreate aibox-app pour propager
docker compose --env-file .env -f services/app/docker-compose.yml up -d --force-recreate app
```

Le code est en place : aucune régression si TTS_BACKEND_URL est absent
(useTTS reste sur Web Speech).

## 🔴 Code Interpreter — BACKLOG (sécurité = chantier sérieux)

**Pourquoi ce n'est PAS dans ce sprint** :
1. Sandbox sécurisé requis : exécuter du code Python généré par LLM
   = vecteur d'attaque évident (sortir du sandbox, lire fichiers,
   appeler le réseau interne, miner crypto, etc.).
2. Options techniques évaluées et leurs coûts :
   - **Daytona / e2b** : excellent mais SaaS, contredit principe
     local-first. Self-hosted : 6+ containers en plus, complexe.
   - **Pyodide WASM** (browser-side) : ~6 MB de bundle, pas de
     pip install, pas de I/O fichiers. Pour le scope « calculatrice
     scientifique », OK. Pour analyse de données (pandas/matplotlib),
     non.
   - **Custom sandbox** (gVisor / Firecracker microVM) : 2-3
     semaines de dev, expertise sysadmin Linux requise.
3. Demande client TPE/PME ? Non, pas encore. Les usages dominants
   restent : Q&A documents, automation workflows, recherche, agents.

**Verdict** : reste backlog jusqu'à demande client claire. Si elle
arrive : commencer par Pyodide pour les usages simples (calculs,
graphiques matplotlib). Si besoin de pip/I/O réel : custom sandbox
Daytona self-hosted ou Modal-style isolated worker.

## Notes architecturales

- `mem0` était dans le backlog par erreur — vérification de
  l'existant aurait évité de le re-planifier.
- Canvas/Artifacts choisit la simplicité : iframe sandbox + esm.sh
  CDN dynamique pour Mermaid plutôt que d'alourdir le bundle.
- TTS Piper feature-flagged : on peut shipper la V1 sans le service
  en prod, le code reste dormant.
- Code Interpreter = la seule case noire qui demande encore un
  vrai design avant code.
