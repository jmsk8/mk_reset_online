# Audit — la prise de décision de direction des karts

> **Nature de ce document.** Audit de la chaîne qui décide **où un kart se place en profondeur de
> piste** : ce qu'il voit, ce qu'il en juge, et ce qu'il commande au volant. Constat par constat.
> **Rien n'a été codé ni commité.**
>
> **Date : 2026-09-17.** Portée : **le moteur JS** (`raceEngine/`), qui est la référence.
> Le portage C++ (`raceEngineCpp/`) est **hors périmètre**.
>
> Fichiers lus intégralement : [`ai.js`](../../raceEngine/src/engine/ai.js),
> [`plans.js`](../../raceEngine/src/engine/plans.js),
> [`vision.js`](../../raceEngine/src/engine/vision.js),
> [`driving.js`](../../raceEngine/src/engine/driving.js),
> [`steering.js`](../../raceEngine/src/engine/steering.js),
> [`pipes.js`](../../raceEngine/src/engine/pipes.js), plus `config/ai.js` et `config/vision.js`.
>
> Ce document **remplace** [audit-pilotage-2026-08.md](audit-pilotage-2026-08.md), archivé : il
> décrivait `physics.js`, fichier qui n'existe plus. La refonte annoncée dans son §7 a bien eu
> lieu, et l'essentiel de ses défauts D-1 à D-9 est refermé (§6 ci-dessous).
>
> **Limite de méthode, posée d'entrée.** Ni Node ni Docker ne sont disponibles dans
> l'environnement où cet audit a été mené : **aucun constat n'a pu être rejoué au banc.** Tout ce
> qui suit vient de la lecture et du calcul. Chaque constat porte donc une ligne « À mesurer »,
> sauf **D-1**, qui est prouvé statiquement. C'est exactement la distinction que posait déjà
> l'audit d'août, et elle vaut toujours : *rien ici ne doit être appliqué sans campagne avant/après
> à graine fixe.*

---

## 1. Le modèle en une page

La décision de direction repose sur **une seule idée**, et tout le reste en découle :

> La **situation** dit **OÙ** aller. L'**agilité** dit en **COMBIEN DE TEMPS** on y arrive.

C'est l'invariant central, posé en tête de [`steering.js`](../../raceEngine/src/engine/steering.js).
Sa conséquence pratique est qu'aucune manœuvre ne calcule d'amplitude proportionnelle à l'agilité :
les huit karts visent **la même profondeur**, et seul le temps de parcours les sépare. Corollaire
utile : toute question de pilotage devient une question de **temps**, donc mesurable.

Le système se lit en quatre étages, strictement séparés :

```
┌──────────────────────────────────────────────────────────────────────┐
│  1. ATTENTION        updateGlance()            vision.js             │
│     Devant ou derrière ? Un seul côté à la fois.                     │
│     → décide de CE QUE LE BALAYAGE VERRA                             │
├──────────────────────────────────────────────────────────────────────┤
│  2. PERCEPTION       perceive()                vision.js             │
│     Un balayage toutes les 80 ms. Occlusion, réflexe, inattention.   │
│     → produit kart.sight : LA menace, les spans, les occasions       │
├──────────────────────────────────────────────────────────────────────┤
│  3. PLAN             updatePlan()              plans.js              │
│     Une décision qui SURVIT à plusieurs images. Révision cadencée.   │
│     → produit kart.plan : laneY (où aller), kind, intensity          │
├──────────────────────────────────────────────────────────────────────┤
│  4. COMMANDE         updateAI() → steer()      ai.js / driving.js    │
│     Ordre de priorité des manœuvres, puis UN SEUL écrivain de vy.    │
│     → écrit kart.targetVy, puis kart.vy                              │
└──────────────────────────────────────────────────────────────────────┘
```

**La séparation est réelle, pas décorative** : `vision.js` ne pilote rien, `steering.js` ne décide
rien. C'est la qualité structurelle la plus forte du système, et elle rend chaque étage testable
isolément.

---

## 2. L'arbitrage : comment LA menace est désignée

