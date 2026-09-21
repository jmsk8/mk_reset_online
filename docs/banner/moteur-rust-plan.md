# Le moteur de course en Rust — conception

> Document de travail interne, dans le même esprit que
> [moteur-cpp-plan.md](moteur-cpp-plan.md), dont il reprend la méthode, la structure et les
> règles : pouvoir implémenter plus tard sans refaire l'analyse. Écrit après relecture
> intégrale de [moteur-cpp-plan.md](moteur-cpp-plan.md) et de
> [moteur-cpp-avancement.md](moteur-cpp-avancement.md), du `raceEngineCpp/CMakeLists.txt` et du
> `Dockerfile` C++, et des blocs `ENGINE` / `RACE_CONTEXT` / `engine*` du `Makefile`.
>
> Conventions : **[DÉCIDÉ]** = tranché par l'utilisateur · **[REPRIS]** = règle du plan C++,
> reconduite à l'identique · **[PROPOSÉ]** = choix de ce document, à valider avant de coder ·
> **[À TRANCHER]** = arbitrage attendu.
>
> **Rien n'est codé.** Ce document est une conception. Il n'y a pas encore de
> `raceEngineRust/`.

---

## 1. Contexte

Le banner tourne aujourd'hui sur `raceEngine/` (Node, la référence) ou sur `raceEngineCpp/`
(le port C++, jalons M0 à M5 livrés le 2026-09-11, terrain de jeu volontairement vide). Le
choix se fait par le fichier `.engine`, lu par le `Makefile`.

On ajoute un **troisième moteur, en Rust**, avec la même ambition que le C++ : une base
propre et vivante qui parle exactement le protocole 11, fait tourner un grand prix entier, et
laisse vides les fonctions à écrire soi-même (objets, perception, décision, contacts).

**[DÉCIDÉ] Le Rust s'ajoute, il ne remplace rien.** `js`, `cpp` et `rust` coexistent,
sélectionnables par `.engine`. `raceEngineCpp/` reste en place et maintenu ; le moteur JS
reste la référence de comportement.

**Pourquoi le faire, si le C++ existe déjà** — la motivation est celle de l'objectif à long
terme du banner : des IA dont on règle finement l'« intelligence », et peut-être un jour un
mode jouable en temps réel. Le moteur qui portera ça doit être robuste à long terme : pas de
segfault ni de course de données en production, un outillage (tests, benchmarks, formatage)
livré avec le langage, et un serveur asynchrone mûr le jour où le service devra faire plus
que diffuser un flux. Le plan C++ est le modèle ; le plan Rust en refait la méthode, pas la
conception.

**Critère d'acceptation, unique et non négociable, hérité tel quel : zéro ligne modifiée dans
`frontEnd/`.** `PROTOCOL_VERSION` reste à 11 des deux côtés. Le contrat de
[moteur-cpp-plan.md](moteur-cpp-plan.md) §5 s'applique au caractère près.

---

## 2. Ce que la base fait, ce qu'elle laisse vide

