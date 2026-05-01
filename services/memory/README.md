# 🧠 Service Memory — Mémoire long-terme par user

Réimplémentation **light** de [mem0](https://github.com/mem0ai/mem0) (~30 fois moins lourd) qui réutilise ton Qdrant + Ollama existants.

## Pourquoi pas mem0 officiel ?

mem0 c'est `pip install mem0ai` mais ça pèse ~200 Mo de deps (LangChain + LiteLLM + Pinecone + Chroma + ...). Ici on a 50 Mo, et pas de dépendance optionnelle qui casse au prochain release.

Le contrat API est compatible (POST /memory/add, GET /memory/search) — si plus tard tu veux migrer vers le SaaS mem0, c'est plug-and-play.

## Quand l'activer

- Tier `pme` ou `pme-plus` dans [config/profiles.yaml](../../config/profiles.yaml)
- Use cases :
  - "L'assistant se souvient que je suis allergique au gluten depuis 6 mois"
  - "Tu m'avais dit que ton serveur principal s'appelle XEFIA"
  - "Comme la dernière fois, prépare un devis sur la base de [...]"
- **Différenciateur fort vs ChatGPT** côté commercial

Pas pertinent en tier `tpe` (overhead pour 1-5 users sans valeur évidente).

## Démarrage

```bash
# 1. Variables (.env)
MEM0_API_KEY=$(openssl rand -hex 32)
QDRANT_URL=http://aibox-qdrant:6333
QDRANT_API_KEY=...                 # si activé
LLM_EMBED=bge-m3
LLM_MAIN=qwen2.5:7b
CLIENT_NAME=acme                   # devient le tenant_id

# 2. Build + run
cd services/memory
docker compose --env-file ../../.env up -d --build

# 3. Vérifier
curl http://127.0.0.1:8087/v1/info
```

## API

### Ajouter de la mémoire (extraction auto via LLM)

```bash
curl -X POST http://127.0.0.1:8087/memory/add \
  -H "Authorization: Bearer $MEM0_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "marie.dupont@acme.fr",
    "agent_id": "general",
    "messages": [
      {"role": "user", "content": "Mon entreprise s appelle Acme Textile, on est 12 salariés et on fait du textile bio."},
      {"role": "assistant", "content": "Compris, vous êtes une PME textile bio."}
    ],
    "metadata": {"source": "chat"}
  }'
```

Retour :
```json
{
  "facts_added": 2,
  "facts": [
    {"id": "...", "fact": "L utilisateur dirige Acme Textile, une PME de textile bio.", "score": null, ...},
    {"id": "...", "fact": "Acme Textile compte 12 salariés.", ...}
  ]
}
```

### Rechercher de la mémoire pertinente

```bash
curl "http://127.0.0.1:8087/memory/search?user_id=marie.dupont@acme.fr&query=combien%20de%20salariés&limit=3" \
  -H "Authorization: Bearer $MEM0_API_KEY"
```

Retour : top-K facts triés par similarité cosinus.

### RGPD : effacer toute la mémoire d'un user

```bash
curl -X DELETE http://127.0.0.1:8087/memory/user/marie.dupont@acme.fr \
  -H "Authorization: Bearer $MEM0_API_KEY"
# → {"user_id": "marie.dupont@acme.fr", "facts_deleted": 12}
```

## Intégration côté Chat AI Box

Pattern à mettre dans `services/app` (Next.js) :

```typescript
// Avant chaque message envoyé à l agent
const memories = await fetch(`http://aibox-mem0:8000/memory/search?user_id=${user.email}&query=${userMessage}&limit=5`, {
  headers: {Authorization: `Bearer ${MEM0_API_KEY}`}
});
const memorySection = memories.facts.map(f => `- ${f.fact}`).join("\n");
const promptWithMemory = `Mémoire user :\n${memorySection}\n\nMessage utilisateur :\n${userMessage}`;
// → envoyer promptWithMemory à Dify

// Après chaque échange réussi
await fetch(`http://aibox-mem0:8000/memory/add`, {
  method: "POST",
  headers: {Authorization: `Bearer ${MEM0_API_KEY}`, "Content-Type": "application/json"},
  body: JSON.stringify({
    user_id: user.email,
    agent_id: currentAgent,
    messages: [{role: "user", content: userMessage}, {role: "assistant", content: aiReply}]
  })
});
```

## Architecture

- **1 collection Qdrant par tenant** : `mem0_<TENANT_ID>` (multi-tenant safe)
- Embeddings via Ollama bge-m3 (1024 dims, cosine)
- Index payload sur `user_id` et `agent_id` pour filtrage rapide
- Extraction des faits via Ollama LLM (qwen2.5:7b par défaut, format=json)

## Coûts

- ~3-5s par `/memory/add` (1 appel LLM extraction + N appels embedding)
- ~200ms par `/memory/search` (1 appel embedding + recherche Qdrant)
- Stockage : ~5 Ko par fact (vector 4 Ko + payload 1 Ko)
- 1000 users × 50 facts moyen = 250 Mo dans Qdrant