Le point le plus élégant du système. Il n'existe **pas** d'ordre figé « carapace avant banane avant
tuyau ». Il existe une **monnaie commune : la milliseconde**, et une seule formule
([`vision.js`](../../raceEngine/src/engine/vision.js), `threatScore`) :

```
                    coût du danger (ms)
    score  =  ──────────────────────────────
                temps avant impact (ms)
```

Chaque danger perçu est noté, **le plus haut score gagne**, et il devient `sight.threatId`.

```
    Un kart, trois dangers perçus au même instant
    ═══════════════════════════════════════════════════════════════

     banane à 1200 ms        coût 2000        score = 2000/1200 = 1.7
     tuyau  à  800 ms        coût  ~∞*        score = fort
     kart   à  400 ms        coût  300        score =  300/400  = 0.75
                                                       ▲
                                              le plus cher PAR UNITÉ
                                              DE TEMPS l'emporte
    * le coût du tuyau est vision.cost.pipe ; sa vraie force
      est ailleurs (cf. le VETO, §3)
```

Ce qui rend ce choix juste : **un danger lointain mais grave peut battre un danger proche mais
bénin**, sans qu'aucun seuil ne soit écrit nulle part. C'est ce qui fait qu'un kart accepte de
frôler un tuyau pour éviter une carapace, et jamais l'inverse.

### La même monnaie sert au placement

`laneRisk()` ([`driving.js`](../../raceEngine/src/engine/driving.js)) note **une profondeur** dans
cette même unité :

```
    note(y)  =  ce qu'on RISQUE en y étant  +  ce que coûte d'Y ALLER
                ───────────────────────────    ────────────────────────
                 somme des corps traversés      detour × steerDelay()
                 + encombrement + bord
                 − bonus de boîte
```

L'ordre des prix **est** la hiérarchie du jeu, et il tient en quatre lignes :

| Corps | Coût | Nature |
|---|---|---|
| **tuyau** | infranchissable de près | masse infinie, `hard: true` |
| **objet** | 2000 ms | un tête-à-queue |
| **carrosserie** | 300 ms | une bousculade — et elle peut s'écarter seule |
| **bord** | 200 ms | un frottement, il ne ferme rien |

Et une subtilité qui mérite d'être relevée : les **marges de confort ne refusent rien**, les
entamer *coûte*, en proportion (`place.graze`). C'est ce qui rend un passage serré **jouable —
cher, mais jouable** — quand il est le moins cher de la piste. Les deux chercheurs de couloir
antérieurs répondaient par oui ou par non, et le plus large gagnait donc toujours.

---

## 3. L'ordre de commande, et le seul veto

Une fois la menace désignée et le plan posé, `updateAI()` descend une liste de priorités. **Le
premier qui s'applique commande et sort** (`return`).

```
   updateAI(kart)
        │
        ├─ isBill ? ──────────────────────────► rejoint le milieu, FIN
        │
        ├─ updateGlance()   (attention)
        ├─ perceive()       (si 80 ms écoulées)
        ├─ updatePlan()     (le plan survit aux images)
        ├─ updateShield()   (objet : couvrir ou lancer)
        │
        │   ┌─────────────────────────────────────────────────┐
        ├──►│ 1. ESQUIVE     plan.kind === 'spin'             │
        │   │    ⚠ SAUF SI pipeOutranksPlan() ── LE VETO      │
        │   └─────────────────────────────────────────────────┘
        ├──► 2. TUYAU        steerAroundPipes()
        ├──► 3. PRÉCAUTION   giveWay / safety   (+ lever le pied)
        ├──► 4. VISÉE        aiming
        ├──► 5. DÉPASSEMENT  kart devant qui bouche
        ├──► 6. BOÎTE        collecte
        ├──► 7. MARAUDE      dérive de confort
        └──► 8. CROISIÈRE    relâche le volant  (aucun retour de ligne)
```

### Le veto : `pipeOutranksPlan()`

C'est **la seule exception** à l'arbitrage par les coûts, et elle est parfaitement justifiée dans
le code : un tuyau **ne se paie pas, il ARRÊTE**. Le mettre dans la même monnaie revenait à lui
donner un tarif — et « une carapace à 800 ms l'emportait sur un mur à 500, et le kart y allait en
pleine connaissance de cause ».

