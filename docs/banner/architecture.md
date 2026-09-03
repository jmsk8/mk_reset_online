# Architecture du banner SMK

La course affichée en tête de la page d'accueil. Une seule course tourne, sur le
serveur ; tous les navigateurs la regardent.

Ce document décrit **ce qui tourne aujourd'hui**. Le journal de la migration qui
y a mené est archivé dans [migration-wss-2026-08.md](migration-wss-2026-08.md) —
il raconte des décisions passées, pas l'état actuel.

---

## 1. La règle qui gouverne tout

> **Le client n'a aucune simulation. Le serveur n'a aucun rendu.**

Il n'existe qu'une implémentation du jeu, et elle est dans `raceEngine/`. Le
navigateur reçoit des positions et les affiche. Cette séparation n'est pas un
principe abstrait : elle est vérifiable, et elle se vérifie en une ligne.

```sh
grep -r "physics\|stepPhysics" frontEnd/static/js/    # doit ne rien trouver
```

Corollaire posé par le protocole : **le snapshot fait foi**. Un spectateur qui
arrive à la 187ᵉ seconde n'a vu passer aucun événement et doit pourtant afficher
une scène complète et juste. Avant d'ajouter un élément visuel côté client, la
question est donc toujours : *un arrivant peut-il le déduire du seul snapshot ?*
Si non, c'est un champ qui manque au protocole.

---

## 2. Ce qui tourne où

```
                navigateur                          service `race`
       ┌──────────────────────────┐          ┌──────────────────────────┐
       │ frontEnd/static/js/      │  WSS     │ raceEngine/src/          │
       │   banner/*.js  (rendu)   │◄─────────┤   engine/  (simulation)  │
       │ frontEnd/static/css/     │  /ws/race│   config/  (réglages)    │
       │   banner.css             │─────────►│   protocol.js  (contrat) │
       └──────────────────────────┘  ping    │   track.js (circuits)    │
                    ▲                  vote  │   server.js (boucle, WS) │
                    │                  watch └──────────────────────────┘
              Flask (frontEnd)                            ▲
              sert index.html                             │
              et les assets                         tracks/*.md
                                                  (montés en lecture seule)
```

Le service `race` est isolé sur le réseau Docker `frontend` **uniquement** : ni
base de données, ni session, ni cookie. C'est ce qui rend acceptable d'exposer
une connexion permanente non authentifiée. Il est plafonné à 0,25 CPU / 128 Mo.

Le backend Flask ne participe pas au banner. Sa seule contribution est
`get_banner_season()` dans [frontend.py](../../frontEnd/frontend.py), qui choisit
le décor saisonnier.

---

## 3. Le moteur — `raceEngine/src/engine/`

Dix-neuf modules ES, **graphe de dépendances acyclique**, du plus bas au plus
haut niveau. Chacun ne connaît que ceux qui le précèdent dans cette liste.

| Module | Rôle |
|---|---|
| `math.js` | les quelques fonctions numériques partagées |
| `geometry.js` | distances et positions sur un circuit qui boucle |
| `steering.js` | la loi de braquage : ce qu'un kart **peut** faire du volant |
| `bodies.js` | emprise d'un corps, rapetissement, contact |
| `stats.js` | caractéristiques d'un pilote, vitesses qui en découlent |
| `standings.js` | classement, points, étapes de course |
| `camera.js` | la caméra de course |
| `items.js` | le **tirage** d'un objet |
| `effects.js` | ce qui **arrive** à un kart : éclair, Bill, écrasement, souffle |
| `driving.js` | la voie et le volant : choisir une profondeur, puis y aller |
| `weapons.js` | l'**usage** d'un objet : viser, lancer, traîner |
| `plans.js` | le plan de course : la profondeur visée, et pourquoi |
| `vision.js` | ce qu'un kart **voit**, et le jugement qu'il porte dessus |
| `pipes.js` | collisions, rebonds et évitement des tuyaux |
| `road.js` | le bord de piste et le contact entre karts |
| `race.js` | grille, départ, tours, arrivée |
| `ai.js` | `updateAI` : le pilote, qui arbitre tout le reste |
| `step.js` | un pas de simulation — l'ordre dans lequel le monde avance |
| `world.js` | la fabrique d'un monde |
| `index.js` | baril : l'API publique |

Deux fonctions suffisent à faire tourner une course : `createWorldState` et
`stepPhysics`. Tout le reste n'est exporté que pour les **observateurs** — bancs
d'essai, relevé de décision, protocole — qui relisent une grandeur sans la
recalculer. Aucun consommateur externe n'écrit dans l'état.

**Pour lire le moteur, commencer par `step.js`** : cette fonction n'invente rien,
elle appelle dans un ordre qui compte ce que les autres modules savent faire. La
lire, c'est lire la course.

### La configuration — `raceEngine/src/config/`

Sept fragments (`bodies`, `world`, `driving`, `items`, `pipes`, `vision`, `ai`)
recollés par `index.js`. Ce sont des littéraux sans référence croisée : un
fragment ne connaît pas les autres. Les seules valeurs calculées sont posées à la
fin par `deriveBodies`, qui a besoin de l'objet entier.

