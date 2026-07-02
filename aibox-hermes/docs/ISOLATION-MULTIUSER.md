# Isolation multi-utilisateur AI Box — design & plan de migration

> Statut : **design validé, non implémenté** (2026-07-02). Réserve la partie « refactor Unix »
> à une session avec une **machine de test** (re-provisionne tous les employés → intestable
> sur la démo xefia sans risque). La Phase A ci-dessous est déployable sans refactor.

## 1. Problème & modèle de menace

Aujourd'hui, **tous les Hermes/webui de tous les employés tournent sous le même compte Unix
`clikinfo`** (`aibox-webui@.service` → `User=clikinfo`), sur des ports loopback prévisibles
(9130, 9131, …), et partagent un `roles.json` inscriptible par ce compte.

Conséquences (vérifiées en review 2026-07-02) — un employé « client » malveillant, **ou une
simple injection de prompt** dans un email/document lu par son agent, peut :

| # | Vecteur | Cause racine |
|---|---------|--------------|
| V1 | **Lire les secrets d'un autre employé** (`.env` : clés API, tokens Telegram) et son `HERMES_HOME` (mémoire, historique, credentials) | Tous les fichiers sont `clikinfo:clikinfo` → tout process `clikinfo` les lit, malgré `chmod 600` |
| V2 | **S'auto-promouvoir admin** : écrire directement `$AIBOX_ROOT/roles.json` (owned clikinfo) via un tool fichier/shell de son agent | `roles.json` inscriptible par le compte qui exécute tous les agents |
| V3 | **Parler au webui d'un autre** : `curl 127.0.0.1:9131/...` (le port de marc depuis l'agent d'andre) | Le loopback TCP est joignable par tout process local, quel que soit le user |
| V4 | **Élévation via l'API** : `POST 127.0.0.1:9130/api/plugins/aibox-rights/set {role:admin}` (9130 = port de l'admin) | `aibox-rights` déduit l'identité du `HERMES_HOME` du **process serveur**, pas de l'appelant |

