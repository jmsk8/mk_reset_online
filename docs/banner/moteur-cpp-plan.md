# Le moteur de course en C++ — conception

> Document de travail interne, dans le même esprit que
> [../auth-discord-plan.md](../auth-discord-plan.md) et
> [../hierarchie-admin-plan.md](../hierarchie-admin-plan.md) : pouvoir implémenter plus tard
> sans refaire l'analyse. Écrit après lecture intégrale de `raceEngine/src/protocol.js`,
> `server.js`, `track.js`, des 19 modules de `src/engine/`, des 7 fragments de `src/config/`,
> des 22 scripts de `frontEnd/static/js/banner/`, du `Makefile`, de `docker-compose.yml`,
> de `nginx/snippets/app.conf` et des six documents de ce dossier.
>
> Conventions : **[DÉCIDÉ]** = tranché par l'utilisateur · **[À TRANCHER]** = arbitrage attendu.
>
> **M0 à M5 sont codés** (2026-09-11) : `raceEngineCpp/` tourne, parle le protocole 11 et
> passe l'audit du contrat. Ce document reste la CONCEPTION ; l'état d'avancement et les
> écarts constatés sont dans
> [moteur-cpp-avancement.md](moteur-cpp-avancement.md).

---

## 1. Contexte

Le banner tourne aujourd'hui sur `raceEngine/`, un service Node de 19 modules moteur et
7 fragments de config. Le serveur est maître, le navigateur n'est que spectateur :
[architecture.md](architecture.md) en fait la règle qui gouverne tout —
*« Le client n'a aucune simulation. Le serveur n'a aucun rendu. »*

On veut reprendre cette simulation en C++, **sans toucher au front** et **sans tout
réécrire d'un coup**. L'objectif n'est pas un portage complet : c'est une base propre et
vivante — un service C++ qui parle exactement le protocole 11, fait tourner un grand prix
entier avec des karts qui roulent, et laisse volontairement vides les fonctions à écrire
soi-même : distribution d'objets, perception, esquive, prise de décision, physique des
objets.

Le moteur JS reste en place et reste la référence. Le Makefile bascule de l'un à l'autre.

**Critère d'acceptation, unique et non négociable : zéro ligne modifiée dans `frontEnd/`.**
`PROTOCOL_VERSION` reste à 11 des deux côtés.

Ce que la réécriture doit à la migration d'août 2026 : c'est elle qui a sorti toute la
physique du navigateur ([migration-wss-2026-08.md](migration-wss-2026-08.md) §9.1). Sans
ça, un moteur C++ aurait imposé de maintenir une seconde version du gameplay côté client —
le blocage exact qui avait fait écarter un portage Python à l'époque. Il n'existe
aujourd'hui qu'une seule implémentation du jeu, et c'est ce qui rend ce chantier possible.

---

## 2. Ce que la base fait, ce qu'elle laisse vide

| Système | v0 C++ |
|---|---|
| Départ arrêté, décompte Lakitu, feu vert, tirage turbo / normal / calé | **fait** |
| Grille aléatoire (course 1) puis ordre d'arrivée précédent (courses 2-4) | **fait** |
| Grand prix 4 courses, points `[10,8,6,5,4,3,2,1]`, tableau `gp` | **fait** |
| Karts indépendants : poids / puissance / maniabilité → masse, force, grip, pointe, accélération, agilité, virage | **fait** — port fidèle de `stats.js` |
| Circuits lus dans `tracks/*.md`, validés, ordre du GP par nom de fichier | **fait** |
| Défilement du décor (`cx` / `bx`), caméra d'approche, parking | **fait** |
| Classement latéral, ordre d'arrivée, événements de changement de place | **fait** |
| Boîtes à objets : présentes, consommées, régénérées, état `b[]` | **fait** |
| Déplacement latéral : `steer()` réel indexé sur l'agilité + errance douce | **fait** |
| Tuyaux : dessinés + choc bloquant (arrêt, recul, `FLAG_BUMPED`) | **fait** |
| Vote de redémarrage, `SIGHUP`, `/healthz`, arrêt 30 s après le dernier spectateur | **fait** |
| **Distribution d'objets** (`rollItem`, courbes, poids, décotes) | **vide** |
| **Objets** (banane, carapaces, bleue, éclair, bill, étoile, champignon) | **vide** |
| **Perception** (`perceive`, ombres, spans, mémoire) | **vide** — `sight` absent ⇒ `ai[]` rend 0, exactement comme le JS |
| **Décision** (`chooseLane`, `laneRisk`, plans, esquive, `giveWay`, visée) | **vide** |
| **Contacts kart ↔ kart** | **vide** — les karts se traversent |
| Orage / éclair (`st`) | **vide** — `st: null` |

Chaque case « vide » est une fonction qui **existe**, avec sa vraie signature, son
commentaire en français expliquant ce qu'elle doit faire, et un corps qui ne fait rien.
C'est le plan de travail, pas une lacune.

---

## 3. Décisions actées

