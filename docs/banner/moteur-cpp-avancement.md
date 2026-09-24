# Le moteur C++ — avancement

> Journal du chantier décrit par [moteur-cpp-plan.md](moteur-cpp-plan.md). Le plan dit ce
> qu'il faut faire ; ce document dit ce qui est fait, et surtout **ce qui a divergé**.

État au **2026-09-11** : jalons **M0 à M5 terminés**. Le service C++ tourne, parle le
protocole 11 sans qu'une ligne de `frontEnd/` ait bougé, et le moteur JS reste la référence.

---

## 1. Ce qui tourne

```
raceEngineCpp/
├── CMakeLists.txt          C++20, uWebSockets v20.62.0 par FetchContent
├── Dockerfile              alpine builder + alpine runtime, non-root, wget
└── src/                    21 fichiers, 4 couches (cf. plan §4.1bis)
```

| Jalon | Contenu | Vérifié par |
|---|---|---|
| **M0** | uWS, `/healthz`, `hello`/`s`/`pong`, les 4 messages entrants | audit du contrat : aucun `MANQUE`, 10,1 Hz |
| **M1** | parseur `tracks/*.md`, 11 erreurs dures, `--tracks` | parité chiffre à chiffre avec un calcul de référence indépendant |
| **M2** | `deriveCharacterStats`, `deriveBodies`, grille, décompte, élan | grille identique au JS à 8 karts (3.15→8.93 / 24.85→30.63) |
| **M3** | phases, classement par distance restante, points, GP 4 manches, vote, SIGHUP | `gp[0]` progresse, cumuls `[10,8,6,5,4,3,2,1]`, `t0` neuf à chaque relance |
| **M4** | `steer()` seul écrivain de `vy`, `clampKartToRoad`, choc de tuyau, boîtes | 204 profondeurs distinctes observées, `FLAG_BUMPED` + `bumpEnd` réels |
| **M5** | `--simulate` (mulberry32), `--soak`, correctif `race-spectate` | même graine → même résultat ; soak 900 s sans NaN |

Les fonctions **volontairement vides** existent avec leur vraie signature et sont appelées
dans le tick : `roll_item`, `choose_lane`, `resolve_kart_contacts`. Elles ne font rien —
c'est le plan de travail, pas une lacune.

---

## 2. Écarts assumés par rapport au plan

Trois décisions prises pendant l'implémentation, qui n'étaient pas dans le plan.

### 2.1 La grille s'adapte au nombre de rangs

Le plan prévoyait `rangs = ceil(N / 2)` sur les deux colonnes de `lanes`. Appliqué tel quel,
le 12ᵉ kart démarrait à `y = 34.48` — collé au rail, dans la bande de frottement, alors que
la config prend soin de garder les extrêmes hors de cette bande.

Le pas de diagonale (`laneSlope`) est donc **réparti sur le nombre de rangs réels** au lieu
d'être constant. À 8 karts, le diviseur vaut 4 et la grille est **identique au JS** ; à 12,
elle tient dans `3.15 → 30.63` au lieu de déborder.

### 2.2 L'errance évite les tuyaux

Le plan décrivait l'errance comme « une profondeur cible tirée toutes les 2-6 s », point.
Implémentée ainsi, elle produisait un blocage franc : un kart tirait une profondeur alignée
sur un tuyau, s'y cognait, était écarté, retirait la même, et **la course ne se terminait
jamais** — elle restait en `finishing` jusqu'au délai maximum sans que rien ne dise pourquoi.

`wander()` refuse donc une cible qui pointe sur un tuyau proche, et **tient l'écart tant que
le tuyau est devant**. Ce n'est pas de la perception : un vrai évitement regarde ce qu'il a
devant, mesure le temps disponible et choisit un couloir — c'est le travail de
`choose_lane()`, qui reste vide. C'est le minimum pour qu'une course arrive au bout.

