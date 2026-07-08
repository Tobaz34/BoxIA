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
   « Clôturé => … »). Note les **IDs des stages OUVERTS** (fold=false : New,
   In Progress, On Hold, Planifié).
2. Liste les tickets ouverts **avec un domaine par IDs de stage** (⚠️ NE PAS
   utiliser `stage_id.fold` : le domaine à champ pointé fait échouer l'XML-RPC).
   `odoo_search_read("helpdesk.ticket", [["stage_id","in",[<ids stages ouverts>]]],
   ["name","stage_id","user_id","team_id","priority","create_date","write_date","partner_id","ticket_ref"], 200, "priority desc, write_date asc")`.
   (limite : garde ≤ 200 ; si beaucoup de tickets, traite d'abord les prioritaires.)

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

## LIVRAISON (PRIORITAIRE - remplace tout format "Bilan Telegram" ci-dessus)

Tu livres en DEUX temps.

### 1) Mail recap HTML au patron (clair, colore, actionnable)
Compose un email **HTML** puis ENVOIE-le :
`create_draft_email(mailbox="a.ladurelle@clikinfo.fr", to="a.ladurelle@clikinfo.fr", subject=<court + compteur>, body=<HTML>, html=True)` -> recupere `draft_id`, puis `send_draft_email(mailbox="a.ladurelle@clikinfo.fr", draft_id=<id>)`.

**Regles du mail :**
- `html=True` obligatoire. Le body est du **HTML avec styles INLINE uniquement** (les clients mail ignorent le CSS externe).
- **Scannable en 5 secondes** : des blocs colores, une ligne = un item = une action en gras. Pas de paragraphes longs.
- **Omets les sections vides.** Mets le plus grave en haut.
- Chaque item : **<b>reference</b>** (n. ticket/opportunite/tache) + le fait marquant + **l'action en gras**.

**Gabarit a suivre** (adapte les titres au poste, garde les couleurs et le style inline) :
```html
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;color:#1f2937;font-size:14px">
  <div style="background:#0f766e;color:#ffffff;padding:14px 18px;border-radius:8px 8px 0 0">
    <div style="font-size:18px;font-weight:700">TITRE DU POINT — HEURE</div>
    <div style="font-size:13px;opacity:.92">Une phrase de synthese : ce qui compte aujourd'hui.</div>
  </div>
  <div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 8px 8px;padding:6px 0 12px">

    <div style="border-left:4px solid #dc2626;margin:12px;padding:8px 12px;background:#fef2f2;border-radius:4px">
      <div style="font-weight:700;color:#991b1b;margin-bottom:6px">🔴 A TRAITER EN PRIORITE</div>
      <div style="margin:5px 0"><b>#2756 FLASHBACK</b> (Guillaume) — SLA + client en attente 49j (rebond #2351) → <b>relancer aujourd'hui</b></div>
    </div>

    <div style="border-left:4px solid #ea580c;margin:12px;padding:8px 12px;background:#fff7ed;border-radius:4px">
      <div style="font-weight:700;color:#9a3412;margin-bottom:6px">🟠 A REPARTIR / A PLANIFIER</div>
      <div style="margin:5px 0"><b>#5266 MCC</b> — non assigne, SLA depasse → <b>affecter</b></div>
    </div>

    <div style="border-left:4px solid #2563eb;margin:12px;padding:8px 12px;background:#eff6ff;border-radius:4px">
      <div style="font-weight:700;color:#1e40af;margin-bottom:6px">📝 BROUILLONS PRETS (a valider dans Outlook)</div>
      <div style="margin:5px 0"><b>Devis / mail « objet »</b> → <b>relire et envoyer</b></div>
    </div>

    <div style="border-left:4px solid #16a34a;margin:12px;padding:8px 12px;background:#f0fdf4;border-radius:4px">
      <div style="font-weight:700;color:#166534;margin-bottom:6px">✅ DEJA FAIT PAR L'ASSISTANT</div>
      <div style="margin:5px 0">Contexte / rebond pose dans Odoo sur #.., #..</div>
    </div>

    <div style="margin:12px;padding:8px 12px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;font-size:13px;color:#4b5563">
      <b>👥 Lecture equipe :</b> qui accumule / qui surcharge / qui rebalancer (1-2 phrases).
    </div>
  </div>
</div>
```
Couleurs de reference : rouge `#dc2626` (urgent), orange `#ea580c` (a repartir), bleu `#2563eb` (brouillons/a valider), vert `#16a34a` (fait), gris `#6b7280` (info/equipe), bandeau `#0f766e`.

### 2) Reponse finale = UNE ligne courte (part sur Telegram)
Un ping type : « Point technique : 8 a traiter, 5 non assignes, 2 mecontents — detail + actions dans ton mail. » Rien d'autre : pas de detail, pas de liste.

Si rien a signaler : n'envoie pas de mail et reponds `[SILENT]`.