**[DÉCIDÉ] Couche réseau : uWebSockets, récupéré par CMake `FetchContent` sur un tag figé.**
Retenu contre une pile WebSocket écrite à la main et contre `libwebsockets`. uWS est
littéralement conçu pour le cas d'usage du banner — diffuser une même chaîne à N clients,
compressée une seule fois — et fournit `permessage-deflate` d'office. Le tag figé garde la
posture du `npm install --omit=dev` du Dockerfile JS : dépendance déclarée, version
épinglée, aucun submodule dans un dépôt qui n'en a aucun.

**[DÉCIDÉ] Bascule Makefile collante.** Le choix du moteur s'écrit dans `.engine`
(gitignoré), lu par défaut par toutes les cibles. Retenu contre `ENGINE=cpp` à chaque
commande : un seul `make up` sans la variable remettrait le moteur JS en service sans que
rien ne le signale, et le banner changerait de comportement sans explication.

**[DÉCIDÉ] Collisions en v0 : tuyaux bloquants, karts sans contact.** Un kart qui touche un
tuyau s'arrête et recule (≈ 40 lignes reprenant `pipe.bumpMs`, `recoilPx`, `recoilMs`,
`immuneMs`). Les karts se traversent entre eux. La scène reste crédible à l'œil — un kart
qui traverserait un tuyau rendrait le rendu impossible à juger — et toute l'esquive reste à
écrire.

**[DÉCIDÉ] Latéral en v0 : errance douce avec le vrai `steer()`.** Port de `steering.js`
(`steerCap = base × agilité × grip × bite`) plus une profondeur cible tirée toutes les
2-6 s. La maniabilité compte donc dès le premier jour, et `chooseLane()` reste une fonction
vide : le point d'accroche de la prise de décision.

**[DÉCIDÉ] Simulation mono-thread, boucle lisible et isolée du réseau.** Un seul thread
logique fait tourner `stepPhysics`, calqué sur `step.js` : une boucle `for` par kart, dans
l'ordre qui compte, sans job system ni thread par kart — écarté après discussion, cf.
raisonnement ci-dessous. Ce choix sert un objectif explicite de l'utilisateur : arriver dans
le code plus tard, lire une boucle simple, et pouvoir l'améliorer (IA, objets, esquive) sans
se battre avec de la synchronisation. `step_physics()` ne connaît ni uWS, ni les sockets, ni
la sérialisation JSON — elle prend `(cfg, state, rng, now, deltaTime)` et rend des
événements, exactement comme `step.js`. Toute la configuration WebSocket (compression,
`idleTimeout`, upgrade, origines) reste confinée à `service/server.cpp` : le fichier qu'on
ouvre pour toucher au *gameplay* n'a jamais besoin d'y entrer.

Écarté : un thread par kart plus un thread de monitoring (distribution d'objets, rangs,
physique des objets lancés). Sur 8 karts à 30 Hz, le couplage est trop fort pour en tirer un
bénéfice : `resolveKartContacts` s'exécute *après* que tous les karts ont bougé
précisément pour éviter qu'un kart soit poussé contre un adversaire qui n'a pas encore fait
son pas (commentaire de `step.js:339-341`) — avec un thread par kart, cette garantie d'ordre
redevient une barrière de synchronisation à poser explicitement, deux fois par tick, pour 8
entités. Le banc d'équilibrage (`--simulate`, graine `mulberry32`) dépend aussi d'un ordre de
lecture/écriture déterministe pour comparer deux courses à graine égale — un gain difficile à
garder avec des accès concurrents à l'état partagé (positions, boîtes, tuyaux). Le
parallélisme utile dans les moteurs de jeu (rendu, physique bas niveau, IA de masse) prend la
forme d'un job system à l'intérieur d'un pas, pas de threads persistants par entité — hors de
propos à cette échelle.

**[DÉCIDÉ] Nombre de karts réglable en développement, de 1 à 12.** Un flag lu au démarrage
du binaire (`--karts=N`, `N` par défaut 8) fixe combien de karts prennent le départ — utile
pour observer un duel à 2, stresser le moteur à 12, ou isoler un kart seul pendant qu'on
modifie sa logique. **Ce n'est pas un réglage de production** : `docker-compose.yml` ne
l'expose sur aucune variable d'environnement, le service en conteneur reste à 8 par défaut ;
le flag ne sert qu'en lancement local du binaire (`./race_engine --karts=3 --tracks=...`) ou
via une future sous-commande de banc.

Deux conséquences à porter, toutes deux dans `engine/world.js` → `world.cpp`, jamais dans
`config/` :

- **La grille de départ** (`cfg.race.grid`, deux colonnes de `lanes`, `rowGap`,
  `laneSlope`) est dimensionnée en JS pour 8 places fixes. `createWorldState` doit calculer
  le nombre de rangs à partir de `N` plutôt que le lire en dur — `rangs = ceil(N / 2)` sur
  les deux mêmes colonnes — et non l'inverse : la config décrit une loi de grille, pas un
  nombre de karts.