**[REPRIS]** Le tableau de [moteur-cpp-plan.md](moteur-cpp-plan.md) §2 est reconduit ligne pour
ligne : ce qui est **fait** en v0 (départ, grille, GP, stats, circuits, caméra, classement,
boîtes, `steer()`, tuyaux, vote/SIGHUP/`/healthz`) et ce qui est **vide** (distribution
d'objets, objets, perception, décision, contacts kart ↔ kart, orage).

Même convention : chaque « vide » est une fonction qui **existe**, avec sa vraie signature,
un commentaire en français expliquant ce qu'elle doit faire, et un corps qui ne fait rien.
`roll_item` rend `None`, `choose_lane` garde l'errance, `resolve_kart_contacts` ne pousse
personne.

Le Rust ne doit pas être plus complet que le C++ à sa livraison : la parité de périmètre est
ce qui rend les deux moteurs comparables au banc `--simulate`.

---

## 3. Décisions

### 3.1 Décisions reprises du plan C++

Reconduites sans rediscussion — les rouvrir serait rouvrir le plan C++ :

- **[REPRIS]** Calque **fichier pour fichier** sur `raceEngine/src/` (§4.1).
- **[REPRIS]** Quatre couches à dépendances acycliques (§4.1bis).
- **[REPRIS]** **Struct pour toutes les données du jeu, jamais de méthodes de gameplay**
  (§4.1ter) : le comportement vit dans des fonctions libres de `engine/`, nommées comme leur
  équivalent JS.
- **[REPRIS]** Simulation **mono-thread**, boucle lisible, `step_physics()` isolée du réseau :
  elle prend `(cfg, state, rng, now, delta_time)` et rend des événements.
- **[REPRIS]** `--karts=N` (1 à 12, défaut 8) et `--laps=N` (1 à 20) : réglages de
  **développement**, jamais exposés par `docker-compose.yml`.
- **[REPRIS]** Grille adaptée au nombre de rangs réels (`laneSlope` réparti, cf.
  [moteur-cpp-avancement.md](moteur-cpp-avancement.md) §2.1), roster recyclé
  (`characters[i % roster.len()]`) au-delà de 8 karts.
- **[REPRIS]** Ramassage fonctionnel dès v0 : `roll_item()` est appelée et rend `None` ;
  `Kart` porte **deux emplacements** (`held_items: [Option<Item>; 2]`), un seul exposé au
  protocole. Le protocole ne change pas.
- **[REPRIS]** Errance qui évite les tuyaux (cf. avancement §2.2) : sans elle, une course ne
  se termine jamais.
- **[REPRIS]** Bascule Makefile **collante** via `.engine`, service toujours nommé `race`,
  `wget` dans l'image finale, réseau `frontend` uniquement, plafonds 0,25 CPU / 128 Mo.

### 3.2 Décisions propres au Rust

**[PROPOSÉ] Couche réseau : `axum` sur `tokio`, avec l'upgrade WebSocket d'`axum`.**
Critères posés par l'utilisateur : fiable en HTTP/HTTPS, très bien documenté, sans plafond
technique pour ce type de projet. `axum` est la pile Rust la plus documentée et la plus
répandue pour ce cas ; elle est bâtie sur `tokio` et `hyper`, donne routes multiples,
middlewares, extraction typée et TLS possible un jour sans repasser par nginx. Le service
n'expose aujourd'hui que `/healthz` et `/ws/race`, mais un mode temps réel demandera
davantage : c'est la marge que ce choix achète.

Versions **épinglées par `Cargo.lock`, commité**, et image construite avec
`cargo build --release --locked` : même posture que le tag figé d'uWebSockets et le
`npm install --omit=dev` du Dockerfile JS.

**⚠ Limite réelle, à ne pas découvrir en cours de route : `permessage-deflate`.** Le C++ tire
sa compression d'uWebSockets (`DEDICATED_COMPRESSOR_4KB`, une compression par sujet, pas par
client). `axum` s'appuie sur `tungstenite`, qui **ne sait pas négocier `permessage-deflate`**.
Les snapshots partiraient donc en clair. Ce n'est pas bloquant à 8 karts et 10 Hz, mais c'est
un écart mesurable avec les deux autres moteurs. Voir **[À TRANCHER] A** plus bas.

**[PROPOSÉ] La simulation appartient à une seule tâche `tokio`, sans verrou.** L'état
(`WorldState`) est **possédé** par la tâche de simulation, jamais partagé derrière un
`Mutex`/`RwLock`. Les clients lui parlent par un canal `mpsc` (`vote`, `watch`, `vis`,
connexion, déconnexion) ; elle leur répond par un `broadcast` de charges déjà sérialisées.
C'est la traduction Rust de « simulation mono-thread » : le borrow checker garantit ce que le
plan C++ obtenait par discipline.

**[PROPOSÉ] Sérialisation faite une fois, partagée par tous.** Le snapshot est écrit dans un
tampon puis distribué en `Arc<str>` (ou `Utf8Bytes`) à tous les abonnés : équivalent de
`app.publish("race", …)` du C++. Un spectateur qui a demandé `watch` reçoit son propre envoi
porteur de `vw` et se retire du flux commun.

**[PROPOSÉ] `stats` partagé par `Arc<CharacterStats>`.** L'équivalent du pointeur du C++
(`const CharacterStats*`, jamais copié). Deux karts du même personnage partagent la même
entrée. Alternative écartée : un index dans une `Vec` — plus léger, mais qui casse
l'équivalence « pointeur partagé » du JS et du C++.

