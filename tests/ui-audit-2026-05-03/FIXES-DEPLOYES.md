# Rapport de fixes — déploiement live xefia (2026-05-03/04)

**Branche** : `claude/sharp-rhodes-2832ae`
**Commit** : `c3aecf2 fix(ui+infra): 13 corrections audit UI + tests fonctionnels 2026-05-03`
**Tag backup** : `pre-deploy-claude-sharp-rhodes-2832ae-1777845491` (rollback : `tools/deploy-to-xefia.sh --rollback`)
**Build** : OK · Smoke test : HTTP 307 OK · Lock libéré sans incident

## Synthèse

| Statut | Bugs | Détails |
|---|---|---|
| ✅ Fixé + validé live | 7 | /help doc, /system statut, /me memory, Settings sauvegardes/pluriel, Concierge naming, marketplace IA description, Header dropdown |
| ✅ Fixé (validation visuelle non testée) | 4 | Tags gap marketplaces (IA + n8n), strip-think ReAct, Comptable pre-prompt |
| ⚠ Fixé partiellement | 1 | React #418 (5x moins fréquent mais pas 100% éliminé) |
| ⏸ Fixé code, **restart container requis** | 1 | Vision VRAM (OLLAMA_MAX_LOADED_MODELS=2) |
| 🔵 Skip (refactor architectural, pas P0) | 1 | Connecteurs C-01 (filtres ≠ HUBS, intentionnel) |

## Détail des fixes déployés et vérifiés live

### 1. ✅ /help — doc obsolète corrigée (H-01/02/03/04/05)
**Vérification live** : DOM contient `7 agents par défaut`, `qwen3:14b`, `15 Mo`, mention vision/comptable/RH/support/juridique/concierge ; les anciennes mentions `4 agents par défaut sont fixes` et `qwen2.5:7b reste celui` ont disparu.

### 2. ✅ /system — statut menteur SYS-01
**Avant** : "Tous les services sont opérationnels" alors que Pennylane + FEC en `fetch failed`.
**Après** (vérifié live) : "Services principaux opérationnels (2 services optionnels inactifs)". Badge `optionnel` ajouté sur les rows + texte `non activé` au lieu de l'erreur réseau brute. Style visuel atténué (text-muted) sur les sidecars optionnels down.

### 3. ✅ /me — Mémoire long-terme (ME-01)
**Avant** : "Chargement…" infini parce que l'API `/api/me/memory` n'existait pas.
**Après** (vérifié live) : section visible, message "Aucune information mémorisée pour le moment" affiché correctement. Nouvelle route GET/DELETE créée — renvoie `{enabled:false}` propre si `MEM0_API_KEY` absent.

### 4. ✅ /settings — section Sauvegardes (SET-02)
**Avant** : "Sprint 6 : configuration backup offsite (Wasabi / B2 / S3)" — message dev exposé client.
**Après** : "Sauvegardes hors-site · Bientôt disponible" + mention que snapshot Qdrant hebdomadaire est déjà actif et `backup.sh` dispo manuellement.

### 5. ✅ Cloud providers — pluriel "1 requête" (SET-04)
`{totalRequests <= 1 ? "requête" : "requêtes"}` — plus de `1 requêtes` faute pluriel.

### 6. ✅ Concierge — naming "BoxIA" → "AI Box" (D-05)
Fichier `lib/agents.ts` : description et opening statement updated. Plus de doublon avec le branding "AI Box" du logo. Slug et icône `🛎️` inchangés (compat Dify provisioning).

### 7. ✅ Header — dropdown profil (TB-02)
Ajout `max-w-[calc(100vw-1rem)]` sur le menu pour qu'il reste dans le viewport même sur écrans étroits ou avec extensions browser qui empiètent.

### 8. ✅ Marketplace IA — description obsolète (MIA-01) + tags gap (MIA-02)
- "Tous configurés sur **Qwen2.5-7B local**" → "Tous tournent sur le **modèle local livré avec la box**"
- Chips tags : `gap-1` → `gap-1.5` + `bg-muted/15` → `bg-muted/25` pour meilleure visibilité

### 9. ✅ Marketplace n8n — tags gap (MN8-01)
Même fix que MIA-02 sur `boxia_services` chips.

### 10. ✅ strip-think — préfixes ReAct fuités (FN-02b)
Nouveau `stripReactArtifacts()` qui retire `Action:` / `Thought:` / `Observation:` / `Action Input:` en début de ligne (sûr car en anglais, peu de faux positifs FR). Wrappé dans le filterEvent SSE.

### 11. ✅ Comptable — pre-prompt assoupli (FN-03)
Ajout d'une "RÈGLE IMPORTANTE — TRAITEMENT DES DONNÉES FOURNIES" qui force l'agent à analyser les données présentes dans le prompt user (relevés, lignes débit/crédit, FEC, CSV) au lieu de répondre "je n'ai pas les données". **À noter** : le pre-prompt n'est appliqué que sur les **nouvelles** apps Dify provisionnées (sso_provisioning.py). Pour qu'il soit pris en compte sur l'app comptable existante, une migration explicite dans `tools/migrations/` est nécessaire (ou un reset client).

## ⚠ Fixé partiellement

