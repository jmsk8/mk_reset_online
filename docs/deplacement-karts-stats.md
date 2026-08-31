# Déplacement latéral des karts — défauts recensés et pistes d'équilibrage

> Document de travail interne. Écrit le **2026-08-28** sur la branche `dev`, après lecture
> intégrale de la chaîne de pilotage latéral de `physics.js` (perception → décision →
> braquage → intégration) et de la config associée.

### Journal

| Date | Ce qui a changé |
|---|---|
| 2026-08-28 | Rédaction initiale : §1 à §4, défauts **D-1** à **D-9**. |
| 2026-08-28 | Ajout du **§5** — piste d'équilibrage « coût de braquage indexé sur l'agilité » (proposition de Jérémy), avec le piège d'annulation et le protocole de mesure. Ordre de traitement du §6 revu en conséquence. |
| 2026-08-29 | **Refonte du braquage appliquée** (cf. §7). Le modèle passe de « l'agilité décide de l'amplitude » à « la situation décide du lieu, l'agilité décide du temps ». Une seule fonction écrit `vy`. D-1, D-3, D-4, D-5, D-6, D-7, D-8 corrigés ; D-2 atténué. §5 **activé** (contrainte de virage, `cost: 0.018`). Rien n'est mesuré. |
>
> **État du code au moment de la rédaction :** `physics.js` et `physics-config.js` portent des
> modifications **non commitées** (refonte de la vue, du plan et de la table de coût ;
> `topSpeed` passé en additif ; `massDragSpin` ajouté en « ESSAI »). Tout ce qui suit décrit
> **cet état-là**, pas le dernier commit.
>
> **Nature des constats :** ils viennent de la **lecture du code et du calcul**, pas du banc.
> C'est la différence avec [`prompt-equilibrage.md`](prompt-equilibrage.md), qui est
> mesuré. Chaque défaut porte donc une ligne « À mesurer » — rien ici ne doit être appliqué
> sans campagne avant/après à graine fixe.
>
> Conventions de gravité : 🔴 critique · 🟠 élevé · 🟡 moyen · 🔵 faible/documentaire.

---

## 1. Le modèle, et son invariant

Une seule règle porte tout le pilotage latéral, posée en tête de section dans
`physics.js:435-464` :

> `agility` dit **de combien** un kart se décale, jamais **en combien de temps** il s'y met.

- La latence est **commune à tout le plateau** : `physics.steerResponse: 5` → constante de
  temps de 200 ms, plus le réflexe IA `ai.reactionBaseMs: 280` × jitter [0.8, 1.35].
- L'amplitude est **personnelle** : `steerSpeed(kart, base) = base * kart.stats.agility`.

L'invariant déclaré (`physics.js:464`) : **quatre fonctions seulement écrivent `vy`** —
`steerSpeed`, `applySteering`, `steerClamped`, `seekLane`. Les chocs vivent dans un canal
séparé, `bumpVy`, précisément pour ne pas être effacés par `applySteering` en 200 ms
(`physics.js:3190`).

**Cet invariant est violé une fois : voir D-1.**

## 2. Table de référence

Recalculée depuis `deriveCharacterStats` sur la config actuelle
(`speedBase: 490`, `speedPerWeight: 35`, `speedPerPower: 10`, `gripCurve: 2.5`,
`massDragAgility: 1.70`, `massDragAccel: 1.25`, `massDragSpin: 1.6`) :

| kart | p/pu/m | mass | topSpeed | accel | **agility** | facteur toupie |
|---|---|---|---|---|---|---|
| bowser | 9/5/1 | 1.197 | 526.5 | 0.90 | **0.334** | 1.333 |
| dk | 8/5/2 | 1.144 | 523.0 | 0.95 | **0.370** | 1.240 |
| mario | 5/5/5 | 0.985 | 512.5 | 1.15 | **0.620** | 0.976 |
| luigi | 4/6/5 | 0.932 | 510.0 | 1.29 | **0.681** | 0.893 |
| yoshi | 4/5/6 | 0.932 | 509.0 | 1.23 | **0.781** | 0.893 |
| peach | 3/6/6 | 0.879 | 506.5 | 1.39 | **0.862** | 0.814 |
| toad | 2/5/8 | 0.826 | 502.0 | 1.43 | **1.312** | 0.736 |
| koopa | 2/4/9 | 0.826 | 501.0 | 1.36 | **1.548** | 0.736 |

Amplitude d'agilité sur le plateau : **rapport 1 à 4.6**. `agilityClamp` (0.25 / 1.70) ne mord
sur personne — la marge est saine des deux côtés.

Deux repères utiles pour tout ce qui suit :
- **Piste profonde de 30 unités** (`road.minY: 0`, `road.maxY: 30`).
- **Dégagements nécessaires** : 6.9 u pour un tuyau (`hitboxes.kartVsPipe.y`), 7 u pour un
  objet (`itemVsKart.y: 5` + `ai.crossDodgeMargin: 2`).

---

## 3. Les défauts

### D-1 🔴 La glissade de tuyau court-circuite la maniabilité

`physics.js:421`

```js
kart.vy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;   // 18, plat
```

Deux problèmes en un.

