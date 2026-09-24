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