- **Le roster compte 8 personnages jouables** (`bowser`, `dk`, `mario`, `luigi`, `yoshi`,
  `peach`, `toad`, `koopa` — `config/bodies.js:231-238`), ce qui couvre pile la grille par
  défaut. Au-delà de 8 karts, les personnages se **recyclent** : `characters[i %
  roster.length]`, dans l'ordre où `Object.keys` les énumère côté JS, pour que le kart 9 et
  le kart 1 soient assignés au même nom si `N > 8`. Deux instances du même personnage
  partagent alors la même entrée de `StatsTable` (cf. §4.1ter) — c'est voulu, exactement
  comme deux joueurs qui choisiraient le même kart dans le vrai jeu : rien à dupliquer,
  `stats` reste un pointeur partagé.

`hello.karts[]` et tous les tuples alignés positionnellement (`ai[i]`, `gp[1][i]`) suivent
`N` sans changement de contrat : le protocole ne fixe nulle part un nombre de karts, seul le
JS actuel en fait toujours partir 8.

**[DÉCIDÉ] Ramassage fonctionnel dès v0, deux emplacements par kart, un seul exposé au
protocole.** Le passage dans une boîte à objets (§2 : « présentes, consommées, régénérées »)
reste comme en JS, mais déclenche désormais un vrai appel à `roll_item()` — la fonction
existe, avec sa signature réelle (`(cfg, state, rng, now, kart) -> optional<Item>`), et
**rend toujours "rien"** en v0 : c'est elle qui est vide, pas le ramassage. Un kart qui passe
dans une boîte consomme bien le cube (`box.active = false`, `reactivateTime`) et déclenche
bien la mécanique de don, exactement comme le JS aujourd'hui — seule la distribution
elle-même ne produit encore aucun objet. `chooseLane()`, `ai.cpp` et les autres fonctions
vides listées en §2 gardent cette même convention : le point d'accroche existe et s'exécute,
son corps ne fait rien.

Nouveau par rapport au JS : `Kart` porte **deux emplacements** (`heldItems[2]`, cf. §4.1ter),
pas un seul `heldItem`. Une fois `roll_item()` implémenté, un kart pourra détenir deux objets
simultanément — un tenu/actif, un en réserve — sans repasser par une boîte entre les deux.

**Le protocole ne change pas.** `k[]` reste le 13-uplet actuel, avec un seul jeu de champs
`heldId`/`heldType`/`heldHold`/`orbitAngle`/`orbIds` — celui du **premier** emplacement,
toujours. Le deuxième emplacement est un état purement moteur, invisible du snapshot, comme
si le kart avait un objet "en poche" que rien à l'écran ne montre encore. C'est un choix
assumé pour préserver le critère non négociable du §1 (zéro ligne modifiée dans `frontEnd/`,
`PROTOCOL_VERSION` à 11 des deux côtés) : exposer un deuxième objet au rendu est un vrai
changement de gameplay visible, qui mérite sa propre discussion (et sa propre montée de
version) plutôt que d'être tiré en marge de ce chantier. Le jour où le deuxième emplacement
doit se voir à l'écran, c'est un nouveau document, pas un avenant à celui-ci.

---

## 4. Architecture

### 4.1 Emplacement

Un dossier frère, `raceEngineCpp/`, qui **calque la structure du JS fichier pour fichier** :
le portage reste traçable, et une divergence de comportement se cherche dans deux fichiers
qui portent le même nom.

```
raceEngineCpp/
├── CMakeLists.txt          C++20, FetchContent pour uWebSockets (tag fige)
├── Dockerfile              alpine builder + alpine runtime, non-root, wget dispo
├── .dockerignore
└── src/
    ├── main.cpp                 <- server.js  : arguments, signaux, boucle, enchainement GP
    ├── service/server.{hpp,cpp} <- server.js  : uWS App, /healthz, /ws/race, clients, diffusion
    ├── json.{hpp,cpp}           <- ecriture (std::to_chars) + lecture des 4 messages clients
    ├── protocol.{hpp,cpp}       <- protocol.js : version 11, drapeaux, tuples, filterEvents
    ├── track.{hpp,cpp}          <- track.js   : parseur .md, applyTrack, loadTracks, forRound
    ├── config/config.{hpp,cpp}  <- config/*.js: une struct Config + deriveBodies
    ├── engine/
    │   ├── math.{hpp,cpp}       geometry.{hpp,cpp}
    │   ├── stats.{hpp,cpp}      <- deriveCharacterStats (les 3 axes)
    │   ├── world.{hpp,cpp}      <- createWorldState : grille, karts, boites, tuyaux
    │   ├── race.{hpp,cpp}       <- machine a phases, panneaux, awardRacePoints
    │   ├── standings.{hpp,cpp}  <- rangs par distance restante, evenements de classement
    │   ├── camera.{hpp,cpp}     <- cx / bx
    │   ├── road.{hpp,cpp}       <- clampKartToRoad (+ resolveKartContacts : VIDE)
    │   ├── steering.{hpp,cpp}   <- steerCap / steerReach / steer
    │   ├── driving.{hpp,cpp}    <- chooseLane : VIDE (errance en attendant)
    │   ├── pipes.{hpp,cpp}      <- collideKartWithPipes (choc simple)
    │   ├── items.{hpp,cpp}      <- boites ; rollItem / giveKartItem : VIDES
    │   ├── ai.{hpp,cpp}         <- updateAI : VIDE (errance + croisiere)
    │   └── step.{hpp,cpp}       <- stepPhysics, l'ordre du tick
    └── tools/                   <- sous-commandes du binaire : --tracks, --simulate
```