**Corrigé le 2026-09-23** — l'esquive était rognée à la marge d'errance (`lo`/`hi`, 8 → 27).
Face à un tuyau centré (y = 17,5), elle plafonnait à 27, soit 9,5 de dégagement pour 9 à 9,7
d'emprise cumulée : le kart s'arrêtait à 26,4 (tolérance du volant), frottait le tuyau, était
écarté vers la même borne, et recommençait. Sans contact entre karts, tout le peloton
s'empilait là et la course bloquait. HEAD avait **le même frottement** et s'en sortait par
chance ; le tirage de 8 karts parmi 10 (Birdo et Daisy) le faisait bloquer dès les premières
courses d'une graine sur deux. L'esquive est désormais bornée par la **piste** : quand elle
tient dans les marges, cible et choix du côté sont exactement ceux d'avant. 800 courses sur
8 graines sans un blocage.

### 2.1bis Le roster : 8 karts tirés parmi les personnages actifs

Miroir du `roster` JS (raceEngine/src/config/bodies.js). Chaque `CharacterSpec` porte
`enabled` ; `create_world_state` ne mélange que ceux-là, et les `kartCount` premiers courent.
Moins de personnages actifs que de places : la course se fait avec eux. Seul `--karts`
(développement) recycle encore au-delà du roster (`kartCountForced`). Le kart de référence
des corps est figé sur les huit d'origine (`bodies.referenceKarts`), comme en JS. `--simulate`
retire le tirage à chaque ouverture de grand prix, comme le service.

### 2.3 Un flag `--laps`, comme `--karts`

Même esprit que le `--karts` du plan §3 : une course de 5 tours dure ~154 s, ce qui rend
l'enchaînement des manches pénible à observer quand on travaille dessus. `--laps N`
(1 à 20) est un réglage de **développement**, absent de `docker-compose.yml`.

---

## 3. Ce que le banc ne mesure pas encore

`--simulate` produit des classements qui **reproduisent l'ordre de grille** : le vainqueur
gagne 80 % du temps, le dernier finit dernier à chaque manche.

Ce n'est pas un défaut d'équilibrage, c'est ce qu'une course sans interaction peut produire.
Sans objets (`roll_item` vide) et sans contacts entre karts (`resolve_kart_contacts` vide),
il ne reste que la pointe pour départager — et l'écart entre le plus rapide et le plus lent
du plateau vaut **5,1 %**, soit 0,74 s par tour, moins que ce que la grille donne d'avance.

D'ici à ce que `items.cpp` et `road.cpp::resolve_kart_contacts` soient écrits, ce banc
vérifie que la simulation **tient** (aucun NaN, toutes les courses arrivent au bout), pas que
le plateau est juste. La note est imprimée sous le tableau pour que personne ne s'y trompe.

---

## 4. Vérification — ce qui a réellement été passé

Les points 1, 2, 6 et 7 du plan §10 ont été exécutés. Les points 3, 4 et 5 demandent un
navigateur et restent à faire.

| | Point | Résultat |
|---|---|---|
| 1 | Parité des circuits | ✅ chaque valeur vérifiée contre un calcul indépendant |
| 2 | Contrat WS | ✅ aucun `MANQUE`, 10,1 Hz, `vis` coupe et rend un `hello` complet |
| 3 | `bannerDev.wipeDom()` | ⏳ demande un navigateur |
| 4 | À l'œil | ⏳ demande un navigateur |
| 5 | HUD de debug | ⏳ demande un navigateur |
| 6 | Endurance | ✅ soak 900 s, 27 000 pas, 4 courses, aucun NaN |
| 7 | Retour arrière | ✅ `make engine-js` rend le JS, qui est le défaut sans `.engine` |

**Deux bugs trouvés et corrigés** au passage : `lp` (tour du leader) partait à l'infini —
un « tour 10 / 5 » se serait vu à l'écran — et la grille débordait sur le rail au-delà de
8 karts (cf. §2.1).

À noter : `node` et `docker` n'étant pas accessibles depuis l'environnement de travail,
`spectate.js` n'a pas pu être exécuté tel quel. L'audit a été refait à l'identique par un
client WebSocket écrit pour l'occasion — mêmes champs vérifiés, même critère `MANQUE`.

---

## 5. Fichiers touchés hors `raceEngineCpp/`

Quatre fichiers, conformément au plan §8 — et **aucune ligne de simulation JS**.

