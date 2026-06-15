# AI Box (Hermes-first)

> **Le produit AI Box, reconstruit sur une base saine.** Le moteur conversationnel n'est plus du code maison : c'est **Hermes Agent** (Nous Research, MIT), intact et mis à jour automatiquement. Notre valeur — connecteurs métier français, RGPD, multi-utilisateur, branding — se greffe **par-dessus, sans forker le cœur**.

## Pourquoi cette réécriture

L'ancienne stack BoxIA (`services/app` Next.js + Dify + n8n + Authentik + ~58 000 LOC) était à ~80 % de la plomberie d'agent off-the-shelf qu'on maintenait à la main. La douleur n'était pas notre métier — c'était **la colle** entre 33 conteneurs et 3 bases Postgres.

Hermes fournit nativement ce qu'on rebâtissait : boucle agent, tool-calling, mémoire persistante, multi-canal (Telegram/WhatsApp/Discord/Slack/Signal), MCP, hooks de sécurité, multi-session par utilisateur, fallback cloud/local. **On garde notre moat, on jette la colle.**

Décision actée le **2026-06-14** (cf. [ARCHITECTURE.md](ARCHITECTURE.md)). Remplace l'approche de `../aibox-host/` et `../tools/hermes/` (prior-art absorbé ici).

## Le principe : zéro fork

Tout notre produit se construit sur les **points d'extension** de Hermes, déclarés en config :

| Notre besoin | Mécanisme Hermes | Fork ? |
|---|---|---|
| Connecteurs FR (Pennylane, Odoo, GLPI, FEC…) | `mcp_servers:` (shim MCP → FastAPI existant) | ❌ |
| Approval-gate (anti prompt-injection) | hook `pre_tool_call` | ❌ |
| RGPD / scrub PII français | hook `pre_api_request` | ❌ |
| IA locale + fallback cloud | `model:` provider `custom` (Ollama) + `hermes fallback` | ❌ |
| Multi-employé / entreprise | `group_sessions_per_user` + pairing Telegram | ❌ |
| Branding « AI Box » | `display.skin` + `SOUL.md` | ❌ |
| Skills métier FR | `skills.external_dirs` | ❌ |

→ Le cœur Hermes reste **vierge et updatable** ; on hérite gratuitement de ses améliorations.

## Structure du dossier

```
aibox-hermes/
├── README.md            # ce fichier
├── ARCHITECTURE.md      # design détaillé + flux runtime
├── PORT-MAP.md          # chaque asset BoxIA → son mécanisme Hermes
├── BUILD-BOARD.md       # plan d'exécution par phases (source de vérité avancement)
├── install.sh           # ⭐ installeur one-command VPS
├── INSTALL-VPS.md       # guide d'installation VPS (Ubuntu, Telegram, HTTPS)
├── config/
│   └── config.template.yaml   # template de ~/.hermes/config.yaml (rempli au provisioning)
├── plugins/             # sécurité : aibox-approval, aibox-rgpd, aibox-audit
├── mcp-connectors/      # connecteurs FR en serveurs MCP (pennylane)
├── skills/              # skills FR : aibox-cookbook, aibox-email-triage, aibox-deep-research
├── cookbook/            # reco modèle local selon le hardware (idée Odysseus)
├── pwa/                 # app mobile installable vers l'API Hermes (idée Odysseus)
├── provision/           # wizards : wizard-company.sh + wizard-user.sh (1 Hermes/user)
└── tests/               # 32 tests unitaires
```

## État

🚧 **En construction.** Voir [BUILD-BOARD.md](BUILD-BOARD.md) pour l'avancement réel. Rien n'est encore déployé ; l'ancienne stack BoxIA reste la référence le temps du portage du moat.
