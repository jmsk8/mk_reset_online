# Audit — la prise de décision des karts sur leurs objets

> **Nature de ce document.** Audit de la chaîne qui décide **ce qu'un kart fait de son objet** :
> ce qu'il reçoit, ce qu'il en planifie, quand il change d'avis, et comment il le lance.
> Constat par constat. **Rien n'a été codé ni commité.**
>
> **Date : 2026-09-17.** Portée : **le moteur JS** (`raceEngine/`), qui est la référence. Le
> portage C++ est hors périmètre.
>
> Fichiers lus intégralement : [`items.js`](../../raceEngine/src/engine/items.js) (le tirage),
> [`weapons.js`](../../raceEngine/src/engine/weapons.js) (l'usage),
> `updateShield()` dans [`vision.js`](../../raceEngine/src/engine/vision.js) (le changement d'avis),
> plus `config/items.js` et `config/ai.js`. Les points d'exécution de
> [`step.js`](../../raceEngine/src/engine/step.js) ont été suivis.
>
> **Compagnon** de [audit-decision-direction-2026-09-17.md](audit-decision-direction-2026-09-17.md),
> qui traite le pilotage latéral. Les deux systèmes se croisent en deux endroits, relevés au §5.
>
> **Même limite de méthode** : ni Node ni Docker dans l'environnement de cet audit, **aucun
> constat n'a pu être rejoué au banc**. Tout vient de la lecture et du calcul. Les constats **O-1**
> et **O-2** sont prouvés statiquement (recherche exhaustive sur le dépôt) ; les autres portent une
> ligne « À mesurer ».

---

## 1. Le modèle en une page

La décision d'objet se lit en **trois moments**, et la qualité du design tient à ce qu'ils soient
séparés :

```
   ┌────────────────────────────────────────────────────────────────────┐
   │  1. LE TIRAGE            rollItem()               items.js         │
   │     Qui a droit à quoi. Une pression unique, cinq mesures.         │
   │     → décide du TYPE reçu                                          │
   ├────────────────────────────────────────────────────────────────────┤
   │  2. LE PLAN              planItemUse()            weapons.js       │
   │     Pris À LA RÉCEPTION, quand le kart en sait le MOINS.           │
   │     → trailTime, throwTime, shotDirection, lobbing, aimError       │
   ├────────────────────────────────────────────────────────────────────┤
   │  3. LE CHANGEMENT D'AVIS updateShield()           vision.js        │
   │     Un danger apparaît derrière → il RECONSIDÈRE, une fois par     │
   │     ÉPISODE de danger.                                             │
   │     → réécrit trailTime / throwTime / shotDirection                │
   └────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
   ┌────────────────────────────────────────────────────────────────────┐
   │  EXÉCUTION      step.js, chaque tick, dans CET ordre :              │
   │     if (trailTime && now > trailTime)  → 'hands' devient 'behind'  │
   │     if (now > throwTime)               → activateItem()            │
   └────────────────────────────────────────────────────────────────────┘
```

**L'idée forte, et elle est bonne** : le plan se prend au moment où le kart est le plus ignorant —
il vient de ramasser une boîte, il ne sait pas encore qui le suivra. `updateShield` est la
réparation de cette ignorance, et elle est bornée à **une reconsidération par épisode de danger**,
faute de quoi le kart tirerait à pile ou face soixante fois par seconde.

---

## 2. Le tirage : une pression, cinq mesures

Aucun palier figé « rang 1 reçoit ceci, rang 8 cela ». Une seule grandeur, la **pression**, et
chaque objet y répond à sa façon.

```
   CINQ MESURES, toutes normalisées 0 → 1
   ═══════════════════════════════════════════════════════════════

     p   rang            (kart.rank − 1) / (n − 1)
     d   écart au 1er    distance / 3500      (~7 s de retard)
     s   étape de course 0 au départ → 1 à l'arrivée
     g   écart au kart DE DEVANT    / 1200
     i   isolement       0.65 × étalement + 0.35 × g

                          │
                          ▼
   pression = (0.45·p + 0.55·d) × (0.85 + 0.30·s) × (0.48 + 0.52·i)
              └─── où j'en suis ──┘ └─ temps qui ─┘ └─ suis-je ──┘
                                      reste           seul ?
```

Puis **deux familles**, et c'est la bonne coupure :

```
   OBJETS TACTIQUES                    OBJETS PUISSANTS
   banane, verte, rouge, champignon    étoile, bill, éclair
   ─────────────────────────────       ─────────────────────────
   courbes propres sur p / d / s / g   ne lisent QUE la pression
   présents dès p = 0                  + un seuil d'ouverture
   (le 1er n'a que banane et verte)    + un verrou de calendrier

     poids = base                        poids = base
           × curve(rank, p)                    × ramp(pression,
           × curve(dist, d)                           open, full)
           × curve(stage, s)
           × curve(gap, g)               star  : ouvre à 0.28, rang ≥ 2
                                         bill  : ouvre à 0.45, rang ≥ 4
                                         éclair: ouvre à 0.58, 3 derniers
```

Trois correctifs se superposent ensuite, et chacun répond à un défaut nommé :

| Correctif | Effet | Ce qu'il empêche |
|---|---|---|
| `repeatPenalty: 0.4` | l'objet déjà reçu pèse 40 % | recevoir trois bananes d'affilée |
| `decay` / `regenPerLap` | chaque exemplaire **distribué** divise le poids du suivant **pour tout le monde** | la rafale d'éclairs |
| `lateFade` | écrête la fin de course | *« près des deux tiers des orages tombaient au dernier tour »* |

**Le point le plus fin du tirage** est que `decay` est **global et non par porteur** : c'est ce qui
fait qu'un éclair rend les suivants rares pour tout le plateau. Et `lateFadeFactor` est compensé
par un `base` relevé (35), sans quoi écrêter le dernier tour aurait **réduit** le nombre d'orages
au lieu de les redistribuer. Ce raisonnement de second ordre est correct et rarement fait.

---

## 3. Le plan, et le changement d'avis

### Le plan initial (`planItemUse`)

```
   objet reçu
      │
      ├─ carapace ? ──► shotDirection = rollShellDirection()
      │                    verte  arrière : leader 1.00 / pack 0.20 / dernier 0.05
      │                    rouge  arrière : leader 1.00 / pack 0.05 / dernier 0.00
      │
      ├─ banane ?   ──► lobbing = rankChance(bananaLobChance)
      │                    leader 0 / pack 0.20 / dernier 0.70
      │
      ├─ RANG 1 ?   ──► écrase tout : lobbing = false, direction = −1
      │                 « le premier défend » ; shotAsLeader mémorisé
      │
      ├─ aimError = ±3.5           (hitbox verticale d'un objet = 5)
      │
      └─ traînable ET tirage trailChance ?
              OUI ──► trailTime = now + [400…3000] × hurry
                      throwTime = trailTime + [1200…6000] × hurry × holdFactor
              NON ──► throwTime = now + [500…8000] × hurry
```

L'**agressivité** module toutes les attentes :

```
   agression = √(rang × écart) × étape        ← moyenne GÉOMÉTRIQUE :
                                                être dernier DANS le peloton
                                                ne suffit pas, il faut les deux
   hurry = 1 − agression × (1 − 0.35)         ← jusqu'à ×0.35 sur les délais
```

La racine est là parce que « deux moitiés donneraient un quart » — le commentaire le dit, et c'est
juste.

### Le changement d'avis (`updateShield`)

C'est la partie la plus subtile du système, et elle mérite son schéma :

```
   un danger apparaît DERRIÈRE  (dangerBehind, souvenir ≤ 3500 ms)
      │
      ├─ danger === 'ram' (étoile / bill) ? ──► RIEN, l'esquive s'en charge
      │
      ├─ objet = star ou bill ?
      │     └─► ne se pose pas derrière : il rend INTOUCHABLE
      │         panic 0.80 → AVANCE la date au simple temps de réflexe
      │         « il ne la recule JAMAIS »   ← garde-fou explicite
      │
      └─ objet traînable (banane, verte, rouge) ?
            │
            └─ UNE FOIS PAR ÉPISODE   (kart.shieldAt !== sight.dangerSince)
                  │
                  ├─ garder ?  keep = 0.98 si carapace DÉJÀ PARTIE
                  │            keep = 0.90 si simple PORTEUR
                  │      │
                  │      ├─ NON (shieldHold = false)
                  │      │     └─► throwTime = now          (lance tout de suite)
                  │      │         backThrow 0.60 → vers le danger
                  │      │
                  │      └─ OUI (shieldHold = true)
                  │            └─► trailTime = now          (se couvre TOUT DE SUITE)
                  │
                  └─ tant que le danger dure :
                        throwTime = now + 3500     ← repoussé à chaque appel
```

La ligne *« TOUT DE SUITE, et pas seulement s'il n'avait rien prévu »* corrige un vrai défaut :
un kart qui avait programmé de sortir son objet attendait son minuteur **avec un bouclier dans
les mains**. Décider de se couvrir et le faire plus tard, ce n'est pas se couvrir.

---

## 4. Constats

| # | Constat | Gravité | Statut |
|---|---|---|---|
| **O-1** | ~~`shieldHold` n'est jamais remis à `false`~~ | ✅ **corrigé 2026-09-18** | **prouvé** |
| **O-2** | Les trois triples sont désactivés, tout leur code dort | 🟡 | prouvé |
| **O-3** | `findRedShellTarget` ignore l'occlusion — la rouge voit à travers tout | 🟡 | lecture |
| **O-4** | La rouge tirée en arrière part **sans cible**, en ligne droite | 🔵 | lecture |
| **O-5** | `getAggression` lit `state.cachedLeader` avec un repli sur soi-même | 🔵 | lecture |

### O-1 — `shieldHold` survit à l'objet qui l'a justifié 🟠 *(prouvé)* — ✅ CORRIGÉ le 2026-09-18

> **Résolu.** `kart.shieldHold = false` dans `giveKartItem()`, **en amont des deux branches**
> — et non dans `planItemUse()` comme la « correction naturelle » le suggérait d'abord. La
> raison est le piège que l'audit signale lui-même deux paragraphes plus bas : `planItemUse`
> n'est pas appelée pour les objets en orbite, la branche `spec` sortant avant. Placée là où
> elle est, la remise à zéro couvre aussi les triples le jour où ils reviennent (O-2).
>
> Sans risque de déborder : `updateShield` réécrit le drapeau par un tirage propre à chaque
> nouvel épisode de danger (`shieldAt !== dangerSince`), et la remise à zéro n'a lieu qu'à la
> réception d'un objet.
>
> **Reste à mesurer**, une fois le banc regardé tourner : la proportion d'objets dont le
> `throwTime` était repoussé sans qu'aucun tirage `keep` ait été joué pour eux.



Recherche exhaustive sur `raceEngine/src/` — le drapeau n'apparaît qu'en **quatre** endroits :

| Endroit | Ce qui s'y passe |
|---|---|
| `world.js:173` | initialisation à `false`, **une fois**, à la création du kart |
| `vision.js:476` | `kart.shieldHold = rng() < keep` — la seule écriture |
| `vision.js:499` | `if (kart.shieldHold) kart.throwTime = now + pressureMemoryMs` |
| `protocol.js:55` | lecture pour l'affichage |

**Aucun chemin ne le remet à `false`.** Ni `activateItem()`, qui consomme l'objet et remet pourtant
soigneusement `kart.trailTime = 0` dans ses **sept** branches. Ni `giveKartItem()`. Ni
`planItemUse()`, qui réinitialise pourtant **six** champs du kart — `shotDirection`, `lobbing`,
`shotAsLeader`, `aimError`, `trailTime`, `throwTime` — tout **sauf** celui-là.

Conséquence : un kart qui décide de se couvrir avec une banane garde `shieldHold = true` **après
avoir lâché cette banane**. Au prochain objet, la ligne 499 s'applique à un drapeau hérité d'une
décision qui ne le concerne pas.

```
   t0   banane reçue, danger derrière → shieldHold = TRUE, se couvre
   t1   la banane part (activateItem) ── trailTime remis à 0 ✓
                                         shieldHold RESTE À TRUE ✗
   t2   nouvelle boîte : verte reçue
        planItemUse → throwTime = now + [500…8000]
   t3   un danger est encore perçu derrière (souvenir ≤ 3500 ms)
        ligne 499 s'applique AVANT toute reconsidération d'épisode :
        → throwTime = now + 3500, repoussé à chaque appel
        → la verte est retenue sur une décision prise pour la BANANE
```

**Ce qui limite la portée**, et c'est pourquoi ce n'est pas 🔴 : la ligne 499 n'est atteinte que si
`updateShield` a passé ses deux gardes d'entrée — un objet en main **et** un danger frais derrière
(`dangerBehind`, ≤ 3500 ms). Hors danger, le drapeau périmé dort sans rien faire. Et si un nouvel
épisode de danger s'ouvre (`shieldAt !== dangerSince`), le drapeau est **réécrit** par un tirage
propre, ce qui répare l'état.

La fenêtre de dégât est donc : **un nouvel objet reçu pendant que le danger précédent est encore
frais**, avant qu'un nouvel épisode ne s'ouvre. C'est étroit, mais pas rare — c'est exactement ce
qui arrive à un kart sous pression qui traverse une zone de boîtes.

> **Correction naturelle** : `kart.shieldHold = false` dans `planItemUse()`, à côté des six autres
> réinitialisations qui y sont déjà. C'est l'endroit qui porte déjà cette responsabilité.
>
> ⚠️ Attention à un piège : `planItemUse()` **n'est pas appelée pour les objets en orbite**
> (`giveKartItem` sort par sa branche `spec` avant). Si les triples sont réactivés, la remise à
> zéro devrait vivre dans `giveKartItem`, en amont des deux branches.
>
> **À mesurer ensuite** : proportion d'objets dont le `throwTime` a été repoussé par la ligne 499
> alors qu'aucun tirage `keep` n'avait été joué pour **cet** objet.

### O-2 — tout le code des triples dort 🟡 *(prouvé)*

`disabledItems: ['tripleBanana', 'tripleGreenShell', 'tripleRedShell']` — les trois.

Dorment donc, sans être jamais exercés : `getOrbitSpec`, `getHoldPosition` (branche `'orbit'`),
la boucle `orbs` de `giveKartItem`, `updateOrbitItems` entier (~60 lignes avec sa hitbox et son
parcours à rebours), la branche orbite d'`activateItem`, `removeOrbitItem`, `destroyOrbitItem`,
`getOrbitItemPosition`, et `heldThreatType` — dont le commentaire dit lui-même : *« Sans effet tant
que les triples sont désactivés — et c'est bien le problème. »*

Le commentaire de config affirme « en place et testés — vider cette liste suffit ». Le code est
effectivement soigné (le parcours à rebours pour cause de `splice`, la phase figée à l'attribution,
la non-filtration sur la profondeur pour ne pas « rendre le bouclier troué à l'arrière »). Mais
« testé » et « jamais exécuté en course » ne sont pas la même chose, et **une réactivation changerait
d'un coup le comportement du danger latent** pour tout le plateau (cf. D-3 de l'audit direction).

### O-3 — la rouge cible à travers les murs 🟡

`findRedShellTarget()` boucle sur `state.karts` **directement**, sans passer par `kart.sight` :

```js
for (let i = 0; i < state.karts.length; i++) { ... }
```

C'est le dernier endroit du système d'objets à lire le monde plutôt que la vue. Or l'audit de
direction montre que la visée, elle, a été explicitement corrigée sur ce point : *« C'était le
dernier endroit du pilotage à lire le monde directement, sans occlusion ni portée de regard : un
kart caché derrière un autre s'y faisait prendre pour cible. »*

La même correction n'a pas été portée ici. Deux lectures possibles, et je ne tranche pas :

- **défendable** : une rouge est une tête chercheuse, elle n'a pas besoin que son lanceur voie la
  cible ; c'est même ce qui la rend redoutable, et `seeHomingThroughCover` assume déjà qu'elle
  échappe aux règles d'occlusion dans l'autre sens ;
- **discutable** : le *choix* de la cible est une décision du **tireur**, pas de l'objet. Un kart
  qui désigne quelqu'un qu'il ne peut pas voir contredit la règle qui gouverne tout le reste du
  moteur.

> **À mesurer** : proportion de rouges dont la cible désignée était **masquée** pour le tireur au
> moment du tir. `sight.hiddenIds` existe déjà et relève exactement cette information.

> **Tranché le 2026-09-23 par l'utilisateur** : la lecture « défendable » est la bonne. La
> rouge est une tête chercheuse, voir à travers les murs n'est pas grave. **Ce qui est
> attendu d'elle, en revanche, n'existe pas** : elle devrait contourner un obstacle fixe
> comme un pipe et foncer droit sur sa cible sinon. Aujourd'hui elle vise la profondeur de sa
> cible sans regarder le décor, et se brise sur le premier pipe (`advanceProjectile`).
> C'est un chantier à ouvrir.

### O-4 — la rouge arrière part aveugle 🔵

```js
const target = dir > 0 ? findRedShellTarget(cfg, state, kart) : null;
```

Tirée vers l'arrière, la rouge n'a **jamais** de cible : elle part tout droit avec un `vy`
aléatoire, exactement comme une verte. Le commentaire l'assume (« tête chercheuse vers l'avant
seulement »).

C'est cohérent avec `shellBackwardChance.redShell` — `{ leader: 1, pack: 0.05, last: 0 }` — donc le
cas ne se produit presque jamais, **sauf pour le leader, où il vaut 1**. Or le leader est
précisément celui qui tire toujours en arrière. Autrement dit : **la rouge du premier est toujours
une verte plus rapide**. C'est peut-être exactement l'intention (le premier ne doit pas avoir
d'arme téléguidée), mais ce n'est écrit nulle part, et la table de probabilités laisse croire à un
choix tactique là où il n'y en a pas.

### O-5 — un repli discret dans l'agressivité 🔵

```js
const pace = state.cachedLeader || kart;
```

Si `cachedLeader` est absent, le kart se prend **lui-même** comme référence de progression — et son
`raceTerm` devient alors celui d'un leader. L'effet est faible et le repli ne dure qu'un tick, mais
c'est un repli **silencieux** qui change la valeur au lieu de la neutraliser. Noté pour mémoire,
pas pour action.

> **Repris le 2026-09-23** : le repli est pratiquement inatteignable. Ce qui est étrange,
> c'est la **copie** de `getRaceStage()` (`standings.js`), qui calcule la même grandeur avec
> un repli à 0. Piste : n'en garder qu'une. À réfléchir, rien de modifié.

---

## 5. Où les deux systèmes se croisent

Deux points de contact entre la décision d'objet et la décision de direction, tous deux voulus :

```
   OBJETS ──────────────────────────────────────► DIRECTION

   1. isArmedForward() / isTrailable()
      ce qu'un kart PEUT faire de son objet
              │
              └──► alimente le DANGER LATENT (SEE_PRESSURE)
                   → déclenche la manœuvre `safety` (se ranger)

   2. isTrailable(kart.heldItem)
              │
              └──► BLOQUE le `giveWay` : porter de quoi riposter
                   dispense de se faire doubler
```

Le second est le plus fin : un kart qui porte une carapace ne se range pas devant une rouge, parce
qu'il a mieux à faire que de céder le passage. La condition est bien posée dans `updatePlan`.

---

## 6. Ce qui tient

| Point | Verdict |
|---|---|
| Plan à la réception + reconsidération bornée à un épisode | ✅ La bonne structure : décider tôt, réviser une fois |
| `shieldAt !== dangerSince` comme borne d'épisode | ✅ Sans elle, un tirage 60 fois/s |
| `panic` n'avance la date, **jamais** ne la recule | ✅ Garde-fou explicite et vérifié |
| `getShotDirection` corrige le plan sur la place **réelle** | ✅ Le 1er ne tire jamais devant ; doublé, il redevient normal |
| `redShellTargetScore` : pente et non seuil | ✅ Corrige « un kart à un pixel sous la barre écarté comme un kart au pare-chocs » |
| Pénalité de proximité **au carré** | ✅ Ne mord qu'au contact, linéaire elle décalerait tout le monde |
| `decay` **global**, pas par porteur | ✅ C'est ce qui casse les rafales pour tout le plateau |
| `base` de l'éclair relevé pour compenser `lateFade` | ✅ Redistribue au lieu de réduire |
| `unique` + orage en cours comptent ensemble | ✅ `isSingletonFree` traite le cas |
| Poids nuls exclus du tirage | ✅ Un `rng()` rendant 0 ne peut pas choisir un objet verrouillé |
| `total <= 0` → aucun objet plutôt qu'un objet interdit | ✅ Le cas « tout verrouillé » est traité |
| `itemArmDistance` : ne pas toucher son propre lanceur | ✅ Protège sans immuniser |
| Orbite : parcours à rebours (cause `splice`) | ✅ Un orbe consommé ne décale pas les non testés |
| Orbite : phase figée à l'attribution | ✅ La rotation des survivants ne saute pas |
| Étoile/bill effacent le rapetissement | ✅ « On ne part pas en trombe en étant écrasé » |
| `throwDelayAfterHit` après un tête-à-queue | ✅ On ne lance pas en toupie |

---

## 7. Ce que cet audit n'a pas couvert

- **Aucune mesure au banc** — c'est la limite principale. O-3, O-4 et O-5 sont des hypothèses de
  lecture.
- **L'équilibrage des courbes de distribution** (`rank`, `dist`, `stage`, `gap` par objet) : lues
  pour comprendre le mécanisme, **pas** jugées. Dire si la rouge sort trop souvent au 3ᵉ rang
  demande le banc, pas la lecture.
- **La physique des objets lancés** (rebonds, `maxShellBounces`, la bleue) : hors périmètre, c'est
  du déplacement, pas de la décision.
- **L'éclair et son orage** (`state.storm`) : la décision de lancer est auditée, les effets non.
- **Le portage C++**.

---

## 8. Recommandations, par ordre

1. **Réinitialiser `shieldHold` dans `planItemUse()` (O-1).** Une ligne, au seul endroit qui porte
   déjà cette responsabilité pour cinq autres champs. C'est le seul constat qui décrit un
   comportement incorrect en course.
2. **Réparer le banc** (`crossDodgeMargin`, cf. D-1 de l'audit direction) — condition de toute
   mesure, donc de tout le reste.
3. **Trancher le sort des triples (O-2).** Les réactiver et mesurer, ou acter qu'ils dorment et le
   dire dans `heldThreatType`.
4. **Décider pour la rouge (O-3).** Soit le ciblage passe par `kart.sight` comme la visée, soit on
   écrit pourquoi il en est dispensé. L'incohérence actuelle n'est pas documentée.
5. **Documenter O-4** — une ligne suffit : la rouge du leader est délibérément une verte rapide.
   ✅ **Acté le 2026-09-23** par l'utilisateur, comme O-2 (les triples dorment, c'est voulu).
