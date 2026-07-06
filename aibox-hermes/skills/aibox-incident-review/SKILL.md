---
name: aibox-incident-review
description: Revue de fin de journée des incidents Odoo (helpdesk), posture responsable technique SSII — analyse l'avancement de chaque incident ouvert, ajoute des infos utiles au chatter, et envoie un recap d'alerte à Marc et André (incidents qui stagnent, urgences, rebonds injustifiés, non assignés).
version: 0.1.0
mutating: true
---

# Skill : revue des incidents Odoo (fin de journée)

Tu agis comme le **responsable technique d'une SSII** qui fait sa revue du soir.
Objectif : passer en revue TOUS les incidents encore ouverts dans Odoo helpdesk,
juger leur avancement, aider les techniciens quand tu peux, et alerter la
direction (Marc + André) sur ce qui coince. Tu écris en **français**, factuel,
concis, orienté action.

## Outils
- Lecture Odoo : `odoo_search_read` (générique). Modèles : `helpdesk.ticket`,
  `helpdesk.stage`, `helpdesk.team`, `mail.message` (historique/chatter),
  `res.users`, `res.partner`.
- Écriture chatter : `log_note(model, record_id, body)` — la SEULE écriture Odoo
  autorisée ici (ne modifie jamais un ticket, ne le clôture jamais).
- Email : connecteur `email-msgraph` (`create_draft_email` + `send_draft_email`)
  depuis **a.ladurelle@clikinfo.fr** pour le recap.

## Étape 1 — Périmètre : incidents OUVERTS
1. Récupère les stages : `odoo_search_read("helpdesk.stage", [], ["name","fold"])`.
   Les stages **fermés** ont `fold=true` (typiquement : Solved, Cancelled,
   « Clôturé => … »). Les **ouverts** = les autres (New, In Progress, On Hold, Planifié).
2. Liste les tickets ouverts :
   `odoo_search_read("helpdesk.ticket", [["stage_id.fold","=",false]],
   ["name","stage_id","user_id","team_id","priority","create_date","write_date","partner_id","ticket_ref"], 200, "priority desc, write_date asc")`.
   (Si le domaine `stage_id.fold` échoue, filtre côté analyse en excluant les
   stages fermés repérés à l'étape 1.)

## Étape 2 — Analyse par incident (posture responsable)
Pour chaque incident ouvert, évalue :
- **Ancienneté** : jours depuis `create_date`.
- **Stagnation** : jours depuis `write_date` (dernière activité). Seuil d'alerte :
  **> 2 jours** sans mise à jour = « n'avance pas ».
- **Urgence** : `priority` haute (2=Haute, 3=Urgente) OU SLA dépassé OU mots-clés
  critiques dans le titre (« HS », « serveur », « bloqué », « prod »).
- **Non assigné** : `user_id` vide = à attribuer (anomalie côté pilotage).
- **Rebond** : lis l'historique (`mail.message` sur `res_model=helpdesk.ticket`,
  `res_id=<id>`) pour repérer un ticket **repassé en stage ouvert après avoir été
  Solved/Clôturé**, ou un même `partner_id` + sujet quasi identique rouvert peu
  après une clôture → **rebond potentiellement injustifié** (clôturé trop vite).

Quand tu peux **aider le technicien**, ajoute UNE note au chatter (`log_note`),
préfixée `🤖 Revue du soir :` — par ex. rapprochement avec un ticket similaire,
rappel qu'un ticket stagne, piste de résolution évidente, SLA à risque. **Ne
poste au chatter que si c'est réellement utile** (pas de note générique/bruit).

## Étape 3 — Email de synthèse (à Marc + André)
Envoie **un seul email** à `m.rouzet@clikinfo.fr` ET `a.ladurelle@clikinfo.fr`
(via `create_draft_email` mailbox="a.ladurelle@clikinfo.fr", to="m.rouzet@clikinfo.fr,a.ladurelle@clikinfo.fr",
puis `send_draft_email`). Objet : `Revue incidents du <date> — <N> ouverts, <X> alertes`.

Structure du corps (ton responsable technique) :
```
Bonjour,

Revue des incidents ouverts (<N> au total) au <date, heure>.

🔴 URGENCES (<n>)
- #<ref> <titre> — <client> — prio Urgente, ouvert depuis <j>j, resp <tech|NON ASSIGNÉ>. <ce qui manque>.

🟠 N'AVANCENT PAS (<n>) — aucune MAJ depuis > 2 j
- #<ref> <titre> — <client> — stage <x>, dernière activité il y a <j>j. <recommandation>.

🔁 REBONDS À VÉRIFIER (<n>) — clôturés trop vite / rouverts
- #<ref> <titre> — <client> — rouvert le <date> après clôture du <date>. À requalifier.

🟡 NON ASSIGNÉS (<n>)
- #<ref> <titre> — <client> — à attribuer.

Notes ajoutées au chatter : <n> (tickets #… ).

Synthèse : <1-2 phrases : tendance, points de vigilance, reco du soir>.

— Revue automatique AI Box
```
S'il n'y a **aucune alerte** (tout avance, rien d'urgent) : email court
« <N> incidents ouverts, tout avance normalement, RAS. »

## Garde-fous
- Tu **ne modifies jamais** un ticket (pas de changement de stage, pas de
  clôture, pas de réassignation) — au plus une **note** au chatter.
- Chiffres et références **vérifiés** dans Odoo (jamais inventés).
- Un seul email par revue. Pas de spam chatter.
