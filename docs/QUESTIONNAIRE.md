# Questionnaire de qualification IA TPE/PME

> Source : `Questionnaire_qualification_IA_TPE_PME.xlsx`  
> Structure programmable : `config/questionnaire.yaml`

## Vue d'ensemble

Le questionnaire couvre **11 chapitres / 56 éléments**, dont **48 enrichissables par notre IA (87 %)**. C'est l'**outil commercial** qu'on utilise en RDV avec le prospect pour cadrer son installation.

Chaque réponse client active des **connecteurs**, **templates n8n** ou **agents Dify** pré-configurés sur le serveur AI Box du client.

| # | Chapitre | Éléments | Dont IA |
|---|---|---|---|
| 1 | Infrastructure matérielle | 8 | 6 (75 %) |
| 2 | Connectivité | 4 | 3 (75 %) |
| 3 | Logiciels & applications | 5 | 5 (100 %) |
| 4 | Cloud | 4 | 3 (75 %) |
| 5 | Cybersécurité | 8 | 7 (88 %) |
| 6 | Données & conformité | 5 | 5 (100 %) |
| 7 | Présence en ligne & marketing | 5 | 4 (80 %) |
| 8 | Mobilité & télétravail | 4 | 3 (75 %) |
| 9 | Services & exploitation | 5 | 5 (100 %) |
| 10 | Innovation & transformation | 4 | 4 (100 %) |
| 11 | Gouvernance & humain | 4 | 3 (75 %) |
| **Total** | | **56** | **48 (86 %)** |

## Comment c'est utilisé dans le produit

### Phase 1 — `install.sh` (POC actuel)

L'installeur CLI ne pose qu'une dizaine de questions clés (les "drivers" qui activent vraiment des connecteurs : Office, Messagerie, ERP, GED, BI, IAM, IA générative actuelle). Les autres éléments sont stockés à `unknown` dans `client_config.yaml`.

### Phase 2 — Portail web (à développer)

Un wizard graphique posera les 56 questions de manière fluide, chapitre par chapitre, avec :
- Indicateur de progression (X/56)
- Pastille verte sur les briques enrichissables IA + description de l'apport
- Champ "précision" libre pour chaque ligne
- Génération automatique du `client_config.yaml`
- Export PDF de la fiche de qualification (livrable client)

### Phase 3 — Activation automatique

Selon les réponses, le portail :
1. Génère le `.env` du serveur cible
2. Active les bons connecteurs (n8n, Dify, RAG)
3. Pré-charge des templates métier adaptés
4. Configure Authentik avec la source d'identité du client (AD / Entra / Google)
5. Pousse le tout via SSH sur le serveur du client

## Lien entre réponse et activation (extrait)

| Réponse client | Activations automatiques |
|---|---|
| **Stockage : OneDrive/SharePoint** | Connecteur RAG MS Graph |
| **Stockage : NAS Synology/QNAP/SMB** | Connecteur RAG SMB/CIFS |
| **Stockage : Google Drive** | Connecteur RAG Google Drive |
| **Office : Microsoft 365** | Connecteur M365 (Outlook, Teams, SharePoint) |
| **Office : Google Workspace** | Connecteur Google Workspace |
| **Messagerie : Exchange Online** | Agent tri emails MS Graph |
| **Messagerie : Gmail Workspace** | Agent tri emails Gmail API |
| **Messagerie : IMAP (OVH/Ionos)** | Agent tri emails IMAP générique |
| **ERP : Odoo (online/self-hosted)** | Workflows Odoo n8n (devis, factures, leads) |
| **ERP : Salesforce** | Workflows Salesforce n8n |
| **ERP : Sage** | Workflows Sage n8n |
| **MFA/SSO : Entra ID** | Source Authentik Azure AD |
| **MFA/SSO : Google Workspace** | Source Authentik Google |
| **BI : Power BI** | Agent Power BI (NL→DAX) |
| **BI : Metabase** | Agent Metabase (NL→SQL) |
| **Téléphonie : 3CX/Wildix/Ringover** | Workflow transcription appels Whisper |
| **Helpdesk : Support interne** | Template agent IA niveau 1 |

(Liste complète dans `config/questionnaire.yaml` sous le champ `activates:`.)