Les circuits **ne sont pas copiés** dans l'image : `./tracks:/app/tracks:ro` reste monté,
comme aujourd'hui. Ce sont des dessins, pas du code — retoucher une boîte à objets ne doit
pas demander une reconstruction.

### 4.1bis Les couches, et le sens des dépendances

Les dossiers ci-dessus ne sont pas qu'un rangement : ce sont quatre couches, avec une règle
stricte, la même que celle qu'[architecture.md](architecture.md) donne déjà au JS —
*« graphe de dépendances acyclique, du plus bas au plus haut niveau »*. Chaque couche ne
connaît que celles listées en dessous d'elle. Jamais l'inverse — c'est ce qui garantit qu'une
modification reste locale à l'endroit où on la fait.

```
service/            <- server.js : uWS, sockets, /healthz, boucle de diffusion
    │  connait le protocole et l'engine, jamais l'inverse
    ▼
protocol / json      <- protocol.js : (dé)serialisation, aucune regle de jeu
    │
    ▼
engine/              <- 19 modules, dans l'ordre de step.js
    │  ne connait ni uWS, ni JSON, ni les sockets
    ▼
config/ + track/     <- reglages et circuits : donnees pures, aucune fonction de simulation
```

**Ce que ça change concrètement pour modifier le jeu :**

- **Changer une règle de gameplay** (vitesse, esquive, objets, contacts) → uniquement dans
  `engine/`. Ces fichiers ne dépendent que de `config/` et entre eux, jamais de `service/`
  ni de `protocol/` : on peut les relire, les tester (`--simulate`, `--soak`) et les modifier
  sans avoir la moindre ligne de réseau sous les yeux.