**a) C'est un cinquième écrivain de `vy`**, non déclaré dans l'invariant de `physics.js:464`,
et il ne passe pas par `steerSpeed`. Le déplacement latéral qui en résulte vaut
`slideAway / steerResponse` = **3.6 unités, identiques pour les huit karts**.

Rapporté à ce que chacun sait faire seul sur une esquive d'objet complète :

| kart | esquive complète | les 3.6 u offertes valent |
|---|---|---|
| bowser | 5.0 u | **72 %** de son esquive |
| mario | 9.3 u | 39 % |
| koopa | 23.2 u | 15 % |

Le tuyau rend donc au moins maniable les trois quarts d'une esquive **gratuitement**, et au
plus maniable un sixième. Et ça tombe exactement dans la situation où l'agilité devrait se
payer : le redémarrage contre un mur, piste encore encombrée.

**b) Les deux branches du même effet ont divergé.** La branche `'hit'` juste au-dessus
(`physics.js:399`) fait la même chose dans `bumpVy` — ce qui est correct. La branche
`'running'` l'écrit dans `vy`, c'est-à-dire précisément ce que le commentaire de
`physics.js:3190` interdit noir sur blanc.

> **Correctif pressenti :** basculer la ligne 421 sur `bumpVy`, comme sa jumelle. Question
> ouverte : faut-il en plus mettre `slideAway` à l'échelle de la masse (c'est un choc), ou le
> laisser plat ? Un choc plat est défendable ; un choc plat écrit dans le canal de braquage ne
> l'est pas.
>
> **À mesurer :** taux de contact tuyau par kart avant/après. C'est aussi un préalable à
> D-2 — sans ce correctif, le lourd récupère au choc ce qu'on lui retire à l'approche, et la
> mesure ne dira rien.

### D-2 🟠 L'esquive de tuyau ne teste la maniabilité de personne

`physics.js:1720` (`choosePipeLane`), `physics.js:1857` (`steerAroundPipes`)

Un tuyau est vu à `vision.range.front: 1100` px, soit ~2.1 s. Avec `pipe.laneSeekSpeed: 45`,
le budget latéral disponible avant de l'atteindre :

| kart | temps dispo | budget latéral | px de visibilité qu'il lui faudrait |
|---|---|---|---|
| bowser | 2.09 s | **28.4 u** | 343 |
| dk | 2.10 s | 31.7 u | 316 |
| mario | 2.15 s | 54.3 u | 217 |
| peach | 2.17 s | 76.5 u | 173 |
| koopa | 2.20 s | **139.0 u** | 119 |

Bowser dispose de **3.2× la marge dont il a besoin**, et son budget (28.4) couvre quasiment
toute la largeur de piste (30) : il traverse d'un bord à l'autre avant d'arriver dessus.

