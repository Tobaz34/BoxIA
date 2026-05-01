# BoxIA — Guide de démarrage rapide

> Document à destination de l'**administrateur du client** qui reçoit
> sa BoxIA. Pour la procédure de reset / re-déploiement,
> voir `PRODUCT-READY.md`.

## 1. Première connexion (dès la box reçue)

### 1.1 Branchement physique

1. Branche le serveur sur le réseau du bureau (câble Ethernet)
2. Allume le serveur — la BoxIA démarre toute seule
3. Trouve l'adresse IP du serveur :
   - **Si tu as un écran branché** : l'IP s'affiche au démarrage
   - **Sinon** : connecte-toi à ton routeur (interface admin) pour
     trouver l'appareil nommé `boxia` ou similaire

### 1.2 Première connexion via navigateur

Ouvre **Chrome / Firefox / Edge** sur ton poste de travail. Va à :
```
http://<IP-DU-SERVEUR>:3100
```

Exemple : `http://192.168.1.42:3100`

> **Astuce mDNS** : si ton OS supporte Bonjour (Mac, Windows 10/11
> récent), tu peux aussi utiliser `http://aibox.local:3100`.

Identifiants par défaut :
- **Email** : `admin@aibox.local`
- **Mot de passe** : `aibox-changeme2026`

⚠️ **Change le mot de passe immédiatement** depuis « Mes paramètres »
(badge en haut). La bannière jaune disparaîtra automatiquement après
le changement.

## 2. Visite guidée de la BoxIA

| Section | Description | Pour quoi faire ? |
|---------|-------------|-------------------|
| **Discuter** | Chat avec les assistants IA | Pose ta question en français : compta, RH, juridique, BTP, etc. |
| **Mes assistants** | Liste des assistants IA disponibles | Active de nouveaux assistants depuis la marketplace |
| **Automatisations** | Workflows n8n actifs | Automatiser des tâches récurrentes (relances factures, healthcheck…) |
| **Documents** | Documents indexés (RAG) | Charger un PDF / DOCX que les assistants pourront citer |
| **Connecteurs** | Sources de données externes | Brancher Outlook, Drive, Pennylane, Odoo, NAS, etc. |
| **Marketplace IA** | 🇫🇷 6 templates BoxIA-FR + Dify Explorer | Installer un assistant spécialisé (compta TVA, droit travail, etc.) |
| **Marketplace n8n** | 9 workflows officiels + 39 communauté n8n.io | Ajouter un workflow d'automatisation |
| **Intégrations MCP** | 15 serveurs MCP (filesystem, GitHub, Postgres, etc.) | Étendre les capacités des assistants |
| **Audit** | Journal de toutes les actions admin | Suivre qui a fait quoi |
| **État serveur** | Healthcheck + métriques | Vérifier que tout fonctionne |
| **Paramètres** | Langue, branding, version, instructions personnalisées | Personnaliser l'expérience |

## 3. Cas d'usage typiques

### 3.1 Activer un assistant comptable français en 30 sec

1. Va dans **Marketplace IA**
2. Onglet **🇫🇷 BoxIA-FR**
3. Clique « Activer » sur **Assistant TVA & comptabilité FR**
4. L'assistant apparaît automatiquement dans **Mes assistants** et
   dans le sélecteur en haut de **Discuter**

### 3.2 Brancher ton SharePoint

1. Va dans **Connecteurs**
2. Clique « Activer » sur **SharePoint Online**
3. Saisis tes credentials Microsoft 365 (tenant ID, client ID,
   client secret — fournis par ton DSI)
4. La synchronisation s'active automatiquement (toutes les heures)
5. Pose une question dans **Discuter** → l'assistant Q&R citera tes
   documents SharePoint avec leurs URLs

### 3.3 Automatiser tes relances de factures impayées