> **Vérifié live (xefia, 2026-07-02) :**
> - **V4 déjà mitigé** ✅ — `/api/plugins/aibox-rights/{me,users}` renvoient **401 sans token**
>   (gating par `HERMES_DASHBOARD_SESSION_TOKEN` en place). L'élévation par l'API est donc bloquée
>   pour qui n'a pas le token de session de l'admin. La Phase A (§4.1) est **largement acquise** pour ces routes.
> - **V3 confirmé et sérieux** ⚠️ — depuis le loopback, `curl http://127.0.0.1:9131/` (webui de marc
>   depuis le compte d'andre) répond **200 sans aucune auth** : Authentik ne protège qu'au niveau
>   **Caddy**, pas le bind direct `127.0.0.1:<port>`. Un employé dont l'agent exécute du code local
>   peut donc piloter le Hermes d'un collègue. **C'est le vecteur qui justifie le refactor Unix + sockets (§4.2).**

Les correctifs du 2026-07-02 (fail-closed, `roles.json` atomique, `/set` admin-only) **durcissent
la logique applicative** mais ne changent PAS le fait que la barrière est logicielle, pas noyau.

## 2. Ce que l'isolation Unix résout — et ce qu'elle ne résout PAS

Un compte Unix par employé (`User=aibox-<user>`) avec fichiers en mode `700/600` :

- ✅ **Ferme V1** : les `.env`/`HERMES_HOME` d'un employé deviennent illisibles par les autres (permissions noyau, pas juste applicatives).
- ✅ **Ferme V2** *si* `roles.json` n'est plus inscriptible par les comptes employés (owned `root`/compte admin dédié, mode `644`).
- ❌ **NE ferme PAS V3** : le loopback TCP `127.0.0.1:<port>` reste joignable par n'importe quel process local, quel que soit son user. Il faut **en plus** un des mécanismes §4.2.
- ❌ **NE ferme PAS V4 à elle seule** : tant que `/api/plugins/*` et `/api/ws` ne vérifient pas un secret propre à l'appelant, un voisin qui atteint le port (V3) contourne. Il faut **l'auth HTTP** (§4.1).

**Conclusion : l'isolation Unix est nécessaire mais insuffisante.** La cible sûre = isolation Unix
(V1/V2) **+** auth HTTP sur les routes sensibles (V4) **+** cloisonnement du loopback (V3).

## 3. Architecture cible

Un **compte système par employé** : `aibox-<user>` (ex. `aibox-andre`), sans shell de login
(`/usr/sbin/nologin`), pas dans le groupe `docker`, home = l'arbre du tenant de l'employé.

```
/opt/aibox/
  roles.json                     root:aibox-admins 0644   # lisible par tous, écrivable par personne d'autre que le service admin
  companies/<co>/
    company.env                  root:aibox-<co> 0640     # secrets entreprise, lisible par les employés de la boîte uniquement
    users/<user>/hermes/         aibox-<user>:aibox-<user> 0700
      .env                       aibox-<user>:aibox-<user> 0600
```

- `aibox-webui@andre.service` → `User=aibox-andre`, `Group=aibox-andre`.
- Les secrets entreprise partagés (`company.env`) : groupe `aibox-<co>` dont chaque employé de la
  boîte est membre → héritage OK, cloisonnement inter-entreprises.
- `roles.json` : écriture réservée à un **service admin privilégié** (§4.3), lecture pour tous.

## 4. Défense en profondeur — les 3 briques

### 4.1 Auth HTTP réelle sur les routes sensibles (ferme V4) — **Phase A, faible risque**
- `/api/plugins/aibox-rights/{users,set}` et `/api/ws` doivent exiger un **secret propre à
  l'appelant** (le `HERMES_DASHBOARD_SESSION_TOKEN` par-user, déjà servi via `/aibox-chat/session`).
  → Vérifier que hermes-webui **gate déjà** ces routes (à confirmer empiriquement : `curl` sans
  token doit renvoyer 401). Si oui, V4 est en grande partie couvert **sans refactor Unix**.
- Le token doit être **par-user et secret** (déjà le cas : `chat-tokens/<u>.json` servi par Caddy
  avec rewrite forcé sur `<X-Authentik-Username>.json`). Ne jamais accepter l'identité déduite du
  `HERMES_HOME` du process comme preuve d'autorité (c'est la faille V4).

### 4.2 Cloisonner le loopback (ferme V3) — **Phase B**
Deux options, par ordre de préférence :
1. **Sockets Unix par-user** au lieu de TCP loopback : `aibox-webui@` écoute sur
   `/run/aibox/<user>.sock` (mode `0600`, owned `aibox-<user>`), Caddy `reverse_proxy unix//run/aibox/<user>.sock`.
   → un employé ne peut atteindre que sa propre socket (permission noyau). **Le plus propre.**
   Nécessite que hermes-webui supporte le bind sur socket Unix (à vérifier ; sinon rester TCP + option 2).
2. **Pare-feu loopback owner-match** (si TCP conservé) :
   `iptables -A OUTPUT -o lo -p tcp --dport 9130:9199 -m owner ! --uid-owner aibox-<user> -j DROP`
   par port/user. Fonctionne mais lourd à maintenir (une règle par employé).

### 4.3 `roles.json` non inscriptible par les employés (ferme V2) — **Phase B**
Le backend `aibox-rights` tourne sous `aibox-<user>` → il ne peut plus écrire un `roles.json`
protégé. Options :
1. **Petit service admin** (`aibox-roles.service`, `User=aibox-admin`) exposant une socket Unix
   `0660 root:aibox-admins` ; `aibox-rights` (admin authentifié via §4.1) y POST le changement de
   rôle ; le service valide et écrit atomiquement. Seul ce service écrit `roles.json`.
