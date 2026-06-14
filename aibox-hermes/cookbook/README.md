# Cookbook — modèle local recommandé selon le hardware

Idée reprise d'**Odysseus** (« Cookbook », VRAM-aware), ré-implémentée pour
l'install « 1 PC = 1 entreprise ». Au provisioning, le wizard choisit
automatiquement le bon modèle Ollama selon la machine du client.

## Usage
```bash
python cookbook.py                      # auto-détecte RAM/VRAM, recommande
python cookbook.py --ram 32 --vram 12   # forcer (démo/test)
python cookbook.py --prefer speed       # un cran sous le max
python cookbook.py --pull               # + ollama pull du modèle
python cookbook.py --json               # sortie machine (pour le wizard)
```

## Exemples (validés)
| Hardware | Recommandé |
|---|---|
| 32 Go RAM + GPU 12 Go (RTX 4070) | `qwen3:14b` |
| 64 Go RAM + GPU 24 Go | `qwen3:32b` |
| 16 Go RAM + GPU 8 Go | `qwen3:8b` |
| 8 Go RAM, pas de GPU | `qwen3:4b` (ou `1.7b` en --prefer speed) |

## Pièces
- `recommend.py` — catalogue Qwen3 + heuristique de fit (pur, **7 tests**)
- `scan.py` — détection RAM (/proc/meminfo, ctypes Windows, sysconf) + VRAM (nvidia-smi)
- `cookbook.py` — CLI scan + reco + pull

## Intégration
- **Wizard de provisioning** : `MODEL=$(python cookbook.py --json | jq -r .recommended)` puis écrit `model.default` dans la config Hermes.
- **Skill Hermes** (`skills/aibox-cookbook/`) : l'agent peut répondre « quel modèle pour ma machine ? ».