1. Va dans **Marketplace n8n** → onglet « ⭐ Officiels BoxIA »
2. Clique « Installer » sur **Relance email factures impayées**
3. Va dans **Automatisations** → workflow installé désactivé
4. Configure les credentials SMTP dans n8n (clic « Ouvrir n8n » →
   auto-login)
5. Active le workflow → tous les lundis matin, les relances partent
   automatiquement

### 3.4 Demander à l'IA de faire le boulot pour toi

> **🚧 V0 — disponible après attachement manuel du Custom Tool**

1. Va dans **Discuter** → sélectionne **Concierge BoxIA** dans le
   sélecteur en haut
2. Tape en langage naturel :
   > « Tu peux automatiser ma comptabilité ? »
   > « Connecte mon NAS pour indexer les documents partagés »
   > « Ajoute le workflow de relances factures »
3. Le concierge te liste les options, te demande confirmation, puis
   exécute (ou te donne un lien direct pour saisir tes credentials).

## 4. Permissions par utilisateur (RBAC)

3 rôles disponibles :
- **Admin** : accès complet
- **Manager** : accès complet sauf paramètres système
- **Employé** : accès chat + documents seulement

Pour ajouter un user : **Utilisateurs** → « Inviter » → renseigne
email + rôle. Le user reçoit un lien d'inscription.

Pour restreindre l'accès à un connecteur (ex : Pennylane visible
seulement par les comptables) :
1. **Connecteurs** → clic sur l'icône **🛡️ Permissions** d'un
   connecteur actif
2. Décoche les rôles non autorisés (Admin reste toujours coché)
3. Optionnellement, whitelist par email (bouton « Whitelist par email »)
4. **Enregistrer**

## 5. Que fait la BoxIA quand tu n'es pas là ?

- Un workflow **Healthcheck stack** vérifie toutes les 5 min que tous
  les services sont up (envoie un email à l'admin si problème).
- Un workflow **Snapshot Qdrant hebdomadaire** sauvegarde la base de
  connaissances tous les dimanches à 2h.
- Tous les connecteurs activés synchronisent en arrière-plan
  (fréquence configurable par connecteur).

## 6. Dépannage rapide

| Symptôme | Cause probable | Solution |
|----------|----------------|----------|
| Pas de réponse de l'IA | Ollama down | Va dans **État serveur** → si Ollama est down, contacte le support |
| « Mot de passe par défaut détecté » persistant | Tu n'as pas encore changé le mdp dans Authentik | Clique « Changer maintenant » → suis les étapes |
| Connecteur en erreur | Credentials expirés (token Microsoft, mdp NAS, etc.) | **Connecteurs** → clic sur ⚙️ Reconfigurer |
| Workflow n8n en échec | Credentials externes (SMTP, Pennylane) à mettre à jour | **Automatisations** → clic sur ⤴️ Ouvrir dans n8n → onglet Credentials |

## 7. Support technique

- **Email support** : (à définir par l'intégrateur)
- **Audit log** : `/audit` permet de partager au support la liste des
  actions récentes pour diagnostic
- **Version courante** : visible sur **Paramètres** → carte « Version
  & mises à jour » (à donner au support en cas de bug)

## 8. Sécurité

- Toutes les données restent **sur ton serveur** (pas de cloud externe)
- Les credentials des connecteurs sont chiffrés au repos
- Le journal d'audit trace toutes les actions admin
- Le RBAC permet de cloisonner par rôle / utilisateur

## 9. Pour aller plus loin

- **Marketplace IA / BoxIA-FR** : 6 templates métier français
  (compta, RH, juridique, BTP, e-commerce, helpdesk)
- **Marketplace n8n communauté** : 39 workflows populaires de
  n8n.io (top par vues), à explorer
- **Marketplace MCP** : 15 serveurs MCP curés (filesystem, GitHub,
  Postgres, Slack…) pour étendre les capacités IA
- **Multi-langue** : sélecteur FR/EN dans **Paramètres** → carte
  « Langue de l'interface »
