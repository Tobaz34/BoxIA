# Audit UI exhaustif — AI Box (xefia, port 3100)

**Date** : 2026-05-03
**Auditeur** : Session Chrome MCP (Claude)
**Build serveur** : qwen3:14b chargé, 33 containers, branche déployée = main avec fixes 4 P0 du 2026-05-03
**User testé** : a.ladurelle@xefi.fr (admin)
**Résolution navigateur effective** : 1568×698
**Pages parcourues** : Discuter, /agents, /agents/marketplace, /workflows, /workflows/marketplace, /documents, /users, /connectors, /integrations/mcp, /audit, /system, /settings, /me, /help, topbar

> **Méthode** : navigation systématique sur chaque écran de l'app + read_page (DOM) + JS introspection + zooms ciblés. Pas de modification, pas de relecture code. Sévérités à arbitrer.

## Légende

| Niveau | Sens |
|---|---|
| 🔴 P0 | Bloque l'usage / casse la démo client |
| 🟠 P1 | Visible / agaçant mais contournable |
| 🟡 P2 | Polissage UX / cohérence visuelle |
| 🔵 IDEA | Suggestion (pas un bug) |

---

## Synthèse exécutive

**24 observations** dont :
- **2 P0** : erreur React #418 récurrente (toutes les ~40-60s) ; État serveur affiche "Tous opérationnels" alors que 2 services sont "fetch failed".
- **9 P1** : doc /help obsolète (modèle qwen2.5:7b, 4 agents au lieu de 7, limites 20Mo vs 15Mo) ; vocabulaire d'état inconsistant ("Configurer"/"Configuré"/"Opérationnel") ; dropdown profil tronqué à droite ; status bar topbar trompeuse (affiche le dernier modèle Ollama chargé, pas l'agent sélectionné) ; greeting Discuter divergent du champ "Message d'accueil" ; chip "qwen2.5vl:7b" lisible "v1" à cause de la fonte ; section Sauvegardes non finalisée laisse "Sprint 6 …" côté client ; aucune validation form sur cloud-call (modèle inexistant accepté) ; tags des marketplaces collés sans gap.
- **8 P2** : naming "AI Box" vs "BoxIA" co-existent ; z-index dropdown agents recouvert par historique ; descriptions tronquées ("CGV, C…" / "Adapté au dro…") ; compteur "6/6 assistants" stale ; sidebar bottom items clippés ; chat input partiellement masqué en bas viewport ; pas de filtre/tri/recherche sur Mes assistants & Documents ; champ "Mémoire long-terme" reste sur "Chargement…".
- **5 IDEA** : aligner filtres et cards Connecteurs ; ajouter tooltip explicite sur les ⚠ chips modèles ("non enregistré dans Dify") ; ajouter pagination/recherche sur /audit ; afficher le nom commit + branche (actuellement "—") sur Settings → Version ; harmoniser les libellés d'état des providers BYOK.

---

## 1. Topbar (présent sur toutes les pages)

| ID | Sévérité | Observation |
|---|---|---|
| TB-01 | 🟠 P1 | **Status bar "Local …" trompeuse** : affiche le dernier modèle Ollama actif en VRAM (a varié pendant la session : `qwen3:14b 10.6G` → `qwen2.5vl:7b 10.9G` → `bge-m3:latest 1.1G`) — change tout seul sans action user, donne l'illusion que l'agent sélectionné a changé. |
| TB-02 | 🟠 P1 | **Dropdown profil tronqué à droite** : 3 items du menu (Mes données / Mon compte / Déconnexion) sont coupés sur le bord du viewport. Ouverture en `right-0` au lieu de `left-0` aligné sur le bouton. |
| TB-03 | 🟡 P2 | Bouton Menu (hamburger) à gauche : utilité pas évidente sur desktop (sidebar déjà visible). Vérifier si pertinent ou à masquer ≥ md. |
| TB-04 | 🔵 IDEA | Status bar : afficher en plus l'agent **sélectionné** + le modèle qu'il **utilise** (ex: `Assistant général · qwen3:14b`) plutôt que le dernier modèle chargé en VRAM. |

## 2. Page Discuter (`/`)