**[PROPOSÉ] Un écrivain JSON maison, pas `serde_json` pour les snapshots.** Voir piège R-1 :
`serde_json` écrit `1.0` là où JS écrit `1`. Le `hello` et `s` sont écrits à la main dans un
tampon réutilisé (comme `json.cpp` avec `std::to_chars`). `serde` reste utilisable pour
**lire** les 4 messages clients (charge ≤ 512 octets), où il n'y a aucun piège de format.

**[PROPOSÉ] Le sens des dépendances est appliqué par Cargo, pas par la discipline.** Le
plan C++ garantit « `engine/` n'inclut jamais `service/` » par une règle vérifiable à la
main. En Rust, on peut faire mieux : voir §4.1bis.

---

## 4. Architecture

### 4.1 Emplacement

Un dossier frère, `raceEngineRust/`, qui calque la structure du JS **et du C++**, fichier pour
fichier : une divergence de comportement se cherche dans trois fichiers qui portent le même
nom.

```
raceEngineRust/
├── Cargo.toml              workspace : deux membres, edition 2021, resolver 2
├── Cargo.lock              commite : c'est l'equivalent du tag fige
├── Dockerfile              rust:alpine builder + alpine runtime, non-root, wget dispo
├── .dockerignore
├── engine/                 crate `race_core` (lib) : AUCUNE dependance reseau
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── track.rs                 <- track.js   : parseur .md, apply_track, load_tracks, for_round
│       ├── config/mod.rs            <- config/*.js: une struct Config + derive_bodies
│       └── engine/
│           ├── math.rs   geometry.rs
│           ├── stats.rs             <- deriveCharacterStats (les 3 axes)
│           ├── world.rs             <- createWorldState : grille, karts, boites, tuyaux
│           ├── race.rs              <- machine a phases, panneaux, award_race_points
│           ├── standings.rs         <- rangs par distance restante, evenements
│           ├── camera.rs            <- cx / bx
│           ├── road.rs              <- clamp_kart_to_road (+ resolve_kart_contacts : VIDE)
│           ├── steering.rs          <- steer_cap / steer_reach / steer
│           ├── driving.rs           <- choose_lane : VIDE (errance en attendant)
│           ├── pipes.rs             <- collide_kart_with_pipes (choc simple)
│           ├── items.rs             <- boites ; roll_item / give_kart_item : VIDES
│           ├── ai.rs                <- update_ai : VIDE (errance + croisiere)
│           ├── rng.rs               <- mulberry32
│           └── step.rs              <- step_physics, l'ordre du tick
└── service/                crate `race_engine` (bin) : depend de `race_core`, `axum`, `tokio`
    ├── Cargo.toml
    └── src/
        ├── main.rs                  <- server.js  : arguments, signaux, boucle, enchainement GP
        ├── server.rs                <- server.js  : routeur axum, /healthz, /ws/race, clients
        ├── json.rs                  <- ecriture (tampon, entiers/flottants JS) + lecture 4 messages
        ├── protocol.rs              <- protocol.js : version 11, drapeaux, tuples, filter_events
        └── tools/                   <- sous-commandes : --tracks, --simulate, --soak
```

Les circuits **ne sont pas copiés** dans l'image : `./tracks:/app/tracks:ro` reste monté.

### 4.1bis Les couches, et le sens des dépendances

Même règle que [moteur-cpp-plan.md](moteur-cpp-plan.md) §4.1bis — chaque couche ne connaît que
celles en dessous d'elle :

```
service/ (main, server)   <- axum, tokio, sockets, /healthz, boucle de diffusion
    │  connait le protocole et l'engine, jamais l'inverse
    ▼
protocol / json            <- (de)serialisation, aucune regle de jeu
    │
    ▼
engine/                    <- 19 modules, dans l'ordre de step.js
    │  ne connait ni axum, ni tokio, ni JSON, ni les sockets
    ▼
config/ + track            <- reglages et circuits : donnees pures
```

**Ce que Rust apporte ici : la frontière est mécanique.** `engine/`, `config/` et `track`
vivent dans la crate `race_core`, dont le `Cargo.toml` **ne déclare ni `axum`, ni `tokio`, ni
`serde_json`**. Une fonction d'`engine/` qui tenterait d'écrire dans une socket ne compile
pas : la dépendance n'existe pas. Le plan C++ ne pouvait promettre que « aucun `#include` », à
vérifier par `grep` ; ici la vérification est la compilation.

Conséquences, identiques au plan C++ :

