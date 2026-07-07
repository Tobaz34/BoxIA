# Rapport de vérification des agents — nuit du 2026-07-06 → 07

Méthode : pour chaque agent, exécution réelle + contrôle contre les KPI de sa
fiche de poste. Corrections appliquées à chaud. Les schedules étant en heures
ouvrées (8h-19h), la vérification des passages **planifiés** se fera le matin.

## Verdicts par agent

| Agent | Verdict | Détail |
|---|---|---|
| **Dispatcher** | ✅ | Route correctement (Technique/Commercial/Direction remplis, perso non touché, bruit en corbeille). Limite : dossiers EWS non gérés → skill ajusté (M365 uniquement pour l'instant). |
| **Technique** | ⚠️→✅ corrigé | Créait des **tickets dupliqués** (FRANLEAPPIND002 ×3) : re-traitait les mails lus + dédup ratait les alertes monitoring. **Corrigé** (idempotence non-lus + dédup par nom serveur). Idempotence re-testée OK. Brouillon AB METAL bien créé. **Reste : nettoyer les doublons existants** (~10 tickets FRANLEAPPIND002). |
| **Commercial** | ✅ | Passage ok, 2 actions auto-approuvées (opportunité/brouillon). Sur le mail DGF BTP. |
| **Direction** | ✅ | Passage ok, digest produit (2 actions). |
| **Comptabilité** | ⏸️ en attente | Dossier AI-Comptabilite vide (aucune facture reçue cette nuit) → non vérifiable en comportement. Structurellement prête (module factures prouvé sur Synology plus tôt). |
| **Assistante** | ⏸️ en attente | Dossier AI-Assistante vide → non vérifiable. Structurellement prête. |

## Problèmes trouvés + corrigés cette nuit
1. **Doublons de tickets** (Technique) → fix idempotence + dédup serveur. **Déployé.**
2. **Curator Hermes** réécrivait les skills partagés en douce (dérive git) → **désactivé sur les 8 instances** (les skills doivent rester gérés par git).
3. **Trou EWS** : `create_mail_folder` n'existe que sur M365 → dispatcher restreint au routage M365 (skill ajusté). **À faire : ajouter `create_mail_folder`/`move` EWS** pour router aussi la boîte xefi.

## Vérification des passages RÉELS du matin (07/07, ~07h UTC)

Après le 1er cycle planifié (agents 6h-17h UTC) :
- **Dispatcher** ✅ actif, ~20 actions de routage (déplace en masse vers AI-*).
- **Technique** ✅ **fix dédup confirmé** : 0 ticket créé ce matin. Les 3 nouveaux
  tickets `FRANLEAPPIND002` (01h08/03h08/05h08) sont créés **hors heures agents** →
  c'est un **monitoring/alias Odoo externe** qui crée un ticket ~toutes les 2h pour
  ce serveur chroniquement HS. **À corriger en amont** (supervision/alias), pas l'IA.
- **Commercial** ✅ status ok (traite AI-Commercial ; backlog qui se résorbe par passage).
- **Assistante** ⚠️→✅ : plantait sur `mark_email_read` (**400** — id Graph avec `/`,`+`
  non encodés → connecteur disjoncté). **Corrigé** : URL-encodage des id (msgraph). Re-testé.
- **Email andre / Direction** : ok (Direction tourne le soir).

## Incidents d'exploitation traités cette nuit/ce matin
- **Agents modifiaient les skills** (outil `skill_manage`) → dérive git à chaque
  passage. **Toolset `skills` désactivé sur les 8 instances** + curator désactivé
  durablement (`curator.enabled=false`). Les skills restent gérés par git.
- **Bug id Graph** (400 sur mark/move) → URL-encodage. Déployé.

## Contrôle santé complet (07/07 ~09h30) — 2 corrections
- ✅ 8/8 gateways actifs ; toutes les routines status=ok ; connecteurs odoo/msgraph/ews OK ; git propre (dérive stoppée).
- ✅ Fix Assistante confirmé : plus AUCUNE erreur mark_email_read après le correctif.
- ⚠️→✅ **Conflit routines** : l'ancienne routine andre `assistant-email` traitait les mêmes boîtes que dispatcher+agents → courses (mail déplacé → 404). **Mise en PAUSE** (superseded par le multi-agents). La revue-incidents-odoo d'andre reste active.
- ⚠️→✅ **Agents sans creds Odoo** : agent-provision ne sourçait que le .env, or les creds Odoo d'andre étaient dans son config.yaml (saisis via formulaire). Résultat : technique/commercial/compta/assistante/direction avaient ODOO_* vides → ne pouvaient PAS agir sur Odoo. **Corrigé** : creds injectés dans les 5 configs + ajoutés au .env andre (repro). find_partner OK depuis technique. → à ajouter dans agent-provision : sourcer aussi les creds bakés du config de référence.
- Recadrage : les « doublons » de la nuit venaient du monitoring amont, PAS de l'agent technique (qui ne pouvait pas créer, Odoo vide). Le dédup + Odoo fonctionnent maintenant.

## Reste à faire (matin)
- Vérifier les **passages planifiés réels** (6h-17h UTC) de chaque agent contre sa fiche.
- **Nettoyer les tickets FRANLEAPPIND002 en double** (garder 1 ouvert, annuler les autres) — à valider avec André car certains peuvent être d'anciens tickets légitimes.
- **`systemctl daemon-reload`** (units modifiées — avertissement bénin).
- Désactiver le curator aussi dans `render_config.py` (pour les futurs agents/clients).
- Vérifier Comptabilité + Assistante dès qu'un mail de leur métier arrive.
- Outil dossiers **EWS** pour router xefi.
