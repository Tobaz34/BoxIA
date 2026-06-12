# AI Box — Roadmap vers un produit utile au quotidien

> **Cible** : un boulanger / comptable / garage TPE allume son PC AI Box le matin et l'utilise vraiment — pas un POC, un outil de travail.

## Vision produit

**Le concierge IA de l'entreprise.** Le patron et ses employés parlent à leur AI Box via Telegram/WhatsApp/Email (en mobilité) ou via le web (au bureau). L'AI Box répond, consulte leur compta, leurs tickets, leurs factures, et déclenche des actions (créer une facture, envoyer un mail, planifier un rappel). Tout reste sur leur PC local — souveraineté, RGPD, vitesse.

## 📍 État actuel (2026-05-13)

| Domaine | État |
|---|---|
| **Install one-command** | ✅ Validé sur xefia (wipe → fresh → 33 containers up + Hermes healthy + login OAuth OK) |
| **Stack BoxIA** | ✅ Authentik / Dify (general + vision) / n8n / Postgres / Ollama GPU / Hermes / monitoring |
| **Modèle LLM** | ⚠️ qwen3:14b local sur GPU 12 Go → latence 30 s/réponse (split CPU/GPU car modèle 17 Go > VRAM) |
| **Connecteurs FR** | ⚠️ Microservices Python présents (Pennylane, Odoo, GLPI, FEC, 3CX) mais **non testés** + Hermes ne les appelle pas encore |
| **Telegram / WhatsApp** | ❌ Pas activé |
| **UX client** | ⚠️ Admin email = `@acme-sarl.local` (hardcoded bootstrap) — pas vraiment client-ready |
| **Doc** | ⚠️ USER-GUIDE.md commencé, pas de vidéo, pas d'onboarding |

**7 bugs P1 connus** côté pipeline install (cf. mémoire `hermes_deployment_2026-05-13.md`).

---

## 🎯 Roadmap par phases

> Chaque phase a un **critère de sortie** clair. On ne passe à la suivante que si le critère est atteint.

---

### **Phase 1 — Quotidien fonctionnel** *(1-2 semaines)*

**Objectif** : le client peut chatter et obtenir des réponses **rapides** et **pertinentes** sur ses documents.

**Critère de sortie** : l'admin TPE pose 10 questions métier à AI Box web, obtient des réponses < 5 s, dont ≥7 utiles. Si réponse < 5 s n'est pas tenable en local, mode cloud BYOK activable.

| Tâche | Priorité | Effort | Bloqueurs |
|---|---|---|---|
| **Latence solvée** : activer provider cloud (Anthropic Claude Haiku BYOK) côté Hermes ET Dify agents — fallback local | P0 | 1 j | Clé Anthropic (création gratuite + 5 € crédit) |
| **Migrations Dify retry** : run-pending.py qui retente avec backoff jusqu'à Dify ready | P0 | 0.5 j | — |
| **Admin email correct** : `/api/configure` propage admin_email du payload (pas du DOMAIN .env) | P0 | 0.5 j | — |
| **NEXTAUTH_URL auto** : détecter IP LAN ou utiliser hostname configurable | P0 | 0.5 j | — |
| **Authentik redirect URI** : ajouter automatiquement IP LAN au provision-sso | P0 | 0.5 j | — |
| **Test RAG** : upload 5 docs métier (PDF facture, devis, contrat), poser des questions dessus | P0 | 1 j | — |
| **Test agents Dify** : valider general / vision sur prompts réels | P0 | 0.5 j | — |
| **Password admin propre** : `/api/configure` propage admin_password du payload (pas DEFAULT) | P1 | 0.3 j | — |
| **Quick wins UI** : "logout" visible, breadcrumbs, fil d'Ariane | P1 | 0.5 j | — |
| **Reset password user** : flow self-service (oubli mdp via email) | P1 | 1 j | SMTP configuré |

**Total** : ~6-7 jours-homme. **Risque principal** : la latence locale 30 s reste un dealbreaker même après quant Q3, donc cloud LLM devient quasi obligatoire pour usage quotidien.

---

### **Phase 2 — Connecteurs métier opérationnels** *(2-3 semaines)*

**Objectif** : Hermes et les agents Dify peuvent **vraiment** appeler Pennylane/Odoo/GLPI/FEC/3CX et obtenir des résultats utilisables.

