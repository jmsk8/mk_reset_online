# Documentation du banner SMK

La course affichée en tête de la page d'accueil : une seule course tourne, sur le
serveur, et tous les navigateurs la regardent.

## Références — l'état actuel

| Document | Ce qu'il répond |
|---|---|
| [architecture.md](architecture.md) | Qu'est-ce qui tourne où, quel fichier fait quoi, comment travailler dessus |
| [protocole.md](protocole.md) | Que s'échangent le service et le navigateur, et pourquoi |
| [equilibrage.md](equilibrage.md) | Comment régler les statistiques des pilotes, et avec quel banc |
| [../../tracks/README.md](../../tracks/README.md) | Comment dessiner un circuit |

## Archives — des décisions passées

Ces documents décrivent un état du code qui n'existe plus. Ils sont gardés parce
qu'ils expliquent **pourquoi** les choses sont comme elles sont, pas parce qu'ils
décrivent ce qui tourne. Les chemins de fichiers et numéros de ligne qu'ils
citent sont ceux de leur date de rédaction.

| Document | Sujet |
|---|---|
| [migration-wss-2026-08.md](migration-wss-2026-08.md) | Le passage d'une simulation dans le navigateur à un serveur autoritatif (août 2026) |
| [audit-pilotage-2026-08.md](audit-pilotage-2026-08.md) | Revue intégrale de la chaîne de pilotage latéral (août 2026) |

## Le code

```
raceEngine/               le service : simulation, protocole, circuits
├── src/engine/           le moteur — 19 modules ES, graphe acyclique
├── src/config/           les réglages, en 7 fragments par domaine
├── src/protocol.js       le contrat serveur ↔ client
├── src/track.js          la lecture des circuits dessinés
├── src/server.js         boucle 30 Hz, diffusion 10 Hz, WebSocket
└── tools/                quatre observateurs : ils lisent, ils n'écrivent pas

frontEnd/static/js/banner/   le rendu — 22 scripts chargés dans l'ordre
frontEnd/static/css/banner.css   la feuille de style, en un fichier
tracks/                      les circuits, dessinés en Markdown
```
