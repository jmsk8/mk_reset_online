# Migration du banner SMK vers WebSocket (WSS)

> **Archive.** Ce document décrit un état du code qui n'existe plus : les chemins
> de fichiers et numéros de ligne cités sont ceux de sa date de rédaction. Il est
> gardé parce qu'il explique *pourquoi* les choses sont comme elles sont.
> L'état actuel est décrit dans [architecture.md](architecture.md) et
> [protocole.md](protocole.md).

> Objectif : **tous les visiteurs voient exactement la même course**, au lieu d'une
> simulation locale et aléatoire par navigateur.
>
> Statut : **migration faite** sur la branche `feature/banner-wss`, non publiée. Le serveur est
> autoritatif, les clients ne font que du rendu. Ce qui reste à faire est hors de ce
> dépôt : voir §9.3.
> Rédigée le 2026-08-17 sur la branche `feature/stats-saison-matchmaking-public`.
> Mise à jour le 2026-08-22 : audit infra face au 1.4.3 (TLS externalisé).

### Journal

| Date | Ce qui a changé |
|---|---|
| 2026-08-17 | Rédaction initiale (cartographie + plan). |
| 2026-08-18 | **§6.1 résolu** : `isMobile` sorti de la physique, collisions universelles PC/mobile. **§6.11 résolu** : cache-buster posé. **Audit de déterminisme** (§2.0) : `physics.js` est une fonction pure — ce qui **rouvre l'option B**. **Option C** (moteur dans le backend Flask) analysée et écartée. |
| 2026-08-21 | Ajout de **§8, évolutions envisagées** : suivi de kart au clic sur les bulles du classement. Le point à retenir pour la migration : cette caméra-là est **par-spectateur**, ce qui nuance §6.6. |
| 2026-08-18 | **🎯 DÉCISION : option A retenue** (serveur autoritatif + WebSocket). §4 revu en profondeur : le protocole initial ne permettait **pas** à un arrivant en cours de course d'afficher une scène correcte — voir le « test de l'arrivant » (§4.0) et les 6 lacunes corrigées. |
| 2026-08-23 | **Migration réalisée** de bout en bout (lots 1 à 9). Écarts assumés au plan initial et points restants : **§9**. |
| 2026-08-22 | **Audit infra vs 1.4.3** : le 1.4.3 a déporté le TLS sur un reverse proxy **externe** (hors dépôt) — §1 mis à jour, nouveau **§6.17** (le proxy externe est un deuxième saut WS non documenté ici). §3.5 complété (headers `X-Forwarded-*` manquants dans le bloc `/ws/`), §3.6 précisé (`depends_on` de `race` avec `condition: service_healthy`), §3.1 complété (utilisateur non-root, comme les autres Dockerfiles du repo). |

---

## 1. État actuel (cartographie)

### Ce qui existe

> Numéros de ligne à jour au **2026-08-18** (après le refactor §6.1). Ailleurs dans cette note —
> notamment dans les tableaux du §3 — ils datent d'avant et ont pu se décaler.

