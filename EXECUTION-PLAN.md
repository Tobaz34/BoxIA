# Plan d'exécution — Du POC au produit shippable

> Hypothèse : **1 dev plein temps**, ~6h focus/jour effectives. Estimations en **jours-dev**.
> Total : ~50-60 jours de travail effectif (≈ **10-12 semaines**) pour atteindre la version 1.0 vendable.
>
> Chaque sprint produit un jalon commercial clair : « après ça, je peux signer un client X ».

---

## 🟢 Sprint 0 — Boucler le MVP (5-7 jours) → JALON : signature pilote 1

Objectif : que le wizard embarqué fonctionne **de bout en bout sur une VM vierge** + premier client identifié + pitch préparé.

| # | Tâche | J | Blocker / dépendance |
|---|---|---|---|
| 0.1 | Implémenter endpoint backend FastAPI `/api/clients/{id}/deploy` (vrai SSH push via Paramiko + run install.sh distant) | 2 | — |
| 0.2 | Implémenter WebSocket `/api/clients/{id}/logs` (stream via SSH `tail -f /srv/ai-stack/deploy.log`) | 1 | 0.1 |
| 0.3 | Auth admin portail externe : un seul mdp + WebAuthn | 1 | — |
| 0.4 | Créer une VM Ubuntu 24.04 vierge (Proxmox / VirtualBox) et tester install.sh **end-to-end** | 1 | — |
| 0.5 | Activer Caddy en prod : stopper NPM, basculer ports 80/443, vérifier Let's Encrypt avec un domaine public test | 0.5 | Domaine public + DNS |
| 0.6 | Créer outpost Authentik + activer forward_auth Caddy pour Portainer/Qdrant | 0.5 | — |
| 0.7 | Premier login Authentik documenté + screenshots dans `docs/SETUP-CLIENT.md` | 0.5 | — |
| 0.8 | Pitch deck 10 slides (problème, solution, démo, prix, objections) | 1 | — |
| 0.9 | Identifier 3-5 prospects pilotes (réseau perso, LinkedIn) | en parallèle | — |

**Sortie de sprint 0** : démo complète "tu branches une box vierge, 5 minutes plus tard tu as un chat IA + RAG fonctionnels" → utilisable en RDV commercial.

---

## 🟢 Sprint 1 — Connecteurs critiques M365 (10 jours) → JALON : 1er client M365 signable

Le marché PME français est ~70 % en Microsoft 365. Ce sprint couvre cette majorité.

| # | Tâche | J |
|---|---|---|
| 1.1 | **Connecteur `rag-msgraph`** : OAuth2 client_credentials, delta queries, sync + propagation ACL → Qdrant | 4 |
| 1.2 | **Connecteur `email-msgraph`** : récupération mails + classification IA + suggestion de réponse | 3 |
| 1.3 | **Authentik source Azure AD** : tester `provision.py AZURE_AD` sur un tenant dev M365 | 1 |
| 1.4 | **Template Dify** : "Q&R sur procédures internes" (avec sources affichées) | 0.5 |
| 1.5 | **Template Dify** : "Assistant tri emails" (lit via connecteur, propose réponse) | 1 |
| 1.6 | Intégration au dispatcher : tester end-to-end depuis le wizard avec un compte M365 dev | 0.5 |

**Bloquant** : il faut un **tenant Microsoft 365 dev** (gratuit via Microsoft 365 Developer Program). 1h pour le créer.

**Sortie de sprint 1** : un client M365 peut, après le wizard, voir l'IA répondre à des questions sur ses propres docs SharePoint, et trier ses emails. **Tu peux signer.**

---

## 🟢 Sprint 2 — Connecteurs Google + ERP (7-10 jours) → JALON : 80% du marché PME

| # | Tâche | J |
|---|---|---|
| 2.1 | **Connecteur `rag-gdrive`** : service account Google + Drive API + sync delta | 2 |
| 2.2 | **Connecteur `email-gmail`** : Gmail API + tri/résumé | 2 |
| 2.3 | **Authentik source Google Workspace** : tester `provision.py GOOGLE` | 0.5 |
| 2.4 | **Connecteur `email-imap`** : générique (OVH, Ionos, Gandi) — utile pour TPE sans M365/Google | 2 |
| 2.5 | **Connecteur `erp-odoo`** : tool Dify + 2 templates n8n (génération devis depuis brief, relance impayés) | 3 |

