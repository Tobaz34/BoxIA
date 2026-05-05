# Audit P0 #2 — HITL générique + is_sensitive_action

## 🔍 Existant BoxIA

### 1. `lib/approval-gate.ts`

Fichier : `services/app/src/lib/approval-gate.ts` (249 lignes, lu en entier).

**Stockage** : **filesystem** (PAS Postgres, PAS Redis, PAS in-memory). Un fichier JSON par
pending dans `process.env.CONCIERGE_APPROVALS_DIR || "/data/concierge-approvals"`. Volume
Docker `/data` partagé avec l'audit log et toute la state app (`CONNECTORS_STATE_DIR=/data`).

**Type central** (lignes 45-58) :
```ts
interface PendingApproval {
  id: string;                      // 32 hex chars (crypto.randomBytes(16))
  action: string;                  // slug du tool: "install_workflow"
  description: string;             // texte FR pour banner UI
  params: Record<string, unknown>; // params ré-utilisés à l'exécution (jamais le body 2nd appel)
  created_at: number;              // ms epoch
  expires_at: number;              // TTL CONCIERGE_APPROVAL_TTL_MS = 5min
  status: "pending" | "approved" | "rejected";
  caller_actor?: string;           // hardcodé "concierge-agent" partout
}
```

**API publique exportée** :
- `createPending(opts)` → `PendingApproval` (l. 87)
- `listActive()` → liste pending non expirés, auto-purge expirés (l. 112)
- `decide(id, "approved"|"rejected")` (l. 137)
- `consumeApproved(id, expectedAction)` → atomique : valide token+action+TTL, supprime
  fichier, retourne params approuvés (l. 155)
- `requireApproval<T>({ body, action, description, params, caller_actor })` (l. 197) — wrapper
  haut-niveau réutilisé par les 2 routes mutatives

**Pattern d'appel actuel** (cf install_workflow/route.ts l. 52-60) : tool route fait validation
input → check whitelist catalogue → `requireApproval()`. Le 1er appel sans token retourne 202
+ `action_id`. Le 2nd appel (déclenché par `/api/concierge/decide` ligne 87-100 qui ré-appelle
en interne `/api/agents-tools/<action>` avec le token Bearer + body merged
`{...params_approuvés, approval_token: id}`) consomme.

**Limitations actuelles** :
- Aucun `userId` dans le pending — `caller_actor` est toujours `"concierge-agent"`.
  Multi-tenant impossible (l'admin Alice voit les pending de l'admin Bob).