La question posée n'est donc pas un prix mais une **géométrie** :

```
        EN OBÉISSANT À L'ESQUIVE, OÙ SERAI-JE AU MOMENT DU TUYAU ?

    position                                          tuyau
    d'arrêt          portée de braquage          ┌───────────┐
    (settle)         sur le temps restant        │   lo   hi │
       │◄──────────── reach ────────────►│       │           │
       ●─────────────────────────────────○       └───────────┘
                                         ▲
                              « at » : où l'esquive m'emmène
                              
        at ∈ [lo−slop, hi+slop]  ──►  DEDANS : le tuyau reprend le volant
        sinon                    ──►  À CÔTÉ : l'esquive continue
```

Et le détail qui montre la maturité du modèle : le veto a le droit de laisser l'esquive **emmener
le kart de l'autre côté du tuyau** si la place est là. Ce n'est pas « tuyau > esquive », c'est
« la ligne commandée sort-elle bel et bien du mur dans le temps qui reste ».

---

## 4. La boucle complète, de l'œil au volant

```
 ┌── ATTENTION ─────────────────────────────────────────────────────────┐
 │  4 raisons de regarder derrière, LE PLUS ÉLEVÉ GAGNE (jamais la somme)│
 │     sa place      leader 0.30 / pack 0.10 / dernier 0.04             │
 │     zone de boîtes vue      →  0.50 / 0.30 / 0.10   (4 s)            │
 │     danger déjà vu          →  0.70 / 0.65 / 0.65                    │
 │     BRUIT (étoile, bill)    →  0.85  ← seule qui n'exige pas         │
 │                                        d'avoir déjà regardé          │
 └───────────────────────────────┬──────────────────────────────────────┘
                                 ▼  sight.back  (un seul côté !)
 ┌── BALAYAGE (80 ms) ──────────────────────────────────────────────────┐
 │  tuyaux → objets → karts → objets traînés → boîtes                   │
 │                  ↓                                                   │
 │        tri par distance à l'ŒIL (caméra, reculée de 125 px)          │
 │                  ↓                                                   │
 │   marche du plus proche au plus lointain :                           │
 │        • masqué par une ombre déjà posée ?  → invisible              │
 │        • sinon : pose SA propre ombre (cône, pas tranche)            │
 │                                                                      │
 │   exceptions d'occlusion, toutes deux justifiées :                   │
 │        tuyau     `pierces` — « un pilote connaît son circuit »       │
 │        rouge     `seeHomingThroughCover` — sinon inévitable          │
 └───────────────────────────────┬──────────────────────────────────────┘
                                 ▼
 ┌── JUGEMENT (une fois par menace, MÉMORISÉ) ──────────────────────────┐
 │   réflexe   280 ms × [0.80 … 1.35]        ─┐                         │
 │   inattention  missChance()                ├─ judgedIgnored[slot]    │
 │   péremption   memoryMs                   ─┘                         │
 │                                                                      │
 │   fenêtre TAILLÉE AU BESOIN, pas fixe :                              │
 │       threatWindow = réflexe + temps de dégagement    (plancher 900) │
 │       ↑ corrige le défaut où bowser/dk prenaient une banane POSÉE    │
 │         100 % du temps : ils n'avaient pas le DROIT de commencer     │
 └───────────────────────────────┬──────────────────────────────────────┘
                                 ▼
 ┌── PLAN (survit aux images) ──────────────────────────────────────────┐
 │   chooseLane() → 3 passes, chacune lève UNE exigence :               │
 │       1. tel qu'il est, imprécision comprise, dans le temps qu'il a  │
 │       2. sans son imprécision  (tenter un passage serré)             │
 │       3. sans limite de temps  (aller VERS le bon couloir)           │
 │                                                                      │
 │   puis pickLane() : tirage uniforme sur les ÉGALITÉS (Vitter)        │
 │       ↑ sans lui, l'ordre de construction tranchait et le kart       │
 │         passait EN DESSOUS 8 fois sur 10, sur tous les tuyaux        │
 └───────────────────────────────┬──────────────────────────────────────┘
                                 ▼
 ┌── VOLANT — UN SEUL ÉCRIVAIN : steer() ───────────────────────────────┐
 │   diff = laneY − steerSettle(kart)     ← le POINT D'ARRÊT,           │
 │                                          jamais la position          │
 │   targetVy = clamp(steerCap(diff × gain), ±steerCap(speed))          │
 │   vy += (targetVy − vy) × min(1, response × dt)                      │
 │                                                                      │
 │   deux contraintes REPRENNENT vy sans rien commander :               │
 │       clampKartToRoad()   annule la composante sortante au bord      │
 │       resolveKartPair()   reprend ce qui pousse dans l'autre         │
 │   les chocs vivent à part, dans bumpVy                               │
 └──────────────────────────────────────────────────────────────────────┘
```

