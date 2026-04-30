# 🚀 vLLM optionnel — Tier `pme` / `pme-plus`

Service d'inférence haute-perf alternatif à Ollama, **uniquement pertinent** pour les profils PME (16+ Go VRAM, >5 utilisateurs concurrents).

## Quand activer ?

| Critère | Tier `tpe` (Ollama) | Tier `pme` (vLLM) |
|---|---|---|
| VRAM GPU | 8-12 Go | 16+ Go |
| Users concurrents max | 2-3 (file d'attente sinon) | 8+ (continuous batching) |
| Modèle recommandé | Qwen2.5-7B Q4 | Qwen2.5-14B AWQ |
| Throughput 1 user | 40-50 t/s | 60-80 t/s |
| Throughput 5 users | 50 t/s cumulé (file) | 250+ t/s cumulé |
| Outlines guided_json | ❌ (best-effort) | ✅ (100% conforme) |
| Setup | Ollama déjà là | Pull HF (~7 Go) au 1er boot |

**Règle de pouce** : si ton client a une RTX 4070 Super (12 Go), reste en Ollama. Pour une RTX 4090 (24 Go), vLLM devient rentable.

## Activation

```bash
# 1. Pré-requis : NVIDIA Container Toolkit installé sur l'hôte
docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi

# 2. Variables (dans /srv/ai-stack/.env)
HW_PROFILE=pme
INFERENCE_BACKEND=vllm
VLLM_URL=http://aibox-vllm:8000
LLM_MAIN=qwen2.5-14b                # nom du modèle exposé par vLLM
VLLM_MODEL=Qwen/Qwen2.5-14B-Instruct-AWQ
VLLM_MAX_MODEL_LEN=8192
VLLM_GPU_MEM_UTIL=0.55              # laisse 45% pour Ollama embeddings + reranker
ENABLE_OUTLINES=true                # bonus : structured output garanti

# 3. Lancement (premier boot = 3-5 min de pull HF)
cd services/inference-vllm
docker compose --env-file ../../.env up -d

# 4. Vérifier
docker logs -f aibox-vllm
curl http://localhost:8000/v1/models

# 5. Reconfigurer aibox-agents pour pointer dessus
docker restart aibox-agents
curl http://localhost:8085/v1/info
# → backend doit indiquer "vllm" et outlines_enabled=true
```

## Coexistence avec Ollama

vLLM **ne remplace pas** Ollama. Ollama continue de servir :
- Les embeddings (`bge-m3`) — vLLM ne fait pas d'embeddings
- Open WebUI (UI alternative)
- Le LLM 7B en fallback si vLLM down

L'agent `aibox-agents` choisit son backend via `INFERENCE_BACKEND` (cf. [config/profiles.yaml](../../config/profiles.yaml)).

## Budget VRAM (RTX 4090 24 Go)

| Composant | VRAM |
|---|---|
| vLLM Qwen2.5-14B AWQ + KV cache (max_len=8192) | ~13 Go |
| Ollama bge-m3 embeddings | ~1.5 Go |
| Ollama qwen2.5vl:7b (vision à la demande) | ~6 Go |
| TEI reranker bge-reranker-v2-m3 | ~0.5 Go |
| **Total** | **~21 Go** |

→ Marge confortable. Avec un GPU 16 Go on doit choisir entre vision et reranker.

## Désactivation (rollback)

```bash
cd services/inference-vllm
docker compose down

# Reconfigurer aibox-agents pour repasser sur Ollama
sed -i 's/^INFERENCE_BACKEND=vllm/INFERENCE_BACKEND=ollama/' /srv/ai-stack/.env
sed -i 's/^LLM_MAIN=qwen2.5-14b/LLM_MAIN=qwen2.5:7b/' /srv/ai-stack/.env
docker restart aibox-agents
```

Aucune perte de données — vLLM est purement compute, pas de state persisté.

## Bench attendu vs réalité

À mesurer sur ton matériel cible avant de promettre des chiffres au client. Réutilise [methodologie-bench-IA.xlsx](../../methodologie-bench-IA.xlsx) en remplaçant Ollama par vLLM.