- changer une règle de gameplay → uniquement dans `race_core/engine/` ;
- changer un réglage → uniquement dans `race_core/config/` ;
- changer ce qui part sur le réseau → `protocol.rs` et `server.rs`, jamais `race_core` ;
- `main.rs` est le seul fichier qui connaît toutes les couches à la fois.

Bonus non négligeable : `race_core` se teste avec `cargo test` sans un seul socket ouvert, et
se benchmarke seule.

### 4.1ter [REPRIS] Struct pour toutes les données du jeu, jamais de méthodes de gameplay

Même règle, mêmes raisons (le JS ne fait pas de « kart-objet », `getActiveBoost(cfg, state,
kart, now)` et jamais `kart.getActiveBoost()`). **`struct` à champs publics** pour tout ce qui
est état de simulation (`Kart`, `Item`, `Pipe`, `ItemBox`, `WorldState`, `CharacterStats`,
`Config`) ; **aucun bloc `impl` avec de la logique de gameplay** dessus, hormis
`Default`/constructeur trivial. Le comportement reste dans des fonctions libres, une par
responsabilité.

```rust
// engine/stats.rs — <- stats.js : deriveCharacterStats
pub struct CharacterStats {
    pub raw: KartRaw,
    pub norm: NormAxes,
    pub mass: f64, pub force: f64, pub grip: f64,
    pub top_speed: f64, pub acceleration: f64, pub agility: f64, pub cornering: f64,
}
// Une table par personnage, deduite une fois au chargement de Config.
pub type StatsTable = HashMap<String, Arc<CharacterStats>>;

// engine/world.rs — <- world.js:72, la forme d'un kart
pub struct Kart {
    pub id: usize,
    pub char_name: String,
    pub stats: Arc<CharacterStats>,   // partage avec les autres karts du meme personnage

    pub world_x: f64, pub y_percent: f64, pub total_distance: f64,
    pub absolute_velocity: f64, pub momentum: f64, pub momentum_target: f64,
    pub vy: f64, pub target_vy: f64,
    pub bump_vy: f64, pub bump_vx: f64,
    pub contact_speed: f64,

    pub state: KartState,             // enum : Grid, Racing, ...
    pub rank: usize,
    pub ai_state: AiState,            // enum : Cruising, ...
    pub held_items: [Option<Item>; 2],
    // ... le reste, champ pour champ comme world.js
}
```

Deux notes propres au Rust, qui n'enfreignent pas la règle :

- Les **`enum`** (`KartState`, `AiState`, `Phase`) remplacent les chaînes magiques du JS et
  les `enum class` du C++. Le protocole reste, lui, en chaînes et en entiers : la conversion
  vit dans `protocol.rs`.
- **Seule exception à « pas de méthodes »**, identique au plan C++ : les types utilitaires
  sans règle de jeu — `Rng` (mulberry32), les tampons de `json.rs`, les handlers d'`axum`.

### 4.2 Correspondances avec le service C++

| C++ (uWS) | Rust (axum / tokio) |
|---|---|
| `maxPayloadLength: 512` | `WebSocketUpgrade::max_message_size(512)` et `max_frame_size(512)` |
| `DEDICATED_COMPRESSOR_4KB` | **absent** — voir **[À TRANCHER] A** |
| `app.publish("race", payload, TEXT, true)` | `tokio::sync::broadcast` d'une charge `Arc<str>` sérialisée une fois |
| `ws->unsubscribe("race")` sur `{t:'vis',hidden:true}` | le client cesse de lire le `broadcast` (message `vis` vers la tâche de simulation) |
| `idleTimeout` + `sendPingsAutomatically` | ping protocolaire toutes les 30 s, abandon si aucun pong |
| upgrade uniquement sur `/ws/race` | `Router::route("/ws/race", get(ws_handler))` |
| `ALLOWED_ORIGINS` ⇒ 403 brut | contrôle de l'en-tête `Origin` dans le handler, avant l'upgrade, `StatusCode::FORBIDDEN` |
| `us_timer` à ≈ 33 ms | `tokio::time::interval` avec `MissedTickBehavior::Skip` |

Un client lent ne doit jamais ralentir la simulation : un `broadcast` à capacité bornée
**écarte** les messages en retard (`RecvError::Lagged`) au lieu de bloquer l'émetteur. Le client
en retard saute des snapshots, ce que l'interpolation côté navigateur tolère
(`RENDER_DELAY_MS = 200`).