2. **Alternative légère** : `roles.json` owned `aibox-admin:aibox-admins 0644`, et l'écriture via
   un helper `sudo` NOPASSWD très restreint (`aibox-set-role <user> <role>`) appelé uniquement par
   le backend quand l'appelant est prouvé admin (§4.1). Moins élégant, plus rapide à livrer.

## 5. Changements par fichier (refactor Unix, Phases B/C)

| Fichier | Changement |
|---------|-----------|
| `provision/aibox-webui@.service` | `User=aibox-%i`, `Group=aibox-%i` ; chemins dérivés de l'EnvironmentFile (déjà amorcé) ; option socket Unix (§4.2.1) |
| `provision/aibox-dash@.service` | idem |
| `provision/wizard-user.sh` | créer le compte `aibox-<user>` (`useradd -r -s /usr/sbin/nologin`), `chown -R aibox-<user>` le HERMES_HOME, ajouter au groupe `aibox-<co>`, `.env` en `aibox-<user>:… 0600` |
| `provision/wizard-company.sh` | créer le groupe `aibox-<co>`, `company.env` en `root:aibox-<co> 0640` |
| `provision/setup-portal.sh` | générer le `map` Caddy vers les sockets/ports ; ne plus `chown clikinfo` les HERMES_HOME |
| `provision/install.sh` | créer `aibox-admin` + groupe `aibox-admins` ; installer `aibox-roles.service` (§4.3.1) |
| `plugins/aibox-rights/dashboard/plugin_api.py` | l'écriture passe par le service/​helper admin ; **ne jamais** déduire l'autorité du `HERMES_HOME` du process |

## 6. Plan de migration réversible

**Phasage recommandé — livrer le plus rentable/le moins risqué d'abord :**

- **Phase A — auth HTTP (§4.1)** — *faible risque, déployable sur xefia.*
  Confirmer/durcir le gating par token des routes `/api/plugins/*` et `/api/ws`. Ferme V4 (le vecteur
  le plus dangereux car déclenchable par prompt injection) **sans toucher aux comptes Unix**. Test :
  `curl` sans token → 401 ; avec token d'un autre user → 403.
- **Phase B — isolation Unix + roles.json privilégié (§3, §4.2, §4.3)** — *risque élevé, machine de test requise.*
  Migration par employé, idempotente et réversible :
  1. Backup : `git -C ~/BoxIA tag backup-avant-isolation-<ts>` + `tar` des HERMES_HOME.
  2. Créer comptes/groupes, `chown` les arbres, basculer `User=` des units, `daemon-reload`, restart.
  3. Rollback : restaurer `User=clikinfo` dans les units + `chown -R clikinfo` + restart (les données ne bougent pas).
  Valider sur une VM Ubuntu vierge via un vrai wipe+install AVANT xefia.
- **Phase C — sockets Unix (§4.2.1)** — *optionnel, après validation que hermes-webui les supporte.*

## 7. Recommandation

1. **Phase A d'abord** : c'est 80 % du bénéfice sécurité (ferme le vecteur exploitable à distance
   par injection de prompt) pour ~10 % du risque. À faire dès qu'on peut vérifier le gating des routes.
2. **Phase B** seulement avec une machine de test : le refactor Unix protège les secrets au repos
   (V1) mais re-provisionne tous les employés — jamais en aveugle sur la démo.
3. Documenter dans `INSTALL-VPS.md` que, tant que la Phase B n'est pas faite, **la box est
   mono-entreprise de confiance** (les employés d'une même boîte ne sont pas fortement isolés entre
   eux au niveau OS) — acceptable pour une TPE/PME où les employés se font déjà confiance, à
   clarifier commercialement pour un usage multi-entreprises sur une même machine.

Voir aussi la note résiduelle en tête de `plugins/aibox-rights/dashboard/plugin_api.py`.