Les emprises ne se règlent pas une par une : on règle la **loi**, et chaque corps
en reçoit sa part, à partir de la taille réelle de son sprite. Les mesures se
reprennent avec `python3 scripts/sprite-metrics.py`.

---

## 4. Le client — `frontEnd/static/js/banner/`

Vingt-deux **scripts classiques**, chargés dans l'ordre par
[index.html](../../frontEnd/templates/index.html).

Des scripts classiques et non des modules ES, et c'est un choix : sans étape de
build, un `import` échapperait au cache-buster `?v={{ app_version }}`, et un
déploiement laisserait des morceaux de banner en cache (nginx sert les `.js` avec
`expires 7d`). Chargés ainsi, ils partagent la même portée globale que le fichier
unique qu'ils remplacent.

**Seul `main.js` exécute quelque chose au chargement**, d'où sa place en fin de
liste. Tous les autres se contentent de déclarer et pourraient venir dans
n'importe quel ordre.

| Script | Rôle |
|---|---|
| `config.js` | constantes de rendu, monde de repli hors ligne |
| `state.js` | ce que le client garde d'une image à l'autre |
| `layout.js` | profondeur, échelle, z-index, défilement des couches |
| `assets.js` | préchargement des images, choix d'une frame |
| `camera.js` | où le monde se trouve à l'écran |
| `focus.js` | le kart suivi : cartouche, relevé de décision, sélection |
| `director.js` | le réalisateur : à qui la caméra s'intéresse |
| `controls.js` | pause et vote |
| `leaderboard.js` | le classement latéral |
| `scene.js` | bâtir, effacer, rebâtir la scène sur un `hello` |
| `items.js` | l'objet tenu, ceux en orbite |
| `curtain.js` | le rideau de départ, la pastille de connexion |
| `reconcile.js` | le DOM mis au pas de l'état |
| `effects.js` | l'orage et Lakitu |
| `results.js` | classement final, tableau du grand prix |
| `render.js` | le dessin d'une image |
| `interpolate.js` | horloge partagée, interpolation entre deux snapshots |
| `net.js` | la connexion : ouverture, reprise, messages |
| `loop.js` | la boucle d'animation et sa santé |
| `debug.js` | carte de piste, couche de vision, emprises |
| `snow.js` | la neige, l'hiver |
| `main.js` | le démarrage |

La feuille de style reste **un seul fichier**,
[banner.css](../../frontEnd/static/css/banner.css) : une feuille de style bloque
le rendu, et une quinzaine de requêtes bloquantes retarderaient l'apparition du
bandeau. Son sommaire est en tête du fichier.

---

## 5. Les circuits — `tracks/`

Un circuit est un **dessin**, pas du code : un `.md` ordinaire, lisible sur
GitHub, dont un bloc ```` ```track ```` porte le tracé. Format et règles dans
[tracks/README.md](../../tracks/README.md).

C'est pourquoi `tracks/` est **monté** dans le conteneur et non copié : un
circuit retouché part en course au prochain `make restart-race`, sans
reconstruire l'image. Le moteur, lui, est copié — c'est du code.

---

## 6. Travailler dessus

| Commande | Ce qu'elle fait |
|---|---|
| `make race-tracks` | vérifie les circuits et les traduit en chiffres |
| `make race-sim` | banc d'équilibrage : N courses hors horloge, statistiques |
| `make race-scenario` | trace tick par tick **une** décision de pilotage |
| `make race-soak` | soak du moteur seul, sans WebSocket |
| `make race-spectate` | « test de l'arrivant » contre le service en cours |
| `make race-nginx` | même test, mais à travers nginx (upgrade, timeouts, limites) |
| `make re-race` | reconstruit l'image et repart sur un grand prix neuf |
| `make restart-race` | nouveau grand prix sans couper le service (SIGHUP) |
| `make logs-race` | suit les logs du moteur |

Les outils de `raceEngine/tools/` sont tous des **observateurs** : ils lisent le
moteur, ils n'y écrivent jamais.

### Ce qu'il faut savoir avant de toucher au moteur

1. **Aucun test automatisé ne couvre le banner.** Les quatre outils sont des
   bancs de mesure : ils impriment, ils n'assertent pas. `race-spectate` est le
   plus proche d'un test — il marque `MANQUE` sur les champs qui feraient
   afficher une scène fausse — mais il exige un service en cours d'exécution.
2. **Un changement de contrat impose de monter `PROTOCOL_VERSION`**, des deux
   côtés à la fois (`raceEngine/src/protocol.js` et
   `frontEnd/static/js/banner/interpolate.js`). Le client refuse toute version
   qui ne correspond pas : mieux vaut le décor seul qu'une scène interprétée de
   travers.
3. **Le moteur est pur.** `stepPhysics` ne lit ni l'horloge, ni le hasard global,
   ni l'appareil : tout arrive en paramètre. C'est ce qui rend le banc
   d'équilibrage possible, et il faut que ça le reste.