**Critère de sortie** : le client active Pennylane via le wizard, demande "liste mes factures impayées", obtient la liste. Pareil pour Odoo (clients), GLPI (tickets), FEC (import facture comptable). 5 connecteurs sur 5 fonctionnels en E2E.

| Tâche | Priorité | Effort |
|---|---|---|
| **Test Pennylane microservice** : up le container, fournir vraies credentials, valider `/v1/invoices` GET/POST | P0 | 1 j |
| **Hermes skill `aibox-tools` Python** : implémenter les call HTTP vers les microservices (httpx + Bearer) | P0 | 2 j |
| **Wizard connecteurs** : UI pour activer Pennylane via clé API (déjà dans aibox-app probable, à valider) | P0 | 1 j |
| **Approval gate Telegram** pour tools mutatifs (créer facture, envoyer email…) | P0 | 1.5 j |
| **Test Odoo** : même approche, valider partners + sale_orders + invoices | P1 | 1 j |
| **Test GLPI** : tickets list + create | P1 | 1 j |
| **Test FEC** : upload + parsing | P1 | 1 j |
| **Test 3CX** : appel sortant (optionnel, complexe SIP) | P2 | 2 j |
| **Audit centralisé** : Hermes loggue dans aibox-app `/api/audit` chaque tool mutatif (qui, quoi, quand, approval) | P1 | 1 j |
| **Templates Dify métier** : créer 3 agents pré-configurés (compta, support, commercial) qui utilisent les connecteurs | P1 | 1 j |

**Total** : ~12 jours-homme. **Risque principal** : les credentials Pennylane/Odoo réelles côté client demandent une coordination — pour tester, il faut une compta démo.

---

### **Phase 3 — Multi-canal mobilité** *(1-2 semaines)*

**Objectif** : le client interroge AI Box depuis Telegram/Email/WhatsApp comme s'il parlait à un collègue.

**Critère de sortie** : l'admin reçoit un message Telegram "Bonjour, quelles factures à relancer aujourd'hui ?", Hermes répond avec la liste (interroge Pennylane), tout en < 5 s.