**Le point d'arrêt (`steerSettle`) est la référence universelle** : le volant a 200 ms d'inertie,
et une consigne proportionnelle au seul écart courant dépassait d'environ 2,5 unités — de quoi
ressortir par l'autre bord d'un passage de six. Retrancher la course restante rend la réponse
apériodique **sans ralentir la manœuvre**. Cette référence est utilisée partout — placement, veto,
braquage — et c'est ce qui rend le système cohérent.

---

## 5. Constats

| # | Constat | Gravité | Statut |
|---|---|---|---|
| **D-1** | ~~`cfg.ai.crossDodgeMargin` n'existe pas : le banc rend `NaN`~~ | ✅ **corrigé 2026-09-18** | **prouvé** |
| **D-2** | ~~Le commentaire de `vision.threatLane` cite la même clé morte~~ | ✅ **corrigé 2026-09-18** | prouvé |
| **D-3** | `heldThreatType` corrige un défaut que `disabledItems` masque | 🟡 | lecture |
| **D-4** | Le `giveWay` ne vérifie pas que la rouge vise **bien lui** | 🟡 | lecture |
| **D-5** | L'attention est un goulot non mesuré : voir devant **coûte** l'arrière | 🟡 | **mesuré 2026-09-21** |
| **D-6** | `missChance` étalonné sur l'agilité de référence — à confirmer au banc | 🔵 | lecture |

### D-1 — le banc de scénario est cassé 🟠 *(prouvé)* — ✅ CORRIGÉ le 2026-09-18