**Sortie de sprint 2** : couverture des trois cas dominants (M365, Google, IMAP générique) + 1er ERP intégré (Odoo, populaire chez TPE/PME tech).

---

## 🟡 Sprint 3 — Productisation & branding (7-10 jours) → JALON : produit packageable

Passer de "stack qui marche" à "produit vendable comme une box".

| # | Tâche | J |
|---|---|---|
| 3.1 | **Branding** : variables `CLIENT_LOGO_URL`, `CLIENT_PRIMARY_COLOR` injectées dans le wizard, OWUI, Dify, Authentik | 2 |
| 3.2 | **Image disque maître** : créer un script Packer (ou doc Clonezilla) qui produit une image bootable AI Box prête | 2 |
| 3.3 | **Tier de pricing** dans le wizard (TPE / PME / PME+) → désactive certains connecteurs en TPE | 1 |
| 3.4 | **Backup offsite préconfiguré** : Duplicati avec destination Wasabi/B2 templated, clé chiffrement par client | 1 |
| 3.5 | **Métriques d'usage** : Prometheus + Grafana dashboard (requêtes/jour, GPU usage, espace docs) | 2 |
| 3.6 | **Doc client end-user** : "Comment utiliser mon AI Box" (markdown → PDF) | 2 |
| 3.7 | **Doc admin client** : "Restart, voir logs, ajouter un user" | 1 |

**Sortie de sprint 3** : tu sors une box clonable avec un tournevis, brandable au logo client, doc fournie. **C'est un produit, plus un POC.**

---

## 🟡 Sprint 4 — Connecteurs secondaires (10-12 jours)

Pour aller plus loin selon les besoins des prospects qualifiés.

| # | Tâche | J |
|---|---|---|
| 4.1 | `rag-nextcloud` (auto-héberg fréquent en juridique/médical) | 2 |
| 4.2 | `rag-confluence` + `rag-notion` (tech-savvy clients) | 3 |
| 4.3 | `text2sql-postgres` + `text2sql-mysql` (avec garde-fous read-only) | 3 |
| 4.4 | `helpdesk-glpi` (très répandu en France) | 2 |
| 4.5 | `telephony-3cx` (transcription Whisper + résumé) | 2 |

**Sortie de sprint 4** : on peut adresser des secteurs spécifiques (juridique, BTP, IT services).

---

## 🟡 Sprint 5 — Sécurité & conformité (5-7 jours) → JALON : prospects santé/légal

Indispensable avant de prospecter santé, juridique, finance.

| # | Tâche | J |
|---|---|---|
| 5.1 | **Hardening OS** : LUKS, AppArmor profiles, CrowdSec, désactivation services inutiles | 1 |
| 5.2 | **Anti-prompt-injection** : Llama Guard 3 en filtre devant chaque agent Dify | 1 |
| 5.3 | **Logs centralisés** : Loki + Grafana + retention 1 an + signature immuable | 2 |
| 5.4 | **RGPD pack** : mentions légales, registre traitements, DPA, droit à l'effacement testé (vrai delete dans Qdrant + Postgres + MinIO) | 2 |
| 5.5 | **Pentest interne** : nikto, ZAP, Trivy sur les images | 1 |

**Sortie de sprint 5** : tu peux honnêtement répondre "oui" à toutes les questions RGPD/sécurité d'un DPO.

---

## 🔵 Sprint 6 — Mises à jour OTA & multi-client (8-10 jours)

Quand tu as 3-5 clients, gérer le parc devient le sujet.

| # | Tâche | J |
|---|---|---|
| 6.1 | **Repo Git privé** héberge le code AI Box. Chaque box pull une release tag → update auto | 2 |
| 6.2 | Endpoint portail externe `/api/clients/{id}/update` qui SSH push + tail logs | 2 |
| 6.3 | **Dashboard multi-clients** dans le portail Next.js : état de chaque box, version, dernière maj, alertes | 3 |
| 6.4 | **Canary releases** : push une maj sur 1 client de test avant tous | 1 |
| 6.5 | **Rollback** : `./update.sh rollback <version>` qui restaure le backup de la veille | 1 |

**Sortie de sprint 6** : tu maintiens 10+ clients sans y passer la moitié du temps.

---

## 🔵 Sprint 7 — Connecteurs sectoriels (durée variable, à la demande)

À ajouter au catalogue selon les premiers clients signés. Estimations indicatives :

