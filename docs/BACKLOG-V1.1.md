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

---

## V2 : Branching messages + Multi-response BYOK side-by-side

**Pourquoi pas livré en V1** : refactor lourd du data model conversation
(arbre `parentId/childrenIds` au lieu de liste plate), du state Chat.tsx
(navigation entre branches), de l'API `/api/conversations/messages`
(pagination par branche), et **Dify ne supporte pas nativement le
branching** — on contournerait via `conversation_id` parent +
metadata custom.

### Design proposé

**1. Data model côté local (BoxIA storage, pas Dify)**

Nouveau fichier `/data/message-tree.json` :
```json
{
  "<conversation_id>": {
    "messages": {
      "<msg_id>": {
        "id": "...",
        "parent_id": "...",         // null si racine
        "children_ids": ["...", ...], // 0 ou N
        "role": "user" | "assistant",
        "content": "...",           // dupliqué pour l'arbre, source = Dify
        "model": "qwen3:14b" | "gpt-4o" | "claude-3-5-sonnet",
        "created_at": 12345,
        "branch_label"?: string     // optionnel, ex "GPT-4o version"
      }
    },
    "current_path": ["<root_id>", "<msg_id>", ...]
  }
}
```

**2. UI Chat.tsx**

- Quand on clique « Régénérer » → l'ancienne réponse devient sibling,
  pas remplacée. Indicateur `‹ 1/3 ›` apparaît sous le message avec
  flèches pour naviguer entre versions
- Multi-response BYOK : bouton « Comparer avec » dropdown (qwen3 local,
  gpt-4o, claude-3.5-sonnet, mistral-large) → fan-out 2 fetch en
  parallèle, render side-by-side

**3. Multi-response architecture**

```typescript
// app/src/components/MultiResponseRow.tsx
interface MultiResponse {
  modelId: string;       // "qwen3:14b" | "openai/gpt-4o" | ...
  content: string;       // réponse streamée
  status: "streaming" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  cost_eur?: number;     // calculé via cloud-providers
}
// Rendu en 2 cards horizontales scrollables (mobile) ou côte-à-côte (desktop)
```

**4. Estimation effort**

- Data model + persistance : 1 jour
- Refactor Chat.tsx state arbre + navigation siblings : 1.5 jour
- API endpoints (POST /api/messages/branch, GET /api/messages/path) : 1 jour
- Multi-response UI + fan-out fetch BYOK : 1.5 jour
- Tests + audit log + RGPD : 0.5 jour

**Total : ~5 jours dev** (taille V2 confirmée par audit OWUI).

### Quand lancer ?

Quand un client pilote demande explicitement « je veux comparer Qwen
local vs GPT-4o sur la même question ». Argument commercial fort
quand BYOK est activé. Pas avant : un client qui ne paie pas d'API
externe n'a aucun cas d'usage pour le multi-response.

---

## V2 : Voice Call Mode full-duplex

**Pourquoi pas livré en V1** : l'écosystème nécessaire (VAD client +
WebRTC + STT serveur + TTS chunké côté serveur + state machine
duplex) demande 2 semaines minimum, et le ROI client TPE/PME est
faible (les gens préfèrent écrire pour avoir une trace).

### Design proposé

**Architecture cible**

```
┌─ Browser ──────────────────────────────────┐
│ getUserMedia({audio}) → MediaRecorder      │
│ ↓ chunks 250 ms                            │
│ Web Worker VAD (silero-vad WASM)           │
│ ↓ speech detected                          │
│ WebSocket /api/voice/stream → server       │
└────────────────────────────────────────────┘
                  ↓ ↑
┌─ Server (Next.js API route ou sidecar) ───┐
│ STT : whisper-cpp local (sidecar)          │
│ ↓ transcript partial                        │
│ → Dify conversation streaming               │
│ ← LLM tokens                                │
│ ↓ chunks 100 chars                          │
│ TTS Piper → audio/wav stream                │
│ ↓ ↑ via WebSocket binary                    │
└────────────────────────────────────────────┘
```

**Composants à ajouter**

1. **Sidecar `aibox-stt`** : `lscr.io/linuxserver/whisperx` ou
   `ghcr.io/openai/whisper:tiny` self-hosted. Stream PCM 16kHz
   mono → transcript JSON. ~500 MB image, ~1 GB VRAM tiny model
   (CPU OK aussi).

2. **VAD WASM client** : `silero-vad` JS (170 KB), détecte
   debut/fin de parole sans envoyer d'audio inutile au serveur.
   Économie bande passante 80%.

3. **WebSocket route** : `services/app/src/app/api/voice/route.ts`
   (ou mieux : sidecar Node dédié, Next API a ses limites WS).
   Multiplex les flux audio user + audio assistant + transcript
   text dans un même socket binaire.

4. **CallOverlay component** : modal plein écran inspiré de
   l'`OWUI src/lib/components/chat/MessageInput/CallOverlay.svelte` :
   - Visualisation onde audio en temps réel (analyser node)
   - Indicateurs : 🎤 (user parle), 🔊 (assistant répond), ⏸️ pause
   - Transcript live défilant (sous-titres)
   - Bouton « interrompre » qui tue le TTS en cours

**Difficultés réelles**

- **Latence** : la chaîne `audio → STT → LLM → TTS → audio` doit
  rester sous 1.5s pour un effet « conversation naturelle ». Le
  bottleneck est le LLM (qwen3:14b génère ~30 tok/s sur 12 GB GPU,
  donc 1ère phrase ~2s). Solution : speculative decoding +
  streaming TTS chunké phrase par phrase, pas attendre la fin LLM.
- **Annulation** : si l'utilisateur reparle pendant que l'assistant
  parle, il faut killer le TTS proprement et redémarrer le LLM.
  Demande coordination state-machine côté serveur.
- **Permissions navigateur** : accès micro requiert HTTPS (ou
  localhost) + interaction user-gesture initiale.

**Estimation effort**

- Sidecar STT (whisper.cpp) compose + endpoint : 0.5 j
- WebSocket multiplex (audio bidir + transcript text) : 1.5 j
- VAD WASM client + MediaRecorder pipeline : 1 j
- TTS streaming chunké phrase par phrase : 1 j
- CallOverlay UI + visualisation audio : 1.5 j
- State machine duplex (interruption, pause) : 2 j
- Tests latence + tuning + audit RGPD audio : 1.5 j

**Total : ~9-10 jours dev**.

### Quand lancer ?

Pertinent **uniquement quand on attaque le connecteur 3CX**
(téléphonie d'entreprise FR). Là on peut router les appels entrants
vers BoxIA Voice Mode pour pré-qualifier, prendre RDV, transférer.
Sans 3CX, c'est une démo monstre mais zéro usage métier réel chez
TPE/PME.

---

## Récap priorisation V2

| Chantier | Effort | Trigger |
|---|---|---|
| Branching + Multi-response BYOK | ~5 j | Client paie un abo cloud + veut comparer |
| Voice Call Mode | ~10 j | Client active connecteur 3CX |
| Code Interpreter | ~10-15 j | Demande analyse données / Excel répétitive |