| ID | Sévérité | Observation |
|---|---|---|
| D-01 | 🔴 **P0** | **Erreur React #418 (hydration mismatch)** récurrente : 5 occurrences en 4 min en console, ~toutes les 40-60s, en arrière-plan (pas seulement au load). C'était BUG-018 censé fixé par commit `5449888` — régression à confirmer. |
| D-02 | 🟠 P1 | **Greeting divergent du champ config** : la page Discuter affiche `"Bonjour ! Je suis votre assistant général. Posez-moi une question…"` alors que le champ "Message d'accueil" du modal Configurer dit `"Bonjour ! Je suis votre assistant IA local…"`. → soit champ ignoré, soit override hardcodé ailleurs. |
| D-03 | 🟡 P2 | **Z-index dropdown agents** : la liste des conversations passe par-dessus le dropdown ouvert (Concierge BoxIA et agents suivants visuellement masqués lors du déroulé). Confusion. |
| D-04 | 🟡 P2 | **Sous-titre Assistant juridique tronqué** dans dropdown : `"Spécialiste contrats commerciaux, CGV, C…"`. Pas de tooltip ni de wrap. |
| D-05 | 🟡 P2 | **Naming incohérent** : page se nomme "AI Box" (logo, titre tab, settings.brand) mais la description Concierge dit `"Configure votre **BoxIA** en langage naturel"`. Choisir une seule appellation. |
| D-06 | 🟡 P2 | **Sidebar bottom clippé** : "Mes données" coupé en bas (sortie de viewport à 698 px), pas de scroll évident pour l'atteindre. |
| D-07 | 🟡 P2 | **Chat input partiellement masqué** sous le viewport à 698 px (la flèche d'envoi seulement à moitié visible). Layout pas robuste sur petits écrans. |
| D-08 | 🔵 IDEA | Sidebar conversations : ajouter bouton "Tout supprimer" / sélection multiple / filtre par agent. Aujourd'hui 8+ conv visibles sans tri. |
| D-09 | 🔵 IDEA | Suggestions : dépendre de l'agent sélectionné (4 suggestions actuelles génériques type "rédiger un email" ne s'adaptent pas si on switch sur Comptable ou Juridique). |

## 3. Mes assistants (`/agents`)

| ID | Sévérité | Observation |
|---|---|---|
| MA-01 | 🟡 P2 | **Description Juridique tronquée** dans la card : `"Adapté au dro…"` (au lieu de "droit français…"). Wrap manquant. |
| MA-02 | 🟡 P2 | Layout 2 colonnes mais 7 agents → la 7e card (Juridique) est seule sur sa ligne. Acceptable mais peu élégant — alternative : 3 colonnes ≥ xl. |
| MA-03 | 🔵 IDEA | Pas de filtre/tri/recherche. Si demain 15-20 assistants, l'UI sera pénible. |

### Modal Configurer (Assistant général)

| ID | Sévérité | Observation |
|---|---|---|
| MA-04 | 🟠 P1 | **Chip `qwen2.5vl:7b` lisible `qwen2.5v1:7b`** — le `l` minuscule de la fonte est indistinguable du chiffre `1`. Solution : utiliser une fonte mono pour les noms de modèles, ou `font-feature-settings: "ss01"`. |
| MA-05 | 🟠 P1 | **Icônes ⚠ sur certains modèles sans tooltip explicite côté user** : `qwen2.5:14b ⚠`, `qwen2.5-coder:7b ⚠`, `qwen2.5:7b ⚠`, `mistral:latest ⚠`, `llama-guard3:8b ⚠`. Le tooltip dit `"non enregistré dans Dify"` (récupéré via JS) mais visuellement c'est juste un ⚠ inquiétant. → Ajouter un libellé visible "Pas de plugin Dify" ou désactiver la chip avec curseur "not-allowed". |
| MA-06 | 🟡 P2 | **Dropdown ET chips modèle** font la même chose → duplication. Garder un seul des deux. |
| MA-07 | 🟡 P2 | **Bouton Save** "Enregistrer" partiellement coupé en bas du viewport (seul "Enregistr" visible) — modal trop haut pour 698 px. Sticky footer manquant. |
| MA-08 | 🟡 P2 | Section pre-prompt très visible (textarea de 8 lignes avec 2901 caractères en clair) — ok pour admin, mais à rendre collapsible (avancé). |

## 4. Automatisations (`/workflows`)