> **Résolu.** `tools/scenario.js` lit désormais `cfg.vision.place.margin.item`, où la clé a
> migré — `src/config/ai.js` le documentait déjà sur place. D-2 est corrigé dans le même
> geste (le commentaire de `vision.threatLane` citait le même fantôme, avec une valeur
> chiffrée qui n'était plus vérifiable ; elle a été retirée plutôt que recalculée à vue).
>
> ⚠️ **Le banc n'a pas été exécuté** : `node` n'est pas disponible dans l'environnement où
> la correction a été écrite. La clé et son chemin ont été vérifiés dans le source, mais
> **la table de temps de manœuvre reste à regarder tourner** avant de s'appuyer sur ses
> chiffres. C'est un `node tools/scenario.js`.



[`tools/scenario.js:40`](../../raceEngine/tools/scenario.js#L40) :

```js
const trip = cfg.hitboxes.itemVsKart.y + cfg.ai.crossDodgeMargin;   // degager un objet
```

**`cfg.ai.crossDodgeMargin` n'est défini dans aucun fichier de configuration.** Vérifié par
balayage des huit fichiers de `src/config/` : zéro définition. Le commentaire de `config/ai.js`
le dit lui-même — « le dégagement qui l'accompagnait (`crossDodgeMargin`) vit maintenant dans
`vision.place.margin.item` » — mais l'outil n'a pas suivi.

Conséquence : `trip` vaut **`NaN`**, donc `steerDelay(cfg, cap, NaN)` aussi, et **toute la table
des temps de manœuvre du banc affiche `NaN`**. C'est-à-dire précisément la table qui met en
évidence l'invariant du système (« seul le temps change d'un kart à l'autre »).

La gravité est 🟠 et non 🔴 parce que **le moteur n'est pas touché** : la clé morte n'existe que
dans l'outil. Mais c'est l'instrument de mesure qui est en panne, et c'est ce qui rend tous les
autres constats de ce document non mesurables. **À corriger en premier** — c'est la condition de
tout le reste.

> Correction : remplacer par `cfg.vision.place.margin.item`, la valeur qui a repris ce rôle.

### D-2 — le même fantôme dans un commentaire 🔵 *(prouvé)*

[`config/vision.js:20`](../../raceEngine/src/config/vision.js#L20) documente `threatLane` en se
référant à « `hitboxes.itemVsKart.y` + `ai.crossDodgeMargin` = 7 ». La clé n'existant plus, le
lecteur qui veut vérifier ce 7 cherche une valeur introuvable. Sans effet sur le moteur, mais
c'est le genre de renvoi mort qui fait douter du reste d'un commentaire par ailleurs excellent.

### D-3 — une correction que rien n'exerce 🟡

`heldThreatType()` ([`weapons.js`](../../raceEngine/src/engine/weapons.js)) existe pour un bug
réel et bien décrit : un triple annonce le type de son **groupe**, que les prédicats de danger
latent ne reconnaissent pas. Le commentaire est lucide : *« Sans effet tant que les triples sont
désactivés — et c'est bien le problème. »*

Or `disabledItems: ['tripleBanana', 'tripleGreenShell', 'tripleRedShell']` — **les trois le sont**.

Le code est donc correct et **jamais exercé**. C'est une dette silencieuse : le jour où les triples
sont réactivés, c'est tout le danger latent (`isArmedForward`, `isTrailable`) qui change de
comportement d'un coup, sans qu'aucun test ne l'ait jamais parcouru.

> **À mesurer** : réactiver les triples sur une graine fixe et comparer le taux de `safety`
> déclenchées, avant/après. C'est le chiffre qui dirait si `heldThreatType` suffit.

### D-4 — `giveWay` ne vérifie pas qui est visé 🟡

Le raisonnement est juste : contre une rouge, se décaler ne sert à rien — elle se recale huit fois
plus vite qu'un kart ne se déplace — donc la seule parade est de **cesser d'être la cible**, en se
faisant doubler.

Mais la condition déclenchante ne regarde que ceci :

```js
sight.redBehindDist >= 0 && sight.redBehindDist <= vis.giveWay.range
```

C'est-à-dire : *« quelqu'un derrière moi porte une rouge »*. Pas : *« cette rouge me vise »*. Or
`findRedShellTarget()` montre que la rouge ne ciblera pas forcément ce kart-là : elle choisit le
meilleur score en distance, avec un plancher d'armement (`redShellMinTarget`) et une pénalité de
proximité. **Un kart collé au porteur est justement celui que la rouge écartera** (score
`Infinity` sous le plancher) — et c'est pourtant lui qui se rangera.

Le comportement reste défendable : un pilote qui voit une rouge derrière lui n'a aucun moyen de
savoir qui elle visera, et se ranger est une précaution raisonnable. C'est cohérent avec la règle
générale du moteur (« un kart ne réagit qu'à ce qu'il voit »). **Ce n'est donc pas un défaut de
correction, mais un défaut de calibrage possible** : si `giveWay` se déclenche trop, c'est ici
qu'il faut regarder.

> **À mesurer** : proportion de `giveWay` déclenchées où le kart **n'était pas** la cible réelle
> de la rouge. Si elle est forte, c'est du freinage payé pour rien.

### D-5 — l'attention est un goulot dont le coût n'est pas chiffré 🟡

`sight.back` est **exclusif** : regarder derrière **substitue** la vue arrière à la vue avant. Le
choix est assumé et excellent pour le jeu — il donne un coût réel au coup d'œil. Deux
compensations existent déjà et sont bien conçues (les tuyaux échappent à l'occlusion arrière ; le
souvenir du porteur de devant survit au coup d'œil).

Le point non tranché est **l'accumulation**. Un kart en tête est à `backChance: 0.30`, monte à
`0.70` s'il a vu un danger, et à `0.85` sur un bruit d'étoile. Avec `glanceDurationMax: 1200` ms et
`glanceIntervalMs: 1150`, un leader sous pression continue peut passer une **fraction importante
de son temps tourné vers l'arrière** — donc aveugle au trafic devant, aux boîtes et aux tuyaux
qu'il ne connaît que par l'exception `pierces`.

Le commentaire de `backChanceDanger` montre que le sujet a été vu (« à calibrer sur l'attente
moyenne d'un coup d'œil — `glanceIntervalMs / chance` »), et le code note explicitement qu'il ne
faut pas cumuler cadence et probabilité pour la même raison. Mais **la fraction de temps réellement
passée en vue arrière n'est mesurée nulle part**.

> **À mesurer** : distribution du temps passé en `sight.back`, par rang, sur une course complète.
> C'est une sortie que le banc `simulate.js` pourrait rendre sans toucher au moteur.
>
> **Mesuré le 2026-09-21** par la campagne de `tools/alerts.js` (1000 courses complètes) : le
> premier passe **32 %** de son temps tourné vers l'arrière, le peloton **17 %**, le dernier
> **6 %**. Les alertes ([alertes.md](alertes.md)) y ajoutent moins d'un point à chaque place.
> Le premier est donc aveugle devant près d'un tiers du temps — assumé tant qu'il n'a que
> l'arrière à surveiller, mais c'est le chiffre à regarder avant de monter une chance de coup
> d'œil.
>
> **Vérifié le 2026-09-23** (`make race-attention`, 300 courses) : le souvenir de l'arrière
> sert bien face à la route pour céder le passage à une rouge (46 % des décisions) et pour
> garder un bouclier. Mais **pas pour se ranger hors de la ligne d'un porteur derrière**
> (0 % : seul le porteur de devant a un souvenir, `frontAt`). Et 6 % des touches par
> l'arrière frappent un kart qui savait, parce que le souvenir d'une carapace en vol n'en
> garde pas la position. ✅ **Corrigé le même jour** : le porteur qui suit a son souvenir
> (`carrierAt`) et trois réponses tirées au sort (le laisser passer, se ranger, lui tirer
> dessus). Détail au §10 de [etat-avancement-global.md](../etat-avancement-global.md).

### D-6 — l'étalonnage de `missChance` 🔵

`missChance()` est étalonné sur `referenceAgility(cfg)` et non sur l'agilité du kart, avec une
justification explicite et juste : *« ce tirage dit s'il a VU venir la menace, et un kart maniable
n'est pas plus attentif qu'un autre »*.

Le raisonnement est bon. Mais l'effet composé mérite vérification : un kart lourd a une
`threatWindow` **plus longue** (elle se taille sur son besoin de dégagement), donc `spareMs` plus
grand, donc `ease` plus favorable — et il rate donc **moins** son tirage d'attention qu'un kart
vif dans la même situation géométrique. Est-ce voulu ? C'est défendable (il a commencé plus tôt),
mais ce n'est écrit nulle part.

> **À mesurer** : taux de `judgedIgnored` par personnage, à géométrie identique. S'il est
> significativement plus bas pour les lourds, c'est un effet de bord à documenter ou à corriger.
>
> **Mesuré le 2026-09-23** (`make race-attention`, 1000 graines par kart). Quand la menace
> apparaît tard (≤ 450 px), le tirage est identique pour tous. Plus loin, toad et koopa
> gardent 2 à 6 % de ratés là où les autres tombent à 0 %. L'effet de bord existe, il est
> petit, et reste **à trancher**.

---

## 6. Ce qui tient — et ce que l'audit d'août a réellement refermé

Cette section est la contrepartie des constats : ce que j'ai cherché à prendre en défaut sans y
parvenir.

| Point | Verdict |
|---|---|
| **Un seul écrivain de `vy`** (`steer`) | ✅ Vérifié : l'invariant violé en août (D-1 d'alors) ne l'est plus |
| Chocs dans un canal séparé (`bumpVy`) | ✅ Non effacés par le lissage du volant |
| `steerSettle` comme référence universelle | ✅ Placement, veto et braquage la partagent |
| `steerReach` / `steerDelay` exactement inverses | ✅ Newton 4 tours, précision machine |
| Facteur de lissage borné à 1 | ✅ Une frame longue n'oscille plus (onglet en arrière-plan) |
| Occlusion par **cône** et non par tranche | ✅ Un kart lointain ne masque plus comme un collé |
| Un corps ne se masque pas lui-même | ✅ Garanti par l'ordre de la marche (tri par distance à l'œil) |
| Tirage uniforme sur les égalités de couloir | ✅ Corrige le biais « en dessous 8 fois sur 10 » |
| 3 passes de `chooseLane`, jamais de blocage | ✅ La 3ᵉ (sans limite de temps) corrige le pire défaut visible |
| Le plan survit à la perte de vue | ✅ *« Une absence d'observation ne prouve rien »* |
| Révision **cadencée et jitterée** | ✅ Sans le jitter, 8 karts rejouent la même décision au même instant |
| Plan « grossier » repris au 1ᵉʳ balayage de face | ✅ Et sur le **sens du balayage**, pas l'attention du moment |
| Fenêtre de menace taillée au besoin | ✅ Corrige le cas mesuré « banane posée prise 100 % du temps » |
| `place.slop` : l'imprécision propre du kart | ✅ ~0.8 koopa, ~1.6 bowser — un couloir de 3.1 passe pour l'un |
| Dette de mur au lieu d'un refus | ✅ Permet d'enfiler une séquence de tuyaux sans les parcourir un par un |
| `approachMs` : deux régimes d'accélération | ✅ Corrige les « 90 secondes de fenêtre » après un arrêt |
| `steerCapOver` : volant **moyen** sur la fenêtre | ✅ Corrige le planificateur qui lisait un zéro à l'arrêt |
| Aucun retour à la ligne d'avant l'écart | ✅ Justifié : `yPercent` est une profondeur, pas une trajectoire |
| Tampons réutilisés, zéro allocation en boucle | ✅ 8 karts × 30 Hz |

**Sur l'audit d'août** : ses défauts D-1 (invariant violé), D-3 à D-8 sont refermés par la refonte,
et le modèle a effectivement basculé de « l'agilité décide de l'amplitude » à « la situation décide
du lieu, l'agilité décide du temps ». C'est une refonte réussie, et le présent audit ne trouve rien
qui la remette en cause.

---

## 7. Ce que cet audit n'a pas couvert

Dit explicitement, pour que l'absence ne se lise pas comme un blanc-seing :

- **Aucune mesure au banc** (ni Node ni Docker disponibles). C'est la limite principale : les
  constats D-3 à D-6 sont des hypothèses de lecture, pas des faits mesurés.
- **Le moteur C++** (`raceEngineCpp/`), hors périmètre par ta demande.
- **La physique de contact** (`bodies.js`, `resolveKartPair`) : lue pour vérifier qu'elle ne viole
  pas l'invariant de `vy`, pas auditée pour elle-même.
- **Le contournement de tuyau** (`pipes.js`) n'a été lu que par son interface avec l'arbitrage
  (`steerAroundPipes`, `pipeOutranksPlan`), pas ligne à ligne.
- **L'équilibrage des personnages** — c'est le sujet de
  [equilibrage.md](equilibrage.md), et il demande le banc.

---

## 8. Recommandations, par ordre

1. **Réparer `tools/scenario.js` (D-1).** C'est la condition de tout le reste : sans banc, aucun
   des constats suivants ne peut être tranché. Une ligne.
2. **Corriger le commentaire de `threatLane` (D-2).** Même geste, même endroit.
3. **Mesurer avant de toucher à quoi que ce soit d'autre.** Les quatre lignes « À mesurer »
   ci-dessus sont, dans l'ordre, les chiffres qui manquent. Aucun réglage ne devrait bouger avant.
4. **Décider du sort des triples (D-3).** Soit on les réactive et on mesure, soit on acte qu'ils
   restent désactivés — auquel cas `heldThreatType` mérite un commentaire disant qu'il dort.