**Conséquence :** le filtre de portée de `choosePipeLane` — tout le mécanisme censé écarter
les couloirs hors d'atteinte — est **inerte pour les huit karts**. La distinction que le code
construit entre `widestLane` (trajectoire : on choisit où l'on veut être) et `bestGap`
(réflexe : le plus proche qui marche) s'effondre côté tuyau, la joignabilité ne filtrant
jamais rien.

Le contraste avec l'esquive d'objet est net : là, bowser couvre 5.0 u pour un besoin de 7 —
**il échoue vraiment**. Le système fonctionne quand les nombres sont bons ; le tuyau est
l'exception.

**Le contre-argument, et sa limite.** `physics.js:359` défend une position cohérente : le
lourd paie le tuyau à la **relance** (son accélération décide du coût du choc), pas à
l'évitement — un mur se négocie en trajectoire, pas au réflexe. Mais cette pénalité ne se
déclenche que s'il touche des tuyaux, or il n'en touche pratiquement jamais par son propre
pilotage. **Sa faiblesse conçue est en sommeil**, et le tuyau est simultanément l'obstacle le
plus fréquent du circuit et le moins discriminant.

> **Piste chiffrée :** `pipe.laneSeekSpeed: 45` → **~18**. C'est le levier propre : il n'est lu
> qu'à deux endroits, tous deux spécifiques au tuyau — contrairement à `laneSeekGain` et
> `laneTolerance`, partagés avec l'esquive et la précaution (cf. D-8).

| kart | budget à 45 | à 25 | **à 18** |
|---|---|---|---|
| bowser | 28.4 | 15.8 | **11.3** contraint |
| dk | 31.7 | 17.6 | **12.7** contraint |
| mario | 54.3 | 30.1 | **21.7** contraint |
| peach | 76.5 | 42.5 | **30.6** libre |
| koopa | 139.0 | 77.2 | **55.6** libre |

> À 18 la plage enjambe la largeur de piste : le léger choisit le meilleur couloir n'importe
> où, le lourd prend le meilleur **à sa portée**. C'est la phrase que le code voulait écrire.
> Personne n'est bloqué (11.3 > 6.9), donc aucun kart ne se plante mécaniquement — il perd le
> choix, pas le passage.
>
> **Réserve :** baisser `laneSeekSpeed` ralentit aussi la rejointe elle-même, pas seulement le
> budget. Les lourds traîneront visiblement à changer de ligne avant un tuyau. C'est la lecture
> voulue, mais c'est un changement d'allure à l'écran.
>
> **À mesurer :** contacts tuyau par kart, temps perdu par kart, taux de victoire. Corriger D-1
> **d'abord**.

### D-3 🟠 `spinDuration` est indexé sur la masse — le `handling` n'y gagne rien

`physics.js:3950`, `physics-config.js:106`

```js
function spinDuration(cfg, kart) {
    const flat = cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
    return flat * Math.pow(kart.stats.mass, cfg.kartStats.massDragSpin);   // 1.6
}
```

La piste B de `prompt-equilibrage.md` proposait d'**indexer la durée du tête-à-queue sur
l'agilité**, pour faire passer le `handling` de 6 % à ~25 % de la course en zone d'influence.
L'implémentation l'indexe sur la **masse**.

Or `mass = lerp(0.72, 1.25, norm.weight)` ne dépend **que du poids**. Le nouveau canal est donc
piloté entièrement par l'axe `weight`, et **l'axe `handling` en est absent**. La preuve tient
dans la table du §2 :

| paire | même masse | même facteur toupie | mais agilité |
|---|---|---|---|
| toad / koopa | 0.826 | 0.736 | 1.312 vs **1.548** |
| luigi / yoshi | 0.932 | 0.893 | 0.681 vs **0.781** |

Deux karts de poids identique et de handling différent tournent exactement aussi longtemps.
Le canal ouvert par la piste B élargit la fenêtre du **poids**, pas celle du handling — c'est
l'inverse de l'objectif.

**Effet de bord sur l'équilibrage :** l'axe poids est désormais taxé **trois** fois —
accélération (`massDragAccel` 1.25), agilité (`massDragAgility` 1.70), durée de toupie
(`massDragSpin` 1.6, rapport bowser/koopa = **1.81**) — alors que `physics-config.js:122`
affirme toujours qu'« un kart lourd achète sa pointe et la paie **deux fois** ». Le commentaire
est périmé. Et dans le même diff `speedPerWeight` passe de 20 à 35 : la récompense et la
troisième pénalité ont bougé ensemble, ce qui rend l'effet net illisible sans banc.

> **Deux options, à trancher :**
> **(a)** Passer sur `agility` (`flat / agility ** k`) — c'est la piste B telle qu'écrite, et
> elle donne au handling le canal qui lui manque.
> **(b)** Garder la masse, et corriger le commentaire de config + réexaminer `speedPerWeight`.
>
> **À mesurer :** la campagne de référence de `prompt-equilibrage.md`
> (`make race-sim RACES=1000 SEED=2814382103`), en isolant ce seul changement.

### D-4 🟡 `lateralReach` a un paramètre `agility` mort

`physics.js:485`

```js
function lateralReach(cfg, agility, intensity, ms) {
    const t = ms / 1000;
    const tau = 1 / cfg.physics.steerResponse;
    return intensity * (t - tau * (1 - Math.exp(-t / tau)));   // agility n'est jamais lu
}
```

Correct aujourd'hui : les trois appelants pré-scalent `intensity` via `steerSpeed`. Mais deux
d'entre eux (`physics.js:1439` et `physics.js:1720`) passent `kart.stats.agility` en second
argument, ce qui donne l'impression que c'est **là** que le personnage entre.

Le jour où quelqu'un appelle avec une intensité brute en se fiant à la signature, la portée
devient **indépendante du personnage en silence** — et ce sont exactement les deux fonctions
qui décident quels trous sont atteignables (`placePlan`) et quels couloirs tiennent dans le
budget (`choosePipeLane`). La maniabilité disparaîtrait de la planification sans qu'aucun test
ne bouge.

> **Correctif :** supprimer le paramètre. Zéro changement de comportement, le piège se ferme.

### D-5 🟡 La visée dépasse sa cible, et son terme proportionnel ignore l'agilité

`physics.js:2026-2028`

```js
const speed = steerSpeed(kart, ai.aimSpeed);
kart.targetVy = Math.max(-speed, Math.min(speed, diff * ai.aimSpeed));
```

**a)** Seule manœuvre de placement qui n'utilise pas `seekLane` : pas de soustraction de la
course restante (`vy / steerResponse`), tolérance 0.5. Le kart coupe la commande et dérive
encore de `vy / 5` — jusqu'à **3.7 u pour koopa**, 1.5 pour mario, 0.8 pour bowser. C'est
l'ordre de grandeur de `ai.aimErrorMax` (3.5) et de la hitbox d'objet (5) : le dépassement
double l'imprécision qu'on croit avoir réglée, **et il la double le plus pour les karts
agiles** — donc il s'ajoute à rebours de la stat.

**b)** Le terme `diff * ai.aimSpeed` n'est **pas** passé par `steerSpeed`, alors que son
plafond juste au-dessus l'est. Partout ailleurs c'est `steerSpeed(kart, diff * gain)`
(cf. `seekLane`, `physics.js:1383`). Effet pratique : le terme sature le plafond presque
immédiatement pour tout le monde, et l'approche de visée devient du tout-ou-rien au lieu d'être
proportionnelle. L'agilité survit (le plafond la porte), le profil voulu non.

> **Correctif :** faire passer la visée par `seekLane`, avec ses propres gain et tolérance.
> **À mesurer :** précision du tir (touches / tirs) par kart.

### D-6 🟡 `sight.back` et le contenu de `sight` peuvent être désynchronisés 80 ms

`physics.js:1901-1903`

