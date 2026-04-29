# Roadmap — AI Box

## Phase 1 — POC fonctionnel ✅ *(en cours)*

Objectif : avoir une stack qui tourne, validable chez un 1er client pilote.

- [x] Inventaire serveur de référence (xefia)
- [x] Modèles Ollama modernes (Qwen 2.5 7B + bge-m3)
- [ ] Stack consolidée : Open WebUI + Dify + n8n + Qdrant + Authentik + NPM
- [ ] `install.sh` interactif qui demande infos entreprise et techs utilisées
- [ ] Sous-domaines avec TLS + SSO unifié Authentik
- [ ] Documentation install + commandes admin

## Phase 2 — Portail de provisioning web 🎯 *(différenciant produit)*

Objectif : transformer le déploiement en **expérience commerciale**. Plus de CLI, un wizard graphique qu'on utilise en RDV client.

### Wizard graphique

**Étape 1 — Identité client**
- Nom de l'entreprise
- Secteur d'activité (BTP, juridique, santé, immobilier, comptabilité, autre)
- Taille (nombre d'utilisateurs, multi-sites)
- Logo + couleurs (branding interface)

**Étape 2 — Stack technologique du client**
Cases à cocher avec auto-détection des templates à activer :

| Catégorie | Options | Connecteurs activés |
|---|---|---|
| **Messagerie** | Microsoft 365 / Exchange / Google Workspace / autre IMAP | Connecteur emails RAG, agent tri emails, templates réponses |
| **Stockage docs** | SharePoint / OneDrive / Google Drive / Dropbox / NAS local (SMB) / Nextcloud | Connecteur RAG ingestion auto |
| **CRM / ERP** | Odoo / Sage / Cegid / Salesforce / HubSpot / Pipedrive | Workflows n8n pré-configurés (devis, factures, leads) |
| **Comptabilité** | Sage Compta / Cegid / EBP / autre | Agent dépouillement factures |
| **Bases SQL** | PostgreSQL / MySQL / MS SQL / Oracle | Agent text-to-SQL pour reporting |
| **Identité** | Active Directory / Azure AD / LDAP / Google / aucune | Authentik configuré sur source identité |
| **Tickets / Helpdesk** | GLPI / Zammad / Jira Service Mgmt / Freshdesk | Agent qualif tickets |
| **Téléphonie** | 3CX / Wildix / Aircall / autre | Transcription Whisper + résumé appels |
| **Autres** | DocuSign, Slack, Teams, etc. | Workflows n8n |

**Étape 3 — Cas d'usage prioritaires**
Cocher 3-5 use cases dans une liste type :
- Assistant interne questions/réponses (RAG sur procédures)
- Tri & réponse automatique emails
- Génération de devis depuis brief commercial
- Compte-rendus de réunions Teams/Meet
- Recherche sémantique base contrats
- Agent IT (création tickets, FAQ employés)
- Veille / résumé presse
- ...

**Étape 4 — Configuration matérielle**
- Profil HW détecté (CPU/RAM/GPU)
- Modèles recommandés par profil
- Estimation perf (users concurrents)

**Étape 5 — Génération + Déploiement**
- Le wizard génère un `client_config.yaml`
- Push SSH vers le serveur cible
- Lance `install.sh` en mode non-interactif avec ce config
- Suit le déploiement en temps réel (logs streamés)
- À la fin : URL d'accès + identifiants admin

### Stack du portail

- **Frontend** : Next.js 15 (App Router) + Tailwind + shadcn/ui
- **Backend** : FastAPI (Python) + SQLite (catalogue clients) + Paramiko (SSH)
- **Auth admin portail** : un seul compte admin (toi) protégé par WebAuthn
- **Hébergement** : sur ta machine ou un VPS, c'est l'outil d'admin

### Extensions futures

- Catalogue de templates (agents, workflows) en marketplace interne
- Multi-environnement (dev/staging/prod par client)
- Mises à jour pilotées centralement (push d'une nouvelle version d'AI Box vers tous les clients)
- Dashboards consolidés (état de tous les clients)
- Facturation automatique (usage tokens, espace, support)

## Phase 3 — Industrialisation 🚀

- Migration vers K3s pour les clients +50 users
- Multi-tenant sur infra hébergée (offre "AI Box Cloud" alternative au on-prem)
- Marketplace de skills par secteur (BTP / juridique / santé)
- Intégration WhatsApp Business / SMS / téléphonie pour agents conversationnels
- Conformité ISO 27001 / HDS si demande secteur santé
- Programme partenaires (revendeurs, intégrateurs locaux)

## Phase 4 — Vision long terme 🌐

- Réseau d'AI Box fédérées (les modèles/skills se mettent à jour automatiquement)
- Modèles fine-tunés par secteur, distribués aux clients abonnés
- API publique pour intégrer AI Box dans des applis tierces
