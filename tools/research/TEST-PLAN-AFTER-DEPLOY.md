# 🧪 Test Plan — après déploiement de `claude/eager-buck-3b6e79`

> Plan de test à exécuter via Chrome MCP **après** que tu lances :
> ```bash
> tools/deploy-to-xefia.sh claude/eager-buck-3b6e79
> ```
>
> Toutes les nouvelles fonctionnalités passent par migration ; le script
> rejouera automatiquement 0013 (DELEGATE-V1), 0014 (provider Dify),
> 0015 (REPLAN-V1).
>
> Baseline pré-déploiement testé 2026-05-05 par session autonome :
> - `/approvals` → 404 ✅ (attendu)
> - `/api/approvals` → 404 ✅ (attendu)
> - `/api/concierge/pending` → `{"pending":[]}` ✅ (rétrocompat)
> - UI BoxIA chargeable, login André OK, conversations historiques visibles,
>   connecteurs SharePoint/OneDrive/Drive actifs

---

## 🎯 Suite de tests post-déploiement

### TEST 1 — Pages nouvelles (P0 #2 part 3/3)

**Action** : naviguer vers `https://demo.ialocal.pro/approvals`
**Attendu** :
- ✅ Page rendue (plus 404)
- ✅ Header "Actions en attente d'approbation" + icône amber
- ✅ Sous-titre adapté à `isAdmin` (admin = "tous utilisateurs", non-admin = "vos agents")
- ✅ Si aucun pending → ApprovalBanner ne rend rien (pas de bloc), texte explicatif visible
- ✅ Pas d'erreur console JS

**Action** : `GET /api/approvals` (via fetch dans console ou navigation)
**Attendu** :
- ✅ JSON `{"pending":[],"count":0,"is_admin":true|false}`
- ✅ Si admin → tous pending visibles ; sinon → seulement les pending avec `user_id` matching session ou sans `user_id` (legacy)

---

### TEST 2 — Concierge delegate (P0 #4)

**Pré-requis** : migration 0014 a tourné côté Dify console → vérifier dans
Dify console > Tools > Custom Tools que **boxia-delegate** apparaît avec
icon 🤝 et 1 endpoint `delegate_to_specialist`.

**Action** : ouvrir Concierge BoxIA dans `/`, demander :
> « Demande à l'assistant comptable quel est le taux TVA pour la livraison de repas à domicile en France en 2026 »

**Attendu** :
- ✅ Le Concierge appelle `delegate_to_specialist` avec `slug=accountant` (visible dans events SSE Dify ou Langfuse spans `tool:delegate_to_specialist`)
- ✅ Réponse intégrée dans la synthèse Concierge (mentionne "Assistant comptable")
- ⚠️ Si le composant `<DelegationCard>` est wired dans MessageMarkdown.tsx (pas fait dans cette session) → bloc collapsible "🤝 Réponse de 📊 Assistant comptable" visible
- ✅ Pas d'erreur "unknown_agent" ou "agent_unavailable"

