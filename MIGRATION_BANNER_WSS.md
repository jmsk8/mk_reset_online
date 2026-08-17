# Migration du banner SMK vers WebSocket (WSS)

> Objectif : **tous les visiteurs voient exactement la même course**, au lieu d'une
> simulation locale et aléatoire par navigateur.
>
> Statut : **note de préparation** — aucun code n'a encore été modifié.
> Rédigée le 2026-08-17 sur la branche `feature/stats-saison-matchmaking-public`.

---

## 1. État actuel (cartographie)

### Ce qui existe

| Fichier | Rôle | Taille |
|---|---|---|
| [frontEnd/static/js/physics.js](frontEnd/static/js/physics.js) | Moteur de simulation **pur** (UMD). `stepPhysics(cfg, state, rng, now, dt, isMobile)` mute `state` et retourne une liste d'événements. | 778 l. |
| [frontEnd/static/js/smk-banner.js](frontEnd/static/js/smk-banner.js) | `GAME_CONFIG` + création du monde + boucle `requestAnimationFrame` + rendu DOM. | 1001 l. |
| [frontEnd/static/css/smk-banner.css](frontEnd/static/css/smk-banner.css) | Styles, animations CSS (route, neige, star, hit). | 417 l. |
| [frontEnd/templates/index.html:79-101](frontEnd/templates/index.html#L79-L101) | Le bloc `<section class="hero smk-snes-banner">` et ses calques. | |
| [frontEnd/templates/index.html:257-258](frontEnd/templates/index.html#L257-L258) | Chargement de `physics.js` puis `smk-banner.js`. | |

### Comment ça tourne aujourd'hui

1. `DOMContentLoaded` → [`initWorld()`](frontEnd/static/js/smk-banner.js#L351) crée 8 karts, mélange
   les personnages avec [`shuffleArray`](frontEnd/static/js/smk-banner.js#L409) (`Math.random`), crée les
   item-boxes et le DOM.
2. [`animate()`](frontEnd/static/js/smk-banner.js#L715) appelle `PH.stepPhysics(...)` à chaque frame,
   applique les événements retournés via [`applyEvent`](frontEnd/static/js/smk-banner.js#L544), puis
   [`renderState`](frontEnd/static/js/smk-banner.js#L590).
3. Le temps de jeu vient de [`getGameTime()`](frontEnd/static/js/smk-banner.js#L138)
   = `Date.now() - globalTimeOffset`, et le RNG est [`Math.random`](frontEnd/static/js/smk-banner.js#L144).

**→ Chaque onglet a son propre monde, son propre RNG, sa propre horloge.** D'où la divergence.

### Infra

- `frontend` : Flask + `gunicorn -w 2` (workers **sync**) — voir [frontEnd/Dockerfile.frontend](frontEnd/Dockerfile.frontend).
- `backend` : Flask + gunicorn, seul à parler à Postgres.
- `nginx` : reverse proxy, deux modes via `TLS_MODE` (`http` / `https`), config applicative
  factorisée dans [nginx/snippets/app.conf](nginx/snippets/app.conf) (inclus par **les deux** templates).
- **Aucune infra WebSocket / SSE nulle part** dans le projet aujourd'hui.
- Limites de ressources serrées (commit `fbb1303`) : `cpus: '0.5'`–`'1'`, `memory: 128M`–`512M`.

---

## 2. Décision d'architecture (à trancher en début de prochaine session)

### Option A — Serveur autoritatif + diffusion d'état ✅ **recommandée**

Un service dédié fait tourner `stepPhysics` à pas fixe et diffuse des snapshots ;
les clients ne font **que du rendu** (avec interpolation).

- ✅ Identité stricte garantie, quelles que soient les capacités du client.
- ✅ Robuste : onglet en arrière-plan, mobile, arrivée en cours de course, CPU lent.
- ❌ Bande passante (~5–10 Ko/s par visiteur, voir §6.7) + couche d'interpolation à écrire.

### Option B — Seed partagé + simulation déterministe côté client

Le serveur ne diffuse qu'un *seed* + un `t0` ; chaque client rejoue la même simulation
avec un PRNG semé (mulberry32/xorshift) et un pas de temps fixe.

- ✅ Bande passante quasi nulle, pas besoin de WebSocket du tout (un simple endpoint HTTP suffirait).
- ❌ Exige un **déterminisme parfait** : pas fixe obligatoire, suppression de `isMobile` de la physique
  (§6.1), aucune divergence flottante tolérée.
- ❌ **Rattrapage impossible** : un visiteur qui arrive 3 h après le début devrait simuler 3 h de physique.
  Impose de redémarrer la course toutes les N minutes, ou d'envoyer des checkpoints d'état.
- ❌ La mise en pause d'onglet actuelle ([`globalTimeOffset`](frontEnd/static/js/smk-banner.js#L889))
  fait diverger l'horloge de jeu du temps réel — à supprimer de toute façon.

### Recommandation

**Option A**, en **Node.js**, en réutilisant `physics.js` *tel quel*.
Le module est déjà compatible Node — voir le wrapper UMD [physics.js:1-8](frontEnd/static/js/physics.js#L1-L8)
qui exporte via `module.exports`. Aucune réécriture, donc **aucun risque de dérive** entre le
moteur serveur et le moteur client de secours.

> **Si portage Python plutôt que Node** : il faut réécrire ~780 lignes de JS en Python et
> les maintenir en parallèle du fallback client. Coût réel élevé et dérive quasi certaine à
> la première évolution de gameplay. À n'envisager que pour éviter d'ajouter une stack Node.

Dimensionnement : 8 karts + ~8 items à 30 Hz ≈ rien du tout. Un `node:22-alpine` avec la lib
`ws` (zéro dépendance transitive) tient dans `cpus: '0.25'` / `memory: 128M`.

---

## 3. Changements à faire, fichier par fichier

### 3.1 Nouveau service `raceEngine/` (à créer)

```
raceEngine/
  server.js          # boucle de simulation + serveur WS + /healthz
  config.js          # constantes physiques partagées (extraites de GAME_CONFIG)
  package.json       # dépendance unique : ws
  Dockerfile.race
  .dockerignore
```

- Importe `physics.js` (montage bind ou copie au build — **le même fichier que le front**).
- Boucle à pas fixe (`dt = 1/30`) avec accumulateur + plafond de rattrapage.
- Maintient l'état monde + la liste des clients connectés.
- Expose `GET /healthz` pour le `healthcheck` compose.
- **Aucun accès à Postgres, aucun accès au `backend`.** Réseau `frontend` uniquement.

### 3.2 [frontEnd/static/js/smk-banner.js](frontEnd/static/js/smk-banner.js)

C'est là que se concentre le travail côté client.

| Zone | Changement |
|---|---|
| [`initWorld` L351-482](frontEnd/static/js/smk-banner.js#L351) | Ne crée plus le monde. Devient `buildWorldFromSnapshot(hello)` : construit le DOM **à partir du snapshot serveur** (assignation personnage↔couloir incluse). Supprimer le `shuffleArray` local L409. |
| [`animate` L715-741](frontEnd/static/js/smk-banner.js#L715) | Ne fait plus tourner `stepPhysics`. Devient : interpoler entre les 2 derniers snapshots → `renderState`. |
| [`renderState` L590-713](frontEnd/static/js/smk-banner.js#L590) | Quasi inchangé (c'est déjà du rendu pur), mais lit un état *interpolé*. Doit aussi **réconcilier le DOM** (créer les éléments manquants, supprimer les orphelins). |
| [`applyEvent` L544-588](frontEnd/static/js/smk-banner.js#L544) | Conservé, mais les événements ne servent plus qu'aux **fioritures** (spin de hit, glissement du classement). Voir §6.5. |
| [`getGameTime` L138](frontEnd/static/js/smk-banner.js#L138) / `globalTimeOffset` | Remplacé par une horloge calée sur le serveur (§6.8). |
| [`rng` L144](frontEnd/static/js/smk-banner.js#L144) | Disparaît du chemin de jeu (reste utile pour la neige). |
| [`handleVisibilityChange` L875-899](frontEnd/static/js/smk-banner.js#L875) | Sémantique changée : la course continue sans nous. Voir §6.4. |
| `GAME_CONFIG` L1-127 | À scinder : constantes **physiques** (monde, route, hitboxes, vitesses, items, IA) → serveur ; constantes **visuelles** (chemins d'images, tailles, z-index, breakpoint mobile) → client. Voir §6.9. |
| Nouveau | Module client WS : connexion, backoff, buffer de snapshots, resync, fallback local. |

### 3.3 [frontEnd/static/js/physics.js](frontEnd/static/js/physics.js)

- Sortir `isMobile` de la signature de `stepPhysics` (§6.1). C'est la **seule modification
  fonctionnelle nécessaire** dans ce fichier.
- Reste chargé par le navigateur **uniquement en mode dégradé** (§6.10) — donc en `import()`
  paresseux, plus dans un `<script>` au chargement de page.

### 3.4 [frontEnd/templates/index.html](frontEnd/templates/index.html)

- L257-258 : retirer le `<script src="physics.js">` du chargement initial.
- Ajouter un cache-buster `?v={{ app_version }}` sur les `<script>`/`<link>` du banner (§6.11).
- Rien à changer dans le markup du banner L79-101 : les calques et conteneurs restent identiques.

### 3.5 [nginx/snippets/app.conf](nginx/snippets/app.conf)

Ajouter **avant** `location /` (fichier inclus par les templates `http` **et** `https`, donc
une seule modif couvre les deux modes) :

```nginx
location /ws/ {
    proxy_pass http://race:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host       $host;
    proxy_set_header X-Real-IP  $remote_addr;
    proxy_read_timeout  3600s;   # sinon nginx coupe à 60 s d'inactivité
    proxy_send_timeout  3600s;
    proxy_buffering     off;
    limit_conn          ws_conn 5;   # zone à déclarer dans nginx.conf
}
```

Et dans [nginx/nginx.conf](nginx/nginx.conf), à côté des `limit_req_zone` existants :

```nginx
limit_conn_zone $binary_remote_addr zone=ws_conn:10m;
```

> Le bloc regex existant `location ~* \.(js|css|…)$` ne capte pas `/ws/race` (pas d'extension) :
> pas de collision. `location /admin` est un préfixe distinct : pas de collision non plus.

### 3.6 [docker-compose.yml](docker-compose.yml)

```yaml
  race:
    build:
      context: ./raceEngine
      dockerfile: Dockerfile.race
    expose:
      - "3000"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 10s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:
          cpus: '0.25'
          memory: 128M
    networks:
      - frontend        # ⚠️ surtout PAS `backend`
```

Puis ajouter `race` dans le `depends_on` du service `nginx`.

### 3.7 Divers

- [Makefile](Makefile) : rien d'obligatoire, mais une cible `logs-race` sera pratique.
- [CHANGELOG.md](CHANGELOG.md) : entrée à ajouter en fin de migration.
- [frontEnd/frontend.py:36](frontEnd/frontend.py#L36) : bump `APP_VERSION` (sert de cache-buster, §6.11).

---

## 4. Protocole WebSocket proposé

Endpoint : `/ws/race` — **lecture seule**, aucune authentification (contenu public).

### Serveur → client

**`hello`** (une fois, à la connexion et après chaque reconnexion) :

```jsonc
{
  "t": "hello",
  "protocol": 1,
  "serverTime": 1755450000123,        // ms, référence de temps unique
  "world": {                           // constantes physiques : le client n'en garde AUCUNE copie
    "width": 3840, "finishLineX": 1440,
    "roadMinY": 0, "roadMaxY": 30, "roadPPS": 250
  },
  "karts": [                           // assignation personnage ↔ couloir décidée par le serveur
    { "id": 0, "char": "yoshi", "lane": 12.8 }, ...
  ],
  "boxes": [ { "x": 3456, "y": 0 }, ... ],
  "snapshot": { /* identique au message `state` ci-dessous */ }
}
```

**`state`** (~15 Hz) — format compact, tableaux plutôt qu'objets :

```jsonc
{
  "t": "s",
  "ts": 1755450000456,                 // temps serveur du tick
  "k": [ [id, worldX, y, stateCode, rank, heldItemId] , ... ],
  "i": [ [id, type, worldX, y, frame] , ... ]
}
```

**`ev`** (au fil de l'eau, groupés avec le `state` du même tick) : la liste d'événements
déjà produite par `stepPhysics` (`kartHit`, `starOn`/`starOff`, `spawnHeldItem`,
`removeHeldItem`, `killItem`, `leaderboardPosition`, `kartSpawned`).

### Client → serveur

Le serveur **ignore tout le reste**. Seuls messages acceptés :

- `{"t":"ping","c":<clientTime>}` → réponse `{"t":"pong","c":<clientTime>,"s":<serverTime>}` (calage d'horloge).
- `{"t":"vis","hidden":true|false}` → le serveur cesse / reprend l'envoi des snapshots à ce client
  (gros gain sur mobile).

---

## 5. Ordre de travail suggéré

1. **Extraire `isMobile` de `physics.js`** (§6.1) et vérifier que le banner actuel tourne toujours
   à l'identique en local. *Commit isolé, sans WS : ça dérisque tout le reste.*
2. Extraire les constantes physiques de `GAME_CONFIG` dans un module partagé (§6.9). *Commit isolé.*
3. Écrire `raceEngine/server.js` : boucle à pas fixe + `console.log` du classement, **sans WS**.
   Vérifier sur 10 minutes qu'aucun `NaN` n'apparaît et qu'aucun kart ne se bloque.
4. Ajouter le serveur `ws` + le protocole `hello`/`state`/`ev`. Tester avec `websocat` ou un
   petit script Node.
5. Compose + nginx : faire passer la connexion de bout en bout (`ws://` en local d'abord).
6. Côté client : remplacer `initWorld`/`animate` par le pipeline WS + interpolation.
7. Fallback local si le WS échoue (§6.10).
8. Reconnexion + backoff + resync sur `visibilitychange`.
9. Validation en `TLS_MODE=https` (`wss://`), puis deux navigateurs côte à côte pendant 5 min.

---

## 6. Points d'attention (les pièges réels)

### 6.1 ⚠️ `isMobile` est *dans* la physique — bloquant

[`stepPhysics(..., isMobile)`](frontEnd/static/js/physics.js#L382) le propage à
[`giveKartItem` L237-256](frontEnd/static/js/physics.js#L237) → [`getHeldItemOffset` L220-231](frontEnd/static/js/physics.js#L220),
qui **stocke `offset`/`yShift` dans l'état du kart**, et à
[`activateItem` L285-289](frontEnd/static/js/physics.js#L285) pour la position de spawn des carapaces.

Conséquence : **l'état du monde diffère selon l'appareil**. Un objet lâché n'est pas au même endroit
sur mobile et sur PC, donc les collisions divergent. C'est incompatible avec un monde partagé,
quelle que soit l'option d'architecture retenue.

#### Ce qui change vraiment entre PC et mobile

Le scaling visuel mobile (`transform: scale(0.6)` sur `.game-content-wrapper`,
[smk-banner.css:26-35](frontEnd/static/css/smk-banner.css#L26-L35)) ne touche que le rendu — les unités
« monde » restent identiques sur les deux appareils. Les sprites, eux, sont redimensionnés
indépendamment (kart 100→80px, carapaces 48→32, banane 36→28, shroom/star 36→26,
[css:144-148](frontEnd/static/css/smk-banner.css#L144-L148) et alentours). Les offsets `isMobile`
ne sont donc au départ qu'une **compensation visuelle de la taille des sprites** — sauf qu'ils sont
stockés dans l'état du monde et relus par les collisions.

Seules deux constantes sont concernées, un écart de 15 unités chacune :

| | PC | Mobile |
|---|---|---|
| `heldItemBehind` (banane, carapaces) | **-50** | **-35** |
| `shellSpawn` | **+50** | **+35** |

Elles interviennent à quatre endroits :

1. **Position de dépôt de la banane** — [physics.js:285](frontEnd/static/js/physics.js#L285), `startX = kart.worldX + held.offset` (les carapaces écrasent ensuite avec `shellSpawn`). La banane reste 40 s sur la piste (`bananaLife`) à un endroit différent selon l'appareil.
2. **Position de spawn des carapaces** — [physics.js:286-289](frontEnd/static/js/physics.js#L286-L289).
3. **L'objet traîné comme arme** — [physics.js:543-578](frontEnd/static/js/physics.js#L543-L578).
4. **L'objet traîné comme bouclier** — [physics.js:708-723](frontEnd/static/js/physics.js#L708-L723).

Le cas 4 est le plus parlant. Avec `hitboxes.itemVsKart.x = 40`, la fenêtre d'absorption est :

- PC : `[worldX-90, worldX-10]` → s'arrête **10 unités avant** le kart
- Mobile : `[worldX-75, worldX+5]` → **dépasse** le centre du kart de 5 unités

Une carapace arrivant pile dans l'axe est donc **absorbée sur mobile et encaissée sur PC**. Ce n'est
pas un décalage de quelques pixels, c'est une issue binaire qui bascule. À noter : les hitboxes
(`kartVsKart.x = 60`, `itemVsKart.x = 40`) ne changent **pas** avec `isMobile` — confirmation que ces
offsets ont été réglés à l'œil pour le placement visuel, sans intention de gameplay.

#### Pourquoi c'est bloquant, et pas « approximatif »

Le vrai problème est la cascade. Un seul hit qui bascule change `totalDistance` → donc le classement
via `updateLeaderboard` → donc `kart.rank` et `distToLeader` → donc le palier de `rollItem` → donc
**le nombre d'appels à `rng()`**. Or `randomRange` est consommé par les timers de vagabondage, les
cibles de momentum, les tirages d'objets, la vitesse verticale des carapaces, la récupération après
impact.

Dès qu'un client consomme un `rng()` de plus que l'autre, les deux flux aléatoires sont
**désynchronisés définitivement**. Les deux simulations ne divergent donc pas « un peu » : elles
sont identiques quelques secondes, puis deviennent deux courses entièrement différentes à la
première collision marginale.

C'est ce qui condamne l'option B (seed partagé, §2) sans appel, et qui fait qu'en option A il n'y a
pas de compromis possible : le serveur doit détenir une valeur canonique unique.

#### Le reste de `isMobile` : purement visuel

Aucun impact sur l'état du monde — tailles des sprites d'objets (`getItemVisualConfig`), largeur des
slots du classement (46→32), flocons de neige (100→50 et 30→15), le culling
([smk-banner.js:727-730](frontEnd/static/js/smk-banner.js#L727-L730)), et `heldItem.yShift`
(30→25, jamais lu par la physique : les collisions utilisent `kart.yPercent` directement). Les
offsets « mains » (28→18) sont visuels eux aussi, puisque le code de collision ne teste que
`holdPosition === 'behind'`.

Deux bugs annexes relevés en creusant, sans rapport avec la migration mais à garder en tête :

- `visuals.box.sizePC` et `sizeMobile` valent tous deux **42** — différenciation morte.
- `heldItem.offset` est figé au moment où l'objet est donné, alors que `updateMobileStatus()` tourne
  à chaque frame : franchir le seuil de 769px (redimensionnement, rotation de tablette) en tenant un
  objet conserve la valeur de l'ancien appareil jusqu'au lancer. Le code actuel n'est donc même pas
  cohérent avec lui-même sur un seul client.

**Correctif** : le serveur utilise toujours les offsets « monde » (valeurs PC), et le client applique
le facteur mobile **au rendu uniquement** — exactement comme il le fait déjà pour la largeur d'écran
en [smk-banner.js:727-730](frontEnd/static/js/smk-banner.js#L727-L730). Concrètement, la correction se
fait au point où l'offset sert au rendu, [smk-banner.js:671](frontEnd/static/js/smk-banner.js#L671)
(`hx = rx + kart.heldItem.offset` → offset choisi côté client selon `cachedIsMobile`, indépendamment
de la valeur simulée par le serveur).

Effet de bord à accepter : le sprite sera dessiné à 15 unités de l'endroit simulé, soit 15 × 0,6 =
**9px physiques** sur mobile. Invisible en pratique. Si on préfère zéro écart, garder -50 au rendu
aussi : l'objet sera juste un peu plus loin derrière un kart plus petit.

### 6.2 ⚠️ `gunicorn -w 2` : deux processus = deux courses

Le frontend tourne avec **2 workers sync** ([Dockerfile.frontend](frontEnd/Dockerfile.frontend)).
Héberger le WS dans Flask donnerait deux simulations indépendantes : la moitié des visiteurs
verrait la course A, l'autre la course B — soit exactement le bug qu'on cherche à corriger,
en plus vicieux car intermittent.

**Règle** : le moteur de course doit être un **processus unique**. Service dédié, `replicas: 1`,
jamais scalé. (Et si un jour il faut scaler : un seul « leader » simule, les autres relaient via
un bus type Redis — pas au programme ici.)

### 6.3 ⚠️ Interpolation et bouclage du monde

`worldX` boucle à `world.width = 3840` ([physics.js:492-497](frontEnd/static/js/physics.js#L492)).
Interpoler naïvement entre `x=3830` et `x=20` fait **traverser toute la carte à l'envers**.

**Correctif** : interpoler avec la logique de plus court chemin —
[`getShortestDistance`](frontEnd/static/js/physics.js#L39) existe déjà et gère exactement ce cas.
Alternative plus sûre : interpoler sur `totalDistance` (monotone, jamais bouclé) et en déduire `worldX`.

### 6.4 ⚠️ La pause d'onglet change de sens

[`handleVisibilityChange`](frontEnd/static/js/smk-banner.js#L875) *gèle le monde* et décale
`globalTimeOffset` pour reprendre exactement où on s'était arrêté. Avec un serveur autoritatif,
**la course continue sans nous**.

À faire au retour d'onglet :
- **sauter** à l'état serveur courant (surtout pas reprendre l'ancien),
- vider le buffer de snapshots périmés,
- recaler l'horloge (un onglet mobile en arrière-plan peut avoir dérivé de plusieurs secondes).

L'overlay « PAUSE » devient un simple indicateur *local de rendu* — ou se supprime.
Garder l'arrêt du `requestAnimationFrame` (les navigateurs le bridant à ~1 fps de toute façon)
et envoyer `{"t":"vis","hidden":true}` pour couper le flux.

### 6.5 ⚠️ Les événements sont transitoires — le snapshot fait foi

`applyEvent` traite des événements ponctuels (`kartSpawned`, `spawnHeldItem`, `starOn`…).
Un client qui se connecte en cours de course **les a tous ratés**, et un événement peut se perdre
lors d'une micro-coupure.

**Règle à adopter** : *le snapshot est la vérité, les événements ne sont que de la décoration.*
- `renderState` réconcilie le DOM avec le snapshot (crée ce qui manque, supprime les orphelins).
- Les événements ne déclenchent que les animations (spin de hit, glissement au classement,
  halo étoile) — jamais la création/destruction logique d'une entité.

Sans ça : items fantômes, karts invisibles et éléments DOM qui fuient à chaque reconnexion.

### 6.6 ⚠️ La caméra et l'animation CSS de la route

- `cameraX` est mis à jour dans [physics.js:387-390](frontEnd/static/js/physics.js#L387) à vitesse
  constante. Comme elle détermine *ce qu'on voit du monde*, elle doit être partagée. Mais comme elle
  est parfaitement déterministe, **la dériver du temps serveur côté client** donne un résultat plus
  fluide que de l'envoyer dans chaque snapshot :
  `cameraX = (roadPPS * (serverNow - t0) / 1000) % worldWidth`. La garder dans le snapshot
  uniquement comme garde-fou de dérive.
- Le défilement de la route est une **animation CSS infinie** non synchronisée
  ([smk-banner.css:108](frontEnd/static/css/smk-banner.css#L108), `--road-anim-duration`).
  Sa phase différera d'un client à l'autre. C'est purement cosmétique (une texture qui défile) —
  **acceptable en l'état**. Pour une identité stricte, piloter `background-position` depuis `cameraX`,
  comme le fait déjà `.layer-scrolling-bg` en [smk-banner.js:593-598](frontEnd/static/js/smk-banner.js#L593).

### 6.7 ⚠️ Bande passante — le vrai coût

8 karts + jusqu'à ~8 items. Snapshot compact ≈ 400–700 octets → **~6–10 Ko/s par visiteur à 15 Hz**,
soit ~30 Mo/h. Sur mobile en 4G, c'est visible.

Leviers, par ordre de rentabilité :
1. Couper le flux pour les onglets cachés (message `vis`) — souvent la moitié des connexions.
2. Descendre à 10 Hz de diffusion (la simulation reste à 30 Hz) + interpolation client.
3. Envoyer uniquement les karts dont l'état a bougé au-delà d'un epsilon.
4. Activer `permessage-deflate` (gain net sur du JSON répétitif).
5. En dernier recours : encodage binaire (`ArrayBuffer`, positions en `Int16`).

Ne pas optimiser d'entrée : mesurer d'abord avec l'audience réelle du site.

### 6.8 ⚠️ Horloges clientes non fiables

Aucun `Date.now()` client ne doit entrer dans un calcul partagé. Au `hello` puis toutes les ~30 s,
estimer l'offset par ping/pong (`offset = serverTime + rtt/2 - clientTime`), et rendre à
`serverNow - renderDelay` avec un tampon de **100–150 ms** (une trame et demie à 15 Hz) pour
avoir toujours deux snapshots à interpoler.

### 6.9 ⚠️ `GAME_CONFIG` dupliqué = dérive garantie

Si le serveur garde sa copie de `world.width`, `road.minY/maxY`, `hitboxes`, `speeds`…, la
moindre retouche de gameplay désynchronisera silencieusement le rendu.

**Solution la plus propre** : le serveur **envoie** les constantes de monde dont le client a
besoin dans le `hello` (voir §4), et le client ne conserve que les constantes purement visuelles
(chemins d'images, tailles en px, `zIndexBase`, `mobileBreakpoint`, `mobileScale`).
Ajouter un champ `protocol` dans le `hello` : si le client attend une autre version, il bascule
en mode dégradé plutôt que d'afficher n'importe quoi.

### 6.10 ⚠️ Mode dégradé obligatoire

Le banner est la pièce maîtresse de la page d'accueil. Si le service `race` est down, en cours de
redémarrage, ou bloqué par un proxy d'entreprise qui casse les WebSockets, **il ne faut pas laisser
une image figée**.

**Solution** : si la connexion échoue (ou après N tentatives de reconnexion), charger `physics.js`
en `import()` paresseux et relancer la simulation locale actuelle. On y perd la synchronisation,
on garde une page vivante. C'est aussi ce qui permet de retirer `physics.js` du chargement initial
et d'alléger la page d'accueil pour le cas nominal.

### 6.11 ⚠️ Cache navigateur de 7 jours sur les JS

[nginx/snippets/app.conf:9-15](nginx/snippets/app.conf#L9-L15) sert les `.js` avec `expires 7d`, et
aucun template n'ajoute de cache-buster (`app_version` n'est utilisé que dans
[footer.html:4](frontEnd/templates/footer.html#L4)).

Au déploiement, des visiteurs récurrents garderont donc **l'ancien `smk-banner.js` face au nouveau
protocole serveur** pendant jusqu'à 7 jours. À faire *avant* la bascule :
ajouter `?v={{ app_version }}` aux `<script>`/`<link>` du banner et bumper
[`APP_VERSION`](frontEnd/frontend.py#L36). Le champ `protocol` du `hello` (§6.9) sert de filet.

### 6.12 ⚠️ Sécurité : surface d'attaque d'une connexion persistante

- Les `limit_req` existants ne protègent pas une connexion longue → ajouter `limit_conn` (§3.5).
- Le service doit **ignorer** tout message hors `ping`/`vis`, plafonner la taille des messages
  (quelques centaines d'octets) et fermer les connexions inactives.
- `CSRFProtect` ([frontend.py:34](frontEnd/frontend.py#L34)) ne s'applique pas au WS : raison de
  plus pour que ce service soit **sans session, sans cookie, sans accès base**, sur le seul réseau
  `frontend`.
- Vérifier l'`Origin` à la connexion pour éviter que d'autres sites n'ouvrent le flux.

### 6.13 ⚠️ Ne pas coder en dur `wss://`

En local, `TLS_MODE=http` : ce sera `ws://`. Côté client :

```js
const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${proto}//${location.host}/ws/race`;
```

Un `wss://` en dur casse tout le développement local, et l'erreur ne se voit qu'à l'exécution.

### 6.14 Pas fixe et rattrapage serveur

`stepPhysics` prend un `deltaTime` variable ; côté client il est plafonné par
[`if (deltaTime > 0.1) deltaTime = 0.016`](frontEnd/static/js/smk-banner.js#L719).
Côté serveur : **pas fixe** `dt = 1/30` avec accumulateur, et **plafond de rattrapage**
(max ~5 pas par tick). Sans ce plafond, une pause GC ou un gel de l'hôte déclenche une spirale
de rattrapage qui sature le CPU — d'autant plus avec `cpus: '0.25'`.

### 6.15 Cycle de vie de la course — à décider

Aujourd'hui la course est **infinie** (monde bouclé, `lapCount` qui s'incrémente, aucune fin).
Deux choix possibles :

- **Course unique infinie** (le plus proche de l'existant, recommandé pour la v1) : aucun cycle de
  vie à gérer. `lapCount` et `nextItemId` croissent indéfiniment — sans danger en JS.
- **Redémarrage périodique** (ex. toutes les 10 min) : plus varié, mais impose de gérer la
  transition côté client (reconstruction du DOM, message `raceReset`).

Question annexe : **faut-il simuler quand personne ne regarde ?** Recommandation : oui, ça coûte
quasiment rien pour 8 karts et ça évite tout code de démarrage/arrêt. À surveiller quand même sur
la conso CPU réelle du conteneur, vu les limites récemment posées.

### 6.16 Effet neige : rien à faire

[`initSnow`](frontEnd/static/js/smk-banner.js#L901) est purement décoratif et local.
Il utilise `Math.random` et `GAME_CONFIG.speeds.roadPPS` — laisser tel quel, en veillant à ce que
`roadPPS` reste disponible côté client (il arrive dans le `hello`, §4).

---

## 7. Validation

- **Test d'acceptation** : deux navigateurs différents (dont un en mode mobile via les devtools),
  côte à côte, 5 minutes. Positions, classement et impacts doivent coïncider.
- **Arrivée en cours de course** : ouvrir un troisième onglet après 2 minutes → il doit rejoindre
  l'état courant, pas repartir de zéro.
- **Onglet en arrière-plan** : masquer 2 minutes, revenir → saut à l'état courant, aucune rediffusion
  accélérée, aucun élément DOM fantôme.
- **Coupure** : `make restart` du service `race` → reconnexion automatique, resync propre.
- **Mode dégradé** : arrêter le service `race` → le banner doit rester animé (simulation locale).
- **Stabilité** : laisser tourner le moteur seul 30 min et vérifier l'absence de `NaN`, de kart
  bloqué et de fuite mémoire (`state.items` qui grossit sans fin).
