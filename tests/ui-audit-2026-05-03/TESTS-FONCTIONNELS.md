# Tests fonctionnels — AI Box (xefia, port 3100)

**Date** : 2026-05-03
**User** : a.ladurelle@xefi.fr (admin)
**Scénarios couverts** : 9 tests end-to-end via Chrome MCP + curl/JS introspection

## Résumé exécutif

| # | Test | Verdict | Latence | Sévérité bug |
|---|---|---|---|---|
| 1 | Chat Assistant général (qwen3:14b) — Q FR sur TVA rénovation | ✅ OK | ~21 s (cold) | — |
| 2 | Assistant vision — image facture | ❌ Local fail / ✅ Cloud fallback | ~24 s + ~8 s cloud | 🔴 P0 (VRAM saturée) |
| 3 | Assistant comptable — relevé bancaire en texte | ❌ refuse d'analyser | ~30 s | 🟠 P1 |
| 4 | Génération fichier `devis-acme-2026.xlsx` | ✅ OK | ~47 s | — |
| 5 | Concierge BoxIA — list connecteurs via tool | ❌ ne sait pas appeler ses tools + ReAct fuit | ~20 s | 🔴 P0 |
| 6 | Activation 1 agent depuis Marketplace IA | ✅ OK (POST 200) | <2 s | — |
| 7 | Installation 1 workflow depuis Marketplace n8n | ✅ OK (compteur 2 → 3) | <2 s | — |
| 8 | SSO seamless Dify | ✅ OK | <2 s | — |
| 9 | SSO seamless n8n | ⚠ OK avec fallback | timeout >5 s | 🟡 P2 |

**6 ✅ / 2 ❌ / 1 ⚠**

## Test 1 — Chat Assistant général (qwen3:14b)

- **Question** : « Quelle est la TVA sur la rénovation énergétique en France en 2026 ? Réponds en 3 lignes maximum. »
- **Latence** : ~21 s (cold start, modèle déjà chargé en VRAM)
- **Réponse** :
  > « En 2026, la TVA sur les travaux de rénovation énergétique en France est généralement réduite à 5,5 % pour certaines interventions (isolation, chauffage, etc.), contre 20 % pour les autres travaux. Cette réduction vise à encourager les ménages à améliorer leur efficacité énergétique. Les conditions peuvent varier selon les types de travaux et les dispositifs incitatifs en vigueur. »
- **Validations** :
  - Réponse FR correcte et factuelle (TVA 5,5% pour isolation/chauffage)
  - Strip-think OK : aucun `<think>` visible côté user
  - Auto-titrage conversation : « TVA rénovation énergétique France 2026 ? 🤔 »
  - Pas d'erreur console

**Verdict : ✅ OK.** 21 s un peu lent pour la 1ʳᵉ requête mais acceptable.

## Test 2 — Assistant vision (BUG-022 confirmé / BUG-023 partiellement)

- **Image** : facture PNG 600×300 (FACTURE 2026-001 ACME SARL, Total HT 1250, TVA 250, TTC 1500)
- **Méthode** : copie clipboard PowerShell → Ctrl+V dans le chat ✓
- **Question** : « Que vois-tu sur cette image ? Quel est le total TTC ? »
- **Étape 1 — local (qwen2.5vl:7b)** : ❌ **FAIL** après ~24 s
  ```
  [models] Error: API request failed with status code 500: model failed to load,
  this may be due to resource limitations or an internal error
  ```
- **Diagnostic UI** : message FR très bien rédigé :
  > « Mémoire GPU saturée — bascule cloud proposée
  > Le modèle local n'a pas pu charger en VRAM. Cela arrive typiquement quand un modèle vision est demandé alors qu'un modèle texte 14B est déjà chargé (sur GPU 12 GB). »
  > Solution proposée : Utiliser OpenAI (gpt-4o) pour cette requête uniquement. Coût estimé : ~0.030 €.
  > ⚠ Le provider suggéré (OpenAI) n'est pas configuré, mais d'autres le sont (Anthropic Claude, Google Gemini)
- **Étape 2 — fallback cloud Anthropic (claude-sonnet-4-5)** : ✅ OK ~8 s
  > « Je vois une facture (numéro 2026-001) avec les informations suivantes : Client : ACME SARL · Date : 03/05/2026 · Total HT : 1250,00 EUR · TVA 20% : 250,00 EUR · Total TTC : 1500,00 EUR. Le total TTC est de 1500,00 EUR (mille cinq cents euros). »

### Conclusion test 2

