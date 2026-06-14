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

## Phase 1 — POC vertical (dé-risquage)  ⬜
> Objectif : prouver le concept bout-en-bout sur **une** tranche. Critères go/no-go avant d'aller plus loin.
- [ ] Hermes installé en local, branché sur Ollama (`provider: custom`)
- [ ] Lire le wire-protocol exact des hooks (`docs hooks.md`) + MCP (`docs mcp.md`)
- [ ] `mcp-connectors/pennylane/server.py` — shim MCP → FastAPI Pennylane (read-only)
- [ ] `hooks/approval_gate.sh` — port de l'approval-gate en `pre_tool_call`
- [ ] `hooks/rgpd_scrub.sh` — port du scrub PII FR en `pre_api_request`
- [ ] Test : « liste mes factures impayées » via CLI Hermes → tool MCP → réponse
- [ ] Test : action mutative simulée → approval-gate bloque → confirmation → exécute
- [ ] Test : prompt avec PII → scrub avant cloud
- [ ] **Go/No-go** : (1) MCP shim OK ? (2) hooks OK sans fork ? (3) latence cloud hybride acceptable ?

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
- **2026-06-14** — Phase 0 lancée. Hermes cloné (`.research-cache/hermes-agent`, v0.16.0). Interfaces vérifiées : `mcp_servers`, `hooks` (pre_tool_call/pre_api_request), `group_sessions_per_user`, `skills.external_dirs`, `display.skin`. Verdict : produit faisable **sans fork**. Docs + template créés.
