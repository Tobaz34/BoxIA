# Pitch deck — AI Box

> Markdown des slides (1 slide = 1 section H2). À transformer en PPTX/Keynote/Slidev.

## 1. AI Box — l'IA souveraine, chez vous

> **Une "ChatGPT privée" pour TPE/PME, déployée sur un serveur local. Aucune donnée ne quitte vos murs. Conforme RGPD nativement.**

---

## 2. Le problème — l'IA actuelle, c'est compliqué

- 💸 **OpenAI / Microsoft Copilot** : 20-30 €/mois/user, vos données partent aux US
- 🔓 **Outils gratuits (ChatGPT Free)** : vos employés y collent vos contrats sans contrôle
- 🤷 **Solutions DIY** : trop technique pour une PME sans équipe IT
- 📜 **RGPD** : transferts hors-UE = casse-tête juridique
- 🚀 **Vitesse de la lumière côté techno** : tu sais pas par où commencer

**Résultat** : 80% des PME françaises **n'ont pas encore intégré l'IA en production**.

---

## 3. La solution — AI Box, plug-and-play

```
[Box physique] → [Branche réseau] → [aibox.local]
                                         ↓
                              Wizard 5 minutes
                                         ↓
                  Chat IA + RAG + Workflows + Agents
```

- **Tout est local** : ton serveur, tes modèles, tes données
- **Setup en 5 min** : un wizard graphique, pas une ligne de commande
- **Multi-utilisateurs** : SSO unique pour tous tes outils
- **Pré-câblé sur ton stack** : M365, Google, Odoo, Sage… → l'IA voit tes docs sans config supplémentaire

---

## 4. Ce qui tourne dedans

| Brique | Rôle |
|---|---|
| **Open WebUI** | Chat type ChatGPT, multi-users |
| **Dify** | Constructeur d'agents no-code (le client crée ses propres assistants) |
| **n8n** | Automatisations (tri emails, génération devis, …) |
| **Authentik** | SSO unique, intégré Entra ID / Google / AD |
| **Qdrant** | Index vectoriel des documents |
| **Ollama** | Moteur LLM (Qwen 2.5, Mistral, Llama 3) — **local, jamais externe** |

100 % open source. **Pas de dépendance cloud obligatoire.**

---

## 5. Démo — 3 cas d'usage concrets

### Cas 1 — Comptable
> *"Quels fournisseurs ont augmenté leurs prix de plus de 10 % cette année ?"*
→ L'IA lit Sage + factures PDF du NAS + répond en 3 secondes avec sources citées.

### Cas 2 — Commercial
> *"Génère-moi un devis Excel pour Acme SARL, prestation X, 5 jours, basé sur mes derniers devis similaires."*
→ Workflow n8n : analyse historique CRM → template → PDF prêt à envoyer.

### Cas 3 — Direction
> *"Résume-moi les emails non lus de la semaine, par priorité."*
→ Connecteur Outlook + agent Dify : digest 5 lignes / 3 minutes.

---

## 6. Pricing — 3 formules

| | **TPE** | **PME** | **PME+** |
|---|---|---|---|
| Utilisateurs | 1-5 | 5-20 | 20-100 |
| Hardware | RTX 4070 12 Go | RTX 4090 24 Go | 2× RTX 6000 Ada |
| **Setup (one-shot)** | 4 500 € HT | 9 000 € HT | 18 000 € HT |
| **Maintenance / mois** | 290 € | 590 € | 1 290 € |

Inclus : install + onboarding 1j + maj automatiques + backup chiffré + support 8/5 SLA 4h.

**ROI** : amorti en 14 mois vs Microsoft Copilot pour une équipe de 15 (≈ 7 200 €/an économisés).

---

## 7. Pourquoi MAINTENANT

- 🇫🇷 **Souveraineté** = sujet n°1 des CA français en 2026
- 📜 **AI Act européen** entre en vigueur — les PME ne peuvent plus utiliser ChatGPT en mode "yolo"
- ⚡ **Modèles open source ont rattrapé GPT-4** (Llama 3.3 70B, Qwen 2.5 72B)
- 💰 **GPU consumer suffisamment puissants** : RTX 4090 fait tourner du 14B en pleine vitesse
- 🌍 **Marché peu adressé** : pas d'acteur français dominant sur ce segment

---

## 8. Objections — réponses préparées

| "Mais je peux utiliser ChatGPT Team à 25€/user/mois…" | Oui mais : (1) données aux US, (2) pas de RAG sur tes docs, (3) à 20 users tu paies 6000 €/an, j'amortis en 1 an |
| "C'est compliqué à installer ?" | Wizard 5 minutes. Démo live possible. |
| "Et si l'IA hallucine ?" | Chaque réponse cite ses sources, mode "strict" disponible, garde-fous Llama Guard |
| "Et la maintenance ?" | Maj automatiques + backup auto + support inclus |
| "Et si la box plante ?" | Backup quotidien chiffré + RPO 24h. SLA 4h pour intervention. |
| "RGPD ?" | Données 100 % chez vous, registre traitements fourni, DPA signé |

---

## 9. Roadmap pilote — phase d'amorçage

**3 clients pilotes recherchés** (sept-oct 2026)

- 🎁 **-50 % sur le setup** en échange de feedback détaillé
- ✍️ **Étude de cas** publiée (avec accord)
- 🏆 **Conditions tarifaires figées** sur 3 ans

Profil idéal :
- TPE/PME 10-50 utilisateurs
- Stack M365 ou Google Workspace
- Cas d'usage clair identifié (RAG sur docs / tri emails / génération doc)
- Décideur accessible

---

## 10. Q&R — Contact

> *On déploie chez vous la semaine prochaine ?*

📧 contact@aibox.fr
📱 +33 6 XX XX XX XX
💼 LinkedIn : /in/...

**Démo live** disponible sur demande (45 min, en visio ou sur place).

---

## Annexe — slides additionnelles selon le public

- Slide *Sécurité technique* (LUKS, Authentik MFA, Crowdsec) → si DSI
- Slide *Architecture détaillée* → si CTO
- Slide *Témoignages clients* → après les 3 premiers pilotes
- Slide *Comparaison concurrence* (Mistral La Plateforme, Cohere, OpenAI Enterprise) → si questions