| Tâche | Priorité | Effort |
|---|---|---|
| **Activer Telegram** : @BotFather + register-telegram-bot.sh + test 1 user | P0 | 0.5 j |
| **Multi-user Telegram** : aibox-app UI pour ajout/retrait employé Telegram (mapping chat_id ↔ user Authentik) | P0 | 1.5 j |
| **Hermes context multi-user** : un employé pose une question, Hermes connaît son rôle et adapte sa réponse | P0 | 1 j |
| **Email IMAP/SMTP** : Hermes lit les mails, peut répondre, peut envoyer | P1 | 2 j |
| **WhatsApp** : via wabridge ou Twilio Business — exige numéro WhatsApp Business approuvé (3-5 j d'admin) | P2 | 3 j (hors démarches WhatsApp) |
| **Notifications proactives** : Hermes prévient via Telegram quand X arrive (mail urgent, échéance facture) | P1 | 1.5 j |

**Total** : ~6-8 jours-homme. **Risque principal** : WhatsApp Business demande validation officielle Meta (3-5 jours-semaine), pas tenable pour pilote rapide.

---

### **Phase 4 — UX et confort** *(2-3 semaines)*

**Objectif** : le produit donne envie d'être utilisé — pas juste fonctionnel, plaisant.

**Critère de sortie** : un client TPE découvre AI Box en 5 min, sans assistance. NPS > 7 après 1 semaine.

| Tâche | Priorité | Effort |
|---|---|---|
| **Branding Hermes FR** : SOUL.md custom personnalité française, prompts système traduits, error messages localisés | P0 | 2 j |
| **Onboarding wizard** : 1er login → tour des features (chat, agents, marketplaces, connecteurs, settings) | P0 | 2 j |
| **Mot de passe choisi par user** : pas de password généré, l'admin TPE choisit le sien au 1er login | P0 | 0.5 j |
| **Mémoire conversation cross-channel** : conversation Telegram continue sur web et vice versa | P0 | 1.5 j |
| **PWA mobile** : aibox-app installable sur smartphone (offline mode + push) | P1 | 2 j |
| **Voice (Whisper + Piper TTS)** : message vocal Telegram → transcript + réponse vocale | P1 | 1 j (TTS déjà déployé) |
| **Auto-suggest prompts** : sidebar avec suggestions selon les connecteurs activés et historique | P1 | 1 j |
| **Mode dark/light** : toggle (déjà visible top right, à vérifier) | P2 | 0.3 j |
| **Branding entreprise** : logo + couleurs du client dans le UI (déjà supporté côté wizard ?) | P1 | 0.5 j |

**Total** : ~10-12 jours-homme. **Risque principal** : la PWA mobile est ambitieuse, peut-être différer P2 si pression temps.

---

### **Phase 5 — Ops et fiabilité** *(2 semaines + continu)*

**Objectif** : le produit **tient** dans le temps sans intervention humaine quotidienne.

**Critère de sortie** : 30 jours d'usage sans intervention manuelle. Backup quotidien réussi. Update à distance fonctionne. Si un container crash, il restart auto.

| Tâche | Priorité | Effort |
|---|---|---|
| **Backup automatique quotidien** : cron déclenche `aibox-host/backup.sh`, upload chiffré sur Backblaze B2 / OVH Object Storage | P0 | 1.5 j |
| **Self-update watcher** : déjà partiellement codé (`tools/update-watcher.sh`) — finaliser + tester | P0 | 1 j |
| **Monitoring alertes** : Grafana → email/SMS si CPU > 90%, RAM > 95%, container down > 5 min | P0 | 1 j |
| **Healthcheck deep** : Hermes / Ollama / aibox-app testés par cron toutes les 5 min, restart auto si KO | P1 | 1 j |
| **Logs centralisés** : Loki fonctionnel (le bug promtail/docker.sock à fixer si pas encore fait) | P1 | 0.5 j |
| **Audit RGPD** : retention 13 mois, export user data sur demande, droit à l'oubli | P1 | 2 j |
| **Documentation ops** : runbook pour le sysadmin client (ce qu'il fait s'il y a un souci) | P1 | 1 j |
| **TLS LAN** : cert auto-signé pour HTTPS local (sinon Chrome warne sur les mdp en clair) | P2 | 0.5 j |

**Total** : ~8 jours-homme. **Risque principal** : la backup chiffrée upload externe demande config OVH/B2 + clé chiffrement custodial → process commercial pas trivial.

---

### **Phase 6 — Reproductible pour la franchise** *(3-4 semaines)*

**Objectif** : un commercial peut déployer un PC AI Box chez un nouveau client en < 1 h, sans toi.

**Critère de sortie** : 3 clients déployés indépendamment par 3 commerciaux différents. Chacun reporting "ça marche" sans appel SAV technique.

| Tâche | Priorité | Effort |
|---|---|---|
| **USER-GUIDE.md → PDF** + vidéo tutoriel 5 min | P0 | 2 j |
| **Hardware kit** : choisir le PC standard (mini-PC GPU 16 Go VRAM idéal, processeur AMD Ryzen 7) — référence + commande groupée | P0 | hardware research |
| **Image disque pré-installée** : Ubuntu 24.04 + Docker + NVIDIA toolkit + Git → un commercial flash, branche, lance install | P0 | 2 j |
| **provision-new-client.sh** : 1 commande qui prend nom_entreprise + email_admin + génère tout (ou wizard web pré-rempli) | P0 | 1.5 j |
| **Onboarding commercial** : checklist 30 min (déballage → installation → 1er login → 1er chat) | P0 | 1 j |
| **Support N1 ticketing** : un GLPI ou similaire pour le SAV technique | P1 | 1 j |
| **Pricing tools** : calculateur ROI client (heures gagnées vs €/mois) | P1 | 1 j |
| **Contrat type** : NDA / RGPD / SLA léger | P1 | légal externalisé |

**Total** : ~10 jours-homme + recherche hardware + légal.

---

### **Phase 7 — Apprentissage continu** *(continu, sur 3-6 mois)*

**Objectif** : le produit **s'améliore** avec l'usage de chaque client. Les skills Hermes auto-générés deviennent utiles.

**Critère de sortie** : après 3 mois en prod, l'AI Box d'un client a 5+ skills custom auto-créés par Hermes, qui répondent à ses cas d'usage récurrents.

| Tâche | Priorité | Effort |
|---|---|---|
| **Analytics anonymisées** : quels prompts ? quelles réponses utiles (feedback +/-) ? — Langfuse déjà déployé | P0 | 1 j |
| **A/B testing prompts** : tester 2 variantes de system prompt sur l'Assistant général | P1 | 1 j |
| **Curator Hermes activé** : maintenance auto des skills (pinning, archive, dedupe) | P1 | 0.5 j |
| **Optim VRAM** : test qwen3:8b ou qwen2.5:14b-instruct quant Q3 — < 9 Go en VRAM, latence < 10 s en local | P1 | 1 j |
| **Federated learning ?** : avec accord client, partager des skills anonymisés entre AI Box (commune) — éthique à valider | P2 | 5 j |

**Total** : ~3 jours-homme initial + boucle continue.

---

## 📊 Synthèse temporelle

| Phase | Durée | Objectif | Critère de sortie |
|---|---|---|---|
| **P1** | 1-2 sem | Latence + RAG + agents Dify | 10 questions, 7 utiles, < 5 s |
| **P2** | 2-3 sem | Connecteurs métier réels | 5 connecteurs fonctionnels E2E |
| **P3** | 1-2 sem | Telegram + Email | Conversation mobile fluide |
| **P4** | 2-3 sem | UX française + onboarding | NPS > 7 après 1 sem |
| **P5** | 2 sem (+ continu) | Ops, backup, update | 30 j sans intervention |
| **P6** | 3-4 sem | Franchise pliable | 3 clients déployés indépendamment |
| **P7** | continu | Apprentissage | 5+ skills custom auto après 3 mois |

**Total réaliste pour un produit franchisable** : **~12-16 semaines** (3-4 mois) d'effort développeur dédié.

---

## ⚠️ Risques principaux

1. **Latence locale** : si on insiste sur 100 % local pour souveraineté, c'est lent. Compromis hybride cloud BYOK quasi obligatoire pour qualité service.
2. **GPU coût** : un PC avec GPU 16 Go VRAM (RTX 4060 Ti / 4070) coûte ~1500 €. Sur 3 ans = 40 €/mois ajouté au prix franchise.
3. **Connecteurs propriétaires** : Pennylane / Odoo / 3CX changent leur API. Maintenance des microservices = travail continu.
4. **WhatsApp Business** : validation Meta longue (3-10 jours-semaine). Telegram + Email à privilégier en MVP.
5. **Support N1** : sans process clair, le commercial devient le SAV → ça scale mal. Investir dans la doc et la self-réparation.
6. **Sécurité réseau LAN** : un PC client sans TLS sur LAN est OK tant qu'il reste en LAN. Si exposition WAN (télétravail) → mettre Cloudflare Tunnel + TLS.
7. **Conformité légale** : RGPD OK natif (100 % local), mais traitement automatisé de données pros = registre des traitements à documenter.

---

## 🎯 Recommandation : ordre d'attaque pragmatique

Si je devais arbitrer **maintenant** ce qui apporte le plus de valeur dans les **2 premières semaines** :

1. **Latence cloud hybride** (P1 — 1 j) → débloque l'usage quotidien immédiatement
2. **Test RAG documents** (P1 — 1 j) → prouve la valeur métier en 1 jour
3. **Activer Telegram + Hermes répond** (P3 partiel — 0.5 j) → wow factor, démonstratif pour le commercial
4. **Test Pennylane connecteur réel** (P2 — 1 j) → première vraie action métier (lister factures)
5. **Fix 7 bugs P1 install** (P1 — 2 j) → fresh install propre = condition pour passer à la franchise

**5 jours-homme** = MVP démontrable à un premier client TPE en pilote.

Tout le reste vient ensuite, dans l'ordre des phases.

---

## 📌 Pour reprendre

Cette roadmap vit dans `aibox-host/ROADMAP-PRODUIT.md`. À updater au fil des sprints.

Référer aussi :
- `aibox-host/USER-GUIDE.md` — guide client final actuel
- `aibox-host/README.md` — doc technique install
- `tools/hermes/ARCHITECTURE.md` — ADR architecture Hermes + BoxIA
- `memory/hermes_deployment_2026-05-13.md` — mémoire user de la session

Prochaine session : choisir 1 tâche P0 de P1 et l'attaquer.