`updateGlance` tourne à la cadence d'affichage, `perceive` toutes les
`vision.scanIntervalMs: 80`. Au début d'un coup d'œil arrière, `sight.back` est déjà `true`
alors que `sight.seenKartY` provient encore du balayage **avant**. Le relevé de visée arrière
(`physics.js:1988`) mord dessus :

```js
if (aiming && aimDir < 0 && sight.back && sight.seenKartDist >= 0) {
    kart.aimTargetY = sight.seenKartY;
```

Le tireur peut relever la profondeur d'un kart situé **devant** lui pour viser **derrière**.
Fenêtre de ~80 ms sur les 350 de `glanceDurationMs`, soit environ un quart des coups d'œil.
Symétrique à la sortie du coup d'œil.

> **Correctif pressenti :** poser un `sight.backAt` dans `perceive` et n'autoriser le relevé
> que si le balayage courant a bien été fait vers l'arrière.

### D-7 🟡 `plan.threatY` n'est rafraîchi que pour les précautions

`physics.js:1626-1631`

La révision de plan reprend `plan.threatY` en mode `safety`, pas en mode `spin`. Sans effet
pour un objet — ils ne dérivent pas en profondeur — mais les menaces de contact (étoile, bill ;
`e.id = -1 - other.id`, `physics.js:894`) sont des **karts qui manœuvrent**. `placePlan`
calcule `natural` puis `crossing` à partir de cette valeur périmée, et `crossing` déclenche le
frein (`ai.edgeBrakeMs`). Un kart peut donc freiner pour une position que l'étoile a quittée.

### D-8 🔵 Couplage de config : l'esquive et la précaution consomment les constantes du tuyau

`physics.js:1955` et `physics.js:1975`

```js
seekLane(cfg, kart, plan.laneY, plan.intensity, cfg.pipe.laneSeekGain, cfg.pipe.laneTolerance);
```

Régler `pipe.laneSeekGain` pour le contournement retouche **en silence** le gain de toutes les
esquives et de toutes les précautions — trois manœuvres qui partagent la loi de pilotage mais
pas l'urgence. Rien ne le signale dans la config.

À noter pour D-2 : `laneSeekSpeed`, lui, **n'est pas** partagé. C'est ce qui en fait un levier
propre.

> **Correctif :** donner à l'esquive ses propres `dodgeSeekGain` / `dodgeTolerance` dans `ai`,
> même si les valeurs de départ sont identiques.

### D-9 🔵 Le canal de choc comprime la maniabilité — constat, pas défaut

`physics.js:3526`, `physics-config.js:363`

`contact.maxBumpY: 45` contre 16.7 u/s d'autorité de braquage pour bowser (`dodgeIntensityMax`
50 × 0.334). Le partage par inertie corrige dans le bon sens — avec `massBias: 2.0`, bowser
n'encaisse que ~32 % d'un choc contre koopa ~68 % — mais le rapport choc/braquage reste
**deux fois plus défavorable au lourd** (0.86 contre 0.40).

Cohérent avec l'intention affichée (un lourd n'est pas vif), donc pas compté comme défaut.
Consigné parce que c'est un endroit où la maniabilité est **compressée sans que ce soit écrit
nulle part** : en trafic dense, la position latérale d'un lourd est davantage décidée par les
chocs que par son volant.

---

## 4. Vérifié et sain

À ne pas re-suspecter lors d'une prochaine passe :

- `agilityClamp` (0.25 / 1.70) **ne mord sur personne** : plancher réel 0.334, plafond 1.548.
- Toutes les autres consignes latérales passent bien par `steerSpeed` : dépassement
  (`physics.js:2043`), collecte (`:2058`), maraude (`:2076`), retour au couloir (`:2090`).
- `missChance` (`physics.js:528`) utilise `referenceAgility` — la moyenne du plateau — et non
  l'agilité du kart. **Délibéré et documenté** : le tirage dit s'il a *vu venir* la menace, et
  un kart maniable n'est pas plus attentif qu'un autre.
- `applySteering` borne son facteur à 1 : une frame longue arrive pile sur la consigne au lieu
  de la dépasser. Sans effet différencié sur les stats.
- `clampKartToRoad` n'annule que la composante **sortante** au bord, identiquement pour tous.
- Le déplacement latéral est **indépendant de la vitesse d'avance**
  (`yPercent += (vy + bumpVy) * deltaTime`, `physics.js:4341`). Un kart à l'arrêt change de
  ligne aussi vite qu'à pleine vitesse. C'est un choix de modèle assumé, pas un bug — mais
  c'est le levier à envisager si l'on veut un jour que la pointe et la maniabilité
  s'affrontent.

---

## 5. Piste d'équilibrage — indexer le coût de braquage sur l'agilité

> **Origine :** proposition de Jérémy, 2026-08-28. « Plus on a de handling et plus on est
> léger, moins ça coûte en vitesse de tourner. Pour koopa, quasi aucun coût ; pour bowser, un
> coût réel. Quelque chose de léger mais suffisamment marqué. »
>
> **Statut : non implémenté, non mesuré.** Ce qui suit est l'analyse de faisabilité.

### 5.1 Pourquoi c'est le bon canal

Le point 4 de [`prompt-equilibrage.md`](prompt-equilibrage.md) établit que **l'agilité n'agit
que par un canal représentant 6 % de la course** (la remise en route après incident), pendant
que la pointe tient les 94 % restants. C'est la cause du dernier rang de koopa (9 en handling,
6.3 % de victoires sur la campagne de référence).