- **Changer un réglage** (poids d'un objet, gain d'un champignon, dimensions d'une hitbox)
  → uniquement dans `config/`, jamais dans `engine/` : `config/` ne contient que des
  données, décrites en §4 du même esprit que `raceEngine/src/config/`.
- **Changer ce qui part sur le réseau** (ajouter un champ au `hello`, changer la cadence
  d'envoi) → `protocol/` et `service/`, jamais `engine/` : `step_physics()` ne sait pas que
  ses résultats finissent en JSON.
- **`engine/` ne remonte jamais vers `service/` ou `protocol/`** : aucun `#include` d'un
  fichier `engine/` vers `service/server.hpp` ou `protocol.hpp`. C'est la garantie testable
  de la séparation posée en §3 — la boucle qu'on vient de lire ne se retrouve jamais coincée
  avec la configuration WebSocket dans le même fichier ni dans la même unité de compilation.

`main.cpp` est le seul fichier qui a le droit de connaître toutes les couches à la fois :
c'est lui qui les assemble (charge la config, construit le monde, ouvre le service), rien
d'autre.

### 4.1ter [DÉCIDÉ] Struct pour toutes les données du jeu, jamais de classe à méthodes

Le JS ne fait déjà pas de « kart-objet » : un `kart` est un objet de données brut
(`world.js:72`), `stats` une table dérivée une fois par personnage et partagée par référence
entre tous les karts qui le jouent (`stats.js:79`, `kart.stats = stats`, pas une copie), et
tout le comportement vit dans des fonctions libres qui prennent l'état en paramètre —
`getActiveBoost(cfg, state, kart, now)`, jamais `kart.getActiveBoost()`. `step.js` le dit
explicitement : *« elle appelle... ce que les autres modules savent faire »*. Le C++ suit la
même règle plutôt que d'en profiter pour réintroduire des méthodes : une classe `Kart` avec
`kart.applyBoost()`, `kart.steer()` serait une divergence de style, pas seulement de langage,
et romprait la correspondance fichier-pour-fichier posée en §4.1.

**La règle : `struct` avec des champs publics pour tout ce qui est état de simulation
(`Kart`, `Item`, `Pipe`, `ItemBox`, `WorldState`, `CharacterStats`, `Config`). Zéro méthode
dessus au-delà d'un constructeur trivial.** Le comportement reste dans des fonctions libres
de `engine/`, une par responsabilité, nommées comme leur équivalent JS
(`step_physics`, `update_ai`, `clamp_kart_to_road`, `steer`). C'est ce qui permet à `engine/`
de rester lisible et modifiable sans reconstruire un graphe d'objets : ajouter un champ à
`Kart` ou changer une fonction ne touche qu'un seul fichier, jamais une hiérarchie de classes.

```cpp
// engine/stats.hpp — <- stats.js : deriveCharacterStats
struct CharacterStats {
    KartRaw raw;
    NormAxes norm;
    double mass, force, grip;
    double topSpeed, acceleration, agility, cornering;
};
// Une table par personnage, deduite une fois au chargement de Config — l'equivalent
// du WeakMap<cfg, table> du JS, sans cache a gerer a la main.
using StatsTable = std::unordered_map<std::string, CharacterStats>;

// engine/world.hpp — <- world.js:72, la forme d'un kart
struct Kart {
    int id;
    std::string charName;
    const CharacterStats* stats;   // pointe dans StatsTable, jamais copiee ni possedee ici

    double worldX = 0, yPercent = 0, totalDistance = 0;
    double absoluteVelocity = 0, momentum = 0, momentumTarget = 0;
    double vy = 0, targetVy = 0;
    double bumpVy = 0, bumpVx = 0;
    double contactSpeed = 0;

    KartState state = KartState::Grid;
    int rank;
    AiState aiState = AiState::Cruising;
    // ... le reste, champ pour champ comme world.js
};
```

**Seule exception à la règle « pas de classe » : les types utilitaires sans état de jeu.**
Le RNG (`Rng`, wrapper de mulberry32) et les objets de service C++ imposés par les
bibliothèques (le handle uWS, le parseur JSON) peuvent être des classes au sens C++ — ils
n'encodent aucune règle de gameplay, seulement une mécanique technique. La frontière est
celle-là : si un champ ou une méthode décrit **l'état d'une course**, c'est une struct de
données lue par des fonctions de `engine/` ; sinon, libre au code d'utiliser l'outil C++
adapté.

### 4.2 Correspondances à respecter avec `raceEngine/src/server.js:453-463`

| JS (`ws`) | C++ (uWS) |
|---|---|
| `maxPayload: 512` | `maxPayloadLength: 512` |
| `serverMaxWindowBits: 12` (fenêtre 4 Ko, contexte conservé) | `compression: uWS::DEDICATED_COMPRESSOR_4KB` |
| une `JSON.stringify` partagée par tous | `app.publish("race", payload, TEXT, true)` — compressée **une fois** pour le sujet |
| `meta.hidden` ⇒ client sauté | `ws->unsubscribe("race")` sur `{t:'vis',hidden:true}` |
| heartbeat manuel 30 s + `terminate()` | `idleTimeout` + `sendPingsAutomatically` — le navigateur répond au niveau protocole |
| upgrade uniquement sur `WS_PATH` | route `.ws("/ws/race", …)` |
| `ALLOWED_ORIGINS` ⇒ 403 brut | contrôle dans le handler `upgrade`, `writeStatus("403 Forbidden")` |

Un spectateur qui a demandé `{t:'watch', id}` **se désabonne du sujet** et reçoit son propre
envoi porteur de `vw` — sinon il recevrait le snapshot deux fois.

### 4.3 La boucle

Un `us_timer` répétitif à ≈ 33 ms sur la boucle uWS, l'accumulateur à pas fixe faisant le
vrai travail : `DT = 1/30`, écoulé réel plafonné à 1 s, **au plus 5 pas de rattrapage** puis
le retard est jeté. Ce plafond n'est pas optionnel — [migration-wss-2026-08.md](migration-wss-2026-08.md)
§6.14 : *« sans ce plafond, une pause GC ou un gel de l'hôte déclenche une spirale de
rattrapage qui sature le CPU »*. Diffusion tous les 3 pas simulés, soit 10 Hz.

---

## 5. Le contrat, clé par clé

C'est la partie qui ne souffre aucune approximation. `frontEnd/static/js/banner/config.js:123`
ne contient qu'un `OFFLINE_WORLD` qui fait défiler le décor : **un champ manquant produit un
rendu faux et silencieux, pas une erreur.**

Source de vérité : `raceEngine/src/protocol.js`, dont [protocole.md](protocole.md) donne la
carte.

### 5.1 `hello` — une fois par connexion

`t:"hello"`, `protocol:11`, `serverTime` (horloge murale à l'envoi), `t0` (horloge murale à
la **création de la course**).

`world` — les 21 champs, tous obligatoires : `width`, `finishLineX`, `sunX`, `roadMinY`,
`roadMaxY`, `roadPPS`, `hitDuration`, `orbit{count,radiusX,radiusY}`, `shellAnimSpeed`,
`billAnimSpeed`, `laps`, `gpRaces`, `flagAnimSpeed:220`, `blastRadius`, `shrinkScale`,
`ai{states,dangers}`, `hitboxes{kart,pipe,item,heldBehindX,itemBox}`,
`vision{rangeFront,rangeBack,pressureRange,threatLane,clear}`, `pipeDraw{w,h}`.

> Les champs des systèmes non simulés (`blastRadius`, `shrinkScale`, `orbit`, `vision`)
> partent quand même, avec leurs valeurs de config : le HUD de debug les dessine, et le
> client ne garde aucune copie des constantes de simulation.

`karts[]` : `{id, char, body{x,y,scale}}` — `body` vient de `deriveBodies`, mesuré sur les
sprites. Sans `scale`, tous les karts seraient dessinés à la même longueur.
`boxes[]` : `{x,y}` · `pipes[]` : `{x,y,kind}` · `snapshot` : un snapshot complet.

### 5.2 `s` — snapshot, 10 fois par seconde

| Clé | v0 |
|---|---|
| `ts` | horloge de simulation, arrondie à la milliseconde |
| `cx`, `bx` | caméras, 2 décimales, bouclées sur `width` |
| `k[]` | 13-uplet ; cases 6-10 (`heldId`…`orbIds`) à `null`, case 11 (`hitEnd`) à `null`, **case 12 (`bumpEnd`) utilisée** par le choc de tuyau |
| `ai[]` | un `0` par kart — pas de `sight`, donc `aiTuple` rend 0, comportement identique au JS |
| `i[]` | `[]` |
| `b[]` | 0/1, **aligné sur `hello.boxes[]`** |
| `ph` | `countdown` / `racing` / `finishing` / `results` |
| `lp`, `sg`, `fo`, `gp`, `vt` | complets |
| `st` | `null` |
| `ev[]` | seulement `leaderboardPosition` en v0 — `kartHit` et `pipeShaken` ne se déclenchent pas encore |
| `vw` | `null`, et uniquement pour un client qui a envoyé `watch` |

**Contrats d'alignement positionnel**, implicites et cassants :
`ai[i]` ↔ `k[i]` · `b[i]` ↔ `hello.boxes[i]` · `gp[1][i]` et `gp[2][i]` ↔ `hello.karts[i]` ·
l'index d'un `pipeShaken` ↔ `hello.pipes`.

### 5.3 Client → serveur

`{t:'ping',c}` → `{t:'pong', c: <renvoyé tel quel>, s: <horloge murale>}` ·
`{t:'vote'}` (bascule, unanimité ⇒ redémarrage) ·
`{t:'watch', id}` ·
`{t:'vis', hidden}` — et **la transition caché → visible renvoie un `hello` entier**.
Charge utile plafonnée à 512 octets ; tout le reste est ignoré en silence.

### 5.4 Deux pièges d'écriture JSON

- `Math.round` en JS arrondit **la moitié vers +∞** ; `std::round` l'arrondit à l'opposé de
  zéro. Il faut un `js_round(v)` = `std::floor(v + 0.5)`. Ça compte : `cx`, `dx`, `threatY`
  et les ombres passent en négatif.
- Les doubles s'écrivent avec `std::to_chars` sans précision : représentation décimale la
  plus courte, le même algorithme que `Number.prototype.toString`. `1.0` sort `1`, comme en
  JS. Les entiers s'écrivent en entiers.

---

## 6. La bascule Makefile

Dans le bloc de variables, à côté du `DUMP_FILE` des lignes 12-14 dont il reprend exactement
l'idiome `export` → interpolation compose :

```make
ENGINE       ?= $(if $(wildcard .engine),$(shell cat .engine),js)
RACE_CONTEXT  = $(if $(filter cpp,$(ENGINE)),./raceEngineCpp,./raceEngine)
export RACE_CONTEXT
```

`docker-compose.yml:130-132`, une seule ligne change :

```yaml
  race:
    build:
      context: ${RACE_CONTEXT:-./raceEngine}
```

Trois cibles neuves — le `help` de la ligne 246 accepte ces noms, sa regex `^[a-zA-Z_-]+:`
n'interdit que les chiffres :

```make
engine:      ## Affiche le moteur de course actif
engine-js:   ## Bascule le service race sur le moteur JS
engine-cpp:  ## Bascule le service race sur le moteur C++
```

`engine-js` / `engine-cpp` écrivent le fichier et **impriment la commande suivante**
(`make re-race`) plutôt que de déclencher une reconstruction surprise.

`/healthz` gagne un champ `engine: "js"|"cpp"` des deux côtés — une ligne dans
`raceEngine/src/server.js:429-446`. `make engine` dit ce qui est *choisi*, `/healthz` dit ce
qui *tourne* : les deux peuvent diverger tant qu'un `make re-race` n'a pas eu lieu.

### 6.1 Ce qui reste intouchable

- **Le service garde le nom `race`** : `nginx/snippets/app.conf:87` code en dur `race:3000`.
- **`wget` doit exister dans l'image finale** (`docker-compose.yml:149`). Sans healthcheck
  vert, nginx ne démarre pas du tout (`depends_on: race: service_healthy`, l. 184-185).
  Alpine fournit le wget de busybox — c'est ce qui décide du choix de l'image de runtime.
- **Réseau `frontend` uniquement**, jamais `backend`. Plafonds 0,25 CPU / 128 Mo.

### 6.2 Outils, pour les deux moteurs

Le binaire C++ prend les mêmes sous-commandes que les outils JS, et le Makefile choisit :

```make
ifeq ($(ENGINE),cpp)
RACE_TRACKS_CMD = $(COMPOSE) run --rm --no-deps race /app/race_engine --tracks
RACE_SIM_CMD    = $(COMPOSE) run --rm --no-deps race /app/race_engine --simulate
else
RACE_TRACKS_CMD = $(RACE_NODE) node tools/tracks.js
RACE_SIM_CMD    = $(RACE_NODE) node tools/simulate.js
endif
```

**`make race-spectate` (Makefile:233) est cassé pour tout moteur sans `node`** : il fait
`compose exec race node tools/spectate.js`. Correctif valable pour les deux moteurs —
emprunter une image node et la coller dans la pile réseau du conteneur race, où
`localhost:3000` est le moteur :

```make
$(RACE_DOCKER) --network container:$$($(COMPOSE) ps -q race) $(RACE_IMAGE) \
    node tools/spectate.js --url ws://127.0.0.1:3000/ws/race --after $${AFTER:-30}
```

`spectate.js` est le seul filet mécanique du banner — [architecture.md](architecture.md)
rappelle qu'aucun test automatisé ne le couvre. Il doit pointer sur le binaire C++ dès le
premier jour.

---

## 7. Jalons

Chacun se termine par quelque chose qui tourne et se vérifie. Rien n'est écrit « pour plus
tard ».

**M0 — le service parle.** CMake + Dockerfile + bascule Makefile + `/healthz` + upgrade
`/ws/race` + `hello` / `s` / `pong` + les 4 messages entrants, sur un monde **en dur** : un
circuit codé, 8 karts qui avancent à vitesse constante. C'est le vrai jalon — il prouve le
contrat de bout en bout avant la moindre ligne de moteur.
*Vérif : `make engine-cpp && make re-race && make race-nginx` → aucun `MANQUE`, et le
navigateur montre des karts qui roulent avec le décor qui défile.*

**M1 — les circuits.** Port de `track.js` : parseur du bloc ` ```track `, alphabet
`X x B P p . `, `CELL_PX = 80`, les 11 erreurs dures, les 2 avertissements, `applyTrack`,
`loadTracks` (tri par nom = ordre du GP), `forRound`, `resolveTracksDir`. Plus la
sous-commande `--tracks`.
*Vérif : sortie de `make race-tracks` identique entre les deux moteurs sur
`tracks/01-anneau-du-moai.md`.*

**M2 — les karts et leurs stats.** `deriveCharacterStats` : 8 personnages, budget 15 points,
`mass` / `force` / `grip` / `topSpeed` additive / `acceleration` / `agility` / `cornering`.
`deriveBodies` : emprises dérivées des sprites → `hello.karts[].body`. La grille : 4 rangs
× 2 colonnes, `gapToLine`, `laneSlope`, et surtout
`finishDistance = laps × width + gapToLine`. Le décompte et les panneaux Lakitu. L'avance
longitudinale : régime d'élan, `momentumTarget` retiré toutes les 3-7 s, plafond `topSpeed`.
Le comptage des tours et le franchissement.

**M3 — course, classement, grand prix.** Machine à phases
`countdown → racing → finishing → results`. Rangs par **distance restante** — jamais
`totalDistance`, les karts partent de lignes différentes. `leaderboardPosition` toutes les
500 ms. `awardRacePoints` indexé par `charName`, pas par id : les ids sont reconstruits à
chaque course, les personnages non. La caméra d'approche et le parking. L'enchaînement des
4 manches côté service : grille aléatoire en manche 1, ordre d'arrivée précédent ensuite,
remise à zéro après la 4ᵉ. Le vote unanime, `SIGHUP`, l'arrêt 30 s après le dernier
spectateur.

**M4 — latéral et boîtes.** Port de `steering.js` (`steerCap`, `steerReach`, `steerDelay`),
`steer()` comme **seule fonction qui écrit `vy`** — invariant obtenu au prix fort, cf.
[audit-pilotage-2026-08.md](audit-pilotage-2026-08.md) §7.2, il ne se reperd pas.
`clampKartToRoad`. Une profondeur cible tirée toutes les 2-6 s. Le choc de tuyau
(`bumpMs`, `recoilPx`, `recoilMs`, `immuneMs` → `FLAG_BUMPED` + `bumpEnd`). Les boîtes
consommées et régénérées, avec un `giveKartItem()` **vide**.

**M5 — le banc.** Sous-commandes `--simulate` (mulberry32, `--races`, `--seed`, `--chain`,
`--csv`, `--track`) et `--duration` / `--always-on`, plus le correctif `race-spectate`.

**Ensuite, le terrain de jeu :** `items.cpp`, `ai.cpp`, `driving.cpp`, `vision.cpp`,
`weapons.cpp`, `plans.cpp`, `road.cpp::resolveKartContacts`.

---

## 8. Fichiers touchés

**Créés** — tout `raceEngineCpp/`, et ce document.

**Modifiés** — cinq fichiers, sept lignes ou presque :

| Fichier | Changement |
|---|---|
| `Makefile` | variables `ENGINE` / `RACE_CONTEXT`, cibles `engine*`, `ifeq` des outils, correctif `race-spectate`, `.PHONY` (l. 250-254) |
| `docker-compose.yml:131-132` | `context: ${RACE_CONTEXT:-./raceEngine}` |
| `.gitignore` | `.engine`, `raceEngineCpp/build/` |
| `raceEngine/src/server.js:429-446` | champ `engine: 'js'` dans `/healthz` |
| `README.md:97,102` et `CHANGELOG.md` | ligne d'architecture, entrée sous `[Non publié] → #### Infrastructure` |
| `docs/banner/README.md` | ligne d'index vers ce document |

**Jamais touchés :** `frontEnd/` (aucune ligne), `nginx/`, `backEnd/`, `nix/` — raceEngine
n'est pas dans `nix/package.nix` — et `raceEngine/src/engine/` ni `src/config/`.

---

## 9. Conventions d'écriture

Le dépôt écrit ses commentaires **en français, sans accents** dans `raceEngine/src/*.js`, et
ils expliquent le *pourquoi* avec le contre-factuel : « sans quoi… », « auparavant… ». Le
C++ suit la même règle. Les documents et le CHANGELOG sont en français accentué ; le
CHANGELOG utilise `- **Terme en gras** : ` suivi d'une phrase qui dit pourquoi.

---

## 10. Vérification

1. **Parité des circuits** — `make race-tracks` puis `make race-tracks ENGINE=cpp` :
   longueur de tour, colonne d'arrivée, boîtes, tuyaux et passage le plus étroit doivent
   coïncider.
2. **Contrat WS** — `make engine-cpp && make re-race && make race-nginx` : aucun `MANQUE`
   dans l'audit du `hello`, cadence ≈ 10 snapshots/s, `{t:'vis',hidden:true}` coupe le flux,
   `hidden:false` renvoie un `hello` complet.
3. **Le test de l'arrivant** — dans la console du navigateur, `bannerDev.wipeDom()` : la
   scène doit se reconstruire entière depuis le seul snapshot suivant.
4. **À l'œil** — décor qui défile, 8 karts sur la grille, décompte, feu vert, course,
   classement latéral qui bouge, ordre d'arrivée, tableau du GP après la 4ᵉ manche, vote de
   redémarrage.
5. **Debug** — `GAME_CONFIG.debugMode = true` puis `bannerDev.reconnect()` : la carte de
   piste se dessine (elle consomme `world.hitboxes`, `world.vision`, `boxes`, `pipes`), le
   HUD IA affiche `cruising` pour tous, un clic sur une vignette envoie `watch` sans rien
   casser.
6. **Endurance** — `make race-soak DURATION=600 ENGINE=cpp` : pas de fuite, pas de NaN, le
   contrôle d'intégrité ne se déclenche pas.
7. **Retour arrière** — `make engine-js && make re-race` : le front ne bronche pas. C'est la
   preuve que la bascule est réelle et que le contrat a tenu des deux côtés.

---

## 11. Registre des pièges

| | Piège |
|---|---|
| P-1 | **`PROTOCOL_VERSION` reste 11.** Un décalage et `net.js:71` appelle `giveUp()` : décor seul, pastille rouge, **plus aucune tentative de reconnexion**. Le monter impose de le monter des deux côtés à la fois (`protocol.js` et `interpolate.js:59`). |
| P-2 | **`t0`** est le seul discriminant « course neuve / reprise » (`scene.js:156-158`). Il change à chaque nouvelle course, jamais à une reconnexion — sinon le rideau tombe à chaque fois. |
| P-3 | **`RENDER_DELAY_MS = 200`** côté client est calé sur `SEND_HZ = 10` (`interpolate.js:13-18`). Changer la cadence d'envoi dégrade visiblement la fluidité sans rien afficher d'anormal. |
| P-4 | **`ts`** part de l'horloge murale à la création et avance de `1000/30` ms **par pas simulé**, pas par temps réel. C'est cette horloge que le client interpole. |
| P-5 | **La parité flottante bit à bit avec le JS n'est pas un objectif.** `Math.pow` diffère d'une libm à l'autre et `stats.js` en dépend : deux moteurs, même graine, courses différentes. On vise l'équivalence de comportement. Sans cette note, quelqu'un cherchera un jour l'erreur qui n'existe pas. |
| P-6 | **Le monde boucle** (`width`) : toute distance passe par `getShortestDistance` / `forwardDistance`, jamais par une soustraction directe. |
| P-7 | **`docker compose` lit `RACE_CONTEXT` dans l'environnement.** Le `export` du Makefile couvre les appels par `make` ; un `docker compose up -d` tapé à la main retombe sur `./raceEngine`. D'où le champ `engine` de `/healthz`. |
