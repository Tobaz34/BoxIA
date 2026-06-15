# PWA AI Box — accès mobile / web installable

Idée reprise d'**Odysseus** (app installable, responsive). Une petite PWA
statique qui parle à l'**API Hermes** — un canal employé **au-delà de Telegram**.

## Ce que c'est
- App de chat installable (mobile + desktop), responsive, offline-shell.
- Réglages : adresse de l'AI Box + clé d'accès (stockés en `localStorage`).
- Aucune dépendance, aucun build : 6 fichiers statiques.

## Servir
```bash
# n'importe quel serveur statique, derrière le reverse-proxy de l'AI Box
python -m http.server 8088 --directory aibox-hermes/pwa
# puis ouvrir http://<ip-aibox>:8088 et "Installer l'application"
```

## Câblage Hermes
`app.js` POST vers `${endpoint}/api/v1/chat` avec `{ "messages": [...] }` et
`Authorization: Bearer <clé>` — la forme exposée par le déploiement Hermes
(cf. `tools/hermes/README.md`). Le parsing de la réponse est **défensif**
(`choices[].message.content`, `response`, `content`, `message`, `text`).
👉 À confirmer/ajuster contre l'API réelle lors de la validation live (criterion #3).

## À finaliser pour une installabilité 100 %
- Ajouter des **icônes PNG** `icon-192.png` / `icon-512.png` (certains navigateurs
  exigent du PNG en plus du SVG fourni) et les déclarer dans `manifest.webmanifest`.
- Servir en **HTTPS** (obligatoire pour le service worker hors `localhost`).

## Statut
🚧 Shell fonctionnel et autonome. E2E (chat réel) à valider sur une instance
Hermes live — fait partie du QUICKSTART-POC.