Un coût de braquage est **le premier mécanisme qui mettrait l'agilité dans la bande des
94 %**. Ce n'est pas un ajustement de coefficient, c'est l'ouverture du canal qui manque.

Et il fait ce que `massDragSpin` était censé faire et ne fait pas (cf. **D-3**) : comme
`agility = grip / mass^1.70`, le coût porte **à la fois** le poids et le handling. Deux karts
de même masse et de handling différent se sépareraient enfin — ce qui n'arrive nulle part
aujourd'hui hors des 6 % :

| paire (même masse) | écart de coût en `/A` | en `/A²` |
|---|---|---|
| toad / koopa | 1.18× | 1.39× |
| luigi / yoshi | 1.15× | 1.32× |

### 5.2 Le piège — `vy` est déjà proportionnel à l'agilité

**C'est le point à ne pas rater, et il invalide les trois formulations spontanées.**

`steerSpeed` met **toutes** les consignes latérales à l'échelle de l'agilité — esquive,
couloir, maraude, visée, dépassement, collecte. Donc `vy = agility × s`, où `s` est la consigne
de base, identique pour tous les karts.

Coût facturé pour une **manœuvre identique**, normalisé sur koopa :

| formule | bowser | mario | koopa | résultat |
|---|---|---|---|---|
| `k·\|vy\|` | 0.22 | 0.40 | 1.00 | **inversé** — l'agile paie 4.6× plus |
| `k·\|vy\|/A` | 1.00 | 1.00 | 1.00 | **s'annule** — tout le monde paie pareil |
| `k·\|vy\|/A²` | **4.63** | 2.50 | 1.00 | l'intention est rendue |

La première est celle qu'on écrit spontanément, et elle punit koopa. La deuxième est celle
qu'on écrit en se disant « il faut diviser par l'agilité », et elle ne produit **rien**.

Il faut diviser **deux fois** : une fois pour annuler la mise à l'échelle de la consigne et
retrouver la manœuvre demandée, une fois pour la facturer. Forme qui se documente elle-même :

```js
// `vy` porte deja un facteur d'agilite (cf. steerSpeed). On le retire pour
// retrouver la MANOEUVRE demandee, qui ne depend pas du personnage, puis on la
// facture a l'agilite : la meme manoeuvre coute plus cher a un lourd.
const demand = Math.abs(kart.vy) / kart.stats.agility;
const corner = demand / kart.stats.agility;
```

### 5.3 L'arbitrage `/A` contre `/A²`

Les deux formulations sont défendables mais ne disent pas la même chose :

| | même manœuvre | par unité de déplacement réellement couvert |
|---|---|---|
| `/A` | tout le monde paie pareil | bowser paie **4.6×** |
| `/A²` | bowser paie **4.6×** | bowser paie **21.5×** |

`/A` se lit « braquer coûte la même chose à tous, mais l'agile obtient 4.6× plus de
déplacement pour ce prix ». Élégant, mais ce n'est pas l'intention formulée.

**`/A²` est la formulation retenue** — c'est celle qui correspond à l'énoncé. Réserve : 21.5×
par unité de distance est raide. En cas de surcorrection au banc, le repli est l'exposant
intermédiaire `/A^1.5` (2.6× par manœuvre), **pas** un retour à `/A` qui ne fait rien.

### 5.4 Où le brancher

`physics.js:4251`, en multiplicateur sur `effectiveSpeed`, exactement comme
`ai.edgeBrakeFactor` deux lignes plus bas :

```js
effectiveSpeed *= 1 - Math.min(cfg.speeds.cornerMaxLoss, corner * cfg.speeds.cornerCost);
```

**Pourquoi là et pas ailleurs :** le coût disparaît à l'instant où le kart cesse de braquer,
sans période de récupération — c'est ce qui le rend « léger ». C'est isolé, réversible, et
surtout **ça ne se compose pas avec `acceleration`**. Rogner `targetSpeed` (`physics.js:4236`)
ou `absoluteVelocity` ferait payer la reprise une seconde fois via une stat déjà taxée par la
masse, et on ne saurait plus quel levier produit quel effet.

Le plafond `cornerMaxLoss` n'est pas décoratif : sans lui, un kart accolé au bord pendant une
esquive ratée voit son coût partir très haut.

**Propriété acquise gratuitement :** `seekLane` met `targetVy` à 0 dès que le couloir est tenu.
Le coût ne s'accumule donc que pendant les **transitions**, jamais pendant qu'on tient une
ligne. Rien à ajouter pour l'obtenir.

### 5.5 La méta que ça installe

La ligne optimale devient « choisir tôt, et tenir ». Ça récompense la planification de couloir
et punit le zigzag réactif. À l'écran : **les lourds tracent, les légers dansent** — une
identité de build lisible par le spectateur, donc une méta stable plutôt qu'un simple
rééquilibrage de pourcentages.

Ça se marie avec **D-2** : corriger `laneSeekSpeed` force le lourd à s'engager tôt dans un
couloir atteignable, et le coût de braquage récompense précisément cet engagement. Les deux
changements racontent la même histoire.

### 5.6 Quatre risques