- **🔴 BUG-022 confirmé non résolu** : Ollama ne décharge pas qwen3:14b (10.6G) avant de charger qwen2.5vl:7b (5.6G) → 16+ G demandés sur 12 GB de VRAM → fail systématique. À corriger via `OLLAMA_MAX_LOADED_MODELS=1` ou pré-décharge explicite avant switch d'agent.
- **🟢 Le fallback cloud est très bien fait** : message FR clair, alternative proposée selon ce qui est configuré, mention du PII filter, coût estimé. UX impressionnante en cas d'erreur.
- **Conséquence** : un client sans BYOK aura un Vision **inutilisable** en pratique dès qu'il a discuté avec l'agent général juste avant.

## Test 3 — Assistant comptable refuse d'analyser un texte

- **Question** : envoi d'un relevé bancaire en clair (10 lignes débit/crédit MAI 2026) en demandant calcul total/débits/crédits/solde
- **Latence** : ~30 s
- **Réponse** : 🔴 **FAIL fonctionnel**
  > « Pour calculer le total des crédits, débits et le solde, ainsi qu'identifier l'opération la plus importante, je besoin des données spécifiques du relevé bancaire (liste des opérations avec montants, dates, libellés, etc.). Pourriez-vous fournir ces informations ? »
- **Données** : présentes dans le prompt user, ignorées par l'agent.
- **Hypothèse** : pre-prompt comptable trop strict ; l'agent attend un format CSV/FEC précis et refuse les données en colonnes texte. → À assouplir le pre-prompt.
- **Note** : « je besoin » = faute (devrait être « j'ai besoin ») dans la réponse → **probable artefact d'un fine-tuning ou d'un prompt mal structuré**.

**Test upload réel non couvert** : `file_upload` Chrome MCP est bloqué (`Not allowed`), DataTransfer JS aussi (React reset `.files`). À tester manuellement pour valider le pipeline d'extraction texte (BUG-023).

## Test 4 — Génération fichier `devis-acme-2026.xlsx`

- **Demande** : « Génère-moi un fichier Excel devis-acme-2026.xlsx pour la société ACME avec 3 lignes : conseil 5j × 800€, hébergement 12 mois × 50€, formation 2j × 600€ »
- **Latence** : ~47 s (tooling + xlsx generation)
- **Sortie** :
  - Bulle fichier `devis-acme-2026.xlsx · 7 Ko` (BUTTON cliquable, onclick handler)
  - Texte de réponse : « Total HT : 5 800 € · TVA 20 % : 1 160 € · Total TTC : 6 960 € »
  - Math vérifiée : 5×800 + 12×50 + 2×600 = 5 800 ✓ · ×1.20 = 6 960 ✓
  - Référence légale : « article 251-1 du Code général des impôts » (à vérifier — peut être hallucination)
- **Auto-titrage** : « Générer devis Excel ACME 2026 📄 »

**Verdict : ✅ OK.** BUG-006/008/010 (génération [FILE:...]) **résolu**. Latence un peu lourde (~47 s) mais acceptable.

## Test 5 — Concierge BoxIA (function calling cassé)

- **Question** : « Combien de connecteurs sont actuellement actifs sur cette AI Box ? Utilise tes outils pour me répondre. »
- **Latence** : ~20 s
- **Réponse** : 🔴 **FAIL**
  > **Action: Thought:** Je ne peux pas accéder à la liste des connecteurs pour le moment. Veuillez réessayer plus tard ou vérifier manuellement via l'interface admin.
- **2 bugs distincts** :
  1. Le format ReAct interne (`Action: Thought:`) **fuit côté user** — strip-think ne couvre pas ce pattern. P1.
  2. Le Concierge **ne sait pas appeler ses 10 tools HTTP** (`list_connectors`, `install_connector`, etc. selon memory). Soit l'auto-binding tool↔Concierge est cassé sur la branche déployée, soit qwen3:14b ne sait pas function-call à travers le wrapper Dify. **P0** car le Concierge perd toute sa raison d'être.

**Action recommandée** : tester directement côté Dify (« Ouvrir Dify » → app Concierge → tester un tool dans le sandbox) pour isoler la cause.

## Test 6 — Activation 1 agent depuis Marketplace IA

- **Action** : clic « Activer » sur la card « Assistant TVA & comptabilité FR »
- **Comportement** :
  - POST `/api/dify/boxia-fr/install` → **200 OK**
  - GET `/api/dify/installed-agents` → refresh
  - GET `/api/dify/templates` + `/api/dify/boxia-fr` → re-list
  - Compteur passe de **« Assistants activés (1) » → « (2) »**

**Verdict : ✅ OK** (~2 s). Note : le clic via `find + left_click ref` de Chrome MCP **n'avait pas déclenché le handler** — limitation outil, mais via `btns[0].click()` ça marche. À noter pour les tests futurs.

## Test 7 — Installation 1 workflow depuis Marketplace n8n

- **Action** : clic « Installer » sur « Digest factures impayées (Pennylane) »
- **Comportement** :
  - Bouton change en « Installation… » (loading state OK)
  - POST envoyé (probablement `/api/n8n/install`)
  - Compteur passe de **« 2 installés · 2 actifs » → « 3 installés · 2 actifs »**
  - Workflow visible dans n8n direct (cf. test 9)
  - Reste désactivé par défaut (cohérent avec doc « workflows importés désactivés par sécurité »)

**Verdict : ✅ OK**.

## Test 8 — SSO seamless Dify

- **Action** : navigation vers `http://192.168.15.210:3100/api/sso/dify`
- **Résultat** : redirect direct vers `http://192.168.15.210:8081/apps`
- **État** : « André LADURELLE's Workspace » déjà connecté, sidebar Dify (Studio / Connaissance / Outils / Plugins / Explorer) accessible
- **Pas d'écran de login intermédiaire** ✓

**Verdict : ✅ OK** (<2 s).

## Test 9 — SSO seamless n8n (avec fallback)

- **Action** : navigation vers `http://192.168.15.210:3100/api/sso/n8n`
- **Étape 1** (~5 s) : page intermédiaire « Connexion à n8n… Auto-login admin via aibox-app. »
- **Étape 2** (>5 s) : timeout détecté, message « La connexion automatique met du temps. **Ouvrir n8n maintenant** » + bouton fallback
- **Étape 3** (clic fallback) : redirect vers `http://192.168.15.210:5678/home/workflows`
- **État** : connecté comme « AL André LADURELLE », workflows listés dont le Pennylane installé au test 7 (Inactive ✓)

**Verdict : ⚠ OK avec fallback**. Le SSO marche mais l'auto-redirect timeout systématiquement (probablement attente d'un cookie ou d'un POST vers n8n qui prend > 5 s en cold). UX OK puisque fallback button apparaît, mais à optimiser pour seamless < 3 s.

## Bugs P0/P1 nouveaux découverts

| ID | Sévérité | Bug | Sprint propose |
|---|---|---|---|
| FN-01 | 🔴 P0 | **Vision local fail si modèle texte déjà chargé** (BUG-022 non résolu) — impact démo client sans BYOK. | Sprint immédiat (1h) : `OLLAMA_MAX_LOADED_MODELS=1` + `OLLAMA_KEEP_ALIVE=0s` ou pré-décharge explicite avant switch agent vision. |
| FN-02 | 🔴 P0 | **Concierge ne function-call plus** + format ReAct fuit côté user. Perd sa raison d'être. | À investiguer : tester côté Dify, vérifier auto-binding tools, vérifier strip-think regex. |
| FN-03 | 🟠 P1 | **Assistant comptable refuse données texte** structurées en colonnes (10 lignes relevé bancaire). | Assouplir pre-prompt comptable ou ajouter exemples « données en clair OK ». |
| FN-04 | 🟠 P1 | **« je besoin »** (faute FR) dans réponse comptable — qualité prompt. | Revoir pre-prompt comptable. |
| FN-05 | 🟡 P2 | **SSO n8n auto-redirect timeout > 5 s**, fallback button apparaît. | Optimiser le warm-up n8n ou réduire le timeout perçu (skeleton + retry rapide). |

## Tests non couverts (à faire manuellement)

- **Upload PDF/DOCX/XLSX réel** via le bouton trombone (Chrome MCP bloque le file input). À tester pour valider le pipeline d'extraction texte (BUG-023).
- **Téléchargement effectif** du fichier `devis-acme-2026.xlsx` généré par l'agent (button cliquable mais pas testé pour vérifier l'intégrité du xlsx — formules, formatage).
- **Workflow n8n exécuté** (Healthcheck stack 5 min, Snapshot Qdrant) : à vérifier via n8n /executions.
- **Mémoire long-terme** (`/me`) : reste sur « Chargement… ». À investiguer côté API mem0.
- **Branding custom** (Settings → Branding) : champs présents mais effet visuel non vérifié.

## Récapitulatif scoring

- **Bullet-proof pour démo client** :
  - ✅ Chat général + génération fichier + activation marketplace + SSO Dify
- **Casse-démo si non corrigé en sprint 1** :
  - 🔴 Vision local (FN-01) → si pas de cloud BYOK configuré, démo Vision impossible
  - 🔴 Concierge (FN-02) → grosse promesse marketing « configure ta box en langage naturel » pas tenue
- **Polishing avant prod** :
  - 🟠 Comptable trop strict (FN-03/04)
  - 🟡 SSO n8n latence (FN-05)