| Fichier | Rôle | Taille |
|---|---|---|
| [frontEnd/static/js/physics.js](frontEnd/static/js/physics.js) | Moteur de simulation **pur** (UMD). `stepPhysics(cfg, state, rng, now, dt)` mute `state` et retourne une liste d'événements. **Aucune dépendance à l'appareil, au temps réel ni au hasard global** (§2.0). | 776 l. |
| [frontEnd/static/js/smk-banner.js](frontEnd/static/js/smk-banner.js) | `GAME_CONFIG` + création du monde + boucle `requestAnimationFrame` + rendu DOM. | 1062 l. |
| [frontEnd/static/css/smk-banner.css](frontEnd/static/css/smk-banner.css) | Styles, animations CSS (route, neige, star, hit). | 478 l. |
| [frontEnd/templates/index.html:79-103](frontEnd/templates/index.html#L79-L103) | Le bloc `<section class="hero smk-snes-banner">` et ses calques. | |
| [frontEnd/templates/index.html:263-264](frontEnd/templates/index.html#L263-L264) | Chargement de `physics.js` puis `smk-banner.js` (avec cache-buster, §6.11). | |

### Comment ça tourne aujourd'hui

1. `DOMContentLoaded` → [`initWorld()`](frontEnd/static/js/smk-banner.js#L365) crée 8 karts, mélange
   les personnages avec [`shuffleArray`](frontEnd/static/js/smk-banner.js#L433) (`Math.random`), crée les
   item-boxes et le DOM.
2. [`animate()`](frontEnd/static/js/smk-banner.js#L776) appelle `PH.stepPhysics(...)` à chaque frame,
   applique les événements retournés via [`applyEvent`](frontEnd/static/js/smk-banner.js#L589), puis
   [`renderState`](frontEnd/static/js/smk-banner.js#L635).
3. Le temps de jeu vient de [`getGameTime()`](frontEnd/static/js/smk-banner.js#L150)
   = `Date.now() - globalTimeOffset`, et le RNG est [`Math.random`](frontEnd/static/js/smk-banner.js#L156).

**→ Chaque onglet a son propre monde, son propre RNG, sa propre horloge.** D'où la divergence.

**→ Mais depuis le 2026-08-18, la divergence n'a plus qu'une seule cause : le point 3.**
L'appareil n'entre plus en ligne de compte (§6.1) et le moteur est prouvé déterministe (§2.0).
Semer le RNG et fixer l'horloge suffit désormais à obtenir des courses identiques — c'est
exactement ce qui rend l'option B viable.

### Infra

- `frontend` : Flask + `gunicorn -w 2` (workers **sync**) — voir [frontEnd/Dockerfile.frontend](frontEnd/Dockerfile.frontend).
- `backend` : Flask + gunicorn, seul à parler à Postgres.
- `nginx` : reverse proxy **interne**, deux templates `http`/`https` qui incluent tous les deux la
  même config applicative factorisée dans [nginx/snippets/app.conf](nginx/snippets/app.conf).
- ⚠️ **Depuis le 1.4.3 (2026-08-22), ce nginx ne termine plus le TLS public.** Le certbot interne
  ([nginx/docker-entrypoint.d/99-certbot-reload.sh](nginx/docker-entrypoint.d/99-certbot-reload.sh))
  existe toujours dans le repo mais n'est plus actif en prod : `.env` y vaut bien `TLS_MODE=http`
  (confirmé). Le TLS s'est déplacé sur un **reverse proxy externe, hors de ce dépôt** (voir
  `CHANGELOG.md` 1.4.3, « TLS déporté sur un reverse proxy externe »). Le lien entre les deux se
  fait via [docker-compose.override.yml](docker-compose.override.yml) : ce `nginx` rejoint en plus
  un réseau Docker externe `web` (`WEB_NETWORK`, défaut `web`) sous l'alias `mkreset`.
  **Conséquence pour le WS : le trafic WSS traverse deux proxys, pas un seul, et le second est
  invisible depuis ce dépôt** — voir §6.17.
- **Aucune infra WebSocket / SSE nulle part** dans le projet aujourd'hui.
- Limites de ressources serrées (commit `fbb1303`) : `cpus: '0.5'`–`'1'`, `memory: 128M`–`512M`.

---

## 2. Décision d'architecture — ✅ tranchée : **option A**

### 2.0 Audit de déterminisme de `physics.js` — fait le 2026-08-18

Résultat : **`stepPhysics` est déjà une fonction pure et déterministe.** C'est le fait
nouveau le plus structurant de cette note, parce qu'il rouvre l'option B.

| Vérification | Résultat |
|---|---|
| Fonctions `Math.*` utilisées | **uniquement** `Math.abs`, `Math.max`, `Math.min` |
| `Math.sin` / `cos` / `pow` / `tan` | **aucune** |
| `Math.random` | aucune — le RNG est injecté en paramètre |
| `Date.now()` / `performance.now()` | aucune — le temps est injecté en paramètre |
| Dépendance à l'appareil | **aucune depuis le 2026-08-18** (§6.1) |

Pourquoi ça compte : `abs`/`max`/`min` sont **exactement spécifiés** par IEEE 754 et
ECMAScript — résultat identique bit à bit sur tous les moteurs JS. À l'inverse, `sin`,
`cos` et `pow` sont explicitement *implementation-dependent* dans la spec ECMAScript :
leur présence aurait suffi à condamner toute simulation client répliquée. Elles sont
absentes du moteur (le seul `Math.sin` du projet est dans `renderState`, pour le
flottement décoratif des item-boxes — hors physique).

Les opérations arithmétiques (`+ - * /`) sur les doubles IEEE 754 sont, elles, totalement
spécifiées. L'itération d'objets dans `rollItem` porte sur des clés string, dont l'ordre
d'insertion est garanti par la spec. **Aucune source de divergence connue ne subsiste.**

### Option A — Serveur autoritatif + diffusion d'état

Un service dédié fait tourner `stepPhysics` à pas fixe et diffuse des snapshots ;
les clients ne font **que du rendu** (avec interpolation).

- ✅ Identité stricte garantie, quelles que soient les capacités du client.
- ✅ Robuste : onglet en arrière-plan, mobile, arrivée en cours de course, CPU lent.
- ❌ Bande passante (~5–10 Ko/s par visiteur, voir §6.7) + couche d'interpolation à écrire.

### Option B — Seed partagé + simulation déterministe côté client ⬆️ **réévaluée à la hausse**

Le serveur ne diffuse qu'un *seed* + un `t0` ; chaque client rejoue la même simulation
avec un PRNG semé (mulberry32/xorshift) et un pas de temps fixe.

> **Son blocage rédhibitoire a disparu.** Cette option était écartée d'office parce que
> `isMobile` rendait le déterminisme impossible. C'est corrigé (§6.1), et l'audit §2.0
> montre qu'aucune autre source de divergence ne subsiste. Elle redevient une candidate
> sérieuse — et de loin la moins chère.

- ✅ Bande passante quasi nulle. **Pas de WebSocket du tout** : un simple `GET` HTTP suffit.
- ✅ **Aucune nouvelle stack, aucun nouveau service, aucun changement réseau.** L'endpoint
  tient dans le backend Flask existant (voir ci-dessous pourquoi c'est vrai ici alors que
  l'option C est impossible).
- ✅ La physique reste en JS, en **un seul exemplaire** : zéro risque de dérive.
- ❌ **Rattrapage à la charge du client** : un visiteur qui arrive en cours doit rejouer les
  pas manqués. Impose de redémarrer la course toutes les N minutes pour borner le coût
  (à 30 Hz, une fenêtre de 5 min = 9 000 pas pour 8 karts, de l'ordre de la centaine de ms).
- ❌ **Aucun filet de resynchronisation** : si un client dérive malgré tout, rien ne le rattrape.
- ❌ La mise en pause d'onglet actuelle ([`globalTimeOffset`](frontEnd/static/js/smk-banner.js#L139))
  fait diverger l'horloge de jeu du temps réel — à supprimer de toute façon.

#### Le seed doit être dérivé de l'horloge, pas stocké

C'est ce qui rend l'option compatible avec `gunicorn -w 2` **sans aucun état partagé** :

```python
epoch = int(time.time()) // 300          # fenêtre de 5 min
seed  = derive(epoch)                     # doit être STABLE entre process
```

> ⚠️ **Piège** : ne pas utiliser le `hash()` natif de Python. Il est salé par process
> (`PYTHONHASHSEED` aléatoire par défaut sur les `str`), donc les deux workers gunicorn
> renverraient des seeds différents — rétablissant silencieusement le bug qu'on corrige.
> Utiliser `hashlib` ou une dérivation arithmétique pure.

### Option C — Moteur dans le backend Flask existant ❌ **impossible**

Évaluée le 2026-08-18. Écartée : **quatre blocages indépendants**, chacun suffisant seul.

**1. Isolation réseau.** `nginx` est sur le réseau `frontend` uniquement, `backend` sur
`backend` uniquement ([docker-compose.yml](docker-compose.yml)) ; seul `frontend` fait le
pont. nginx **ne peut pas** `proxy_pass` vers `backend:8080`. Il faudrait brancher nginx sur
le réseau `backend`, c'est-à-dire donner au seul service exposé publiquement l'accès au
réseau de la base de données. Régression de sécurité nette, et l'exact inverse de §3.6.

**2. `gunicorn -w 2` en workers *sync*** ([Dockerfile.backend:40](backEnd/Dockerfile.backend#L40))
— le blocage le plus dur :
- 2 process = 2 simulations indépendantes = exactement le bug qu'on corrige (§6.2).
- Surtout, **un worker sync ne peut pas servir de WebSocket** : une connexion persistante
  monopolise un worker jusqu'à sa fermeture. Avec 2 workers, **2 visiteurs suffisent à
  saturer tout le backend** — c'est l'API entière qui tombe, pas seulement le banner.
- Y remédier imposerait de basculer sur gevent/eventlet + `flask-sock`, donc de
  re-architecturer le modèle de concurrence **du service qui détient la base**. Beaucoup
  de risque pour un élément décoratif.

**3. Aucun endroit pour la boucle.** Un worker gunicorn est piloté par les requêtes ; une
boucle à pas fixe 30 Hz exige un process toujours vivant. En thread de fond, les deux
workers en lanceraient chacun un → il faudrait une élection de leader, c'est-à-dire
réinventer le process dédié qu'on cherchait à éviter.

**4. Langage.** Le moteur, c'est `physics.js`. Le mettre dans le backend = le réécrire en
Python et maintenir deux copies (le fallback client reste en JS, §6.10). Particulièrement
malvenu : tout l'objet de l'étape 1 était d'éliminer une source de divergence entre deux
exécutions. Un port Python en réintroduit une bien pire — écarts de flottants et d'ordre
d'itération désynchronisent le flux `rng()`, exactement la cascade décrite en §6.1.

Accessoirement, `backend` est déjà à `cpus: '1'` / `memory: 512M` et sert toute l'API plus
les accès Postgres : y ajouter une simulation 30 Hz et N connexions persistantes entrerait
en concurrence directe avec l'application réelle.

> **À retenir** : « faire tourner le moteur sur le backend » et « exposer un endpoint HTTP
> depuis le backend » sont deux choses très différentes. La première est impossible ; la
> seconde (option B) est triviale et ne coûte rien.

### 🎯 Décision : option A — tranchée le 2026-08-18

**Le serveur joue la course, tous les navigateurs la regardent.** Les options B et C restent
documentées ci-dessus pour mémoire — elles expliquent pourquoi A a été préférée — mais le
choix est fait et n'est plus à rediscuter.

Ce que ça implique et qui n'est plus optionnel :

- Un **service dédié** qui simule en continu, processus unique (§6.2), sur le réseau `frontend`.
- Un **tuyau WebSocket permanent** par visiteur, avec sa conf nginx (§3.5) et son coût de bande
  passante (§6.7).
- Une **couche d'interpolation** côté client (§6.3) et un **mode dégradé** si le service tombe (§6.10).
- Surtout : la capacité à **afficher une scène de milieu de course** (§4.0 et §6.5) — c'est le
  vrai gros morceau, et c'est ce qui rend le point ci-dessous décisif.

Pour mémoire, la comparaison qui a mené là :

| Objectif prioritaire | Option | Coût |
|---|---|---|
| **Garantie stricte** quoi qu'il arrive (client lent, dérive, arrivée tardive) | ✅ **A** — service Node dédié | Élevé : nouveau service, nginx, interpolation, mode dégradé |
| Même course pour tous, infra minimale | B — seed HTTP depuis le backend existant | Faible, mais aucun filet en cas de dérive |
| — | ~~C — moteur dans le backend~~ | Impossible (voir ci-dessus) |

**Mise en œuvre** : en **Node.js**, en réutilisant `physics.js` *tel quel*. Le module est déjà
compatible Node — voir le wrapper UMD [physics.js:1-8](frontEnd/static/js/physics.js#L1-L8)
qui exporte via `module.exports`. Aucune réécriture, donc **aucun risque de dérive** entre le
moteur serveur et le moteur client de secours. Et **service dédié sur le réseau `frontend`
uniquement** — jamais dans le backend (option C).

> **Si portage Python plutôt que Node** : il faut réécrire ~780 lignes de JS en Python et
> les maintenir en parallèle du fallback client. Coût réel élevé et dérive quasi certaine à
> la première évolution de gameplay. À n'envisager que pour éviter d'ajouter une stack Node.

Dimensionnement : 8 karts + ~8 items à 30 Hz ≈ rien du tout. Un `node:22-alpine` avec la lib
`ws` (zéro dépendance transitive) tient dans `cpus: '0.25'` / `memory: 128M`.

---

## 3. Changements à faire, fichier par fichier

> **Portée** : cette section décrit **l'option A**, qui est l'option retenue (§2). Tout ce qui
> suit est donc à faire.
>
> Les numéros de ligne datent d'avant le refactor du 2026-08-18 et ont pu se décaler ; §1 est à jour.

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
- Comme [Dockerfile.backend](backEnd/Dockerfile.backend) et
  [Dockerfile.frontend](frontEnd/Dockerfile.frontend) : tourner en utilisateur non-root
  (`useradd -m -u 1000 appuser` + `USER appuser`). Aucune raison de déroger à la convention du repo
  pour ce service, même s'il n'a pas d'accès base.

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
| `GAME_CONFIG` | 🟡 **Entamé.** Le refactor du 2026-08-18 a déjà séparé `offsets.world` (physique) de `offsets.render` (visuel) — le modèle à généraliser. Reste à scinder de même : constantes **physiques** (monde, route, hitboxes, vitesses, items, IA) → serveur ; constantes **visuelles** (chemins d'images, tailles, z-index, breakpoint mobile) → client. Voir §6.9. |
| Nouveau | Module client WS : connexion, backoff, buffer de snapshots, resync, fallback local. |

### 3.3 [frontEnd/static/js/physics.js](frontEnd/static/js/physics.js)

- ✅ ~~Sortir `isMobile` de la signature de `stepPhysics` (§6.1).~~ **Fait le 2026-08-18.** C'était
  la seule modification fonctionnelle nécessaire dans ce fichier — il est maintenant prêt tel quel
  pour un serveur autoritatif (option A) comme pour une réplication client (option B).
- *(option A uniquement)* Reste chargé par le navigateur **uniquement en mode dégradé** (§6.10) —
  donc en `import()` paresseux, plus dans un `<script>` au chargement de page. Sans objet en
  option B, où le fichier reste le moteur principal du client.

### 3.4 [frontEnd/templates/index.html](frontEnd/templates/index.html)

- *(option A uniquement)* L263-264 : retirer le `<script src="physics.js">` du chargement initial.
- ✅ ~~Ajouter un cache-buster `?v={{ app_version }}` sur les `<script>`/`<link>` du banner (§6.11).~~
  **Fait le 2026-08-18** sur `physics.js`, `smk-banner.js` et `smk-banner.css`.
- Rien à changer dans le markup du banner L79-103 : les calques et conteneurs restent identiques.

### 3.5 [nginx/snippets/app.conf](nginx/snippets/app.conf)

Ajouter **avant** `location /` (fichier inclus par les templates `http` **et** `https`, donc
une seule modif couvre les deux modes) :

```nginx
location /ws/ {
    proxy_pass http://race:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout  3600s;   # sinon nginx coupe à 60 s d'inactivité
    proxy_send_timeout  3600s;
    proxy_buffering     off;
    limit_conn          ws_conn 5;   # zone à déclarer dans nginx.conf
}
```

> Les deux headers `X-Forwarded-For`/`X-Forwarded-Proto` sont absents d'une première version de ce
> bloc. Ils ne changent rien au fonctionnement du WS lui-même (`limit_conn` s'appuie sur
> `$binary_remote_addr`, pas sur ces headers), mais `/admin` et `/` les posent déjà : les omettre
> ici casserait sans raison la cohérence si `race` loggue un jour l'IP réelle ou le schéma d'origine
> (utile pour le contrôle d'`Origin`, §6.12).

Et dans [nginx/nginx.conf](nginx/nginx.conf), à côté des `limit_req_zone` existants :

```nginx
limit_conn_zone $binary_remote_addr zone=ws_conn:10m;
```

> Le bloc regex existant `location ~* \.(js|css|…)$` ne capte pas `/ws/race` (pas d'extension) :
> pas de collision. `location /admin` est un préfixe distinct : pas de collision non plus.
>
> ⚠️ Ce bloc ne couvre que **ce** nginx. Depuis le 1.4.3, un reverse proxy externe est intercalé
> devant lui (§1) — voir §6.17 pour ce qu'il faut vérifier de ce côté-là, hors de ce dépôt.

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

Puis ajouter `race` dans le `depends_on` du service `nginx`, sur le même modèle que `frontend`
(qui a déjà un healthcheck et un `condition: service_healthy`) :

```yaml
  nginx:
    depends_on:
      frontend:
        condition: service_healthy
      race:
        condition: service_healthy
```

> Sans `condition: service_healthy`, `nginx` peut démarrer avant que `race` ait fini son boot et
> proxy-passer dans le vide le temps que `/healthz` réponde — pas grave en soi (le client
> WS réessaiera), mais autant rester cohérent avec le traitement déjà réservé à `frontend`.

### 3.7 Divers

- *(option A uniquement)* [Makefile](Makefile) : rien d'obligatoire, mais une cible `logs-race`
  sera pratique.
- [CHANGELOG.md](CHANGELOG.md) : entrée à ajouter en fin de migration.
- ✅ ~~[frontEnd/frontend.py](frontEnd/frontend.py#L39) : bump `APP_VERSION`~~ — **fait**
  (`1.4.2` → `1.4.3`). À rebumper à chaque changement du contrat entre `physics.js` et
  `smk-banner.js` (§6.11).

---

## 4. Protocole WebSocket proposé

Endpoint : `/ws/race` — **lecture seule**, aucune authentification (contenu public).

### 4.0 Le « test de l'arrivant » — la règle qui gouverne tout le protocole

> **Un visiteur qui se connecte à la seconde 187 d'une course doit voir immédiatement une scène
> correcte et complète.** Il n'a vu passer *aucun* des événements précédents.

C'est le critère qui décide de ce qui doit figurer dans le snapshot. Formulé à l'envers, il
devient un test mécanique à appliquer à chaque élément visible :

**Si un élément n'est à l'écran que parce qu'on a vu passer un événement, il est invisible pour
un arrivant — donc il doit être dans le snapshot.**

Appliqué au code actuel, ce test est **échoué par cinq éléments** :

| Élément à l'écran | Créé aujourd'hui par… | Un arrivant… |
|---|---|---|
| L'objet tenu par un kart | événement `spawnHeldItem` (porte le `type`) | ne sait pas qu'il existe, ni lequel c'est |
| Le halo d'étoile | événement `starOn` | ne verra jamais le halo s'allumer |
| La présence au classement | événement `kartSpawned` | a un classement **vide** |
| Une item-box consommée | champ `box.active`, jamais diffusé | voit des boîtes déjà prises |
| Un kart figé après impact | champ `kart.stopped`, jamais diffusé | voit un kart figé sans le rendu « stoppé » |

**Conséquence directe** : le protocole rédigé le 2026-08-17 (conservé plus bas en §4.4) était
insuffisant. Il envoyait `heldItemId` sans le type de l'objet, ignorait `stopped`, l'état étoile,
l'état des boîtes, et ne permettait pas de reconstruire le classement. Un arrivant aurait vu une
scène **fausse**, pas seulement incomplète.

### 4.1 Inventaire de l'état : ce qui se diffuse, ce qui reste au serveur

Fait à partir de l'état réel du kart ([smk-banner.js:456-497](frontEnd/static/js/smk-banner.js#L456-L497))
et de l'objet ([physics.js:303-316](frontEnd/static/js/physics.js#L303-L316)). Sur les
**25 champs** d'un kart, **8 seulement** intéressent le client.

**Kart — à diffuser :**

| Champ | Fréquence | Pourquoi |
|---|---|---|
| `id`, `charName` | `hello` (identité fixe) | sprite + photo du classement |
| `worldX`, `yPercent` | chaque snapshot | position |
| `totalDistance` | chaque snapshot | **interpolation** : monotone, jamais bouclé (§6.3) |
| `state` (`pending`/`running`/`hit`) | chaque snapshot | masquage, filtre rouge |
| `stopped` | chaque snapshot | classe CSS `kart-stopped` |
| étoile active | chaque snapshot | halo — **dérivé** de `isInvincible`, pas transmissible par événement |
| `rank` | chaque snapshot | classement |
| `heldItem` → `{id, type, holdPosition}` | chaque snapshot | **le `type` est indispensable** : sans lui, impossible de choisir le sprite |

**Kart — interne serveur, jamais diffusé (17 champs)** : `stats`, `absoluteVelocity`, `momentum`,
`momentumTarget`, `nextMomentumChange`, `vy`, `targetVy`, `aiState`, `originalLaneY`,
`dodgeIntensity`, `hitEndTime`, `throwTime`, `pendingItemGrantTime`, `boostEndTime`,
`hitInvincibleUntil`, `nextWanderTime`, `wanderEndTime`, `wanderVy`, `hasPassedFinishLine`,
`lapCount`. Plus `currentFilter`, qui est un cache de rendu purement client.

**Objet libre — à diffuser** : `id`, `type`, `worldX`, `y`, `currentFrame` (animation carapace).
**Interne** : `vx`, `vy`, `shooterId`, `targetKartId`, `createdAt`, `lastAnimTime`, `isDead`.

**Item-box — à diffuser** : position (fixe, dans `hello`) **et `active`** (variable, dans chaque
snapshot). `reactivateTime` reste serveur.

### 4.2 Serveur → client

**`hello`** (une fois, à la connexion et après chaque reconnexion) :

```jsonc
{
  "t": "hello",
  "protocol": 1,
  "serverTime": 1755450000123,        // ms, référence de temps unique
  "t0": 1755449700000,                // ⚠️ départ de la course — INDISPENSABLE pour dériver
                                      //    cameraX et bgCameraX côté client (§6.6)
  "world": {                           // constantes physiques : le client n'en garde AUCUNE copie
    "width": 3840, "finishLineX": 1440, "sunX": 1920,
    "roadMinY": 0, "roadMaxY": 30, "roadPPS": 250
  },
  "karts": [                           // identité seulement — la position vient du snapshot
    { "id": 0, "char": "yoshi" }, ...
  ],
  "boxes": [ { "x": 3456, "y": 0 }, ... ],   // positions fixes ; l'état actif est dans le snapshot
  "snapshot": { /* identique au message `state` ci-dessous */ }
}
```

> Le champ `lane` de la version précédente a été retiré : le couloir de départ n'a aucun intérêt
> pour un arrivant, seule la position courante compte, et elle est dans le snapshot.

**`state`** (~15 Hz) — format compact, tableaux plutôt qu'objets :

```jsonc
{
  "t": "s",
  "ts": 1755450000456,                 // temps serveur du tick
  "k": [ [id, worldX, y, totalDistance, flags, rank, heldId, heldType, heldHold], ... ],
  "i": [ [id, type, worldX, y, frame], ... ],
  "b": [ 1, 0, 1, 1 ]                  // état actif des item-boxes, dans l'ordre du `hello`
}
```

`flags` est un champ de bits, pour rester compact (§6.7) :

| Bit | Sens |
|---|---|
| 0 | kart `pending` (pas encore entré en course → masqué) |
| 1 | kart en état `hit` (filtre rouge) |
| 2 | `stopped` (classe `kart-stopped`) |
| 3 | étoile active (halo) |

`heldId`/`heldType`/`heldHold` valent `null` si le kart ne tient rien.

**`ev`** (au fil de l'eau, groupés avec le `state` du même tick) : la liste d'événements
déjà produite par `stepPhysics` (`kartHit`, `starOn`/`starOff`, `spawnHeldItem`,
`removeHeldItem`, `killItem`, `leaderboardPosition`, `kartSpawned`).

⚠️ **Les événements ne servent qu'aux animations** (§6.5) — jamais à créer ou détruire une
entité. Tout ce qui existe doit exister dans le snapshot, sinon le test de l'arrivant échoue.

### 4.3 Ce que le client doit savoir faire à la réception d'un `hello`

C'est la conséquence pratique du §4.0, et **le plus gros morceau du travail client** :

1. Construire le DOM des karts depuis `hello.karts` (sprites) — sans supposer qu'ils sont au départ.
2. Construire les item-boxes, en masquant celles dont `b[i] === 0`.
3. **Construire le classement de zéro** : pour chaque kart non-`pending`, créer sa photo et la
   placer directement à son `rank`, sans animation d'entrée.
4. Créer les sprites des objets tenus, en choisissant l'image d'après `heldType`.
5. Créer les sprites des objets libres (`i`), carapaces à la bonne frame d'animation.
6. Rallumer le halo des karts dont le bit étoile est à 1.
7. Positionner la caméra : `cameraX = (roadPPS × (serverNow − t0) / 1000) mod width`,
   et `bgCameraX` à demi-vitesse.

Rien de tout cela n'existe aujourd'hui : `initWorld()` ne sait construire qu'une grille de départ.

### 4.4 Client → serveur

Le serveur **ignore tout le reste**. Seuls messages acceptés :

- `{"t":"ping","c":<clientTime>}` → réponse `{"t":"pong","c":<clientTime>,"s":<serverTime>}` (calage d'horloge).
- `{"t":"vis","hidden":true|false}` → le serveur cesse / reprend l'envoi des snapshots à ce client
  (gros gain sur mobile).

---

## 5. Ordre de travail

### Fait

1. ✅ **Extraire `isMobile` de `physics.js`** (§6.1). *Commit isolé, sans WS : ça dérisque tout
   le reste.* Fait le 2026-08-18, accompagné du cache-buster (§6.11) devenu nécessaire.

> ⚠️ **Validation encore à faire à la main.** Aucun runtime JS n'était disponible dans
> l'environnement où le refactor a été écrit (`node` absent) : **aucun test n'a été exécuté**,
> pas même un contrôle syntaxique. La vérification a été purement statique (relecture du diff,
> grep confirmant l'absence de références aux anciens chemins). À valider avant d'aller plus loin :
> ouvrir le banner sur PC et sur mobile et vérifier que le rendu est inchangé sur les deux.

### À faire — option A

2. Extraire les constantes physiques de `GAME_CONFIG` dans un module partagé (§6.9). *Commit isolé.*
   — largement entamé par le refactor §6.1, qui a déjà isolé `offsets.world` de `offsets.render`.

3. 🔑 **Rendre le client capable d'afficher une scène de milieu de course** (§4.0, §4.3, §6.5).
   `renderState` doit réconcilier le DOM avec un état arbitraire : créer ce qui manque, supprimer
   les orphelins, reconstruire le classement, rallumer les halos d'étoile.

   > **C'est le plus gros morceau du travail client, et il ne dépend pas du serveur.** Il se
   > développe et se teste **entièrement en local**, en fabriquant à la main un faux snapshot de
   > milieu de course et en vérifiant que l'affichage est correct. À faire **tôt** : c'est ce qui
   > dérisque le plus la suite, et ça n'attend ni le service Node ni le WebSocket.

4. Écrire `raceEngine/server.js` : boucle à pas fixe + `console.log` du classement, **sans WS**.
   Vérifier sur 10 minutes qu'aucun `NaN` n'apparaît et qu'aucun kart ne se bloque (§6.14).
5. Ajouter le serveur `ws` + le protocole `hello`/`state`/`ev` (§4). Tester avec `websocat` ou un
   petit script Node — **en vérifiant le test de l'arrivant** : se connecter après 3 min et
   contrôler que le snapshot seul suffit à tout reconstituer.
6. Compose + nginx : faire passer la connexion de bout en bout (`ws://` en local d'abord).
7. Côté client : remplacer `initWorld`/`animate` par le pipeline WS + interpolation (§6.3),
   avec l'horloge calée sur le serveur (§6.8).
8. Fallback local si le WS échoue (§6.10).
9. Reconnexion + backoff + resync sur `visibilitychange` (§6.4).
10. Validation en `TLS_MODE=https` (`wss://`), puis deux navigateurs côte à côte pendant 5 min (§7).
    ⚠️ Ceci ne teste que le `nginx` de ce dépôt. La prod n'utilise plus ce mode (§1, §6.17) : elle
    passe par le reverse proxy externe, à valider séparément sur le VPS lui-même.

> **Note** : contrairement à ce qu'envisageait une version intermédiaire de cette note, le client
> n'a besoin **ni** de pas de temps fixe **ni** de PRNG semé — en option A il ne simule rien. Le
> pas fixe est une affaire de serveur (§6.14), et `Math.random` ne sert plus que pour la neige
> décorative (§6.16).

---

## 6. Points d'attention (les pièges réels)

### 6.1 ✅ `isMobile` est *dans* la physique — **RÉSOLU le 2026-08-18**

> Corrigé sur la branche `refactor/banner-collision-reliability`. Le diagnostic ci-dessous
> est conservé parce qu'il explique *pourquoi* la correction était indispensable ; le
> correctif effectivement appliqué est décrit en fin de section.

*(Description au passé : ces signatures et ces lignes n'existent plus depuis le correctif.)*

`stepPhysics(..., isMobile)` le propageait à `giveKartItem` → `getHeldItemOffset`, qui
**stockait `offset`/`yShift` dans l'état du kart**, et à `activateItem` pour la position de
spawn des carapaces.

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

Deux bugs annexes relevés en creusant :

- `visuals.box.sizePC` et `sizeMobile` valent tous deux **42** — différenciation morte. *Toujours
  présent, sans conséquence.*
- ~~`heldItem.offset` est figé au moment où l'objet est donné~~ → **corrigé** par le refactor :
  l'offset est maintenant dérivé à chaque frame, donc franchir le seuil de 769px (rotation de
  tablette) est pris en compte immédiatement.

#### Correctif appliqué

Principe retenu : **la physique ne connaît qu'une seule valeur, le rendu garde les valeurs par
appareil.** Autrement dit, on ne stocke plus de donnée de rendu dans l'état du monde.

| Fichier | Changement |
|---|---|
| [smk-banner.js](frontEnd/static/js/smk-banner.js) | `GAME_CONFIG.offsets` scindé en **`offsets.world`** (physique : `heldItemBehind: -50`, `shellSpawn: 50`, valeurs uniques) et **`offsets.render`** (visuel : valeurs pc/mobile inchangées). |
| [physics.js:223](frontEnd/static/js/physics.js#L223) | `getHeldItemOffset(cfg, isMobile, holdPosition)` → `getHeldItemWorldOffset(cfg, holdPosition)`. |
| [physics.js](frontEnd/static/js/physics.js) | `kart.heldItem` ne contient plus que `{ id, type, holdPosition }` — les champs `offset`/`yShift` ont disparu de l'état. |
| [physics.js:374](frontEnd/static/js/physics.js#L374) | `stepPhysics(cfg, state, rng, now, deltaTime)` — **`isMobile` retiré de la signature**, ainsi que de `giveKartItem` et `activateItem`. |
| [smk-banner.js:551](frontEnd/static/js/smk-banner.js#L551) | Nouvelle `getHeldItemRenderOffset(holdPosition)`, appelée depuis `renderState` ([L731](frontEnd/static/js/smk-banner.js#L731)) : dérive l'offset visuel à chaque frame depuis `cachedIsMobile`. |

Les deux sites de collision qui lisaient `kart.heldItem.offset` lisent désormais
`cfg.offsets.world.heldItemBehind` : l'objet traîné comme **arme**
([physics.js:542](frontEnd/static/js/physics.js#L542)) et comme **bouclier**
([physics.js:708](frontEnd/static/js/physics.js#L708)).

**Choix de la valeur canonique : les valeurs PC (−50 / +50).** Trois raisons :

1. **Zéro changement visuel** sur les deux appareils — les tailles d'assets et le rendu restent
   exactement ceux d'avant, sur PC comme sur mobile.
2. **Le mobile absorbe l'erreur à 60%** (le wrapper est en `scale(0.6)`, donc 1 unité monde =
   0,6 px physique). Concentrer tout l'écart sur le mobile est donc l'option la moins visible :

   | Valeur canonique | Saut PC | Saut mobile | Total visible |
   |---|---|---|---|
   | **−50 (PC)** ✅ | 0 px | 9 px | **9 px** |
   | −42 (milieu) | 8 px | 4 px | 12 px |
   | −35 (mobile) | 15 px | 0 px | 15 px |

3. **Sur PC, rendu == simulation, exactement.** C'est là qu'on développe et qu'on a le HUD de
   debug : garder un appareil où « ce que je vois est ce qui est simulé » vaut cher pour
   diagnostiquer une désync. Une valeur intermédiaire ferait mentir *les deux* appareils.

**Conséquence rassurante** : sur PC les valeurs canoniques sont celles d'avant, donc la
simulation desktop est **bit-à-bit identique**. C'est le mobile qui vient s'aligner sur le PC —
le risque de régression est nul côté desktop.

**Seul écart assumé** : une banane lâchée est simulée à −50 mais l'objet était dessiné à −35
tant qu'il était tenu, d'où un saut de 15 unités = **9 px physiques** sur mobile, sur une frame,
sur un objet qui se déplace déjà de ~5 px par frame. Invisible en pratique. Les carapaces ne
sont pas concernées : elles sautent déjà de −50 à +50 par design.

#### Limite résiduelle, non corrigeable sans toucher aux assets

Les hitboxes sont constantes en unités monde (`kartVsKart.x = 60`), alors que le kart mesure
100 unités sur PC et 80 sur mobile. La collision se déclenche donc à 60% de la largeur du sprite
sur PC contre 75% sur mobile : sur mobile, les karts sembleront se toucher « de plus loin ».

C'est une conséquence directe du choix de garder des tailles d'assets différentes, et c'est
**purement perceptif** — la simulation, elle, est rigoureusement identique. C'est tout ce qui
compte pour la migration.

### 6.2 ⚠️ `gunicorn -w 2` : deux processus = deux courses

Le frontend **et** le backend tournent chacun avec **2 workers sync**
([Dockerfile.frontend](frontEnd/Dockerfile.frontend),
[Dockerfile.backend:40](backEnd/Dockerfile.backend#L40)).
Héberger le WS dans Flask donnerait deux simulations indépendantes : la moitié des visiteurs
verrait la course A, l'autre la course B — soit exactement le bug qu'on cherche à corriger,
en plus vicieux car intermittent.

S'y ajoute un problème encore plus dur, détaillé en **option C** (§2) : un worker *sync* ne peut
pas servir de WebSocket du tout — une connexion persistante monopolise un worker, donc 2 visiteurs
suffisent à saturer le service entier.

**Règle** : le moteur de course doit être un **processus unique et dédié**. `replicas: 1`,
jamais scalé, et **jamais dans le frontend ni dans le backend**. (Et si un jour il faut scaler :
un seul « leader » simule, les autres relaient via un bus type Redis — pas au programme ici.)

> ⚠️ Ne s'applique qu'à l'option A. En **option B**, il n'y a aucun processus de simulation
> côté serveur : le seul endpoint est un `GET` sans état, et le seed dérivé de l'horloge donne
> la même valeur dans les deux workers (§2).

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

> 📌 **Ce point est le cœur du chantier client**, pas un détail de robustesse. Le §4.0 (« test de
> l'arrivant ») en donne le critère opérationnel, le §4.1 l'inventaire exact des champs à
> diffuser, et le §4.3 la liste de ce que le client doit savoir reconstruire. Voir aussi l'étape 3
> du §5 : ce travail est **indépendant du serveur** et se teste en local avec un faux snapshot.

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
- ⚠️ **Ce raisonnement suppose une caméra unique pour tous.** Si le suivi de kart au clic (§8.1) est
  retenu, la caméra devient par-spectateur et n'est plus dérivable du temps serveur dans ce cas :
  il faudra séparer caméra par défaut (déterministe, partagée) et caméra suivie (locale, jamais
  diffusée).

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

### 6.11 ✅ Cache navigateur de 7 jours sur les JS — **RÉSOLU le 2026-08-18**

[nginx/snippets/app.conf:9-15](nginx/snippets/app.conf#L9-L15) sert les `.js` avec `expires 7d`, et
aucun template n'ajoutait de cache-buster (`app_version` n'était utilisé que dans
[footer.html:4](frontEnd/templates/footer.html#L4)).

Le refactor §6.1 a rendu le risque **immédiat** au lieu de théorique : `physics.js` et
`smk-banner.js` partagent désormais un contrat (la forme de `GAME_CONFIG.offsets`). Un visiteur
récurrent qui n'aurait qu'un seul des deux fichiers rafraîchi casse le banner —
`cfg.offsets.world` `undefined` → `NaN` sur `worldX`.

**Correctif appliqué** : `?v={{ app_version }}` posé sur les trois fichiers du banner dans
[index.html](frontEnd/templates/index.html) (`physics.js`, `smk-banner.js`, `smk-banner.css`),
et [`APP_VERSION`](frontEnd/frontend.py#L39) bumpé `1.4.2` → `1.4.3`.

> À savoir : nginx fait son matching de `location` sur l'URI **sans** la query string. Le bloc
> `location ~* \.(js|css|…)$` continue donc de matcher et le `expires 7d` s'applique toujours —
> on garde le cache long, mais changer de version change l'URL, donc l'entrée de cache. C'est
> bien le comportement voulu.

**Règle pour la suite** : tout changement touchant au contrat entre ces fichiers doit
s'accompagner d'un bump d'`APP_VERSION`. Le champ `protocol` du `hello` (§6.9) servira de
second filet si l'option A est retenue.

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

### 6.17 ⚠️ Le reverse proxy externe est un deuxième saut WebSocket, hors de ce dépôt

Depuis le 1.4.3 (§1), ce `nginx` ne termine plus le TLS public : un reverse proxy externe le fait,
sur le réseau Docker `web` ([docker-compose.override.yml](docker-compose.override.yml)), et lui
relaie ensuite du HTTP en clair vers l'alias `mkreset`. Une connexion WSS traverse donc **deux**
proxys, pas un :

```
navigateur --wss://--> [reverse proxy externe, hors dépôt] --ws://--> nginx (ce dépôt) --> race:3000
```

Le §3.5 ne configure que le second maillon. Le premier échappe entièrement à ce dépôt — pas de
fichier de conf à modifier ici, mais un point à vérifier avant de considérer le protocole prêt,
avec quiconque gère ce proxy sur le VPS :

- Il doit relayer l'upgrade WebSocket (`Connection: Upgrade`, `Upgrade: websocket`) sur `/ws/` —
  la plupart des reverse proxies le font, mais **pas garanti par défaut sur tous**.
- Il doit lui aussi tenir un timeout d'inactivité très supérieur à 60 s (comme en §3.5), sans quoi
  il coupera la connexion avant même que ce `nginx` n'entre en jeu.
- Il n'a besoin de connaître que `mkreset` (ce `nginx`) — jamais `race` directement, qui reste
  interne au réseau `frontend` de ce compose.

**Bonne nouvelle** : rien de tout cela ne remet en cause le choix `ws://`/`wss://` côté client
(§6.13). Le navigateur ne voit que l'URL publique — en HTTPS — donc `location.protocol` vaudra
`'https:'` et le client demandera `wss://`, **quelle que soit** la valeur de `TLS_MODE` en interne
(qui vaut `http` en prod, précisément parce que le TLS est traité en amont). Ne pas confondre les
deux : `TLS_MODE` décrit ce que *ce* `nginx` sert, pas ce que voit le public.

> À part, sans rapport direct avec le WS mais même cause racine : `SESSION_COOKIE_SECURE`
> ([frontend.py:35](frontEnd/frontend.py#L35)) suit ce même `TLS_MODE`, donc vaut `False` en prod
> aujourd'hui alors que le site public est en HTTPS. À traiter séparément de cette migration.

---

## 7. Validation

- **Test d'acceptation** : deux navigateurs différents (dont un en mode mobile via les devtools),
  côte à côte, 5 minutes. Positions, classement et impacts doivent coïncider.
- **Arrivée en cours de course** (le test le plus important — §4.0) : ouvrir un troisième onglet
  après 2 minutes → il doit rejoindre l'état courant, pas repartir de zéro. Vérifier **point par
  point**, car chacun correspond à une lacune du protocole initial :
  - le classement est rempli et dans le bon ordre (pas vide) ;
  - les karts qui tiennent un objet l'affichent, **avec la bonne image** (banane ≠ carapace) ;
  - un kart sous étoile a bien son halo ;
  - les item-boxes déjà consommées sont masquées ;
  - un kart percuté au moment de l'arrivée apparaît figé et en rouge ;
  - la position de la ligne d'arrivée et du soleil coïncide avec les autres onglets.
- **Onglet en arrière-plan** : masquer 2 minutes, revenir → saut à l'état courant, aucune rediffusion
  accélérée, aucun élément DOM fantôme.
- **Coupure** : `make restart` du service `race` → reconnexion automatique, resync propre.
- **Mode dégradé** : arrêter le service `race` → le banner doit rester animé (simulation locale).
- **Stabilité** : laisser tourner le moteur seul 30 min et vérifier l'absence de `NaN`, de kart
  bloqué et de fuite mémoire (`state.items` qui grossit sans fin).

---

## 8. Évolutions envisagées (non planifiées)

Idées notées au fil de l'eau, à confronter au protocole avant toute implémentation.

### 8.1 Suivre un kart en cliquant sur sa bulle de classement

Rendre les vignettes du classement cliquables pour verrouiller la caméra sur un kart et le suivre,
au lieu de le laisser traverser l'écran.

**Déjà en place, rien à construire :**

- les bulles portent l'identité du kart : `ppDiv.dataset.kartId = kart.id`
  ([smk-banner.js:375](frontEnd/static/js/smk-banner.js#L375)) — un seul listener sur le conteneur
  suffit, sans toucher à leur création ;
- tout le rendu passe déjà par `getScreenPosition(worldX, cameraX, screenWidth)`
  ([smk-banner.js:288](frontEnd/static/js/smk-banner.js#L288)) : karts, objets, boîtes et ligne
  d'arrivée sont positionnés relativement à la caméra, aucune coordonnée écran n'est figée ;
- le **bouclage du monde est déjà géré** par cette même fonction, qui teste `rawDiff`, `+width` et
  `−width`. Un kart suivi qui boucle ne provoquera donc pas de saut.

**Le vrai obstacle : la caméra n'avance pas à la vitesse des karts.**
`cameraX` progresse à `roadPPS` = 250 px/s alors que les karts roulent entre 485 et 530 px/s. La
scène est un tapis roulant : les karts traversent vers la droite, sortent, et reviennent par la
gauche. Ancrer la caméra (`cameraX = kart.worldX − ancrage`) entraîne en cascade :

| Élément | Conséquence |
|---|---|
| Décor de route | Défile ~2× plus vite. Plus juste physiquement, mais change l'identité visuelle du bandeau. |
| Parallaxe et soleil | `bgCameraX` est accumulé **indépendamment** à `roadPPS * 0.5` ([physics.js:589](frontEnd/static/js/physics.js#L589)). Il faudrait le passer en `bgCameraX += deltaCameraX * 0.5`, sinon fond et route se désolidarisent dès que la vitesse change. |
| Décor d'été (`layer-scrolling-fg`) | Dérivé de `cameraX % width`, suivrait automatiquement. |
| Autres karts | Défilent dans les deux sens autour du kart suivi. Avec plusieurs centaines de pixels d'écart et un bandeau d'environ 1000 px, suivre le dernier fait sortir le leader du cadre presque en permanence. **À trancher avant de coder** : laisser sortir, ou dézoomer. |

**⚠️ Incidence sur la migration — nuance §6.6.**
§6.6 propose de ne pas diffuser `cameraX` mais de la **dériver du temps serveur**
(`cameraX = roadPPS * (serverNow - t0) / 1000 % worldWidth`), au motif qu'elle est parfaitement
déterministe. Un suivi de kart casse ce raisonnement : la caméra devient **propre à chaque
spectateur**, puisqu'elle dépend de qui il a cliqué. Il faudra alors distinguer explicitement :

- une **caméra par défaut**, déterministe, dérivable du temps serveur comme prévu en §6.6 ;
- une **caméra locale**, active seulement quand un kart est suivi, jamais diffusée et jamais
  resynchronisée.

Bonne nouvelle pour le protocole : le suivi reste du **rendu pur**. Il ne touche ni à la simulation,
ni au snapshot, ni aux messages — deux spectateurs regardant des karts différents voient toujours
*la même course*, sous un autre angle. L'objectif du document (« tous les visiteurs voient exactement
la même course ») n'est donc pas remis en cause, à condition de bien ranger cette caméra du côté
local et de ne jamais la laisser fuiter dans l'état partagé.

**Version minimale, si le suivi complet est jugé trop coûteux :** se contenter d'un halo sur le kart
sélectionné, via une classe CSS sur le wrapper, sur le modèle de `star-active` qui existe déjà.
Aucune incidence sur la caméra ni sur le protocole.

---

## 9. Ce qui a effectivement été construit (2026-08-23)

Le plan des §3 à §7 a été suivi. Cette section ne répète pas ce qui s'est passé comme
prévu : elle note **ce qui en diffère**, parce que c'est là que la note serait trompeuse
pour qui la relirait plus tard.

### 9.1 Écarts assumés par rapport au plan

| Point | Ce que prévoyait la note | Ce qui a été fait, et pourquoi |
|---|---|---|
| **Mode dégradé** (§6.10) | recharger `physics.js` en `import()` paresseux et **relancer la simulation locale** | **Aucune simulation dans le navigateur, jamais.** Hors ligne = décor qui défile, sans karts, pastille rouge. Décision explicite : « je ne veux pas de fausse course, uniquement du spectateur ». Conséquence heureuse : `physics.js` disparaît complètement du client, et il ne peut plus exister deux versions du gameplay |
| **Défilement de la route** (§6.6) | phase de l'animation CSS « purement cosmétique — acceptable en l'état » | Tranché dans l'autre sens : le décor est **entièrement piloté par la caméra**, animation CSS supprimée. Étendu aux animations de sprite (rebond, étoile, soleil), calées par `animation-delay` négatif sur l'horloge serveur |
| **Caméras** (§6.6) | dérivées du temps par le client, `t0` transmis, snapshot en simple garde-fou | **Transmises dans chaque snapshot** (`cx`, `bx`). Deux nombres contre la certitude qu'aucun spectateur ne verra le décor décalé |
| **Fréquence** (§4.2) | ~15 Hz | **10 Hz**, décidé après mesure : 15 Hz donnait 664 o/snapshot soit ~35 Mo/h par spectateur. Avec `permessage-deflate` (contexte conservé entre messages, fenêtre 4 Ko) : **1,3 Ko/s, ~5 Mo/h** |
| **Champs du snapshot** (§4.1) | inventaire de 8 champs par kart | Deux manques trouvés à l'usage : **`hitEnd`** (sans la date de fin de malus, un arrivant sait qu'un kart est percuté mais pas depuis quand, et le fait tourner à contretemps) et **`hitDuration`** dans le `hello` (le client ne peut pas dériver la frame de toupie sans elle) |
| **Création du monde** | implicite : le serveur pose la grille de départ | `createWorldState()` a été remontée **dans `physics.js`**, le module déjà partagé. La note laissait supposer deux implémentations de la grille de départ à maintenir en parallèle — exactement le genre de duplication que la migration élimine |
| **Cycle de vie** (§6.15) | course unique infinie, simulée même sans public | **Course à la demande** : départ à la première connexion, arrêt 30 s après le dernier départ. Le délai de grâce évite qu'un F5 ne reparte de zéro |
| **Événements** (§4.2) | diffuser la liste produite par `stepPhysics` | Seuls `kartHit` et `leaderboardPosition` sont transmis, et ce dernier **uniquement en cas de changement de place** : `updateLeaderboard` en émet huit toutes les 500 ms, dont l'immense majorité ne déclenche aucune animation |
| **Rideau et indicateur** | absents de la note | Ajoutés : le rideau masque la reconstruction d'une scène de milieu de course, l'indicateur dit au visiteur s'il regarde une course en direct ou un décor |

### 9.2 Un piège qui n'était pas dans la note : le recalage d'horloge

§6.8 demande de recaler l'horloge par ping/pong toutes les 30 s. Fait — mais appliquer
chaque mesure telle quelle **fait sauter l'instant affiché**, donc toute la scène, à chaque
recalage. Invisible sur une liaison locale à 2 ms d'aller-retour, très visible sur mobile où
il varie de plusieurs dizaines de millisecondes : une saccade régulière, toutes les 30 s.

L'horloge effective rejoint donc sa cible **progressivement**, à 1 ms par frame (60 ms/s),
avec saut direct au-delà d'une seconde d'écart — un décrochage n'est pas une dérive.

Corollaire : les éléments créés avant la première mesure portent une phase d'animation
calée sur l'heure locale, donc fausse, et elle ne se corrigerait jamais d'elle-même.
`realignAnimations()` les reprend à la première calibration.

### 9.3 Ce qui reste, et qui est hors de ce dépôt

- **§6.17 — le reverse proxy externe.** Tout ce qui précède a été validé contre le `nginx`
  de ce dépôt (`make race-nginx`). En production le trafic traverse **d'abord** un reverse
  proxy externe, hors dépôt : il doit relayer l'upgrade WebSocket sur `/ws/` et tenir un
  timeout d'inactivité très supérieur à 60 s. À vérifier sur le VPS avant de considérer la
  migration terminée en prod.
- **`WS_ALLOWED_ORIGINS`** : vide, toutes les origines peuvent ouvrir le flux. À renseigner
  dans le `.env` de production, sinon n'importe quel site peut ouvrir une connexion
  permanente sur le service.
- **`SESSION_COOKIE_SECURE`** (noté en §6.17) : toujours à traiter, toujours sans rapport
  avec cette migration.
- **`bannerDev`** (console du navigateur) et `make race-deps` / `make race-spectate` sont
  des outils de développement. Ils ne coûtent rien et servent au diagnostic ; à supprimer
  si l'on veut refermer complètement le chantier.