**a) La maraude devient une taxe pure.** `ai.wanderSpeed: 4` occupe ~25 % du temps et
n'accomplit rien. Sous `/A²`, bowser paierait 4.6× plus cher pour une dérive sans objet — un
impôt invisible, sans décision derrière. Deux sorties : exempter la maraude du coût, ou faire
que l'IA maraude moins quand c'est cher (préférable : ça transforme la taxe en caractère, mais
ça réduit l'effet d'équilibrage). **À mesurer dans les deux configurations.**

**b) Interaction multiplicative avec D-2.** Corriger `laneSeekSpeed` 45 → 18 divise `s` par 2.5
sur les couloirs de tuyau, donc ampute une grosse part du coût total. **Les deux changements ne
doivent pas être mesurés ensemble.**

**c) Le poids serait taxé une quatrième fois** (accélération, agilité, durée de toupie,
braquage) pour une seule récompense. Directionnellement correct — le perdant est le build
handling, pas le build poids — mais **c'est le moment de trancher D-3** : si `massDragSpin`
passe sur l'agilité comme le proposait la piste B, on ouvre deux canaux neufs sur le même axe
d'un coup, et la surcorrection est quasi certaine. *Recommandation : n'en garder qu'un, et
garder celui-ci — il agit sur 94 % de la course, l'autre sur 6 %.*

**d) La ligne de base est périmée.** Les 15.5 % / 6.3 % de `prompt-equilibrage.md` datent
d'avant le passage de `topSpeed` en additif. L'écart de pointe est passé de ~35 à 25.5 px/s,
soit ~5 points de taux de victoire déjà redistribués, et `massDragSpin` s'est ajouté par-dessus.
**Aucun chiffre de balance valide n'existe pour le code actuel.**

### 5.7 Protocole

1. **Campagne de référence** sur `dev` tel quel, avant toute modification.
2. **Instrumenter le banc** pour sortir, par kart : distance latérale parcourue par course, et
   temps passé avec `|vy| > 0`. Personne ne connaît cette quantité, et le §5.2 montre que
   l'intuition s'y trompe. C'est elle qui fixe le coefficient.
3. Le coût en `/A²`, **seul**, calibré pour un **différentiel de 5 à 15 px/s de vitesse
   moyenne** entre bowser et koopa (repère du doc d'équilibrage : ~4.5 px/s ≈ 1 s de course
   ≈ 2 points de taux de victoire).

**Le test de non-régression est déjà écrit.** `prompt-equilibrage.md` a mesuré que les huit
karts croisent à **94.0–94.2 % de leur propre pointe**, et en a conclu — à raison pour le code
d'alors — que « le slalom ne coûte rien ». Après ce changement, cette colonne **doit** diverger.
Si elle reste plate à 94 %, c'est qu'on est dans le cas « s'annule » du §5.2, et le signal est
immédiat.

---

## 6. Méthode et réserves

- **Rien de ce document n'est mesuré.** Tout vient de la lecture et du calcul. Les ordres de
  grandeur sont fiables, les effets sur le taux de victoire sont **inconnus**.
- Le banc est `make race-sim RACES=1000 SEED=2814382103` (cf. `prompt-equilibrage.md`).
  Un changement, une campagne, une conclusion.
- **Ordre de traitement recommandé :** campagne de référence (§5.7) → D-1 (correctif net,
  préalable à toute mesure sur les tuyaux) → D-4 (gratuit) → **arbitrage D-3 vs §5** (les deux
  ouvrent un canal sur le même axe, n'en garder qu'un) → §5 instrumenté puis calibré → D-2
  (réglage chiffré, à mesurer séparément de §5, cf. §5.6b) → D-5 → D-6/D-7 → D-8.
- **Réserve de circuit** — la même que dans `prompt-equilibrage.md` : un seul tracé existe
  (Anneau du Moai, 7 pipes). D-2 est **directement sensible au nombre de tuyaux** : un tracé
  qui en aurait 15 changerait le poids du défaut sans qu'on touche à rien. Générer un tracé
  chargé et rejouer la mesure est un préalable au réglage de `laneSeekSpeed`.


---

## 7. Ce qui a été appliqué le 2026-08-29

> **Statut : écrit, relu, non mesuré.** Aucune campagne n'a tourné sur ce code.
> Tout ce qui suit décrit une intention réalisée, pas un résultat observé.

### 7.1 Le modèle a changé de sens

L'invariant du §1 disait :

> `agility` dit **de combien** un kart se décale, jamais **en combien de temps** il s'y met.

Il dit maintenant l'inverse, et c'est délibéré :

> La **situation** dit où aller, et elle le dit pareil pour les huit karts.
> `agility` dit **en combien de temps** on y arrive.

Le reflexe, lui, ne bouge pas : `ai.reactionBaseMs` et `physics.steer.response` restent
communs. Un kart ne décide pas plus tôt qu'un autre ; il répond avec ses moyens.

Ce que ça corrige concrètement : quatre manœuvres calculaient une **amplitude**
proportionnelle à l'agilité (`base × agility` poussé pendant une durée) au lieu de viser un
point. La maraude emmenait un koopa sur ~6 unités et un bowser sur ~1.3 sans que rien, dans la
situation, ne le demande. Elles visent toutes une profondeur maintenant.

### 7.2 Une seule fonction écrit `vy`

