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
- [x] Smoke E2E : mock FastAPI + client FastMCP → impayés(2) + client round-trip via le shim (criterion #1 = chemin de données prouvé)
- [ ] **Go/No-go criterion #3** : Hermes live (Ollama + cloud + Telegram) → latence hybride — *nécessite install Hermes + clé cloud + bot, non faisable sur le poste de dev seul*
- **Verdict POC** : critères #1 (MCP sans fork) et #2 (hooks/plugins sans fork) ✅. #3 = la seule inconnue restante (mesures connues : local ~24-48 s, cloud Haiku ~1-2 s).

## Phase 2 — Portage du moat  🟦
- [ ] Connecteurs Odoo / GLPI / FEC en shims MCP (même pattern que Pennylane)
- [ ] Skills métier FR (`skills/aibox-fr/`) via `external_dirs`
- [x] BYOK cloud + fallback local câblés (via provision-tenant.sh : `hermes fallback`)
- [x] Audit en plugin `post_tool_call` → JSONL (`plugins/aibox-audit/`, 5 tests)
- [ ] Branding `config/skins/aibox.yaml` + `SOUL.md`

## Phase 3 — Multi-utilisateur (1 Hermes / employé)  🟦
- [x] **Modèle révisé** : 1 Hermes PAR utilisateur (isolation process) ; entreprise = config partagée héritée
- [x] `provision/wizard-company.sh` — config partagée entreprise (modèle auto via cookbook, cloud, connecteurs, RGPD) — dry-run validé
- [x] `provision/wizard-user.sh` — Hermes du user, **hérite** `company.env` (modèle/connecteurs/clés) + delta user (Telegram, SOUL) — héritage validé en dry-run
- [x] RBAC par employé : enforcement connecteur via `provision/render_config.py` (un connecteur non autorisé n'apparaît PAS dans la config du user → inappelable). 5 tests.
- [ ] Pairing Telegram par user — à valider live
- [x] `provision/provision-tenant.sh` conservé (variante single-instance POC)

## Phase 4 — Install clé-en-main (VPS)  🟦
- [x] `install.sh` one-command VPS (deps + Hermes + modèle + wizards + systemd + Caddy) — **dry-run complet validé**
- [x] Wizards entreprise + utilisateur (cf. Phase 3)
- [x] Service systemd `provision/aibox-hermes@.service` (1 par user) + `provision/Caddyfile.template` (HTTPS auto)
- [x] `INSTALL-VPS.md` — guide complet (Ubuntu, cloud-primary, Telegram, ajout d'employés)
- [ ] Mode `--update` / backup-restore (à consolider)
- [ ] PWA web : routage API par user dans Caddy (Telegram OK en attendant)

## Phase 5 — Bascule xefia  ⬜
- [ ] Déployer la stack Hermes-first sur xefia
- [ ] Valider E2E (chat, connecteur, approval, multi-user)
- [ ] **Décommissionner l'ancienne BoxIA** (confirmation explicite avant wipe)

---

## Idées Odysseus greffées (2026-06-14)  🟦
Reprises comme **idées** (Odysseus = AGPL → jamais de code copié), greffées sur Hermes.
- [x] **Cookbook** (`cookbook/`) — modèle local recommandé selon le hardware. 7 tests + démo live + auto-détection OK. Skill `aibox-cookbook`.
- [x] **Email triage** (`skills/aibox-email-triage/`) — workflow FR + scoring d'urgence déterministe (6 tests). Envoi = approval-gate.
- [x] **Deep research** (`skills/aibox-deep-research/`) — workflow recherche multi-sources **sourcée**.
- [x] **PWA mobile** (`pwa/`) — app installable vers l'API Hermes (6 fichiers, JS validé `node --check`). E2E à valider live.

### Journal
- **2026-06-14 (nuit, VPS installable)** — **RBAC effectif** (`render_config.py` : connecteur non autorisé absent de la config user, 5 tests → **37/37**). **Stack installable VPS** : `install.sh` one-command (deps→Hermes→modèle→wizards→systemd→Caddy, dry-run complet OK), service `aibox-hermes@.service` (1/user), `Caddyfile.template` (HTTPS auto), `INSTALL-VPS.md`. VPS = sans GPU → défaut **cloud-primary** (Haiku). Phases 3-4 quasi closes.
- **2026-06-14 (nuit, wizards)** — Révision archi : **1 Hermes par utilisateur** (au lieu de 1/entreprise, à la demande). `wizard-company.sh` (config partagée + modèle auto cookbook) + `wizard-user.sh` (Hermes du user qui **hérite** `company.env`). Héritage validé en dry-run (user reprend modèle qwen3:14b / connecteurs / cloud de l'entreprise). ARCHITECTURE D3/D5 + flux mis à jour.
- **2026-06-14 (nuit, suite)** — 4 features Odysseus greffées : Cookbook (7 tests + démo + auto-détection ce poste = qwen3:8b), Email triage (skill + 6 tests urgence, bug « huissier→haute » corrigé), Deep research (skill), PWA (6 fichiers statiques, JS valide). **Total 32/32 tests.** Tout sur `claude/hermes-pivot`.
- **2026-06-14 (nuit)** — Phase 0 + Phase 1 en autonomie.
  - Phase 0 : décision actée, dossier `aibox-hermes/` + docs + template, commit sur branche `claude/hermes-pivot`. Analyse Git → `BRANCH-AUDIT.md` (origin/main inclut déjà le hardening ; 6 branches fusionnées supprimables, 2 à examiner).
  - Phase 1 : shim MCP Pennylane (FastMCP, 8 tools), plugins `aibox-approval` (pre_tool_call) + `aibox-rgpd` (transform_tool_result), portés depuis BoxIA. **14/14 tests unitaires verts.** Serveur MCP validé (import + 8 tools listés). Matcher mutatif validé contre les vrais noms de tools.
  - Correctif d'architecture vs hypothèse initiale : approval & RGPD sont des **plugins Python** (pas des shell hooks) ; `pre_api_request` est observer-only.
  - Suite (même nuit) : smoke E2E MCP (mock FastAPI → données round-trip), plugin **audit** (+5 tests → **19/19**), script **provisioning** idempotent (`--check` validé), BYOK fallback câblé. Phases 2 & 3 entamées.
  - Reste : critère #3 (latence live), connecteurs Odoo/GLPI/FEC, branding, pairing/RBAC employés.
- **2026-06-14** — Phase 0 lancée. Hermes cloné (`.research-cache/hermes-agent`, v0.16.0). Interfaces vérifiées : `mcp_servers`, `hooks`, `group_sessions_per_user`, `skills.external_dirs`, `display.skin`. Verdict : produit faisable **sans fork**.
