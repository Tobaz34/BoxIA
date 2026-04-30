# Intégration AI Box Agents ↔ Dify

3 façons de brancher les agents autonomes dans Dify, du plus simple au plus automatisé.

## Option A — Manuel (5 min, pas de risque)

1. Console Dify : `http://aibox-agents.local` (ou `http://192.168.15.210:8081`)
2. **Tools → Custom → Create Custom Tool**
3. **Schema Type: OpenAPI 3** → coller le contenu de [openapi-tool.yaml](openapi-tool.yaml)
4. **Authentication Method: API Key**
   - Header name : `Authorization`
   - Value : `Bearer YOUR_AGENTS_API_KEY` (la valeur de la variable d'env du container `aibox-agents`)
5. **Save** → Dify détecte les 3 opérations : `triageEmail`, `generateQuote`, `reconcileInvoice`

## Option B — Script automatique (1 commande)

Si tu n'as pas envie de cliquer :

```bash
# Récupère un token admin Dify (via login)
DIFY_CONSOLE_TOKEN=$(curl -sX POST http://localhost:8081/console/api/login \
  -H "Content-Type: application/json" \
  -d '{"email":"clikinfo@xefia.fr","password":"YOUR_PASSWORD"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['access_token'])")

# Provisionne le tool
DIFY_CONSOLE_TOKEN=$DIFY_CONSOLE_TOKEN \
AGENTS_API_KEY=$(grep AGENTS_API_KEY /srv/ai-stack/.env | cut -d= -f2) \
DIFY_CONSOLE_URL=http://localhost:8081 \
./install-dify-tool.sh
```

Le script est **idempotent** : créé si absent, update si déjà là.

## Option C — Via aibox-app (Next.js) — pour le client final

L'AI Box App expose les agents directement aux utilisateurs sans passer par Dify Workflow. Voir `services/app/src/app/api/agents/` pour la démarche (endpoint Next.js qui proxy vers `aibox-agents`).

---

## Workflow Dify exemple : triage email entrant

Quand le tool est installé, tu peux créer un Workflow :

```
[Start: input email_data (object)]
       │
       ▼
[Tool: AI Box Agents → triageEmail]
   ├ inputs: sender, subject, body, received_at
   └ outputs: category, priority, confidence, suggested_actions, needs_human_validation
       │
       ▼
[Conditional: needs_human_validation == true]
   ├ true  → [End: status="pending_review"]
   └ false → [Switch sur category]
              ├ commercial + action=devis_a_generer → [Tool: generateQuote]
              ├ support → [HTTP: créer ticket GLPI]
              └ administratif → [End: status="archived"]
```

## Bench des perfs (xefia, Qwen2.5-7B Ollama)

| Endpoint | Latence moyenne | Succès (5 runs) |
|---|---|---|
| `triageEmail` | ~5.7 s | 5/5 ✓ |
| `generateQuote` | ~17.8 s | 5/5 ✓ |
| `reconcileInvoice` | ~24 s | 5/5 ✓ |

**Pour une UX réactive côté Dify** : prévoir un loading state (les agents prennent 5-25s).
Les 3 tools sont déjà conçus pour gérer le timeout côté caller (90s par défaut).

## Headers optionnels

- `X-Thread-ID: <uuid>` — pour reprendre un workflow checkpointé. Si tu utilises le checkpointer Postgres (`ENABLE_CHECKPOINTER=true`), passer le même `X-Thread-ID` permet de reprendre à mi-chemin.

## Debug

```bash
# Vérifier que le service répond
curl http://aibox-agents:8000/v1/info

# Lister les tools dans Dify
curl -H "Authorization: Bearer $DIFY_CONSOLE_TOKEN" \
  http://localhost:8081/console/api/workspaces/current/tool-provider/api/list \
  | python3 -m json.tool
```
