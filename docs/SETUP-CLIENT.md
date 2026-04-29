# Guide de configuration AI Box — pour le client final

> Ce document est livré au client après installation. À adapter au branding du client (ajouter logo + couleurs).

## ✅ Ce que vous avez reçu

- **1 boîtier AI Box** (ou 1 serveur préinstallé)
- **1 câble réseau** Ethernet
- **1 alimentation**
- **Identifiants administrateur** dans une enveloppe scellée séparée

## 🚀 Démarrage rapide (5 minutes)

### Étape 1 — Branchements

1. Branchez le câble réseau Ethernet sur votre switch / routeur
2. Branchez l'alimentation
3. Allumez l'appareil (bouton à l'arrière)
4. Patientez 2 minutes (la machine démarre et lance ses services)

### Étape 2 — Première connexion

Sur n'importe quel ordinateur de votre réseau :

1. Ouvrez votre navigateur web
2. Allez sur **`http://aibox.local`**
   - Si l'adresse ne fonctionne pas, demandez à votre administrateur réseau l'IP attribuée à la box, puis tapez `http://<IP-de-la-box>`

### Étape 3 — Wizard de configuration (uniquement la 1ère fois)

Si la box n'a pas encore été configurée, vous arriverez sur un assistant :

1. **Identité** : nom de votre entreprise, secteur, nombre d'utilisateurs prévus
2. **Compte administrateur** : créez vos identifiants (login + mot de passe robuste)
3. **Environnement IT** : indiquez vos outils (Microsoft 365, Google Workspace, Odoo, etc.)
4. **Récapitulatif** : vérifiez vos choix
5. **Déploiement** : ~3 minutes, suivez les logs

À la fin, vous accédez au **tableau de bord** avec vos identifiants.

## 🌐 Accès quotidien

Une fois la box configurée, vous accédez à votre IA via :

- **`https://chat.<votre-domaine>`** — Chat IA (interface principale, type ChatGPT)
- **`https://agents.<votre-domaine>`** — Construire des agents personnalisés
- **`https://flows.<votre-domaine>`** — Workflows automatisés
- **`https://auth.<votre-domaine>`** — Gestion des comptes utilisateurs (admin uniquement)

> En l'absence de domaine personnalisé : utilisez les sous-domaines `.aibox.local` sur votre LAN.

## 👥 Gérer les utilisateurs

1. Allez sur `https://auth.<votre-domaine>` et connectez-vous en admin
2. Menu **Directory > Users > Create**
3. Renseignez : nom, email, mot de passe initial
4. Affectez à un groupe (`employees`, `managers`, `admins`)
5. Communiquez les identifiants à l'utilisateur

> L'utilisateur peut changer son mot de passe à sa première connexion.

## 📚 Connecter ses documents (RAG)

Selon ce que vous avez coché au wizard, des **connecteurs** ont été activés :

- **Microsoft SharePoint / OneDrive** : indexation auto toutes les heures
- **Google Drive** : idem
- **NAS / partage SMB** : idem
- **Dossier local** : déposez les fichiers via Open WebUI (interface chat)

Pour ajouter une nouvelle source, contactez votre prestataire (procédure de configuration OAuth requise).

## 🛠️ Maintenance courante

| Action | Comment |
|---|---|
| Voir l'état des services | `https://status.<votre-domaine>` |
| Sauvegarder | Automatique via Duplicati (configurée par votre prestataire) |
| Redémarrer un service | `https://admin.<votre-domaine>` (admin uniquement) |
| Voir les logs | Idem |
| Mettre à jour | Notification automatique. Cliquez "Mettre à jour" — backup auto avant |

## 🆘 Problèmes courants

### "aibox.local" ne fonctionne pas
- Vérifiez que votre PC et la box sont sur le même réseau
- Essayez avec l'IP : votre routeur affiche les appareils connectés
- Sous Windows ancien : installez "Bonjour Print Services" (Apple)

### "Mon mot de passe ne marche plus"
- Tentez de le réinitialiser via `https://auth.<votre-domaine>` (lien "mot de passe oublié")
- Si ça échoue : contactez votre prestataire (un admin technique peut reset)

### "L'IA répond mal / invente des choses"
- Vérifiez les **sources affichées** sous chaque réponse (l'IA cite ses sources)
- Si elle n'a pas de source pertinente, **précisez votre question**
- Pour les questions sensibles : utilisez l'agent "factuel" (mode strict, pas de paraphrase)

### "C'est lent"
- Normal lors du **premier chargement** d'un modèle (30s)
- Les requêtes suivantes sont rapides
- Si plusieurs personnes posent simultanément des questions complexes, attendez quelques secondes

## 🔒 Bonnes pratiques sécurité

- ✅ Activez le **MFA** (TOTP via Google Authenticator) sur le compte admin
- ✅ Changez le mot de passe admin tous les 6 mois
- ✅ Ne partagez jamais d'identifiants — créez un compte par utilisateur
- ✅ Vérifiez les **logs de connexion** dans Authentik régulièrement
- ⚠️ N'exposez **JAMAIS** la box directement sur Internet sans accord de votre prestataire

## 📞 Support

| Niveau | Contact | Délai |
|---|---|---|
| Question d'usage | <support@votre-prestataire.fr> | 24h |
| Panne / box inaccessible | <hotline@votre-prestataire.fr> | 4h ouvrées |
| Sécurité (incident) | Numéro d'urgence dédié | Immédiat |

---

*Ce guide vous a été remis par votre prestataire AI Box. Conservez-le précieusement.*
