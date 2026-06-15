---
name: aibox-deep-research
description: Recherche approfondie multi-étapes — cherche plusieurs sources, les lit, recoupe, et produit un rapport synthétique SOURCÉ. À utiliser pour une veille, une analyse de marché/concurrent, un état de l'art, ou une réponse documentée à une question complexe.
version: 0.1.0
trigger_phrases:
  - recherche approfondie
  - analyse de marché
  - analyse de marche
  - veille
  - état de l'art
  - etat de l'art
  - compare les solutions
  - étude sur
  - benchmark
---

# Skill : aibox-deep-research

Recherche approfondie sourcée (idée reprise du « Deep Research » d'Odysseus,
lui-même adapté de Tongyi DeepResearch). S'appuie sur les outils web de Hermes
(`web_search`, `web_extract`).

## Quand l'utiliser
Questions qui méritent **plusieurs sources** et un recoupement : veille
concurrentielle, choix d'un fournisseur/outil, tendances marché, réglementation,
état de l'art. **Pas** pour une question factuelle simple (réponds directement).

## Workflow
1. **Décomposer** la question en 3-6 sous-questions précises. Les annoncer.
2. **Chercher** : pour chaque sous-question, `web_search` puis `web_extract`
   sur **2-3 sources indépendantes** (éviter de citer une seule source).
3. **Recouper** : noter les points de **convergence** et les **désaccords**
   entre sources. Se méfier d'une info présente sur une seule source.
4. **Synthétiser** : un rapport structuré
   - *Réponse courte* (3-5 lignes)
   - *Détail par sous-question*, chaque affirmation suivie d'une **citation `[n]`**
   - *Points incertains / contradictoires* explicitement signalés
   - *Sources* : liste numérotée `[n] Titre — URL`
5. **Honnêteté** : si une info manque ou n'est pas vérifiable, le dire. Ne jamais
   inventer une source ou une citation.

## Format de sortie (exemple)
```
## Logiciels de caisse pour boulangerie (France, 2026)

**Réponse courte** : 3 acteurs dominent... [1][3]

### Prix
- Solution A : ~X €/mois [1], mais frais cachés signalés [2].
...

### Points incertains
- Le tarif de B varie selon les sources [2] vs [4].

### Sources
[1] ... — https://...
[2] ... — https://...
```

## Coût / temps
Prévenir l'utilisateur qu'une recherche approfondie prend plus de temps
(plusieurs requêtes web + lectures). Proposer un périmètre si la question est large.