`steerSpeed` / `applySteering` / `steerClamped` / `seekLane` / `lateralReach` sont remplacés par :

| | rôle |
|---|---|
| `steer(cfg, kart, dt, laneY, speed, spec)` | **le seul écrivain sur ordre.** Toutes les manœuvres, bill compris. |
| `steerCap(cfg, kart, base)` | le seul endroit où le personnage entre dans le braquage |
| `steerPace` / `steerGrip` | l'appui qui reste à l'allure du moment |
| `steerSettle` | où le kart s'arrêterait s'il relâchait tout |
| `steerReach(cfg, cap, ms)` | distance couverte en `ms` — utilisée par les planificateurs |
| `steerDelay(cfg, cap, dy)` | temps pour couvrir `dy` — exportée, lue par `scenario.js` |

`steerReach` et `steerDelay` sont **exactement inverses** (Newton, précision machine).

Les deux seules autres écritures de `vy` sont des **contraintes** et sont nommées dans
l'invariant : `clampKartToRoad` (annule la composante sortante au bord) et le refus de
braquage d'un contact dans `resolveKartPair`.

### 7.3 Nouveau : l'appui perdu à l'allure

`physics.steer.pace = { drag: 0.35, curve: 1.0 }` — un kart lancé tourne moins bien qu'un kart
au ralenti. Il reste `1 - 0.35 × allure` de volant, l'allure étant rapportée à **sa propre**
pointe (même convention que `contactInertia`).

| allure | appui restant |
|---|---|
| arrêt | 1.000 |
| rattrapage après incident (~45 %) | 0.843 |
| croisière (94 %) | **0.671** |

**`drag: 0` restaure trait pour trait le comportement d'avant.** C'est l'interrupteur, et
c'est le premier nombre à bouger si le banc dit que les esquives sont devenues trop dures.

**Contrepartie sous objet de vitesse :** `physics.steer.boostGain: 1.20`. Champignon et étoile
rendent **20 % de volant** tant qu'ils durent. Sans ça, l'appui à l'allure faisait l'inverse de
ce qu'on veut — le champignon aurait été le seul objet à dégrader le pilotage de celui qui le
prend, au moment précis où il double. Le bill n'est pas concerné : `steerCap` le laisse hors
des trois facteurs.

Le drapeau `kart.steerBoost` est posé une fois par tick avec `isFlat` et `bumped`, ce qui
permet à `steerCap` de ne lire qu'un kart — sans horloge — et donc de valoir pareil pour le
pilotage et pour les planificateurs.

| état | appui | × objet | volant | koopa, 7 u | bowser, 7 u |
|---|---|---|---|---|---|
| arrêt (relance) | 1.000 | 1.00 | 1.000 | 280 ms | 795 ms |
| rattrapage (~45 %) | 0.843 | 1.00 | 0.843 | 311 ms | 909 ms |
| croisière (94 %) | 0.671 | 1.00 | 0.671 | 359 ms | 1092 ms |
| **champignon / étoile** | 0.650 | **1.20** | **0.780** | **327 ms** | **966 ms** |

Soit **+16 % de volant** sous objet par rapport à une croisière ordinaire : l'allure en reprend
une partie, puisque le kart roule à 1.5 fois sa pointe.

Temps pour dégager 7 unités (profil esquive) :

| kart | agilité | à l'arrêt | en rattrapage | en croisière |
|---|---|---|---|---|
| bowser | 0.334 | 796 ms | 910 ms | **1093 ms** |
| mario | 0.620 | 507 ms | 572 ms | 674 ms |
| koopa | 1.548 | 280 ms | 311 ms | **359 ms** |

Effet de bord voulu : la remise en route après un incident se fait à allure réduite, donc avec
du volant en plus. **Un kart qui repart se replace ; un kart lancé tient sa ligne.**

### 7.4 État des défauts

| | état |
|---|---|
| **D-1** 🔴 glissade de tuyau dans `vy` | **corrigé** — passée dans `bumpVy`, comme sa jumelle `'hit'` |
| **D-2** 🟠 budget latéral de tuyau | **atténué, pas réglé.** L'appui à l'allure ampute le budget d'un tiers : bowser passe de 30.4 à **20.4** unités, sous la largeur de piste (30) pour la première fois. Le rapport entre karts est inchangé (facteur uniforme). `ai.steering.pipe.speed` reste le levier propre. |
| **D-3** 🟠 `spinDuration` indexé sur la masse | **retiré.** Le tête-à-queue est de nouveau forfaitaire pour tout le monde ; `massDragSpin` n'existe plus. Le poids n'est donc plus taxé que deux fois, et le commentaire de config redevient vrai. |
| **D-4** 🟡 paramètre `agility` mort | **corrigé** — le paramètre n'existe plus (`steerReach(cfg, cap, ms)`) |
| **D-5** 🟡 visée qui dépasse, gain hors échelle | **corrigé** — la visée passe par `steer`, avec son propre profil |
| **D-6** 🟡 `sight.back` désynchronisé du balayage | **corrigé** — `sight.scanBack` retient le sens du balayage effectué ; le relevé arrière l'exige |
| **D-7** 🟡 `plan.threatY` périmé en mode `spin` | **corrigé** — la révision le reprend, comme en mode `safety` |
| **D-8** 🔵 couplage de config | **corrigé** — neuf profils dans `ai.steering`, un par manœuvre |
| **D-9** 🔵 canal de choc | inchangé — c'était un constat |

