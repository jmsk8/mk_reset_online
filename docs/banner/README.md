# Documentation du banner SMK

La course affichée en tête de la page d'accueil : une seule course tourne, sur le
serveur, et tous les navigateurs la regardent.

## Références — l'état actuel

| Document | Ce qu'il répond |
|---|---|
| [architecture.md](architecture.md) | Qu'est-ce qui tourne où, quel fichier fait quoi, comment travailler dessus |
| [protocole.md](protocole.md) | Que s'échangent le service et le navigateur, et pourquoi |
| [equilibrage.md](equilibrage.md) | Comment régler les statistiques des pilotes, et avec quel banc |
| [alertes.md](alertes.md) | Ce qu'un kart **entend** sans l'avoir vu — étoile/bill, rouge, bleue — et ce qu'il en fait |
| [../../tracks/README.md](../../tracks/README.md) | Comment dessiner un circuit |

## Audits — comment l'IA décide

Deux états des lieux du **moteur JS**, schémas à l'appui. Ils décrivent le fonctionnement
*et* ses défauts ; ils ne sont pas des plans, et rien n'y a été codé.

| Document | Sujet |
|---|---|
| [audit-decision-direction-2026-09-17.md](audit-decision-direction-2026-09-17.md) | Comment un kart décide **où se placer** : attention → perception → plan → volant |
| [audit-decision-objets-2026-09-17.md](audit-decision-objets-2026-09-17.md) | Comment un kart décide **quoi faire de son objet** : tirage → plan → changement d'avis |

✅ **Le banc est réparé** (2026-09-18) : `tools/scenario.js` lisait `cfg.ai.crossDodgeMargin`, une
clé qui n'existe plus, et la table des temps de manœuvre rendait `NaN`. Elle a migré vers
`vision.place.margin.item` (cf. D-1 et D-2). **O-1 est corrigé également** — `shieldHold` ne se
propage plus à l'objet suivant.

✅ **Le banc a tourné** (2026-09-21) : `tools/scenario.js` sort une table de temps de manœuvre
chiffrée, sans `NaN`. `tools/simulate.js` et le nouveau `tools/alerts.js` tournent aussi. Sans
`node` installé, l'Electron de VS Code en tient lieu :
`ELECTRON_RUN_AS_NODE=1 /app/extra/vscode/code tools/alerts.js` (installation Flatpak).

## Chantiers — en cours de construction

| Document | Sujet |
|---|---|
| [moteur-cpp-plan.md](moteur-cpp-plan.md) | La conception : reprendre la simulation en C++ derrière le même protocole, front inchangé, moteur JS conservé en référence |
| [moteur-cpp-avancement.md](moteur-cpp-avancement.md) | Ce qui tourne (M0-M5), les écarts assumés, et ce qui reste vide |
| [moteur-rust-plan.md](moteur-rust-plan.md) | La conception : un troisième moteur en Rust, mêmes règles que le C++, même protocole, front inchangé — rien n'est codé |

Le moteur C++ vit dans `raceEngineCpp/` et se choisit avec `make engine-cpp` /
`make engine-js`. Le JS reste le défaut et la référence.

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
├── src/engine/           le moteur — 20 modules ES, graphe acyclique
├── src/config/           les réglages, en 7 fragments par domaine
├── src/protocol.js       le contrat serveur ↔ client
├── src/track.js          la lecture des circuits dessinés
├── src/server.js         boucle 30 Hz, diffusion 10 Hz, WebSocket
└── tools/                cinq observateurs : ils lisent, ils n'écrivent pas

frontEnd/static/js/banner/   le rendu — 22 scripts chargés dans l'ordre
frontEnd/static/css/banner.css   la feuille de style, en un fichier
tracks/                      les circuits, dessinés en Markdown
```