| ID | Sévérité | Observation |
|---|---|---|
| AU-01 | 🟡 P2 | Page très minimaliste : juste 2 cards (Snapshot Qdrant + Healthcheck) + lien Ouvrir n8n. Pas de stats d'exécution (success/fail / dernière run / durée moyenne) alors que ça serait utile. |
| AU-02 | 🟡 P2 | Pas de boutons Pause / Désactiver / Voir runs depuis cette page → obligé de basculer sur n8n. |
| AU-03 | 🔵 IDEA | Pas de groupement par catégorie (Backup / Monitoring / Finance), alors que la marketplace en propose. |

## 5. Documents (`/documents`)

| ID | Sévérité | Observation |
|---|---|---|
| DOC-01 | 🟠 P1 | **Limite "15 Mo / fichier"** affichée ici — incohérent avec **/help** qui dit "20 Mo par document, 8 Mo par image". Aligner. |
| DOC-02 | 🟡 P2 | Empty state simple ("Aucun document pour l'instant"). Bien — mais ajouter un exemple "Glissez `procédure-congés.pdf` pour démarrer" + bouton "Charger les données de démo" (déjà présent dans Settings, dupliquer ici). |

## 6. Utilisateurs (`/users`)

| ID | Sévérité | Observation |
|---|---|---|
| US-01 | 🔵 IDEA | Une seule ligne (admin) — mais aucune indication de la 2FA, dernière IP, durée de session. Utile pour un admin. |
| US-02 | 🔵 IDEA | Pas d'affichage groupes Authentik dans la liste (visible seulement sur /me). |

## 7. Connecteurs (`/connectors`)

| ID | Sévérité | Observation |
|---|---|---|
| C-01 | 🟠 P1 | **Filtres catégories ≠ groupement des cards** : 12 chips de filtre (Stockage / Messagerie / Réseaux sociaux / ERP-CRM / Support / Messagerie d'équipe / Gestion projet / Compta / Agenda / Téléphonie / BI) vs 8 cards (Emails / Réseaux sociaux / Logiciels métier / Documents / Compta&finance / Agenda / Téléphonie / Messagerie d'équipe). Ex: filtre "Stockage de fichiers" mais card "Documents", filtre "Messagerie" mais card "Emails", 4 filtres (ERP+Support+Projet+BI) regroupés en 1 card "Logiciels métier". → Aligner les libellés. |
| C-02 | 🔵 IDEA | Compteur 0 actif / 40 dispo correct ; mais pas de "Featured" / "Recommandés pour TPE FR" pour guider. |

## 8. Marketplace IA (`/agents/marketplace`)

| ID | Sévérité | Observation |
|---|---|---|
| MIA-01 | 🟠 P1 | **Description obsolète** : `"Tous configurés sur **Qwen2.5-7B local** (pas d'API key externe nécessaire)"` — on est sur **qwen3:14b** depuis le sprint v1.1 (commit `948be02`). À mettre à jour ou rendre dynamique. |
| MIA-02 | 🟡 P2 | **Tags collés sans gap visible** ("comptatvafiscalfacture") — JS confirme 4 spans distincts mais pas d'espace entre `bg-muted/15 px-1.5` chips. Ajouter `gap-1.5` au flex parent. |

## 9. Marketplace n8n (`/workflows/marketplace`)

| ID | Sévérité | Observation |
|---|---|---|
| MN8-01 | 🟡 P2 | Tags collés idem (`qdrantdify`, `pennylaneagents`). Même fix que MIA-02. |
| MN8-02 | 🔵 IDEA | "48 disponibles · 2 installés · 2 actifs" sympa, ajouter un total dans les autres marketplaces (IA/MCP) pour cohérence. |

## 10. Intégrations MCP (`/integrations/mcp`)