### 4.3 La boucle

Identique dans sa loi, différente dans son outil : accumulateur à pas fixe, `DT = 1/30`,
écoulé réel plafonné à 1 s, **au plus 5 pas de rattrapage** puis le retard est jeté
([migration-wss-2026-08.md](migration-wss-2026-08.md) §6.14). Diffusion tous les 3 pas
simulés, soit 10 Hz.

Le tick s'exécute dans **une seule tâche** possédant `WorldState`. Le pas de simulation est
synchrone et court (8 karts) : il ne rend jamais la main au milieu d'un pas, donc n'a besoin
d'aucun `.await` entre deux fonctions d'`engine/`. Si un jour un pas devenait long (IA de
masse), il passera dans `spawn_blocking` — pas avant.

---

## 5. Le contrat, clé par clé

**[REPRIS]** Intégralement : [moteur-cpp-plan.md](moteur-cpp-plan.md) §5.1 (`hello`, les 21
champs de `world`), §5.2 (`s`, le 13-uplet `k[]`, les alignements positionnels `ai[i]` ↔
`k[i]`, `b[i]` ↔ `hello.boxes[i]`, `gp[1][i]` ↔ `hello.karts[i]`) et §5.3 (`ping`, `vote`,
`watch`, `vis` — la transition caché → visible renvoie un `hello` entier ; charge plafonnée à
512 octets ; tout le reste ignoré en silence). Source de vérité : `raceEngine/src/protocol.js`.

Un champ manquant produit un rendu faux et **silencieux**, pas une erreur. Le contrat n'est
pas un endroit où le Rust peut « mieux faire ».

### 5.4 Les pièges d'écriture JSON, version Rust

Trois pièges, dont deux propres à Rust :

- **`Math.round` ≠ `f64::round`.** JS arrondit la moitié vers +∞ ; `f64::round` l'arrondit
  à l'opposé de zéro. Même piège que `std::round` en C++. Il faut
  `fn js_round(v: f64) -> f64 { (v + 0.5).floor() }`. Ça compte : `cx`, `dx`, `threatY` et
  les ombres passent en négatif.
- **`serde_json` écrit `1.0`, JS écrit `1`.** `serde_json` sérialise les `f64` avec `ryu`
  (représentation la plus courte, comme JS) mais **conserve le `.0`** d'un flottant entier.
  Le client compare des valeurs, pas des chaînes, donc ce n'est pas fatal — mais le champ
  `engine` de `/healthz` est lu par un `sed` du Makefile, et les diffs de sortie entre moteurs
  deviendraient bruyantes. D'où l'écrivain maison : un `f64` entier s'écrit en entier, sinon
  `ryu` sans `.0` superflu ; les entiers s'écrivent en entiers.
- **`NaN` et `±inf` ne sont pas du JSON.** `serde_json` les écrit `null` en silence ; un
  écrivain maison les écrirait tels quels et le client planterait. Le bug `lp` du C++ (tour
  du leader à l'infini, cf. [moteur-cpp-avancement.md](moteur-cpp-avancement.md) §4) montre
  que ça arrive. **L'écrivain refuse un flottant non fini** (`debug_assert!` en développement,
  remplacement par `0` et compteur d'erreur en production, jamais un `panic` qui tuerait la
  course).

---

## 6. La bascule Makefile

Trois valeurs pour `ENGINE` : `js` (défaut), `cpp`, `rust`. Aujourd'hui, `Makefile:22` ne
connaît que deux contextes :

```make
RACE_CONTEXT  = $(if $(filter cpp,$(ENGINE)),./raceEngineCpp,./raceEngine)
```

Il devient une chaîne de choix, sans changer l'idiome `export` → interpolation compose :

```make
RACE_CONTEXT  = $(if $(filter cpp,$(ENGINE)),./raceEngineCpp,\
                $(if $(filter rust,$(ENGINE)),./raceEngineRust,./raceEngine))
export RACE_CONTEXT
```

Cible neuve, calquée sur `engine-cpp` (`Makefile:253`) :

```make
engine-rust:         ## Bascule le service race sur le moteur Rust
	@echo rust > .engine
	@echo "moteur Rust choisi. Pour l'appliquer : make re-race"
```

