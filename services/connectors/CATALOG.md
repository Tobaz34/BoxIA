# Catalogue des connecteurs AI Box

> Liste de tous les connecteurs implémentés ou envisagés. Chaque connecteur **active** une capability concrète sur la box quand le client coche la techno correspondante dans le wizard.

**Légende statut** :
- ✅ Implémenté
- 🟡 Squelette (structure + TODO)
- 📋 Planifié (juste l'idée)

## 📁 RAG sur sources documentaires

| ID | Source | Statut | Notes |
|---|---|---|---|
| `rag_smb` | NAS Synology / QNAP / partage Windows (CIFS/SMB) | ✅ | Worker Python périodique |
| `rag_msgraph` | Microsoft 365 SharePoint / OneDrive | 🟡 | App Microsoft Graph + delta queries |
| `rag_gdrive` | Google Drive | 🟡 | Service account + Drive API |
| `rag_nextcloud` | Nextcloud | 📋 | WebDAV ou API native |
| `rag_dropbox` | Dropbox Business | 📋 | API Dropbox |
| `rag_box` | Box | 📋 | API Box |
| `rag_confluence` | Confluence | 📋 | REST API + delta sync |
| `rag_notion` | Notion | 📋 | API Notion + databases |
| `rag_local_fs` | Filesystem local (dossier monté) | ✅ | fswatch + ingestion |
| `rag_web` | Site web public du client (crawl + index) | 📋 | Scrapy/Crawl4AI + cron |

## 📧 Email — agents tri / résumé / réponse

| ID | Source | Statut |
|---|---|---|
| `email_msgraph` | Microsoft 365 Exchange Online | 🟡 |
| `email_gmail` | Google Workspace Gmail | 🟡 |
| `email_imap` | IMAP générique (OVH, Ionos, Gandi…) | 🟡 |
| `email_exchange_onprem` | Exchange On-Premise | 📋 |

Capabilities activées : classification IA des emails, suggestions de réponse, résumé de fil, détection PII/phishing, génération de digest hebdo.

## 🗓️ Calendrier — assistant agenda

| ID | Source | Statut |
|---|---|---|
| `calendar_msgraph` | Outlook Calendar (M365) | 📋 |
| `calendar_gcal` | Google Calendar | 📋 |
| `calendar_caldav` | CalDAV générique | 📋 |

Capabilities : préparation de RDV (résumé contexte client), résumé de la semaine, suggestions de créneaux libres.

## 💼 ERP / CRM — workflows métier

| ID | Source | Statut |
|---|---|---|
| `erp_odoo` | Odoo (Online / Enterprise / Community) | 🟡 |
| `crm_salesforce` | Salesforce | 📋 |
| `crm_hubspot` | HubSpot | 📋 |
| `erp_sage` | Sage 50 / 100 / X3 | 📋 |
| `crm_pipedrive` | Pipedrive | 📋 |
| `erp_dynamics` | MS Dynamics 365 / Business Central | 📋 |
| `erp_cegid` | Cegid | 📋 |
| `erp_ebp` | EBP | 📋 |

Templates fournis : génération de devis depuis brief, scoring de leads, résumé d'opportunités, relance automatique impayés.

## 🎫 Helpdesk / Ticketing — agent IA niveau 1

| ID | Source | Statut |
|---|---|---|
| `helpdesk_glpi` | GLPI | 🟡 |
| `helpdesk_zammad` | Zammad | 📋 |
| `helpdesk_freshdesk` | Freshdesk | 📋 |
| `helpdesk_zendesk` | Zendesk | 📋 |
| `helpdesk_jira` | Jira Service Management | 📋 |

Capabilities : qualification automatique, réponse niveau 1 sur questions récurrentes, escalade intelligente.

## 📞 Téléphonie — transcription + résumés

| ID | Source | Statut |
|---|---|---|
| `telephony_3cx` | 3CX | 🟡 |
| `telephony_wildix` | Wildix | 📋 |
| `telephony_ringover` | Ringover / Aircall | 📋 |
| `telephony_yeastar` | Yeastar | 📋 |

Pipeline : enregistrement audio → faster-whisper (transcription) → LLM (résumé + action items) → CRM ou email.

## 💬 Messaging — agent dans les canaux

| ID | Source | Statut |
|---|---|---|
| `messaging_teams` | Microsoft Teams (channels + chat 1-1) | 📋 |
| `messaging_slack` | Slack | 📋 |
| `messaging_whatsapp` | WhatsApp Business | 📋 |
| `messaging_webhook` | Webhook générique (chatbot site web) | 📋 |

## 🔐 Sources d'identité (Authentik)

| ID | Source | Statut |
|---|---|---|
| `authentik_source_azure` | Microsoft Entra ID (ex-Azure AD) | 🟡 |
| `authentik_source_google` | Google Workspace SSO | 🟡 |
| `authentik_source_ldap` | Active Directory local / OpenLDAP | 🟡 |
| `authentik_source_oidc` | Provider OIDC custom (Okta, Auth0) | 🟡 |
| `authentik_source_saml` | Provider SAML | 📋 |

Le script `provision.py` crée la source dans Authentik via API.

## 📊 BI / Reporting — agent NL→SQL/DAX

| ID | Source | Statut |
|---|---|---|
| `bi_powerbi_agent` | Power BI (NL→DAX, semantic model) | 📋 |
| `bi_metabase_agent` | Metabase (NL→SQL via Metabot) | 🟡 |
| `bi_tableau` | Tableau (Ask Data API) | 📋 |
| `bi_looker` | Looker Studio (BigQuery NL→SQL) | 📋 |
| `bi_superset` | Apache Superset | 📋 |

## 🗄️ Bases de données métier — text-to-SQL

| ID | Source | Statut |
|---|---|---|
| `text2sql_postgres` | PostgreSQL | 🟡 |
| `text2sql_mysql` | MySQL / MariaDB | 📋 |
| `text2sql_mssql` | Microsoft SQL Server | 📋 |
| `text2sql_oracle` | Oracle | 📋 |
| `text2sql_sqlite` | SQLite (cas niche) | 📋 |

## 📄 Extraction documents — factures, devis, contrats

| ID | Use case | Statut |
|---|---|---|
| `doc_invoice_extract` | Extraction structurée factures (lignes, montants, fournisseur) | 📋 |
| `doc_contract_analyze` | Analyse contrats (clauses risquées, échéances) | 📋 |
| `doc_devis_compare` | Comparaison de devis fournisseurs | 📋 |

Pipeline : Unstructured.io / Marker → LLM avec schéma JSON forcé → DB.

## 🌐 Marketing / Site web

| ID | Source | Statut |
|---|---|---|
| `marketing_mailchimp` | Mailchimp (lecture stats, génération brouillons campagnes) | 📋 |
| `marketing_brevo` | Brevo (ex-Sendinblue) | 📋 |
| `marketing_hubspot` | HubSpot Marketing (séquences, leads) | 📋 |
| `cms_wordpress` | WordPress (lecture posts, brouillons) | 📋 |
| `cms_shopify` | Shopify (catalogue produit RAG) | 📋 |

## 💰 Finance / Banque

| ID | Source | Statut |
|---|---|---|
| `bank_bridge` | Bridge / Powens / Tink (open banking) | 📋 |
| `accounting_pennylane` | Pennylane | 📋 |
| `accounting_tiime` | Tiime | 📋 |
| `expense_spendesk` | Spendesk (notes de frais) | 📋 |
| `expense_qonto` | Qonto (banque pro) | 📋 |
| `signature_docusign` | DocuSign | 📋 |
| `signature_yousign` | Yousign | 📋 |

## 👥 Paie / RH

| ID | Source | Statut |
|---|---|---|
| `hr_payfit` | PayFit | 📋 |
| `hr_lucca` | Lucca | 📋 |
| `hr_silae` | Silae | 📋 |
| `hr_factorial` | Factorial | 📋 |

## 🏛️ Sources publiques (juridique, BTP, …)

| ID | Source | Statut |
|---|---|---|
| `gov_legifrance` | Legifrance (juridique FR) | 📋 |
| `gov_bofip` | BOFIP (fiscalité FR) | 📋 |
| `gov_inpi` | INPI (entreprises, marques) | 📋 |
| `gov_urssaf` | URSSAF | 📋 |

Pré-chargés selon secteur du client (juridique → Legifrance + BOFIP, BTP → DTU + normes, etc.).

## 🎙️ Audio / Transcription

| ID | Use case | Statut |
|---|---|---|
| `audio_whisper_upload` | Transcription via faster-whisper sur upload | ✅ (via Open WebUI) |
| `audio_meeting_teams` | Récupération auto enregistrements Teams | 📋 |
| `audio_meeting_meet` | Récupération auto Google Meet | 📋 |

## 🤖 Templates Dify pré-chargés

Au-delà des connecteurs (qui poussent de la donnée vers la box), Dify propose des **agents pré-configurés** :

- `agent_qa_documents` — Q&R sur les docs internes (RAG)
- `agent_email_triage` — tri + suggestion réponse emails
- `agent_devis_generator` — génère un devis depuis brief client
- `agent_meeting_summarizer` — résumé + action items depuis transcription
- `agent_legal_assistant` — analyse contrats (secteur juridique)
- `agent_construction_helper` — assistant DTU/normes (secteur BTP)
- `agent_helpdesk_n1` — agent ticket niveau 1
- `agent_lead_scorer` — scoring leads commerciaux
- `agent_invoice_processor` — traitement factures fournisseurs

Chacun est packagé en JSON Dify importable (`templates/dify/<id>.json`).

## Convention pour ajouter un connecteur

Voir `services/connectors/README.md` (à venir avec l'implémentation de référence `rag-smb`).