| ID | Sévérité | Observation |
|---|---|---|
| MCP-01 | 🟡 P2 | "Catalogue (15) · Attachés à Dify (0)" → l'onglet Attachés est vide alors que la mémoire dit qu'il y a eu setup. À investiguer (peut-être que l'attache n'a jamais été déclenchée par l'utilisateur). |
| MCP-02 | 🟡 P2 | Filtres chips à gauche (Tout / Officiels Anthropic / Développement / Données&SQL / Communication / Productivité / Recherche web / Monitoring) — manquent quelques catégories visibles dans les cards (ex: Filesystem est listé comme "Officiels Anthropic" mais il n'a pas de sous-cat propre). |
| MCP-03 | 🔵 IDEA | Description "Config requise : Personal" / "Config requise : Brave" / "Config requise : Sentry" / "Config requise : Bot, Team" / "Config requise : Cheminé" → libellés cryptiques. Préciser : "Token GitHub", "Clé Brave Search", "Clé Sentry", etc. |

## 11. Audit (`/audit`)

| ID | Sévérité | Observation |
|---|---|---|
| AUD-01 | 🟡 P2 | Format des lignes redondant : `"Paramètres a.ladurelle@xefi.fr a.ladurelle@xefi.fr · admin · 10.242.2.2 il y a 2 h"` → l'email apparaît 2 fois (sujet + acteur) sans label distinctif. Préfixer par `Cible :` / `Acteur :`. |
| AUD-02 | 🟠 P1 | **Pas de validation form** : on voit `cloud-call:google:gemini-fake-model-that-does-not-exist` dans les events → le formulaire Settings BYOK accepte des noms de modèle arbitraires sans vérifier qu'ils existent. Ajouter un select limité aux modèles supportés. |
| AUD-03 | 🔵 IDEA | Pas de pagination, pas de recherche/filtre full-text, pas d'export CSV. Si le client cumule 1000+ events, page sera lente. |

## 12. État serveur (`/system`)

| ID | Sévérité | Observation |
|---|---|---|
| SYS-01 | 🔴 **P0** | **Statut global trompeur** : header dit `"Tous les services sont opérationnels"` (vert) alors que la liste juste en dessous montre `"Connecteur Pennylane fetch failed"` et `"Import FEC fetch failed"`. Le statut global doit refléter les fails. |
| SYS-02 | 🟠 P1 | **Compteur stale** : `"Assistants 6 / 6 opérationnels"` alors que /agents en montre 7 (Juridique CGV/RGPD activé). La conversation par agent ne liste que 6 (Juridique manquant). Refresh pas synchro. |
| SYS-03 | 🟡 P2 | Compteur "Utilisateurs 3 / 3 actifs / total" mais /users n'en liste qu'un. Différence groupes Authentik vs comptes app ? À clarifier le libellé. |
| SYS-04 | 🟡 P2 | Latences en ms affichées sans seuil de référence (vert/orange/rouge). 8ms vs 100ms vs 5000ms → pareil visuellement aujourd'hui. |
| SYS-05 | 🔵 IDEA | Bouton "Détails" sur chaque service (versions, uptime, derniers logs courts) absent. |

## 13. Paramètres (`/settings`)

| ID | Sévérité | Observation |
|---|---|---|
| SET-01 | 🟠 P1 | Section "Version & mises à jour" : `Version v0.2.0`, `unknown`, `Branche —`, `Build il y a 1 h` → la branche est vide (`—`) et "unknown" affiché sans contexte. Hooks de build à compléter (commit SHA + branche dans `version.json`). |
| SET-02 | 🟠 P1 | Section "Sauvegardes" affiche `"Sprint 6 : configuration backup offsite (Wasabi / B2 / S3)"` → c'est un message dev/roadmap exposé au client. Remplacer par "Bientôt disponible" ou retirer la section. |
| SET-03 | 🟠 P1 | **Vocabulaire d'état BYOK incohérent** : OpenAI=`Configurer`, Anthropic=`Opérationnel`, Google AI=`Configuré`, Mistral=`Configurer`. 3 mots pour 2 états réels (configuré ou non). Aligner sur 2 valeurs : `Configurer` / `Configuré` (et indicateur point vert pour testé OK). |
| SET-04 | 🟡 P2 | "Conso ce mois : 0.000 € / 50 € (0%) · 1 requêtes" — `1 requête**s**` → faute pluriel. |
| SET-05 | 🟡 P2 | Le bouton "Configurer" sur OpenAI/Mistral et "Opérationnel" sur Anthropic se confondent visuellement (couleur similaire). Différencier (vert plein vs outline). |
| SET-06 | 🔵 IDEA | "Charger les données de démo" est utile mais isolé en bas. Ajouter aussi sur Documents (empty state). |

## 14. Mes données — RGPD (`/me`)

| ID | Sévérité | Observation |
|---|---|---|
| ME-01 | 🟠 P1 | Section "Mémoire long-terme" reste figée sur **"Chargement…"** (testé > 10s). Soit le service mem0 ne répond pas, soit l'UI ne gère pas l'erreur. Ajouter un timeout + message "Aucune mémoire stockée pour l'instant" / "Erreur de chargement, réessayer". |
| ME-02 | 🟡 P2 | Boutons "Télécharger mes données (JSON)" / "Supprimer toutes mes conversations" sans confirmation modale visible (probablement présente mais à vérifier — destructif). |
| ME-03 | 🔵 IDEA | Pas de timestamp sur "compte créé le" / "dernière modif profil". |

## 15. Aide (`/help`)

| ID | Sévérité | Observation |
|---|---|---|
| H-01 | 🟠 P1 | **Doc obsolète** : `"Pour l'instant, les **4 agents par défaut** (général, comptable, RH, support) sont fixes"` — il y en a **7** : général, vision, comptable, RH, support, concierge, juridique. |
| H-02 | 🟠 P1 | **Doc obsolète** : `"Le modèle **qwen2.5:7b** reste celui livré avec la box"` — c'est **qwen3:14b** depuis le sprint v1.1. |
| H-03 | 🟠 P1 | **Doc obsolète** : `"Sélectionnez l'agent en haut de la liste de conversations : général, comptable, RH, support"` (4 agents). |
| H-04 | 🟠 P1 | **Limite incohérente** : `"20 Mo par document, 8 Mo par image"` ici vs `"15 Mo / fichier"` sur /documents. Source unique à définir. |
| H-05 | 🟡 P2 | Email `support@aibox.local` dans "Aller plus loin" → factice / non monitorée. À remplacer par contact réel ou retirer. |
| H-06 | 🟡 P2 | Commande `sudo ./recover-admin-password.sh --random` exposée → ok pour admin technique mais peut-être à mettre dans une section "Pour l'admin technique" séparée du FAQ user. |

---

## Bugs de fonctionnement vs UI (rappel)

L'erreur **React #418** (D-01) est la plus prioritaire car elle indique un mismatch SSR/CSR récurrent qui peut casser silencieusement des composants. Stack pointe vers le runtime Next.js (`MessagePort.T`), probablement un composant `'use client'` qui rend différent au premier paint (souvent : `Date.now()`, `Math.random()`, `localStorage` lu sans guard `typeof window`, ou polling avec valeur instable). À investiguer côté code via la version dev de Next pour avoir le message non-minifié.

---

## Recommandations d'ordre de fix

**Sprint 1 (1 jour) — Quick wins UX visibles :**
- D-01 (React #418), SYS-01 (statut global), SET-01/02/03 (Settings polish), H-01/02/03 (doc obsolète), TB-02 (dropdown profil).

**Sprint 2 (1 jour) — Cohérence et lisibilité :**
- D-02/03/04/05 (greeting/agents), MA-04/05 (chips modèles), MIA-01 (modèle marketplace), MIA-02/MN8-01 (tags), C-01 (filtres connecteurs), DOC-01/H-04 (limites taille), AUD-01/02 (audit + form validation), TB-01/04 (status bar), ME-01 (mémoire long-terme).

**Sprint 3 (idea / nice-to-have) :**
- D-08/09, AU-01/02/03, US-01/02, MCP-03, AUD-03, SYS-04/05, SET-06.

---

## Annexes

### Liste des modèles Ollama vus en topbar pendant l'audit

- `qwen3:14b · 10.6G` — modèle principal Assistant général
- `qwen2.5vl:7b · 10.9G` — modèle Vision (ex `qwen2.5vl` mais affiché `v1` dans les chips à cause de la fonte)
- `bge-m3:latest · 1.1G` — embedding RAG (chargé quand on a navigué vers /me probablement)

### Erreur console récurrente — texte brut

```
[EXCEPTION] /_next/static/chunks/4bd1b696-02ba2b069efa3780.js
Error: Minified React error #418
    at rv (...)
    at rb (...)
    at uf (...)
    at uu (...)
    at i8 (...)
    at uD (...)
    at MessagePort.T (.../1517-f6bf6243617e842f.js)
```
React #418 = "Hydration failed because the initial UI does not match what was rendered on the server."

### Sidebar finale (12 liens user-visible)

Discuter / Mes assistants / Automatisations / Documents · **Admin** : Utilisateurs / Connecteurs / Marketplace IA / Marketplace n8n / Intégrations MCP / Audit / État serveur / Paramètres · **Footer** : Mes données (clipped) / Aide.