`engine-rust` **imprime** `make re-race` sans le déclencher : pas de reconstruction surprise.

**Les outils.** Le bloc `ifeq ($(ENGINE),cpp)` de `race-tracks` / `race-sim` gagne une
branche `rust` (`/app/race_engine --tracks`, `--simulate`), le binaire Rust portant les mêmes
sous-commandes.

**`/healthz` gagne `engine: "rust"`.** Le `sed` de `make engine`
(`s/.*"engine":"\([^"]*\)".*/\1/p`) exige un JSON **sans espace** autour des deux-points : c'est
une contrainte sur l'écrivain de `json.rs`, pas sur `serde`.

### 6.1 Ce qui reste intouchable

Identique au plan C++ : service nommé `race` (`nginx/snippets/app.conf` code `race:3000` en
dur), `wget` dans l'image finale (sinon nginx ne démarre pas), réseau `frontend` seul,
plafonds 0,25 CPU / 128 Mo.

### 6.2 Le Dockerfile

Deux étapes, comme le C++ :

- **Builder** : `rust:alpine` (musl). `cargo build --release --locked`, avec un premier
  `COPY` de `Cargo.toml` + `Cargo.lock` seuls et un `src/main.rs` factice pour **mettre les
  dépendances en cache** : sans quoi la moindre retouche d'un fichier de gameplay
  retélécharge et recompile `tokio` et `axum`.
- **Runtime** : `alpine:3.20` — pas `scratch`, pour le `wget` du healthcheck. Le binaire est
  lié statiquement à musl : pas de `libstdc++`, pas de `zlib` à embarquer.
- Utilisateur non-root (`adduser -D -u 1000 race`), `EXPOSE 3000`, `tracks/` non copié.

**Contrainte d'environnement :** `cargo` et `rustc` ne sont **pas installés** sur la machine
de travail (constaté le 2026-09-21), et `docker` n'y est pas toujours accessible (cf.
[moteur-cpp-avancement.md](moteur-cpp-avancement.md) §4). Deux voies : installer `rustup`
en local pour `cargo test` / `cargo run`, ou tout compiler via l'image. Le jalon R0 doit
trancher avant d'écrire la première ligne.

---

## 7. Jalons

Même découpage que M0-M5, chacun terminé par quelque chose qui tourne et se vérifie.

**R0 — le service parle.** Workspace, `Cargo.lock`, Dockerfile, bascule Makefile,
`/healthz`, upgrade `/ws/race`, `hello` / `s` / `pong` + les 4 messages entrants, sur un monde
**en dur** (un circuit codé, 8 karts à vitesse constante). C'est le vrai jalon : il prouve le
contrat de bout en bout avant la moindre ligne de moteur, **et il mesure la taille d'un
snapshot non compressé** pour éclairer le point **[À TRANCHER] A**.
*Vérif : `make engine-rust && make re-race && make race-nginx` → aucun `MANQUE`, karts qui
roulent, décor qui défile.*