- Pas de `auto_approve_key` (chaque appel d'un même tool re-déclenche un pending).
- Pas de classification `is_sensitive_action` — l'opt-in est binaire et explicite par tool.
- Décide route `/api/concierge/decide` couple décision + ré-exécution synchrone (le
  `decide()` de la lib ne fait que muter le statut ; c'est la route qui re-fetch).

### 2. Routes `/api/concierge/decide` et `/api/concierge/pending`

- `services/app/src/app/api/concierge/decide/route.ts` (120 lignes) — POST. Gate admin via
  `getServerSession + isAdmin` (l. 28-32). Body `{action_id, decision: "approve"|"reject"}`.
  Si `approve`, ré-appelle `${url.origin}/api/agents-tools/${updated.action}` avec
  `Authorization: Bearer ${AGENTS_API_KEY}` (l. 87-100). Logge dans audit avec action
  `concierge.approval`. Génériques **par accident** : la route est déjà name-agnostique côté
  decide/dispatch (elle utilise `updated.action` comme path), donc elle peut déjà router vers
  n'importe quel `/api/agents-tools/<x>` qui implémente `requireApproval`. Le couplage
  Concierge est dans le **nom** + l'accès admin-only + le `caller_actor` "concierge-agent".

- `services/app/src/app/api/concierge/pending/route.ts` (26 lignes) — GET. Renvoie `{pending: []}`
  en silence pour non-admin (l. 21-23). Renvoie tout `listActive()` sans filtrer par user.

### 3. Liste exhaustive des 17 agents-tools

Vérifié via `Glob services/app/src/app/api/agents-tools/**/route.ts` (17 routes + 1 index `route.ts`).

| # | Tool | Méthode | Classification | Justification |
|---|---|---|---|---|
| 1 | `route.ts` (index) | GET | **read-only** | Manifest statique |
| 2 | `calendar_find_free_slot` | GET | **read-only** sensitive=false | Lecture freeBusy Google/MS |
| 3 | `calendar_today` | GET | **read-only** sensitive=false | Liste events du jour |
| 4 | `deep_link` | GET | **read-only** sensitive=false | Génère URL admin (action manuelle ensuite) |
| 5 | `gmail_get_thread` | GET | **read-only** sensitive=false | Lecture pure |
| 6 | `gmail_read_inbox` | GET | **read-only** sensitive=false | Lecture pure |
| 7 | `gmail_search` | GET | **read-only** sensitive=false | Lecture pure |
| 8 | `install_agent_fr` | POST | **mutatif sensitive=true** | Provisionne app Dify + persiste `installed-agents.json` |
| 9 | `install_workflow` | POST | **mutatif sensitive=true** | Crée workflow n8n + écrit catalogue local |
| 10 | `list_connectors` | GET | **read-only** sensitive=false | Lecture state |
| 11 | `list_marketplace_agents_fr` | GET | **read-only** sensitive=false | Catalogue statique |
| 12 | `list_marketplace_workflows` | GET | **read-only** sensitive=false | Catalogue statique |
| 13 | `outlook_get_message` | GET | **read-only** sensitive=false | Lecture pure |
| 14 | `outlook_read_inbox` | GET | **read-only** sensitive=false | Lecture pure |
| 15 | `outlook_search` | GET | **read-only** sensitive=false | Lecture pure |
| 16 | `rag_search` | GET | **read-only** sensitive=false | Recherche Qdrant |
| 17 | `system_health` | GET | **read-only** sensitive=false | Proxy `/api/system/health` |
| 18 | `web_search` | POST | **read-only** sensitive=false | Méthode POST mais sémantique read-only via SearXNG |

**Bilan actuel** : 2 tools mutatifs (#8, #9) déjà couverts. **Tous les futurs tools mutatifs
prévisibles** (`gmail_send`, `outlook_send_reply`, `calendar_create_event`,
`gmail_delete`, `outlook_move`, `connector_activate`, `connector_revoke`, `n8n_run_workflow`,
`uninstall_agent`, `bash_exec` du P0 #1, etc.) devront utiliser le wrapper.

### 4. Audit log existant

Fichier : `services/app/src/lib/app-audit.ts` (132 lignes, lu).

- **Stockage** : JSONL append-only `/data/audit.jsonl`, max 5000 entrées (rotation).
- **API** : `logAudit(entry: AuditEntry)`, `readAudit(opts)`, `maybeRotate()`. Sérialisation
  via `writeQueue` (Promise chain) pour éviter les races.
- **Types `AuditAction`** (l. 21-48) — enum de 24 actions ; `concierge.approval` déjà présent
  (l. 46). Pas d'événement générique pour HITL — il faudra ajouter
  `approval.create | approval.approve | approval.reject | approval.expire | approval.execute`
  (ou un namespace `hitl.*`).
- **Helper haut-niveau** : `services/app/src/lib/audit-helper.ts` (38 lignes) — `logAction(action,
  target, details, clientIp)` lit la session NextAuth pour remplir actor + role automatiquement.
  `ipFromHeaders(req)`. **Ne fonctionne PAS dans `/api/agents-tools/*`** car ces routes sont
  authentifiées via Bearer AGENTS_API_KEY, pas NextAuth — actuellement elles passent
  `"concierge-agent"` en hard-code.

### 5. UI banner approval

Fichier : `services/app/src/components/ConciergeApprovalBanner.tsx` (165 lignes, lu).

- Sticky `fixed top-0 ... z-40` avec icône `ShieldAlert` (lucide), boutons Approuver/Refuser,
  affichage TTL secondes, toast résultat 6s.
- **Polling 5s** sur `/api/concierge/pending` (intervalle `setInterval`, pas WebSocket, pas SSE).
- **Branché global** dans `services/app/src/app/layout.tsx` l. 82 — uniquement si `isAdmin`.
- **Réutilisable** : composant entièrement self-contained (pas de prop drilling), il pull
  l'API et POST decide. Pour le rendre générique, il suffit que l'API renvoie le même format
  de pending. Renommer en `<ApprovalBanner>` et faire pointer vers
  `/api/approvals` + `/api/approvals/:id/decide`.

### 6. DB Postgres (aibox)

**Vérifié `services/app/package.json`** : `Grep "pg"|"prisma"|"drizzle"|"postgres"|"@prisma|@drizzle"`
→ **0 match**. L'app Next.js BoxIA n'a **AUCUNE** DB Postgres dédiée actuellement. Toute la
state utilise le filesystem `/data/*.json[l]` :
- `/data/audit.jsonl`
- `/data/concierge-approvals/<id>.json`
- `/data/installed-agents.json`
- `/data/connectors-state.json`
- `/data/conversation-tags.json`
- `/data/oauth-storage.json`
- `/data/cloud-providers.json`
- etc. (cf grep `CONNECTORS_STATE_DIR|/data` → 10+ libs)

Les 3 Postgres existants (`aibox-dify-postgres`, `aibox-n8n-postgres`,
`aibox-authentik-postgres`) sont des DBs internes de Dify/n8n/Authentik — pas accessibles à
l'app Next.js, gérées par les outils respectifs.

## 🧱 Composants à créer / modifier

1. **NOUVEAU** `services/app/src/lib/hitl-store.ts` — store dédié, peut rester filesystem
   (`/data/hitl/<id>.json`) pour V1 cohérence avec le reste, ou ajouter Postgres `aibox` pour
   robustesse multi-process. Recommandation V1 : **garder filesystem** + index par user.
2. **REFACTO** `services/app/src/lib/approval-gate.ts` → renommer `lib/hitl.ts`, étendre
   `PendingApproval` (ajouter `user_id`, `is_sensitive_action`, `auto_approve_key`,
   `decided_at`, `decided_by`), réécrire `requireApproval()` → `checkApproval()` avec décision
   ternaire (`approved | rejected | pending`).
3. **NOUVEAU** `services/app/src/lib/agents-tools-hitl.ts` — helper `withApprovalGate(handler,
   {sensitive, description})` qui wrappe automatiquement.
4. **MODIF** les 17 tools : décorer chaque export POST avec `withApprovalGate`. Les 15
   read-only marquent juste `{sensitive: false}` (no-op runtime mais traçabilité explicite).
5. **NOUVEAU** routes `/api/approvals` (GET list pending pour admin), `/api/approvals/:id/decide`
   (POST). Le rôle filtrage : admin voit tout, employee voit ses propres.
6. **REFACTO** `/api/concierge/{decide,pending}` → soit aliases proxy vers `/api/approvals*`
   pour rétrocompat (banner concierge déjà branché), soit suppression progressive après
   migration UI.
7. **REFACTO** `ConciergeApprovalBanner` → `ApprovalBanner` générique. Garder `Concierge`
   comme alias pour ne pas casser layout.
8. **NOUVEAU** page `/approvals` (admin) — liste + historique des dernières 50 décisions
   (peut lire `audit.jsonl` filtré sur `hitl.*`).
9. **MODIF** `lib/app-audit.ts` `AuditAction` → ajouter `hitl.create | hitl.approve |
   hitl.reject | hitl.expire | hitl.execute`.
10. **NOUVEAU** badge topbar (count pending) dans `services/app/src/components/Header.tsx` —
    réutilise le polling.

## 🎯 Plan d'attaque détaillé

### Étape 1 — Schema (V1 filesystem, pas Postgres)

**Recommandation : ne PAS créer de DB Postgres dédiée**. Justifications :
- Cohérence avec le reste de l'app (audit.jsonl, connectors-state.json, etc.) ;
- Pas de runtime cost supplémentaire (1 container de moins) ;
- TTL court (5 min) → pas besoin de queries analytiques ;
- Race conditions inexistantes (1 process Next.js, queue de write déjà en place dans
  `app-audit.ts`).

Schéma JSON `/data/hitl/<id>.json` :
```ts
interface HitlPending {
  id: string;                     // 32 hex
  user_id: string;                // email NextAuth
  user_role: "admin"|"manager"|"employee";
  tool_name: string;              // ex "install_workflow"
  tool_args: Record<string, unknown>;
  is_sensitive_action: boolean;   // discriminant créé au déclenchement
  description: string;            // texte FR humain
  status: "pending"|"approved"|"rejected"|"expired";
  created_at: number;
  expires_at: number;
  decided_at?: number;
  decided_by?: string;
  auto_approve_key?: string;      // ex `${tool_name}:${user_id}` pour skip si déjà approuvé dans la session
  caller_actor?: string;          // legacy "concierge-agent" si déclenchement Dify
}
```

**Si tu veux quand même Postgres** (option B, à reporter post-V1) : ajouter container
`aibox-app-postgres` dans `services/app/docker-compose.yml`, ajouter `pg` à package.json,
schema `aibox.pending_human_review`, migration `tools/migrations/0013_hitl_table.py`
(pattern voir `0001_dify_max_tokens_8192.py` mais pour DB applicative et pas Dify console).
Coût : +1 container, +1 dep, ~1j de plus.

### Étape 2 — Refacto `lib/approval-gate.ts` → `lib/hitl.ts`

Signature cible :
```ts
async function checkApproval<T>(opts: {
  userId: string;
  toolName: string;
  toolArgs: T;
  isSensitiveAction: boolean;
  description: string;
  autoApproveKey?: string;
  body?: { approval_token?: unknown };
}): Promise<
  | { decision: "auto_approved"; toolArgs: T }
  | { decision: "approved"; toolArgs: T; reviewId: string }
  | { decision: "rejected"; reason: string }
  | { decision: "pending"; reviewId: string; response: Response }
>;
```

- Si `!isSensitiveAction` → renvoie immédiatement `auto_approved` (no-op gate).
- Si `autoApproveKey` matche un record `approved` déjà consommable dans la même session → idem.
- Sinon, applique le pattern actuel (1ère passe pending 202 / 2nde passe consume).

Garder rétrocompat : `requireApproval()` legacy reste exporté comme thin wrapper
(`isSensitiveAction: true`, `userId: "concierge-agent"`).

### Étape 3 — Wrapping des 17 tools

Helper dans `services/app/src/lib/agents-tools-hitl.ts` :
```ts
export function withApprovalGate(
  handler: (req: Request, ctx: { gate: GateContext }) => Promise<Response>,
  opts: { toolName: string; isSensitive: boolean; describe?: (args: any) => string }
): (req: Request) => Promise<Response>;
```

Marquage explicite par tool (table § 3) — 2 sensitive (install_*), 15 non-sensitive. Les 15
read-only n'ont pas vraiment besoin du wrapper, mais l'appliquer uniformément donne :
(a) traçabilité audit homogène (`hitl.execute`) ; (b) point d'extension central pour rate-limit,
quotas, scopes par user.

### Étape 4 — Routes API génériques

- `GET /api/approvals` → list pour user courant (admin = tout, employee = ses propres pending).
  Code = `pending/route.ts` adapté + filtrage `userId === session.user.email || isAdmin`.
- `POST /api/approvals/:id/decide` body `{decision, autoApprove?: boolean, autoApproveScope?:
  "session"|"24h"}` → permet à l'admin de cocher "ne plus me redemander pour `install_workflow`
  cette session". Le record `auto_approve_key` est persisté avec un `expires_at` plus court
  que TTL standard.
- `/api/concierge/{decide,pending}` deviennent des **proxies fins** redirigeant vers
  `/api/approvals*` avec filtre `caller_actor === "concierge-agent"`. Aucun changement frontend
  nécessaire pour cette session.

### Étape 5 — UI

- Renommer `ConciergeApprovalBanner.tsx` → `ApprovalBanner.tsx`. Pull `/api/approvals`. Garder
  un alias `<ConciergeApprovalBanner>` qui re-export (zéro casse layout.tsx).
- Page `/approvals` (admin) avec tab "En attente" / "Historique 30j" (lit `audit.jsonl`
  filtré `action.startsWith("hitl.")`).
- Badge topbar : `<Header>` reçoit `pendingCount` via le même polling, mais débrancher du
  banner pour éviter 2 timers (centraliser dans un `useApprovalsContext`).

### Étape 6 — Tests + migration

- Tests unitaires `lib/hitl.test.ts` : create+consume happy path, expire, rejected, action
  mismatch, token invalide, auto_approve hit.
- **Pas de migration DB** si on reste filesystem. Si DB → migration `0013_hitl_table.py`
  pattern `0001`.
- Migration data : les pending existants `/data/concierge-approvals/<id>.json` doivent être
  copiés vers `/data/hitl/<id>.json` avec `user_id="concierge-agent"`,
  `is_sensitive_action=true`, status préservé. Migration JS one-shot au boot Next.js (lib
  `hitl-store.ts` lit les 2 chemins le 1er mois puis purge).

## ⚠️ Risques / pièges

- **Granularité auto-approve** : `auto_approve_key = tool_name` seul est trop large (un
  attaquant injectionne `install_workflow` n'importe quoi → bypass). Limiter à
  `auto_approve_key = ${tool_name}:${hash(JSON.stringify(toolArgs))}` pour exiger args
  identiques, ou scope `session_id` strict.
- **Multi-tab UI** : 2 onglets admin → polling 5s × 2 → potentiel double-decide. La consume est
  atomique (`consumeApproved` supprime le fichier) donc le 2nd appel renvoie `not_found`. OK.
- **TTL 5 min** trop court pour un employee distrait : passer à 15 min pour les non-admins,
  garder 5 min pour les vraiment sensibles (install_*).
- **Filesystem partagé** : si on passe BoxIA en HA multi-instance plus tard, `/data` bind-mount
  sur un seul host bloquera. Pas un sujet V1 (1 box client = 1 host).
- **UI fatigue** : badge "12 pending" si l'agent appelle plein de read-only marqués
  sensitive=false par erreur. Mitigation : badge n'affiche QUE `is_sensitive_action: true`.
- **Routes `/api/concierge/decide` actuelles déclenchent l'exécution synchrone** (l. 87-100).
  Garder ce pattern — sinon le LLM Concierge ne sait pas quand son tool a été ré-exécuté.
- **`AGENTS_API_KEY` injection** : actuellement, n'importe quel possesseur de la clé peut
  appeler `/api/agents-tools/install_workflow` et déclencher un pending. La gate protège bien.
  Mais si la clé fuit, la fuite peut spammer pending (DoS). Mitigation : rate-limit par
  `caller_actor` + auto-rejet après 10 pending non décidés.

## 📊 Estimation

- Étape 1 (schema + lib hitl) : **0.5j** (filesystem) ou 1.5j (Postgres + migration).
- Étape 2 (refacto checkApproval) : **0.5j** + tests.
- Étape 3 (wrap 17 tools) : **0.5j** (15 read-only triviaux, 2 sensitive déjà câblés).
- Étape 4 (routes génériques + proxy concierge) : **0.5j**.
- Étape 5 (UI Banner générique + page /approvals + badge) : **1j**.
- Étape 6 (tests + migration data) : **0.5j**.

**Total ~3.5j filesystem / ~5j si DB Postgres**. Complexité moyenne, peu de dépendances
externes. Bloquant uniquement si on touche aussi la nouvelle UI `/approvals` (sinon le banner
existant suffit pour V1).

## 🚦 Ordre vs autres P0

**Faire P0 #2 AVANT P0 #1 (sandbox bash_exec)**. Justification :

1. `bash_exec` (P0 #1) DOIT impérativement être marqué `is_sensitive_action: true`. Sans
   l'infrastructure HITL générique en place, il faudrait soit (a) câbler `bash_exec` dans
   l'approval-gate Concierge actuel — qui n'est pas conçu pour user-scope, soit (b) créer un
   gate spécifique. Faire HITL d'abord évite le rework.
2. P0 #2 est une dette de **généralisation** d'un pattern existant qui marche déjà — risque
   technique faible, livre une plateforme propre.
3. P0 #1 (sandbox) demande à la fois HITL (pour gater l'exécution) ET sandboxing (pour
   contenir l'exécution une fois autorisée). Les 2 sont nécessaires, mais HITL est la couche
   « extérieure » : sans elle, l'exécution est inconditionnelle et le sandbox ne peut pas
   être bypassé seulement par injection LLM mais peut l'être par tout consumer Bearer-auth.
4. Tools futurs (gmail_send, calendar_create_event…) attendent le pattern. Plus on tarde,
   plus la dette grandit (chaque dev re-câblerait `requireApproval` à la main).

**Conclusion** : ordre canonique = P0 #2 (HITL générique) → P0 #1 (sandbox bash_exec marqué
sensitive avec wrap automatique) → autres tools mutatifs ajoutés au catalogue.
