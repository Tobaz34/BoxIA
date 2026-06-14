# Build-board — AI Box Hermes-first

Source de vérité de l'avancement. Mode **radical** : Hermes devient le produit, le moat se porte en parallèle, l'ancienne BoxIA est archivée une fois le portage validé.

Statut : ⬜ à faire · 🟦 en cours · ✅ fait

---

## Phase 0 — Base saine  🟦
- [x] Décision actée (Hermes socle, MIT) — cf. ARCHITECTURE.md
- [x] Dossier propre `aibox-hermes/` + docs (README, ARCHITECTURE, PORT-MAP, board)
- [x] Template `config/config.template.yaml`
- [ ] Nettoyage Git : merger/archiver les ~15 branches mortes, repartir d'un `main` propre
- [ ] Archiver l'ancienne stack BoxIA (`services/app`, Dify…) sous `legacy/` ou tag, sans la supprimer

## Phase 1 — POC vertical (dé-risquage)  🟦
> Objectif : prouver le concept bout-en-bout sur **une** tranche. Critères go/no-go.
- [x] Wire-protocol hooks + MCP lus dans la source Hermes (clone v0.16.0)
- [x] `mcp-connectors/pennylane/server.py` — shim MCP FastMCP → FastAPI (8 tools read-only)
- [x] `plugins/aibox-approval/` — approval-gate en plugin `pre_tool_call` (+ /aibox-approve)
- [x] `plugins/aibox-rgpd/` — scrub PII FR en plugin `transform_tool_result`
- [x] Tests unitaires : 14/14 verts (scrub PII ordering + machine d'approbation anti param-swap)
- [x] Valide : serveur MCP importe + liste 8 tools ; matcher mutatif OK (read-only non bloqués, mutatifs bloqués)
- [ ] **Go/No-go criterion #3** : Hermes live (Ollama + cloud + Telegram) → latence hybride — *nécessite install Hermes + clé cloud + bot, non faisable sur le poste de dev seul*
- **Verdict POC** : critères #1 (MCP sans fork) et #2 (hooks/plugins sans fork) ✅. #3 = la seule inconnue restante (mesures connues : local ~24-48 s, cloud Haiku ~1-2 s).

## Phase 2 — Portage du moat  ⬜
- [ ] Connecteurs Odoo / GLPI / FEC en shims MCP
- [ ] Skills métier FR (`skills/aibox-fr/`) via `external_dirs`
- [ ] BYOK cloud + fallback local câblés
- [ ] Audit en hook `post_tool_call` → JSONL
- [ ] Branding `config/skins/aibox.yaml` + `SOUL.md`

## Phase 3 — Multi-utilisateur / multi-tenant  ⬜
- [ ] 1 instance par entreprise (`HERMES_HOME` dédié, `provision/provision-tenant.sh`)
- [ ] N employés isolés (`group_sessions_per_user`, pairing Telegram)
- [ ] RBAC par employé (visibilité tools / connecteurs)

## Phase 4 — Install clé-en-main  ⬜
- [ ] `aibox-install.sh` Hermes-first (absorbe `../aibox-host/`)
- [ ] Wizard : entreprise, clé cloud, bot Telegram, connecteurs
- [ ] Mode `--update`, backup/restore

## Phase 5 — Bascule xefia  ⬜
- [ ] Déployer la stack Hermes-first sur xefia
- [ ] Valider E2E (chat, connecteur, approval, multi-user)
- [ ] **Décommissionner l'ancienne BoxIA** (confirmation explicite avant wipe)

---

### Journal
- **2026-06-14 (nuit)** — Phase 0 + Phase 1 en autonomie.
  - Phase 0 : décision actée, dossier `aibox-hermes/` + docs + template, commit sur branche `claude/hermes-pivot`. Analyse Git → `BRANCH-AUDIT.md` (origin/main inclut déjà le hardening ; 6 branches fusionnées supprimables, 2 à examiner).
  - Phase 1 : shim MCP Pennylane (FastMCP, 8 tools), plugins `aibox-approval` (pre_tool_call) + `aibox-rgpd` (transform_tool_result), portés depuis BoxIA. **14/14 tests unitaires verts.** Serveur MCP validé (import + 8 tools listés). Matcher mutatif validé contre les vrais noms de tools.
  - Correctif d'architecture vs hypothèse initiale : approval & RGPD sont des **plugins Python** (pas des shell hooks) ; `pre_api_request` est observer-only.
  - Reste : critère #3 (latence live), Phase 2+.
- **2026-06-14** — Phase 0 lancée. Hermes cloné (`.research-cache/hermes-agent`, v0.16.0). Interfaces vérifiées : `mcp_servers`, `hooks`, `group_sessions_per_user`, `skills.external_dirs`, `display.skin`. Verdict : produit faisable **sans fork**.
