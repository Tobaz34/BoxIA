---
name: aibox-email-triage
description: Triage intelligent de la boîte mail (TPE/PME FR) — repère les urgents, classe, résume, et prépare des brouillons de réponse. À utiliser quand l'utilisateur demande de faire le point sur ses mails, de trier sa boîte, de répondre à des relances/factures, ou un résumé matinal.
version: 0.1.0
trigger_phrases:
  - mes mails
  - ma boîte mail
  - trie mes emails
  - résume mes mails
  - quoi de neuf dans mes mails
  - réponds à ce mail
  - relances clients
mutating: true
---

# Skill : aibox-email-triage

Assistant de tri email (idée reprise du « Email Assistant » d'Odysseus, adaptée
TPE/PME FR). S'appuie sur les outils email de Hermes (IMAP/SMTP) + un scoring
d'urgence déterministe local.

## Garde-fou (important)
- **L'envoi d'un mail est une action mutative** → il PASSE par l'approval-gate
  (`/aibox-approve`). Ne JAMAIS envoyer sans validation. Produire des **brouillons**
  par défaut ; l'utilisateur valide avant envoi.

## Workflow de triage
1. **Récupérer** les mails récents non lus (outils email Hermes / IMAP).
2. **Scorer l'urgence** de chacun de façon déterministe :
   ```bash
   python ${AIBOX_HERMES_DIR}/skills/aibox-email-triage/urgency.py  # via un petit script
   ```
   ou appliquer la logique : signaux forts (mise en demeure, huissier, dernière
   relance, résiliation) = **haute** ; (urgent, relance, impayé, retard, échéance)
   = **moyenne** ; sinon **basse**. Un expéditeur VIP monte d'un cran.
3. **Classer / tagger** : 🔴 Haute · 🟠 Moyenne · ⚪ Basse, + catégorie
   (client, fournisseur, admin/URSSAF/impôts, interne, spam).
4. **Résumer** chaque mail important en 1-2 phrases (qui, quoi, action attendue, délai).
5. **Préparer un brouillon** de réponse pour les mails qui en demandent un,
   dans le ton habituel de l'utilisateur (poli, professionnel, concis, FR).

## Sortie type (résumé matinal)
```
📬 Tri de 14 mails (3 urgents)
🔴 Durand SARL — relance facture #2026-042 impayée (45 j). Brouillon prêt.
🔴 URSSAF — échéance cotisation le 15. Action : régler avant vendredi.
🟠 Fournisseur X — devis à valider. Brouillon prêt.
⚪ 11 autres (newsletters, accusés) — rien à faire.
```

## RGPD
Les contenus d'emails restent locaux (modèle local par défaut). Si un appel
cloud est nécessaire, le plugin `aibox-rgpd` caviarde la PII avant l'envoi.