**R1 — les circuits.** Port de `track.js` : parseur du bloc ` ```track `, alphabet `X x B .`
et pipes en carrés 2×2 (`PP/PP`, `pp/pp`, découpés dans le sens de lecture), `CELL_PX = 80`,
les erreurs dures (dont pipe incomplet, pipe qui mélange `P` et `p`, pipe coupé par le bord
droit), les 2 avertissements, `apply_track`, `load_tracks` (tri par nom), `for_round`. Sous-commande `--tracks`.
*Vérif : sortie de `make race-tracks` identique entre les trois moteurs sur
`tracks/01-anneau-du-moai.md`.*

**R2 — les karts et leurs stats.** `derive_character_stats` (8 personnages, budget 15
points), `derive_bodies`, la grille (4 rangs × 2 colonnes, `laneSlope` réparti), le décompte,
les panneaux Lakitu, l'élan, le comptage des tours. `finish_distance = laps × width +
gap_to_line`.
*Vérif : grille identique au JS à 8 karts (3.15→8.93 / 24.85→30.63), tenue à 12.*

**R3 — course, classement, grand prix.** Phases `countdown → racing → finishing → results`,
rangs par **distance restante** (jamais `total_distance`), `leaderboardPosition` toutes les
500 ms, `award_race_points` indexé par `char_name`, caméra d'approche et parking, enchaînement
des 4 manches, vote unanime, `SIGHUP`, arrêt 30 s après le dernier spectateur.

**R4 — latéral et boîtes.** `steering.rs`, `steer()` **seule fonction qui écrit `vy`**
(invariant obtenu au prix fort, cf. `audit-pilotage-2026-08.md` §7.2 — il ne se reperd pas),
`clamp_kart_to_road`, errance évitant les tuyaux, choc de tuyau (`FLAG_BUMPED` + `bumpEnd`),
boîtes consommées et régénérées, `give_kart_item()` vide.

**R5 — le banc.** `--simulate` (mulberry32, `--races`, `--seed`, `--chain`, `--csv`,
`--track`), `--soak`, `--duration` / `--always-on`, `--karts`, `--laps`. Ajout d'un banc
`cargo bench` (Criterion) sur `step_physics` : c'est la mesure qui sert à choisir entre les
moteurs le jour où l'IA devient coûteuse.

**Ensuite, le terrain de jeu — dans le même ordre que le C++** : `items.rs`, puis
`resolve_kart_contacts`, `vision.rs` + `choose_lane`, `weapons.rs`, `plans.rs`.

---

## 8. Fichiers touchés

**Créés** — tout `raceEngineRust/`, et ce document.

**Modifiés** :

| Fichier | Changement |
|---|---|
| `Makefile` | `RACE_CONTEXT` en chaîne à trois choix, cible `engine-rust`, branche `rust` dans les blocs d'outils, `.PHONY` |
| `.gitignore` | `raceEngineRust/target/` — **et, à vérifier, `.engine` et `raceEngineCpp/build/`** : le `.gitignore` ne les contient pas alors que le plan C++ les annonçait, et `.engine` apparaît en fichier non suivi |
| `docs/banner/README.md` | ligne d'index vers ce document |
| `README.md`, `CHANGELOG.md` | ligne d'architecture, entrée `[Non publié] → #### Infrastructure` |

`docker-compose.yml` **ne change pas** : `context: ${RACE_CONTEXT:-./raceEngine}` suffit déjà.

**Jamais touchés :** `frontEnd/` (aucune ligne), `nginx/`, `backEnd/`, `nix/`,
`raceEngine/src/engine/`, `raceEngine/src/config/`, et **tout `raceEngineCpp/`**.

---

## 9. Conventions d'écriture

**[REPRIS]** Commentaires du code **en français, sans accents**, qui expliquent le *pourquoi*
avec le contre-factuel (« sans quoi… », « auparavant… »). Documents et CHANGELOG en français
accentué ; CHANGELOG au format `- **Terme en gras** : ` suivi d'une phrase qui dit pourquoi.

Idiomes Rust, sans conflit avec la règle : `cargo fmt` (défaut) et `cargo clippy -- -D
warnings` en critère de fin de jalon ; pas de `unwrap()` hors tests et hors initialisation du
démarrage ; les erreurs de chargement de circuit remontent en `Result` avec un message qui
nomme le fichier et la case, comme les erreurs dures du JS.

---

## 10. Vérification

1. **Parité des circuits** — `make race-tracks` sous `ENGINE=js`, `cpp`, `rust` : longueur de
   tour, colonne d'arrivée, boîtes, tuyaux, passage le plus étroit coïncident.
2. **Contrat WS** — aucun `MANQUE` dans l'audit du `hello`, cadence ≈ 10 snapshots/s,
   `{t:'vis',hidden:true}` coupe le flux, `hidden:false` renvoie un `hello` complet.
3. **Le test de l'arrivant** — `bannerDev.wipeDom()` : la scène se reconstruit entière depuis
   le seul snapshot suivant.
4. **À l'œil** — décor, grille, décompte, feu vert, course, classement latéral, ordre
   d'arrivée, tableau du GP après la 4ᵉ manche, vote de redémarrage.
5. **Debug** — `GAME_CONFIG.debugMode = true` puis `bannerDev.reconnect()` : carte de piste,
   HUD IA (`cruising` pour tous), clic sur une vignette = `watch`.
6. **Endurance** — `make race-soak DURATION=600 ENGINE=rust` : pas de fuite (RSS stable), pas
   de NaN.
7. **Retour arrière** — `make engine-js && make re-race` : le front ne bronche pas.
8. **Trois moteurs, un front** — alterner `js` → `cpp` → `rust` → `js` sans toucher au
   navigateur. C'est la preuve que le contrat a tenu partout.