### 7.5 La contrainte de virage — active

`physics.steer.corner = { cost: 0.018, fullLock: 50, maxLoss: 0.08 }`. **`cost: 0` désactive
tout**, sans rien d'autre à toucher.

Une seule fonction la porte, `steerCost(cfg, kart)`, appelée une fois dans `stepPhysics` à côté
de `edgeBrakeFactor`. Rien d'autre dans le moteur ne sait qu'un virage coûte quelque chose.

**Une quatrième stat dérivée, `cornering`** — c'est elle qui répartit la contrainte :

```
cornering = agility * force ^ cornerPowerGain          (cornerPowerGain: 1.0)
```

Bâtie sur `agility` et non sur une quatrième formule : la maniabilité porte déjà le poids au
dénominateur et le handling au numérateur, exactement les deux axes voulus et dans le bon sens.
Il n'y manquait que la puissance. Une seule courbe à régler, et la tenue en virage suit
automatiquement tout réglage de la maniabilité.

| kart | p/pu/m | agilité | **cornering** | esquive (50) | tuyau (45) | esquive moy. (35) | maraude (4) |
|---|---|---|---|---|---|---|---|
| bowser | 9/5/1 | 0.334 | **0.375** | −4.5 % | −4.1 % | −3.2 % | −0.4 % |
| dk | 8/5/2 | 0.370 | 0.417 | −4.1 % | −3.7 % | −2.8 % | −0.3 % |
| mario | 5/5/5 | 0.620 | 0.697 | −2.4 % | −2.2 % | −1.7 % | −0.2 % |
| luigi | 4/6/5 | 0.681 | 0.803 | −2.1 % | −1.9 % | −1.5 % | −0.2 % |
| yoshi | 4/5/6 | 0.781 | 0.878 | −1.9 % | −1.7 % | −1.4 % | −0.2 % |
| peach | 3/6/6 | 0.862 | 1.018 | −1.7 % | −1.5 % | −1.2 % | −0.1 % |
| toad | 2/5/8 | 1.312 | 1.476 | −1.2 % | −1.0 % | −0.8 % | −0.1 % |
| koopa | 2/4/9 | 1.548 | **1.656** | −1.0 % | −0.9 % | −0.7 % | −0.1 % |

Rapport bowser / koopa sur la même manœuvre : **4.4×**. Sur une ligne tenue, zéro pour tout le
monde — `steer` coupe la consigne dès que la cible est tenue, donc le coût ne s'accumule que
pendant les **transitions**. La ligne optimale devient « choisir tôt, et tenir ».

L'allure entre dans la facture : à l'arrêt on tourne pour rien, lancé on paie plein tarif.
C'est ce qui en fait une contrainte de virage et non une taxe sur le volant.

**Sous objet de vitesse, rien** — un champignon doit rendre le multiplicateur qu'on lui donne,
même règle que le frein de bord. Le volant, lui, y gagne (§7.3).

**Le piège du §5.2 est évité par construction :** `steerCost` divise `|vy|` par
`steerCap(cfg, kart, 1)`, ce qui retire d'un coup les trois facteurs que `steerCap` a mis
(agilité, appui à l'allure, objet) et restera juste si un quatrième s'ajoute. Facturer `|vy|`
tel quel punirait l'agile ; ne retirer l'agilité qu'une fois s'annulerait exactement.

`maxLoss: 0.08` ne mord pas au réglage actuel — il faudrait une consigne de 89 quand le
pilotage n'en demande jamais plus de 50. C'est un garde-fou, pas un réglage.

**Le test de non-régression :** le banc mesurait les huit karts en croisière à 94.0–94.2 % de
leur propre pointe. Cette colonne **doit** maintenant diverger, et dans l'ordre du poids. Si
elle reste plate, le coût s'annule quelque part.

Le banc affiche la nouvelle stat : colonne **`virage`** dans le tableau de tête de
`simulate.js`.

### 7.6 Ce qui reste à faire, dans l'ordre

1. **Vérifier que ça tourne.** Aucun runtime JS n'était disponible sur la machine au moment
   d'écrire : `make race-sim RACES=200` est le premier geste.
2. **Campagne de référence** sur ce code. Toutes les lignes de base antérieures sont périmées.
3. **Calibrer les trois nombres neufs**, dans cet ordre : `corner.cost` (0.018),
   `pace.drag` (0.35), `boostGain` (1.20). Les trois sont linéaires et indépendamment
   désactivables (`0`, `0`, `1`). Regarder le taux de contact tuyau et d'objet par kart, la
   colonne « % pointe », et le taux de victoire de ceux qui tirent beaucoup de champignons.
4. **`wanderOffset` / `ai.steering.wander.speed`** : à 4 et 4, seuls toad et koopa atteignent
   leur cible de maraude dans la fenêtre de dérive. Le modèle « même lieu, temps différent »
   n'est donc visible qu'au bout léger du plateau. Monter la vitesse le rendrait lisible
   partout, au prix d'une dérive plus vive.
5. **D-2 chiffré** — `ai.steering.pipe.speed` 45 → ~18, séparément de tout le reste.
6. **§5** — instrumenter, puis ouvrir `corner.cost`.