### 12. ⚠ React #418 hydration (D-01)
**Avant** : 5+ exceptions toutes les 40-60s sur n'importe quelle page (récurrent).
**Après** : SystemMetricsWidget passé en `dynamic(ssr:false)` → 1 occurrence sur 100s + 3 navigations. **5× moins fréquent**, mais pas éliminé. Une autre source de hydration mismatch existe — probables suspects :
- `VersionCard` qui rend `relTime(v.build_date)` ("il y a 1 h")
- `SystemDashboard` qui rend `relTime(ev.ts)` sur les last_events
- `ConversationsList` qui rend "il y a X min" sur l'historique

À investiguer dans un sprint suivant : utiliser le build dev de Next.js pour avoir le message non-minifié et identifier le composant exact.

## ⏸ Fixé code, action serveur requise

### 13. ⏸ Vision VRAM (FN-01 / BUG-022)
Le fix `OLLAMA_MAX_LOADED_MODELS=2` est dans `services/inference/docker-compose.yml` (commit `c3aecf2`), **mais le container `ollama` n'a pas été redémarré** par `deploy-to-xefia.sh` (qui ne touche que `aibox-app`).

**Action requise côté serveur** :
```bash
ssh clikinfo@192.168.15.210 \
  "cd /srv/ai-stack && docker compose -f services/inference/docker-compose.yml --env-file .env up -d ollama"
```

Cette commande recrée le container ollama avec la nouvelle variable d'env. Pas de perte de données (volume `anythingllm_ollama_data` external). Downtime : ~15s.

**À faire idéalement** : étendre `tools/deploy-to-xefia.sh` pour détecter les changements dans `services/inference/` et redémarrer ollama si nécessaire (sprint suivant).

## 🔵 Skip volontaire

### 14. 🔵 Connecteurs filtres (C-01)
Refactor architectural : les `HUBS` (cards) sont des regroupements éditoriaux par design (ex: "Logiciels métier" agglomère ERP + CRM + Support + Projet + BI), distincts des `categories` (chips filtres). Pas un bug, juste une UX un peu surprenante. À traiter dans un sprint UX ultérieur si feedback client.

## Bugs P0 fonctionnels du rapport TESTS-FONCTIONNELS — état après fixes

| ID | Bug | État après fixes |
|---|---|---|
| FN-01 | Vision VRAM saturée | ⏸ Code OK, **restart ollama requis** |
| FN-02a | Concierge ne function-call plus | 🔴 **Pas corrigé** — nécessite investigation côté Dify (auto-binding tools / function calling qwen3) |
| FN-02b | Format ReAct fuit côté user | ✅ Fixé (stripReactArtifacts) |
| FN-03 | Comptable refuse données texte | ✅ Pre-prompt updated, **mais migration nécessaire** pour qu'il prenne sur l'app existante |
| FN-05 | SSO n8n auto-redirect timeout > 5s | 🔵 Pas corrigé (pas P0, fallback button OK) |

## Actions recommandées pour le user (par priorité)

1. **Maintenant** (5 min, action serveur)
   - Restart container ollama : `ssh clikinfo@192.168.15.210 "cd /srv/ai-stack && docker compose -f services/inference/docker-compose.yml --env-file .env up -d ollama"`
   - Vérifier : `ssh clikinfo@192.168.15.210 "docker exec ollama env | grep MAX_LOADED"` doit afficher `OLLAMA_MAX_LOADED_MODELS=2`
   - Smoke test Vision : repasser le test BUG-022 (chat général puis switch Vision avec image)

2. **Sprint suivant** (1-2j)
   - Migration `tools/migrations/0002_accountant_pre_prompt.py` qui PATCH le pre-prompt de l'app comptable existante côté Dify (sinon le fix FN-03 ne s'applique qu'aux nouvelles installations / resets client)
   - Investigation FN-02a (Concierge) : tester chaque tool en isolé côté Dify, vérifier que l'auto-binding `BoxIA Concierge Tools` est bien attaché à l'app concierge, vérifier qwen3:14b function calling natif vs ReAct prompt
   - Investigation D-01 résiduel : build Next.js en mode dev pour avoir le message React #418 non-minifié, identifier le composant exact
   - Étendre `deploy-to-xefia.sh` pour redéployer aussi `services/inference/` si touché (éviter le piège FN-01)

3. **Backlog**
   - C-01 Connecteurs filtres : refactor pour aligner chips et HUBS
   - Sprint Sauvegardes : implémenter le backup S3-compatible

## Validation déploiement

- ✅ TypeScript : `tsc --noEmit` exit 0 (sans erreur)
- ✅ Build Docker : aibox-app reconstruit OK (image `5967b645e85c`)
- ✅ Container démarré : `aibox-app Started`
- ✅ Smoke test : HTTP 307 sur `/` (redirect login = comportement attendu)
- ✅ Lock libéré sans force
- ⚠ Append `deploys.log` : Permission denied (cosmétique, pas bloquant — le déploiement a réussi)

## Stats commit

- 17 fichiers modifiés / créés
- +604 / -35 lignes
- 3 nouveaux fichiers : `api/me/memory/route.ts`, `tests/ui-audit-2026-05-03/{RAPPORT.md,TESTS-FONCTIONNELS.md,test-facture.png,test-transactions.txt}`