9. **Nouveau, propre au Rust** — `cargo test -p race_core` passe **sans réseau**, et
   `cargo tree -p race_core` ne fait apparaître ni `axum` ni `tokio` : la garantie de §4.1bis
   se vérifie en une commande.

---

## 11. Registre des pièges

**[REPRIS]** P-1 à P-7 de [moteur-cpp-plan.md](moteur-cpp-plan.md) §11 s'appliquent sans
changement (`PROTOCOL_VERSION` à 11 ; `t0` seul discriminant course neuve / reprise ;
`RENDER_DELAY_MS = 200` calé sur 10 Hz ; `ts` avance par pas simulé ; pas de parité flottante
bit à bit ; le monde boucle ; `RACE_CONTEXT` lu dans l'environnement).

Propres au Rust :

| | Piège |
|---|---|
| R-1 | **`serde_json` écrit `1.0` là où JS écrit `1`,** et transforme `NaN` en `null`. Écrire les snapshots à la main (§5.4). `serde` reste bon pour lire les messages entrants. |
| R-2 | **`f64::round` ≠ `Math.round`** sur les moitiés négatives. `js_round(v) = (v + 0.5).floor()` partout où le JS arrondit. |
| R-3 | **`permessage-deflate` absent** d'`axum` / `tungstenite`. Écart de bande passante avec le C++, à mesurer en R0 (**[À TRANCHER] A**). |
| R-4 | **`mulberry32` demande des opérations modulo 2³².** `Math.imul` → `u32::wrapping_mul`, additions en `wrapping_add`. Un débordement arithmétique est un `panic` en debug et un repli silencieux en release : la graine ne donnerait plus la même course d'un mode de compilation à l'autre. |
| R-5 | **`powf`/`sin`/`cos` dépendent de la libm,** et musl n'est pas glibc. Comme P-5 : on vise l'équivalence de comportement, pas la parité bit à bit — le banc doit comparer des **distributions**, pas des courses. |
| R-6 | **Un `.await` tenu pendant l'accès à l'état.** Si un jour l'état est partagé derrière un verrou, ne jamais le garder à travers un `.await`. La conception §3.2 l'évite en n'ayant aucun verrou : ne pas en introduire « juste pour un cas ». |
| R-7 | **Un client lent bloque une file non bornée.** Toute file entre la simulation et une socket doit être bornée, avec abandon des messages en retard. Sans quoi un onglet en arrière-plan fait grossir la mémoire du service jusqu'au plafond de 128 Mo. |
| R-8 | **Le premier `cargo build` télécharge tout.** Le cache de dépendances du Dockerfile (§6.2) n'est pas une optimisation : sans lui, chaque `make re-race` recompile `tokio` et `axum`, dans un conteneur plafonné à 0,25 CPU. |

---

## 12. À TRANCHER

**A — `permessage-deflate`.** Le Rust n'a pas la compression WebSocket que le C++ obtient d'uWS.
À mesurer en R0 (taille d'un snapshot, débit par spectateur), puis choisir :

1. **Assumer l'absence** si le débit reste faible à 8 karts et 10 Hz. Le plus simple, et
   probablement suffisant ; à documenter comme écart connu.
2. **Compresser à la main** : `flate2` en `deflate` par message, et gérer nous-mêmes
   l'extension. Fastidieux et fragile : les navigateurs attendent un protocole précis.
3. **Choisir une autre bibliothèque WebSocket** qui implémente l'extension. À vérifier au
   moment de trancher — l'écosystème évolue, ne pas s'appuyer sur la mémoire de ce document.

Recommandation : mesurer d'abord. Le débit d'un snapshot de 8 karts ne justifie sans doute pas
de compliquer le service.

**B — Toolchain locale ou tout en conteneur** (§6.2) : installer `rustup` sur la machine de
travail, ou compiler exclusivement via Docker. Le premier donne `cargo test` et un cycle
d'itération rapide ; le second évite d'installer quoi que ce soit.

**C — Un workspace à deux crates (§4.1) ou un seul crate.** Deux crates donnent la garantie
mécanique de §4.1bis pour un léger surcoût de structure. Un seul crate garde le calque
fichier-pour-fichier plus simple, mais retombe sur la garantie « par discipline » du C++.
Recommandation : deux crates.
