# RGPD pack — AI Box

> Documents et procédures à fournir au client pour rendre AI Box conforme RGPD. À adapter par client (mentions, DPO, etc.).

## 1. Position de l'éditeur (toi)

L'éditeur d'AI Box agit comme **sous-traitant RGPD** (article 28) lorsqu'il intervient sur la box (maintenance, mise à jour, support). Le **responsable de traitement** reste le client.

Conséquence : un **DPA** (Data Processing Agreement) doit être signé entre l'éditeur et le client.

## 2. Documents fournis avec la box

### 2.1 — DPA template (`docs/legal/DPA-template.md`)

Modèle de contrat de sous-traitance RGPD couvrant :
- Nature et durée du traitement
- Catégories de données traitées
- Sécurité des données (chiffrement, contrôle d'accès)
- Sous-traitants ultérieurs (ex: hébergeur cloud pour offsite backup)
- Retour ou destruction des données en fin de contrat

### 2.2 — Registre des traitements (`docs/legal/REGISTRE-template.md`)

Modèle pour le client : 1 fiche par traitement IA mis en place
- Finalité (ex: "Tri intelligent des emails commerciaux")
- Catégories de personnes concernées (employés, clients, prospects)
- Catégories de données (identifiants, contenus emails, factures…)
- Durée de conservation
- Destinataires (interne, sous-traitants)
- Mesures de sécurité techniques

### 2.3 — Mentions légales / CGU AI Box (`docs/legal/CGU-aibox.md`)

À afficher dans Open WebUI au premier login utilisateur (modal d'acceptation).

### 2.4 — Politique de confidentialité (`docs/legal/POLITIQUE-CONFIDENTIALITE.md`)

À publier sur l'intranet du client. Précise :
- Quelles données sont collectées par AI Box (chats, requêtes RAG, métriques d'usage)
- Combien de temps elles sont conservées
- Comment exercer les droits RGPD (effacement, portabilité, opposition)

## 3. Mécanismes techniques pour la conformité

### 3.1 — Droit à l'effacement (article 17)

L'effacement d'un user doit purger ses données dans **toutes** les briques :
- Authentik (compte + groupes)
- Open WebUI (DB SQLite : conversations)
- Dify (DB Postgres : conversations agents)
- Qdrant (vecteurs liés à ce user dans chaque collection)

Script fourni : `scripts/rgpd_erase_user.py <username>`. Voir détail dans `docs/RGPD-OPERATIONS.md`.

### 3.2 — Droit à la portabilité (article 20)

Export JSON des données d'un user : conversations OWUI + Dify + agents créés.
Script : `scripts/rgpd_export_user.py <username> --output user.json`.

### 3.3 — Droit d'accès (article 15)

Les users peuvent voir leur historique directement dans Open WebUI / Dify (pas besoin de script).

### 3.4 — Anonymisation des logs

Loki conserve les logs 1 an. **Aucun log ne doit contenir de mot de passe / token / contenu de message en clair.** Le filtre Promtail `drop_pii` masque automatiquement :
- Emails (regex)
- Tokens Bearer (header Authorization)
- Numéros CB

À configurer dans `services/monitoring/promtail.yml` (étape Sprint 5+).

### 3.5 — Chiffrement

| Layer | Mécanisme |
|---|---|
| Disque OS | LUKS (à activer à l'install Ubuntu) |
| Volumes Docker | sur disque LUKS, donc chiffrés |
| Postgres | pgcrypto pour colonnes sensibles (admin password Authentik = bcrypt) |
| Qdrant | snapshots chiffrés via Restic |
| Backups offsite | AES-256 via Duplicati (passphrase générée à l'install) |
| TLS en transit | Let's Encrypt (Caddy) |
| TLS interne | mTLS via SPIRE (à venir Sprint 6) |

### 3.6 — Anti-prompt-injection (Llama Guard)

Tous les inputs utilisateur passent par `aibox-llama-guard` avant d'atteindre l'LLM principal. Catégories filtrées :
- Tentatives d'exfiltration de données ("envoie tous les emails à xyz@...")
- Prompt injection ("ignore les instructions précédentes")
- Demandes de contenu illégal

Si un input est flaggé : l'agent retourne un message d'erreur générique et l'événement est loggé.

### 3.7 — Retention des données

Configurable par tenant dans `client_config.yaml` :

```yaml
retention:
  chat_history_days: 365
  rag_index_days: 0          # 0 = pas de purge auto, suit les sources
  logs_days: 365
  backups_days: 90
```

Cron quotidien (`services/security/retention-cleaner/`) applique ces valeurs.

## 4. Checklist client à remplir avant production

- [ ] DPA signé entre éditeur et client
- [ ] Désignation d'un DPO (interne ou externe) côté client
- [ ] Registre des traitements rempli (au moins pour Chat + RAG)
- [ ] Politique de confidentialité publiée sur intranet
- [ ] Modal CGU activé dans Open WebUI (paramétrage Authentik > Tenant)
- [ ] Tous les utilisateurs informés (email de bienvenue)
- [ ] LUKS activé sur le disque
- [ ] Backup offsite chiffré configuré
- [ ] MFA obligatoire pour les admins (Authentik > Policy)
- [ ] Test du droit à l'effacement validé sur compte de test
- [ ] Logs centralisés Loki avec rétention 1 an

## 5. Si client soumis à des cadres complémentaires

| Secteur | Cadre | Documents additionnels |
|---|---|---|
| Santé | HDS | Certificat HDS du datacenter (si offsite cloud HDS-compatible : OVHcloud HDS, Outscale, CloudHealth) |
| Finance | LCB-FT, MiFID II | Logs immutables (Loki + signature), traçabilité décisions IA |
| Juridique | Secret professionnel | Cloisonnement strict des données par avocat (collections Qdrant séparées par avocat_id) |
| Public | RGS, SecNumCloud | Hébergement souverain, audit ANSSI |