**Action** : vérifier les garde-fous :
- ✅ Demander au Concierge de "déléguer à Concierge" → réponse self_delegation_refused (le Concierge devrait expliquer qu'il ne peut pas se déléguer à lui-même)
- ✅ Vérifier MAX_DEPTH=2 : le specialist appelé ne devrait pas pouvoir re-déléguer (aucun specialist n'a le tool aujourd'hui, donc auto-respecté)

**Vérification Langfuse** : trace `tool:delegate_to_specialist` avec metadata `target_slug=accountant`, `depth=0`, `answer_chars` > 100.

---

### TEST 3 — Contrat erreurs unifié (S0.2)

**Action** (via curl ou Postman, depuis aibox-app side) :
```bash
curl -X POST https://demo.ialocal.pro/api/agents-tools/web_search \
  -H "Authorization: Bearer $AGENTS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Attendu** :
- HTTP 400
- Body : `{"ok":false,"error":"missing_or_short_query","hint":"Champ 'query' requis ...","retryable":false}`
- (Avant : `{"error":"missing_or_short_query","hint":"min 2 chars"}`)

**Action** : toutes les routes agents-tools/* renvoient désormais ce contrat
unifié sur les chemins d'erreur. Pour le test exhaustif, voir
`audit_P0_02_hitl.md`.

---

### TEST 4 — Langfuse spans tool-call (S0.3)

**Pré-requis** : `LANGFUSE_BASE_URL` configuré dans `.env`, container
`aibox-langfuse-web` healthy.

**Action** : ouvrir Langfuse UI (URL dans l'onglet "Bench & observabilité"
de l'AI Box). Filtrer par tag `tool:web_search`.

**Attendu** :
- ✅ Liste de traces avec metadata `duration_ms`, `http_status`, `error_code` (si fail), `retryable` (si fail)
- ✅ Tags `agent:concierge`, `status:success` ou `status:failure`
- ✅ Si erreur retryable → tag `retryable` posé

**Action** : générer un fail volontaire (web_search avec mots-clés bizarres → SearXNG retourne 0). Vérifier la trace `failure`.

---

### TEST 5 — Replan dynamique (P0 #5)

**Pré-requis** : migration 0015 (REPLAN-V1) injectée. Vérifier dans Dify
console > Concierge BoxIA > Pre-prompt que le marqueur `[REPLAN-V1]` est
présent en tête.

**Action** : poser au Concierge une tâche multi-step explicite :
> « Cherche le dernier email de mon directeur dans Outlook, puis
>   résume-le pour moi, et enfin propose-moi 2 lignes de réponse »

**Attendu** :
- ✅ Le Concierge expose un PLAN (3 steps) avant d'exécuter
- ✅ Step 1 : `outlook_search` ou `outlook_read_inbox`
- ✅ Step 2 : synthèse (peut être inline dans la réponse)
- ✅ Step 3 : 2 lignes de réponse
- ✅ Si un step fail (ex: Outlook OAuth non connecté) → Concierge réécrit
  proprement (« je ne peux pas accéder à Outlook actuellement, voici une
  alternative... »)

**Action** : poser une tâche TRIVIALE :
> « Bonjour »

**Attendu** :
- ✅ Réponse directe sans plan exposé (mode LOW)

---

### TEST 6 — Safety Auditor (P0 #3) — limité sans contexte injecté

⚠️ Le SafetyAuditor ne s'active QUE si la route mutative passe
`audit_context` à `requireApproval()`. Aujourd'hui aucune route ne le
passe (pas wired dans cette session). Donc P0 #3 est **livré en library
mais pas encore activé en prod**.

**Action minimale** : vérifier que le service `qwen3:1.7b` est chargeable
via Ollama :
```bash
ssh clikinfo@xefia "docker exec aibox-ollama ollama list" | grep qwen3:1.7b
```

**Attendu** : `qwen3:1.7b` listé. Si absent :
```bash
ssh clikinfo@xefia "docker exec aibox-ollama ollama pull qwen3:1.7b"
```
(~1 GB téléchargé en quelques minutes)

**Action de wiring future** (out of scope cette session) : modifier
`install_workflow/route.ts` et `install_agent_fr/route.ts` pour passer
`audit_context` (par ex le 3 derniers tool-call results capturés depuis
Langfuse OU passé par le Concierge dans le body).

---

### TEST 7 — Approval auto-approve persistent (P0 #2 partie 1)

**Action** : déclencher une approval ayant `auto_approve_key` (à wirer
côté tool — actuellement pas exposé. Best-effort : le flag est dispo
côté lib mais aucun caller ne le set encore).

**Attendu après wiring** : checkbox "ne plus me redemander" visible
dans `<ApprovalBanner>`. Si cochée + approve, future demande avec même
(action, auto_approve_key) bypass silencieux le banner.

---

### TEST 8 — Régression rétrocompat

**Critique** — vérifier que rien n'a cassé :

| Endpoint legacy | Statut attendu |
|---|---|
| `GET /api/concierge/pending` (admin) | `{"pending":[]}` JSON |
| `POST /api/concierge/decide` (admin, body `{action_id,decision}`) | mêmes returns qu'avant |
| `<ConciergeApprovalBanner>` global dans `layout.tsx` | toujours rendu pour admin |
| 17 routes agents-tools (call avec auth Bearer) | renvoient bien JSON ok=true (pas de 500) |
| Concierge avec `install_workflow` legacy | Banner s'affiche toujours, approve → exécute |
| `/api/chat` streaming SSE | toujours fonctionnel (utilise difyChatStream désormais) |

---

## 📋 Comment exécuter ce plan

**Option 1 — manuel via Chrome** : suivre les actions une à une.

**Option 2 — automatisé via Chrome MCP** (Claude session) : prompt à donner :

```
Tu vas exécuter le plan de test dans tools/research/TEST-PLAN-AFTER-DEPLOY.md
sur https://demo.ialocal.pro/.

Le déploiement de claude/eager-buck-3b6e79 vient d'être fait.

Pour chaque TEST :
1. Liste les browsers Chrome connectés, sélectionne PC MAISON
2. Crée un nouvel onglet
3. Exécute les actions (navigate / click / find)
4. Compare au résultat attendu
5. Rapport ✅/❌ avec capture si échec

Sortie : un fichier tools/research/TEST-RESULTS-<DATE>.md avec
la liste des tests et leur statut + screenshots des fails.

Stop conditions : si un test régression (TEST 8) fail → STOP, alerte user.
```

**Option 3** — moi (Claude) je l'exécute en mode autonome quand tu me
dis « OK déployé, lance les tests ». Je rapporte les résultats dans
TEST-RESULTS-<DATE>.md et identifie tout fail bloquant.