| Fichier | Changement |
|---|---|
| `Makefile` | `ENGINE` / `RACE_CONTEXT`, cibles `engine*`, correctif `race-spectate`, `.PHONY` |
| `docker-compose.yml` | `context: ${RACE_CONTEXT:-./raceEngine}` |
| `.gitignore` | `.engine`, `raceEngineCpp/build/` |
| `raceEngine/src/server.js` | champ `engine: 'js'` dans `/healthz` — une réponse de diagnostic, pas du gameplay |

`frontEnd/` : **zéro ligne**. `raceEngine/src/engine/`, `src/config/`, `protocol.js`,
`track.js`, `tools/` : **intacts**.

---

## 6. La suite

Le terrain de jeu, dans l'ordre où il se laisse écrire :

1. **`items.cpp`** — `roll_item` : la courbe de tirage, les poids, les décotes par rang.
   C'est ce qui rend le banc lisible (cf. §3), donc à faire en premier.
2. **`road.cpp::resolve_kart_contacts`** — les karts cessent de se traverser.
3. **`vision.cpp`** puis **`driving.cpp::choose_lane`** — la perception, puis la décision.
   C'est là que l'errance de §2.2 disparaît au profit d'un vrai choix de couloir.
4. **`weapons.cpp`**, **`plans.cpp`** — l'usage des objets et la visée.

---

## 7. À reporter depuis le JS

Changements faits côté JS pendant que le C++ est mis de côté. Tant que cette liste n'est
pas vide, `make engine-cpp` fait courir les anciennes valeurs : le C++ n'est plus le même
jeu que le JS.

### 7.1 Stats calées sur MK8D (2026-09-24)

`raceEngine/src/config/bodies.js`, `kartStats.characters` →
`raceEngineCpp/src/config/config.hpp`, `characters` (colonnes weight / power / handling).
L'ordre des lignes ne change pas.

| Personnage | Avant | Après |
|---|---|---|
| dk | 8 / 5 / 2 | 7 / 5 / 3 |
| birdo | 5 / 4 / 6 | 4 / 5 / 6 |
| luigi | 4 / 6 / 5 | 5 / 4 / 6 |
| peach | 3 / 6 / 6 | 4 / 5 / 6 |

### 7.2 Sprites redimensionnés au gabarit MK8D (2026-09-24)

Les PNG de course de bowser, dk, birdo, toad et koopa ont été redimensionnés par
`scripts/resize-karts.py` (originaux dans `assets-src/karts/`). Le C++ ne lit pas les
PNG : il porte leurs mesures en dur. À reporter dans `raceEngineCpp/src/config/config.hpp`,
`characters`, colonnes w / h / px — les autres personnages ne changent pas.

| Personnage | Avant | Après |
|---|---|---|
| bowser | 111 / 124 / 10451 | 123 / 137 / 12821 |
| dk | 119 / 124 / 10497 | 129 / 135 / 12386 |
| birdo | 112 / 144 / 10229 | 106 / 137 / 9183 |
| toad | 110 / 120 / 8278 | 95 / 103 / 6113 |
| koopa | 110 / 114 / 7395 | 95 / 98 / 5495 |

La référence (`referenceKarts`, moyenne des 8 d'origine) se recalcule d'elle-même : les
karts moyens passent de ×0,99 à ×1,00 sans que leur fichier change. Rien d'autre à porter —
le placement de l'objet tenu en main (`render.js`) est côté client, commun aux deux moteurs.

### 7.3 Profondeur de l'emprise : l'écart roue à roue remplace la surface (2026-09-24)

La profondeur d'un kart ne se tire plus de la surface dessinée de son profil (`px`), qui
comptait la hauteur et la carrure du pilote — et la taille deux fois, une surface suivant
le carré de l'échelle : bowser sortait ×1,51 plus large que luigi. Elle se tire de
l'écart ROUE À ROUE, lu sur `<perso>-back.png` (rangée la plus large des 20 % du bas,
`WHEELS_BAND` de `scripts/sprite-metrics.py`) : ×1,12, comme MK8D.

À reporter :

- `config.hpp`, `CharacterSpec` : la colonne `spritePx` devient `spriteWheels`, et la table
  `characters` prend les valeurs `wheels` de `bodies.sprite.kart` (la colonne px
  disparaît) ;
