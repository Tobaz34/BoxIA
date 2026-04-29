# Connecteurs AI Box

> Voir [CATALOG.md](./CATALOG.md) pour la liste complète des connecteurs envisagés et leur statut.

## Concept

Un **connecteur** est un container Docker (worker Python en général) qui :
1. **Se connecte** à une source externe (NAS, M365, Odoo, base SQL…)
2. **Récupère** la donnée (avec sync delta pour ne pas tout retraiter)
3. **Traite** (parse PDF/DOCX, OCR si scan, extraction de structure)
4. **Embed** via TEI / Ollama bge-m3 → vecteurs
5. **Indexe** dans Qdrant (collection dédiée par client + ACL en payload)

OU (cas non-RAG) :
1. **Expose** une API qui sera appelée par Dify ou n8n (text-to-SQL, transcription…)

## Activation

Au déploiement, le `dispatcher.py` lit `client_config.yaml` et démarre uniquement les connecteurs dont la techno est cochée.

```yaml
# client_config.yaml (extrait)
technologies:
  stockage_docs: nas_smb     # → active connecteur rag_smb
  messagerie: m365           # → active connecteur email_msgraph
  erp_crm: odoo              # → active connecteur erp_odoo
```

## Convention

Chaque connecteur vit dans `services/connectors/<id>/` avec :

```
<id>/
├── docker-compose.yml      # service worker + (optionnel) cron sidecar
├── Dockerfile              # build de l'image
├── worker.py               # entrypoint (boucle de sync ou serveur HTTP)
├── requirements.txt        # deps Python
├── manifest.yaml           # métadonnées du connecteur (voir ci-dessous)
└── README.md               # doc spécifique
```

### `manifest.yaml`

```yaml
id: rag_smb
name: "RAG SMB / CIFS"
category: rag                  # rag | email | erp | identity | bi | text2sql | telephony | helpdesk | calendar
description: "Indexe un partage SMB dans Qdrant"
required_env:
  - SMB_HOST
  - SMB_SHARE
  - SMB_USER
  - SMB_PASSWORD
optional_env:
  - SMB_DOMAIN
  - SYNC_INTERVAL_MINUTES
qdrant_collection: rag_smb_<TENANT>
```

## Implémentation de référence : `rag-smb`

C'est le connecteur le plus simple à implémenter et à comprendre. Servir de modèle pour les autres.

```
rag-smb/
├── Dockerfile
├── requirements.txt
├── worker.py            # boucle : list SMB → diff → parse → embed → upsert Qdrant
├── manifest.yaml
├── docker-compose.yml
└── README.md
```

## Workflow d'ajout d'un nouveau connecteur

1. Cloner `rag-smb` comme template : `cp -r rag-smb my-new-connector/`
2. Adapter `manifest.yaml` (id, env vars, collection Qdrant)
3. Implémenter la logique de connexion à la source dans `worker.py` (remplacer la partie SMB)
4. Tester en local avec un `.env` minimal
5. Ajouter au CATALOG.md (statut → 🟡 squelette → ✅ implémenté)
6. Référencer dans le `dispatcher.py` (mapping `activates_id` → service Docker)
7. Ajouter une option dans `config/questionnaire-essentials.yaml` si la techno doit apparaître dans le wizard

## Variables communes à tous les connecteurs

Définies dans le `.env` global de la box, lues par tous les connecteurs :

| Variable | Rôle |
|---|---|
| `OLLAMA_URL` | URL Ollama (par défaut `http://ollama:11434`) |
| `LLM_EMBED` | Modèle d'embedding (par défaut `bge-m3`) |
| `QDRANT_URL` | URL Qdrant (par défaut `http://aibox-qdrant:6333`) |
| `QDRANT_API_KEY` | API key Qdrant |
| `TENANT_ID` | Identifiant tenant (= nom client slug) |
| `SYNC_INTERVAL_MINUTES` | Fréquence de sync (par défaut 60) |

## Le dispatcher

`dispatcher/dispatch.py` orchestre :

```bash
# Lit client_config.yaml + dérive la liste des connecteurs à activer
python dispatch.py --plan

# Démarre les connecteurs activés (docker compose up sur chaque)
python dispatch.py --apply

# Stop tous les connecteurs
python dispatch.py --stop
```

C'est appelé automatiquement à la fin du wizard (étape 5) après le démarrage de la stack core.
