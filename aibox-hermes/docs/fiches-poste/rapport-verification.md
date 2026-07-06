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

## Reste à faire (matin)
- Vérifier les **passages planifiés réels** (6h-17h UTC) de chaque agent contre sa fiche.
- **Nettoyer les tickets FRANLEAPPIND002 en double** (garder 1 ouvert, annuler les autres) — à valider avec André car certains peuvent être d'anciens tickets légitimes.
- **`systemctl daemon-reload`** (units modifiées — avertissement bénin).
- Désactiver le curator aussi dans `render_config.py` (pour les futurs agents/clients).
- Vérifier Comptabilité + Assistante dès qu'un mail de leur métier arrive.
- Outil dossiers **EWS** pour router xefi.
