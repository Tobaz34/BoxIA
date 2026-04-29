# Sprints — Récap des livrables

> 7 sprints exécutés depuis le `EXECUTION-PLAN.md`. Tout le code est dans le repo, push effectué sur xefia (`/srv/ai-stack/`).

## Sprint 0 — MVP shippable ✅

| Livrable | Fichier |
|---|---|
| Backend deploy SSH/Paramiko | `portal/backend/deploy.py` |
| WebSocket logs streaming | `portal/backend/main.py` (LogBroker + endpoint `/api/clients/{id}/logs`) |
| Auth admin (argon2 + cookies signés) | `portal/backend/main.py` (`/api/auth/login` + `current_user`) |
| Doc client end-user | `docs/SETUP-CLIENT.md` |
| Pitch deck commercial | `docs/PITCH-DECK.md` |

**Bloquants externes** : test E2E sur VM vierge, réservation domaine public pour Let's Encrypt, prospection commerciale.

## Sprint 1 — Connecteurs M365 ✅

| Livrable | Statut |
|---|---|
| `rag-msgraph` (delta queries + ACL) | implémentation complète |
| `email-msgraph` (tri/résumé/réponse) | implémentation complète |
| Templates Dify : `agent_qa_documents`, `agent_email_triage` | YAML + script `import.py` |
| Manifest + prereqs Azure App Registration | `manifest.yaml` |

**Bloquants externes** : tenant M365 dev (gratuit via M365 Developer Program), création App Registration + admin consent.

## Sprint 2 — Google + IMAP + Odoo ✅

| Livrable | Statut |
|---|---|
| `rag-gdrive` (Drive API + delta page tokens + DWD) | implémentation complète |
| `email-imap` (générique OVH/Ionos/Gandi) | implémentation complète |
| `erp-odoo` (FastAPI tool : partners, sale_orders, invoices) | implémentation complète |

**Bloquants externes** : Google Workspace dev (Service Account + DWD admin consent), instance Odoo cible.

## Sprint 3 — Branding + monitoring + doc ✅

| Livrable | Fichier |
|---|---|
| Stack monitoring (Prom + Loki + Grafana + cAdvisor + DCGM) | `services/monitoring/` |
| Variables branding (logo, couleurs, footer) | `.env.example` enrichi |
| Tier pricing (TPE/PME/PME+) | `.env.example` |
| Backup offsite paramétrable (B2/Wasabi/S3/SFTP) | `.env.example` |
| Doc admin IT client (commandes, troubleshooting) | `docs/ADMIN-CLIENT.md` |

## Sprint 4 — Nextcloud + text-to-SQL + GLPI ✅

| Livrable | Statut |
|---|---|
| `rag-nextcloud` (WebDAV) | implémentation complète |
| `text2sql` (Postgres / MySQL / MSSQL avec garde-fous read-only) | implémentation complète |
| `helpdesk-glpi` (FastAPI tool : tickets CRUD) | implémentation complète |

## Sprint 5 — Sécurité + RGPD ✅

| Livrable | Fichier |
|---|---|
| `llama-guard` (filtre prompts via Llama Guard 3 + fallback heuristiques) | `services/security/llama-guard/` |
| `harden.sh` (UFW + CrowdSec + SSH durci + AppArmor + auditd + unattended-upgrades) | `services/security/harden.sh` |
| RGPD pack complet (DPA, registre, droit à l'effacement, anonymisation) | `docs/RGPD-PACK.md` |
| Script effacement user RGPD (Authentik + Qdrant + OWUI + Dify) | `scripts/rgpd_erase_user.py` |

**Bloquants externes** : signature DPA avec premiers clients, rédaction par avocat des CGU/Politique de confidentialité finales.

## Sprint 6 — Multi-client OTA ✅

| Livrable | Fichier |
|---|---|
| Endpoints fleet (update / rollback / health / overview) | `portal/backend/fleet.py` |
| Page dashboard parc Next.js (avec auto-refresh 30s) | `portal/frontend/src/app/fleet/page.tsx` |
| Bouton "↑ MAJ" par client | idem |
| Restore depuis backup | endpoint `/rollback` |

## Sprint 7 — Templates Dify + workflows n8n ✅

| Livrable | Fichier |
|---|---|
| Agent Q&R documents (RAG) | `templates/dify/agent_qa_documents.yml` |
| Agent tri emails | `templates/dify/agent_email_triage.yml` |
| Agent générateur de devis (Odoo) | `templates/dify/agent_devis_generator.yml` |
| Agent helpdesk N1 (GLPI) | `templates/dify/agent_helpdesk_n1.yml` |
| Agent analyste data (text2sql) | `templates/dify/agent_data_analyst.yml` |
| Workflow n8n : digest emails quotidien | `templates/n8n/workflow_email_digest_quotidien.json` |
| Workflow n8n : relance factures impayées | `templates/n8n/workflow_relance_factures_impayees.json` |

## Total

| Catégorie | Compteur |
|---|---|
| **Connecteurs implémentés** | 9 (rag-smb, rag-msgraph, rag-gdrive, rag-nextcloud, email-msgraph, email-imap, erp-odoo, text2sql, helpdesk-glpi) |
| Connecteurs squelettes | 1 (authentik-source) |
| Templates Dify | 5 |
| Workflows n8n | 2 |
| Stacks Docker Compose | 14 (au top des 5 existantes) |
| Backend FastAPI endpoints | ~20 |
| Pages Next.js | 5 |
| Docs | 8 |

## Bloquants externes (à toi de jouer)

Ce qui ne pouvait PAS être fait depuis ce contexte :

1. **VM Ubuntu vierge** pour test E2E réel → 30 min à provisionner (Proxmox/VirtualBox)
2. **Domaine public + DNS** pour valider Let's Encrypt → 5 € pour un .fr OVH ou Cloudflare gratuit
3. **Tenant M365 Developer** (gratuit) → 1h de setup
4. **Workspace Google admin** (1 user existant suffit) + Service Account + DWD
5. **Repo Git privé** (GitHub/GitLab/Codeberg) pour `git clone` côté client
6. **Image disque maître** (Packer ou Clonezilla) → ~1 jour à scripter, dépend du HW cible
7. **Avocat** pour valider DPA/CGU/Politique de confidentialité
8. **GPU upgrade** RTX 4090 24 GB pour la démo PME (sinon ça rame)
9. **3-5 prospects pilotes** identifiés (réseau perso, LinkedIn)
10. **Tests réels** des connecteurs sur des sources clientes (chacun nécessite un OAuth flow propre)

## Estimation honnête restante avant 1er client réel

- **Sprint 0 finalisation (test VM + LE)** : 1 jour
- **Sprint 1 test E2E avec vrai tenant M365** : 2 jours
- **Image disque maître + démo brandée** : 2 jours
- **Démo + prospection** : 1 semaine
- **Premier déploiement chez le pilote** : 1 jour

→ **Compte 2 semaines de boulot + prospection en parallèle**, avec ce qui a été pondu cette session.
