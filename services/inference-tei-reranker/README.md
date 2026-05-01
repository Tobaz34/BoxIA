# 🎯 TEI Reranker — bge-reranker-v2-m3

Service optionnel pour améliorer la qualité du RAG (Retrieval-Augmented Generation) Dify. Activable sur tier `pme` et `pme-plus`.

## Pourquoi un reranker ?

**Sans reranker** : pour une question, on récupère les top-K chunks via embeddings cosinus (bge-m3). Les top-3 ne sont pas toujours les plus pertinents.

**Avec reranker** : on récupère 20 chunks via embeddings (rapide), puis on les re-classe via un modèle cross-encoder spécialisé (bge-reranker-v2-m3) pour obtenir les vrais top-3.

**Gain mesuré** : +30% précision RAG sur tâches FR (sources : MTEB FR, Spider).

## Coût VRAM

| Modèle reranker | VRAM | Throughput |
|---|---|---|
| `BAAI/bge-reranker-v2-m3` | ~0.5 Go | ~50 paires/s sur RTX 4070 |

## Activation

```bash
# 1. Vérifier que HW_PROFILE >= pme dans /srv/ai-stack/.env
grep HW_PROFILE /srv/ai-stack/.env

# 2. Démarrer le service (download du modèle au 1er boot, ~2 min)
cd services/inference-tei-reranker
docker compose --env-file ../../.env up -d

# 3. Vérifier
curl http://127.0.0.1:8082/health
# {"status":"ok"}

# 4. Test rerank simple
curl -X POST http://127.0.0.1:8082/rerank \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Comment calculer la TVA sur une prestation ?",
    "texts": [
      "La TVA est de 20% sur la plupart des biens.",
      "Pour les prestations de services, le taux normal est 20%.",
      "Les frais bancaires peuvent être déductibles."
    ]
  }'
```

## Branchement Dify (manuel pour l'instant)

1. Console Dify → Paramètres → Model Providers → **Hugging Face TEI**
2. **URL** : `http://aibox-tei-reranker:80` (depuis le réseau `aibox_net`)
3. **Model name** : `BAAI/bge-reranker-v2-m3`
4. **Type** : `Rerank`
5. Dans chaque Dataset Dify (`/datasets`) → ouvrir → **Retrieval Setting** → cocher "Rerank Model" → sélectionner TEI

## Désactivation

```bash
docker compose down
# Aucune perte de données : les datasets Dify continuent de fonctionner
# avec retrieval simple (sans rerank).
```

## Roadmap auto-provisioning

À implémenter dans `services/setup/app/sso_provisioning.py` :
- Fonction `setup_dify_reranker_provider()` qui POST le model provider TEI
- Endpoints capturés via Chrome devtools :
  - POST `/console/api/workspaces/current/model-providers/huggingface_tei/credentials`
  - POST `/console/api/workspaces/current/datasets/<id>/retrieval` avec `reranking_enable: true`

Pour la session actuelle : config manuelle (5 min côté admin), à automatiser plus tard.
