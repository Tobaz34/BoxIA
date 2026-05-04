# tools/bench/ — Benchmark IA locale vs cloud

Compare la qualité, latence et fiabilité de l'IA locale (qwen3:14b texte +
qwen2.5vl:7b vision) face au cloud (claude-sonnet-4-5 par défaut, BYOK
Anthropic) sur **30 prompts** représentatifs des usages TPE/PME.

## Pourquoi pas de LLM-as-judge ?

Faire scorer les réponses par un LLM (même Claude) introduit un biais —
le juge favorise systématiquement son propre style. Tous les scorers ici
sont **déterministes** : présence de chiffres exacts, regex sur des
références légales, longueur, absence de patterns de refus, taille des
fichiers générés. Pour les évaluations subjectives (qualité
rédactionnelle), prévoir une **review humaine séparée** sur un échantillon
des réponses.

## Le catalogue de 30 prompts

| Catégorie | # | Domaine |
|---|---|---|
| 💰 Comptabilité | 5 | TVA, relevé bancaire, seuils, devis |
| 👁️ Vision | 5 | Facture, graphique, archi, table, manuscrit |
| 📚 RAG | 5 | Procédure, CGV, contrat, mémoire tech, paie |
| 📄 Génération fichiers | 3 | xlsx budget, docx CGV, pptx pitch |
| 🔧 Tools (Concierge) | 3 | List connectors, list workflows, healthcheck |
| ⚖️ Conformité FR | 4 | RGPD, micro-BNC, arrêt maladie, mise en demeure |
| 🛡️ Robustesse | 5 | Franglais, contradictoire, hors-scope, vague, long |

13 prompts sont marqués `skip_reason` car ils nécessitent des **artefacts
préalables** (images à créer, PDFs à uploader dans /documents). Voir
section « Préparer les fixtures » plus bas.

## Setup (5 min)

### 1. Récupérer un cookie de session

L'API `/api/chat` et `/api/chat-cloud` exigent une session NextAuth. Le
plus simple : se connecter dans Chrome puis copier le cookie.

```
1. Ouvre http://192.168.15.210:3100 et connecte-toi normalement
2. F12 → onglet Application (Chrome) ou Storage (Firefox)
3. Cookies → http://192.168.15.210:3100
4. Copie la valeur de `next-auth.session-token` (longue chaîne JWT)
5. export BENCH_COOKIE="next-auth.session-token=eyJhbGc..."
```

### 2. Vérifier que l'API répond

```bash
curl -sS "http://192.168.15.210:3100/api/agents" \
  -H "Cookie: $BENCH_COOKIE" | head -c 200
# Doit afficher du JSON listant les agents (pas une page de login HTML)
```

### 3. Vérifier qu'un provider cloud est configuré (BYOK)

Le bench compare `qwen3:14b` à `claude-sonnet-4-5` par défaut, donc il
faut une clé Anthropic dans /settings → Fournisseurs Cloud (BYOK). Sans
ça, utiliser `--skip-cloud` pour ne mesurer que le local.

## Lancer le bench

```bash
# Dry-run : liste les prompts qui seraient exécutés
python3 tools/bench/run-bench.py --dry-run

# Bench complet (30 prompts × 2 backends, ~30 min)
python3 tools/bench/run-bench.py

# Une seule catégorie (5 prompts × 2 backends, ~5 min)
python3 tools/bench/run-bench.py --category accounting

# Un seul prompt (debug rapide)
python3 tools/bench/run-bench.py --prompt-id acc-02-releve-bancaire

# Local seulement (skip cloud) — utile sans BYOK configuré
python3 tools/bench/run-bench.py --skip-local=False --skip-cloud

# Provider cloud différent
python3 tools/bench/run-bench.py --cloud-provider openai --cloud-model gpt-4o
```

## Sortie

Chaque run crée :
```
tools/bench/runs/<YYYYMMDD-HHMMSS>/
├── results.csv          # tableau plat (1 ligne par prompt)
├── results.json         # données complètes (scorers + meta)
├── report.html          # dashboard autonome (no JS framework)
└── raw/
    ├── acc-01-tva-mixte.local.json
    ├── acc-01-tva-mixte.cloud.json
    └── ...              # raw response par appel
```

Ouvrir `report.html` dans un navigateur pour le dashboard agrégé.

## Préparer les fixtures (optionnel mais recommandé)

13 prompts sur 30 ont un `skip_reason` car ils nécessitent des artefacts
qu'on ne peut pas inclure dans le repo (sensibles ou trop lourds) :

### Vision (4 images à fournir)

À placer dans `tests/ui-audit-2026-05-03/` (ou ajuster `image_path` dans
`prompts.json`) :

- `graphique-ca.png` — graphique CA mensuel 12 mois
- `archi-diagram.png` — diagramme d'architecture (boîtes + flèches)
- `screenshot-excel.png` — capture d'un tableur 5 colonnes × 8 lignes
- `note-manuscrite.jpg` — photo d'une note écrite à la main

Pour `vis-01-facture` la fixture est déjà committée
(`tests/ui-audit-2026-05-03/test-facture.png`, générée par PIL).

### RAG (5 documents à uploader dans /documents via l'UI)

- `procedure-conges.pdf` — procédure interne RH
- `cgv-acme.pdf` — CGV avec clause pénalité retard
- `contrat-acme.pdf` — contrat client avec date de préavis
- `memoire-tech-btp.docx` — mémoire technique appel d'offres BTP
- `bulletin-paie-2026-04.pdf` — bulletin de paie d'avril 2026

Une fois uploadés, retirer le `skip_reason` du prompt correspondant dans
`prompts.json`.

## Critères d'interprétation

| Métrique | Critère "OK pour démo client" |
|---|---|
| Local moyen | ≥ 70% du score cloud sur la moyenne globale |
| Latence locale | ≤ 30s sur 80% des prompts (cold start tolérable, warm > 95% < 15s) |
| Catégorie Comptabilité | Local ≥ 80% (cœur métier TPE) |
| Catégorie Vision | Local ≥ 60% si fallback cloud configuré, ≥ 80% sinon |
| Catégorie Tools | Local ≥ 80% (sinon Concierge inutilisable) |
| Catégorie Robustesse | Refus injustifiés ≤ 5% |

Si l'un de ces critères tombe sous le seuil, c'est un signal sérieux pour
revoir le routing par défaut (mettre certains agents en cloud par défaut)
ou la config Ollama (modèle plus gros, quantization différente).

## Limites connues V1

- **Pas de support multi-tour** : chaque prompt est un échange unique.
  Le test `rob-05-long-context-todo` est planifié pour V2.
- **RAG nécessite upload manuel préalable** dans /documents (pas
  d'automatisation du seed côté bench V1).
- **Fixtures Vision à fournir** par l'opérateur (4 sur 5 manquantes,
  seule la facture est embarquée).
- **Coût cloud non calculé en sortie** — l'API `/api/chat-cloud` met à
  jour les compteurs `cost_eur_this_month` côté provider, à lire dans
  /settings après le run.
- **Cookie de session expire** : si le bench dure > durée de vie du
  cookie (plusieurs heures), refresh nécessaire.

## Prochaines évolutions (V2 si besoin)

- Authentification service-account dédiée (au lieu du cookie navigateur)
- Seed automatique des documents RAG via `/api/documents` upload
- Génération automatique des fixtures Vision avec PIL
- Multi-tour pour tester le contexte long
- Comparaison N modèles cloud en parallèle (anthropic + openai + google)
- Export Markdown/PDF du report en plus du HTML