- Sage (50, 100, X3) : 3-5 jours
- Salesforce / HubSpot : 2-3 jours chacun
- DocuSign / Yousign / Universign : 2 jours chacun
- Microsoft Teams (transcription réunions) : 3 jours
- Slack : 2 jours
- Pennylane / Tiime (compta) : 2 jours chacun
- Bridge / Powens (open banking) : 3 jours
- Legifrance / BOFIP (juridique) : 1 jour chacun

Total selon besoins : **2-6 semaines de plus**.

---

## 🔴 Tâches en parallèle (toujours actives)

Ces choses tournent en arrière-plan pendant les sprints :

- **Prospection** : 3-5 RDV/semaine dès le sprint 1
- **Recueil feedback** : chaque pilote = 1h de feedback/semaine intégré dans le backlog
- **Veille techno** : nouveaux modèles Ollama, mises à jour Dify/Authentik (~2h/semaine)
- **Réponse aux issues** : à mesure que des clients signent

---

## 📊 Synthèse — Calendrier optimal

```
Semaine  1     2     3     4     5     6     7     8     9    10    11    12
─────────────────────────────────────────────────────────────────────────────
Sprint 0 ━━━━━
Sprint 1       ━━━━━━━━━━━
Sprint 2                   ━━━━━━━━━
Sprint 3                             ━━━━━━━━━
Sprint 4                                       ━━━━━━━━━━
Sprint 5                                                 ━━━━━
Sprint 6                                                       ━━━━━━━━━
Prospection ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                ↑                       ↑                        ↑
            1er pilote signé    1er déploiement réel   3-5 clients vendus
```

## 🎯 Jalons commerciaux clairs

| Après sprint | Tu peux dire à un prospect… |
|---|---|
| 0 | "J'ai un produit fonctionnel, accepte-tu d'être pilote pour 50% du prix ?" |
| 1 | "Tu es en M365 ? Mon IA répond à tes questions sur tes docs SharePoint en 5 minutes." |
| 2 | "Quelle que soit ta stack (M365, Google, IMAP), ça marche." |
| 3 | "Tu peux la mettre à tes couleurs et la déployer toi-même si tu veux." |
| 4 | "J'ai aussi des clients dans ton secteur, voici les workflows déjà packagés." |
| 5 | "Mon produit est compatible RGPD et SecNum-friendly, voici la doc." |

## 💡 Stratégie d'arbitrage

Si tu manques de temps :
- **Tu peux skipper Sprint 4 et Sprint 6** au début. Avec sprints 0-3 + 5, tu as déjà un produit signé.
- **Sprint 7 = uniquement à la demande** (un nouveau client veut un connecteur, tu factures son intégration).
- **Sprint 5 sécurité** : dépriotise si tu ne vises pas santé/juridique au début (mais à faire avant le 5e client).

## ⚠️ Risques majeurs identifiés

1. **Tester sans client réel** : tu peux passer 2 semaines à peaufiner sans recevoir de feedback. → forcer 1 RDV/semaine dès la semaine 1.
2. **Sous-estimer l'OAuth M365 / Google** : leur App Registration + admin consent peut prendre 2-3 jours à un nouveau client. → préparer un guide pas-à-pas avec captures d'écran.
3. **GPU 12 GB pas suffisant** : sur une PME 30-50 users, les latences vont décevoir. → upgrader vers RTX 4090 24 GB pour ton labo dès Sprint 1, sinon tu vends un produit qui rame.
4. **Hallucinations** : le 1er user qui voit l'IA inventer une réponse perd confiance définitivement. → toujours afficher les sources et `temperature=0.1` par défaut sur les agents factuels.
5. **Burn-out solo** : 12 semaines non-stop = quasi 3 mois sans pause. → 1 demi-journée off par semaine, et un buffer de 20% sur chaque estimation.

## 🚀 Démarrage immédiat

**Demain matin** (j'ai préparé tout le contexte) :

1. Créer une VM Ubuntu 24.04 (Proxmox ou VirtualBox), 16 GB RAM, GPU passthrough
2. Push du repo `D:\IA_TPE_PME_POWER\` vers un repo Git privé (GitHub, GitLab, Codeberg)
3. Cloner le repo dans la VM, lancer `install-firstrun.sh`
4. Tester le wizard complet `aibox.local` → vérifier que tout est bien green
5. Documenter chaque blocage rencontré dans `docs/INSTALL-NOTES.md`

Tâche n°1 du Sprint 0 (`endpoint deploy backend`) commence le lendemain.