- `config.cpp`, calcul des corps (l. 22-97) : `ref.px` → moyenne des `wheels` du plateau de
  référence, `body.y = refHalfY * (wheels / ref.wheels)`, message d'erreur « (w, h,
  wheels) », `refSpritePx` → `refSpriteWheels`.

| Personnage | w | h | wheels |
|---|---|---|---|
| bowser | 123 | 137 | 124 |
| dk | 123 | 128 | 117 |
| mario | 112 | 119 | 112 |
| birdo | 106 | 137 | 106 |
| luigi | 111 | 123 | 111 |
| yoshi | 119 | 122 | 112 |
| peach | 112 | 124 | 112 |
| daisy | 112 | 128 | 112 |
| toad | 95 | 103 | 96 |
| koopa | 95 | 98 | 95 |

Cette table remplace les colonnes w / h / px du §7.2.

### 7.4 Plancher du momentum relevé à 0,80 (2026-09-24)

`raceEngine/src/config/driving.js`, `speeds.momentumFloor.base` : 0,70 → 0,80. À reporter
dans `raceEngineCpp/src/config/config.hpp`, `momentumFloorBase` (l. 67). La croisière va
désormais de 95,6 à 100 % de la pointe (au lieu de 93,4 à 100 %).

### 7.5 `massDragAccel` à 1,0 (2026-09-24)

`raceEngine/src/config/bodies.js`, `kartStats.massDragAccel` : 1,75 → 1,0. À reporter dans
`raceEngineCpp/src/config/config.hpp` (champ du même nom). L'écart d'accélération
koopa/bowser passe de +83 % à +38 % (MK8D : +33 %).

### 7.6 DK réduit de 5 % (2026-09-24)

Facteur de `scripts/resize-karts.py` : 10,0 / 9,2 → 10,0 / 9,2 × 0,95. Ses mesures (w 123,
h 128, wheels 117) sont déjà dans la table du §7.3.

### 7.7 Le coût d'un coup dépend de ce qui frappe (2026-09-24)

`delays.hitDecelDuration` et `hitPauseDuration` (1,5 s de glissade + 0,5 s d'arrêt, pour
tous les coups, relance à zéro) sont remplacés par la table `hits` de
`raceEngine/src/config/driving.js` : par source, `spinMs` (durée du tête-à-queue) et `keep`
(part de la vitesse au moment du coup, bornée à la pointe, gardée pendant la glissade et à
la sortie ; 0 = arrêt net, relance de zéro).

| Source | spinMs | keep | invincibleMs |
|---|---|---|---|
| star | 1000 | 0,25 | 1000 |
| bill | 1000 | 0,25 | 950 |
| banana | 1200 | 0,20 | 1500 |
| lightning | 1000 | 0,20 | 1500 |
| greenShell, redShell | 1500 | 0 | 1500 |
| blueShell (souffle) | 2000 | 0 | 1500 |

`invincibleMs` remplace `delays.invincibilityAfterHit` (3000 pour tous) : le sursis
d'après coup, posé à la sortie du tête-à-queue (`hitInvincibleUntil = now +
hitInvincibleMs`).

À reporter :

- config : la table, et la suppression des trois délais (`hitDecelDuration`,
  `hitPauseDuration`, `invincibilityAfterHit`) ;
- `spinOutKart(…, source)` : pose `hitDuration`, `hitEndTime`, `hitKeepSpeed`,
  `hitInvincibleMs`, et un
  événement `kartHit` avec `source`. En JS, les trois copies du tête-à-queue (objet traîné,
  objet au sol ou lancé, orbite) passent désormais toutes par lui ;
- sources : éclair `lightning`, souffle de la bleue `blueShell`, contact d'un intouchable
  `bill` si le percuteur est un bill sinon `star`, objet traîné ou au sol : son `type`,
  orbite : son `childType` ;
- phase `hit` de `step` : vitesse de glissade = `hitKeepSpeed` (plus de courbe de
  décélération ni d'arrêt en fin de toupie), et `absoluteVelocity = hitKeepSpeed` à la
  sortie ;
- protocole : 14ᵉ champ du tuple kart, `hitDur` (durée du coup en cours), et
  `hello.hitDuration` = la plus longue de la table. Le client retombe sur `hello.hitDuration`
  si `hitDur` manque : un serveur C++ non porté reste lisible.
