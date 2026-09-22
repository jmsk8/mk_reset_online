# Les alertes — ce qu'un kart entend sans l'avoir vu

> **État au 2026-09-21.** Livré dans le moteur JS (`raceEngine/`), mesuré au banc,
> **non commité**. Le moteur C++ n'a ni vision ni objets : rien à y porter.
>
> Code : [`alerts.js`](../../raceEngine/src/engine/alerts.js) (l'ouïe), branchée dans
> [`vision.js`](../../raceEngine/src/engine/vision.js) (attention, bouclier),
> [`plans.js`](../../raceEngine/src/engine/plans.js) et [`ai.js`](../../raceEngine/src/engine/ai.js).
> Réglages : `vision.alerts` dans [`config/vision.js`](../../raceEngine/src/config/vision.js).
> Banc : [`tools/alerts.js`](../../raceEngine/tools/alerts.js) — `make race-alerts`.

---

## 1. L'idée

Tout le pilotage repose sur une règle : **un kart ne réagit qu'à ce qu'il voit, et il
ne voit qu'un côté à la fois**. Pour avoir une chance de voir arriver un objet dans son
dos, il doit se retourner — et pendant ce temps il est aveugle devant.

Les alertes ajoutent un sens : **l'ouïe**. Certains objets, en route, se font
entendre du kart qu'ils menacent. Et l'ouïe a une borne, posée par construction :

> **Elle dit QUOI arrive et SI C'EST POUR LUI. Jamais OÙ.**

La position reste l'affaire de la vue. C'est ce qui fait que l'alerte **complète** le
pilotage au lieu de le remplacer : elle déclenche un coup d'œil, un bouclier, un frein —
mais le placement se décide toujours sur ce que le kart a vu.

| Objet | Qui entend | Ce que l'alerte dit | Ce que le kart en fait |
|---|---|---|---|
| **Étoile, bill** | les karts devant, à portée arrière | « un intouchable arrive, dans tant de temps » | se retourne quand il approche, le suit du regard jusqu'à avoir décidé son esquive |
| **Rouge** | sa cible | « une rouge me vise » | ne se retourne pas — ça ne sert à rien, elle suit — il se couvre, et tient sa couverture |
| **Bleue** | le premier, puis sa cible | « une bleue arrive, dans environ tant de temps » / « elle m'a choisi » | se protège (champignon, étoile), sinon cède la tête s'il en a le réflexe |

---

## 2. Où ça se branche

Un étage de plus **avant** les quatre existants
([audit direction §1](audit-decision-direction-2026-09-17.md)) :

```
   updateAI(kart)
        │
        ├─ hear()           OUÏE        alerts.js    → kart.alert : quoi, quand, pour lui ?
        ├─ updateGlance()   ATTENTION   vision.js    ← sursaut, suivi du regard, bleue
        ├─ perceive()       PERCEPTION  vision.js      (+ le kart le plus proche derrière)
        ├─ updateBlue()     BLEUE       alerts.js    → se protéger / céder la tête
        ├─ updatePlan()     PLAN        plans.js     ← 'yieldLead' : quitter la ligne du suiveur
        ├─ updateShield()   BOUCLIER    vision.js    ← rouge entendue : se couvrir
        ├─ command()        COMMANDE    ai.js          (ordre de priorité inchangé)
        └─ frein de la bleue, posé APRÈS la commande : le plus appuyé l'emporte
```

**Chaque alerte a son interrupteur** (`vision.alerts.<objet>.enabled`). À `false`, le
comportement redevient exactement celui d'avant elle : c'est ce que compare le banc,
colonne par colonne. Le déplacement de l'ancien `ramNoise` dans l'ouïe a été vérifié
**au bit près** — 200 courses à graine fixe, sorties identiques.

---

## 3. Objet par objet

### Étoile et bill — regarder quand il arrive

Le bruit existait déjà (`backChanceRam`, 0.85) : un intouchable à moins de 1000 px
derrière relevait la chance de se retourner. Mais sans rien dire du **moment**, et c'est
là que tout se jouait : l'esquive ne se décide qu'en **voyant** la menace entrer dans sa
fenêtre, réflexe compris.

Un premier essai calait un sursaut sur le **début** du bruit. Le banc l'a refusé : plus
de touches contre l'étoile, pas moins. Le kart regardait à quatre secondes de l'impact,
la tête revenait devant, et le coup d'œil suivant tombait trop tard.

Ce qui est livré :

- l'oreille estime le **temps avant contact** du plus pressant (`alert.ramTtc`) ;
- à `ram.leadMs` (2500 ms) du contact, **sursaut** : la question du coup d'œil se pose
  tout de suite, une fois par approche — la réponse reste un tirage ;
- une fois tourné, il **le suit du regard** tant qu'il n'a pas décidé son esquive ; dès
  qu'elle l'est, la tête peut revenir devant, le plan survit à la perte de vue.

### La rouge — se couvrir, sans se retourner

La cible sait qu'elle est visée (`hearRed`), après le réflexe ordinaire et un tirage
d'inattention (`red.miss`, 10 %). Ensuite, dans `updateShield` :

- **étoile ou bill en main** : sortis tout de suite ;
- **objet traînable** (banane, verte, rouge) : passé derrière lui, et **gardé tant
  qu'elle le vise**, puis le temps ordinaire du souvenir (`pressureMemoryMs`) ;
- **rien d'utile** (champignon compris — elle va plus vite) : rien.

Aucun coup d'œil n'est ajouté. L'épisode de danger vu est tranché du même coup, sans
quoi la voir pendant un coup d'œil rejouait le tirage « garder ou lancer » et pouvait
faire lâcher le bouclier juste avant l'impact.

**Limite physique assumée** : tirée à moins de ~250 px, la rouge touche avant la fin du
réflexe (224-378 ms), et le bouclier traîné est déjà dépassé. Elle reste imparable à
bout portant — c'est cohérent avec son plancher de ciblage (`redShellMinTarget`).

### La bleue — se protéger, sinon céder la tête

La bleue a deux temps, et tout en découle : **avant le verrou** elle choisira le premier
à 800 px ; **après**, le verrou est définitif.

**Se protéger passe avant tout frein** (décision du 21/09) :

- **l'étoile** se sort dès qu'elle l'a choisi, après le réflexe : elle dure bien plus
  que les ~2,1 s qui restent avant le souffle ;
- **le champignon** est le geste difficile. Il ne protège que le temps de sa poussée
  (1,5 s), et elle doit couvrir l'explosion **et** le dôme qui s'étend 300 ms derrière.
  Le signal est l'instant où la bleue cesse de tourner et s'arrête au-dessus de lui
  (580 ms avant le souffle) ; il réagit, et hésite une part tirée au sort
  (`hesitateMs`, 300). Réagir à la chute elle-même serait toujours trop tard : elle ne
  dure que 130 ms. Environ **sept sur dix** y arrivent (65 à 75 % au banc).

**Sinon, céder la tête** — seul le premier freine, et seulement s'il en a le réflexe
(`yieldChance`, 60 %) :

- il se retourne pour **voir** qui le suit (décision du 21/09 : le voir, pas le savoir) ;
- il ne cède qu'à un kart **vu**, à moins de `yieldRange` (350 px), **qui ne recule
  pas** — sans quoi deux karts se renvoyaient la tête ;
- l'oreille donne une **échéance approximative** (±25 %, tirée une fois) ; il lève le
  pied (`brakeFactor` 0.55) juste assez tôt pour se faire doubler avant le verrou, et
  **n'essaie pas s'il est déjà trop tard** — un frein qui échoue ramènerait son suiveur
  dans le souffle ;
- doublé, il **reste en retrait** (`clearPx`, 340 px) : le souffle prend tout ce qui est
  à moins de ~310 px derrière sa cible, parce que son centre est fixe et que les karts
  qui suivent roulent dedans pendant qu'il s'étend.

Le frein `giveWay` (0.90) n'aurait rendu que 50 px/s au suiveur : 2 s pour 100 px,
plus que ce qu'on a avant le verrou.

---

## 4. Deux défauts corrigés au passage

Ils n'étaient pas des alertes, mais sans eux l'alerte étoile/bill n'aurait servi à rien :
regarder plus tôt ne sauve pas un kart dont l'esquive vise à côté.

**Le bill vu comme une carrosserie ordinaire.** Son contact porte à ±11 de profondeur
(`bill.hitbox.y`), la vue le traitait à ±5. Bande fermée, fenêtre d'esquive, dégagement
et tirage d'inattention étaient calculés sur 7 unités. Un kart qui le voyait et
l'esquivait « correctement » se posait encore dedans. **Mesure avant correction : 94 à
100 % des karts touchés par un bill lancé à 900 px, à toutes les profondeurs, koopa
compris.**

**Le temps avant impact mesuré au centre.** Une carrosserie lancée touche dès que les
emprises se rejoignent — 60 px pour une étoile, 99 pour un bill. À ~350 px/s de
rapprochement, la fenêtre d'esquive comptait près de 300 ms en trop. Le temps est
désormais mesuré **jusqu'au contact** pour l'étoile et le bill ; les objets gardent la
mesure au centre, sur laquelle leur fenêtre a été réglée.

---

## 5. Mesures

`make race-alerts CAMPAIGN=1000` — 200 graines par scénario, alertes éteintes puis
allumées. Colonne « sans » : les deux défauts du §4 sont déjà corrigés, seules les
alertes diffèrent.

### Étoile et bill lancés à 900 px derrière — taux de touche

| | bill : origine¹ | bill : sans | bill : **avec** | étoile : sans | étoile : **avec** |
|---|---|---|---|---|---|
| koopa | 94 – 98 % | 39 – 54 % | **13 – 28 %** | 39 – 55 % | **15 – 17 %** |
| mario | 99 – 100 % | 48 – 97 % | **20 – 79 %** | 51 – 54 % | **20 – 31 %** |
| bowser | 100 % | 74 – 100 % | **62 – 95 %** | 59 – 74 % | **37 – 61 %** |

¹ avant les deux corrections du §4. Fourchettes sur les profondeurs testées.

Bowser reste souvent pris par un bill : il lui faut plus de 2 s pour couvrir 13 unités,
et le bill arrive en 2,2 s. C'est le prix voulu du poids — *l'agilité dit en combien de
temps*.

### La rouge tirée dans le dos

| Écart, objet en main | Sans alerte | **Avec alerte** |
|---|---|---|
| 400-700 px, banane ou verte | bouclier 25 – 31 % | **bouclier 93 %** |
| 400-700 px, étoile | étoile sortie 26 – 42 % | **étoile sortie 95 – 96 %** |
| 200 px, quoi qu'il tienne | touché 74 – 97 % | inchangé (bout portant) |
| rien en main | touché 100 % | inchangé |

### La bleue sur le premier

| Situation | 1er touché, sans | **avec** |
|---|---|---|
| étoile en main | 49 – 68 % | **5 – 7 %** |
| champignon en main | 86 – 87 % | **≈ 20 %** |
| rien, suiveur à 150 px, lancée à 3000 px | 100 % | **58 %** |
| rien, suiveur à 300 px, lancée à 3000 px | 100 % | **70 %** |
| rien, lancée à 1500 px (0,7 s avant le verrou) | 100 % | 100 % — pas le temps |
| rien, personne derrière | 100 % | 100 %, **aucun frein** |

Quand il a cédé, il sort du souffle : le banc exige qu'au plus un sur dix y soit pris.

### Courses complètes

1000 courses, grille et circuit tirés comme en production, mêmes graines des deux côtés.
C'est la mesure de « ne rien dérégler ».

| | Sans alerte | **Avec alerte** |
|---|---|---|
| tête-à-queue par course | 21,48 | **20,88** (−2,8 %) |
| temps passé à regarder derrière — 1er | 32,4 % | 32,8 % |
| — peloton | 17,2 % | 18,1 % |
| — dernier | 6,2 % | 6,3 % |
| rouges ciblées : touchées | 50,2 % | **47,1 %** |
| rouges ciblées : arrêtées par un bouclier | 18,4 % | **22,6 %** |
| bleues : cible touchée | 92,7 % | 92,3 % |
| victoires, du plus au moins changé | bowser 15,0 %, yoshi 11,5 % | bowser 13,9 %, yoshi 13,2 % |

Le prix en attention est faible : moins d'un point de regard arrière, à chaque place.
Aucun écart de victoires ne dépasse le bruit d'échantillonnage (±1 point à 1000 courses).
En course, l'effet de la rouge est plus faible que dans les scénarios : beaucoup de
cibles n'ont rien en main pour se couvrir.

---

## 6. Les engagements du banc

`tools/alerts.js` sort **en erreur** si l'un de ces engagements n'est pas tenu. Les
seuils laissent la place du hasard (2,5 écarts-types) ; ils sont à revoir si l'on règle
les alertes, jamais à élargir pour faire passer le banc.

- étoile et bill : **aucune** situation n'empire, et l'ensemble s'améliore ;
- rouge à 400-700 px : bouclier ou étoile dans 85 % des cas au moins ; sans objet, rien
  ne change ;
- bleue : étoile en main, 1er touché ≤ 15 % ; champignon, intouchable **entre 50 et
  90 %** — il doit rester un geste difficile ; seul, il ne freine **jamais** ; céder la
  tête fait gagner au moins 20 points quand il en a le temps, et celui qui a cédé sort
  du souffle ;
- courses complètes : tête-à-queue pas plus nombreux (+3 % au plus), regard arrière pas
  plus de 2 points au-dessus, à chaque place.

Vérifié le 21/09 : alertes éteintes dans la config, **15 seuils tombent**.

---

## 7. Ce qui reste à savoir

- **La bleue sert peu en course, et c'est la distribution qui le veut.** Sur 239 bleues
  en 400 courses : le premier ne tenait **jamais** de champignon ni d'étoile (l'étoile
  ne sort qu'à partir du 2ᵉ rang), et il n'a cédé la tête que 16 fois. La bleue sort
  surtout quand le premier s'est échappé : son avance médiane sur le 2ᵉ est de 702 px,
  sous 350 px une fois sur quatre seulement.
- **Une légère tendance contre les lourds, à surveiller.** Le suivi du regard profite
  davantage aux karts vifs, qui ont le temps de s'écarter une fois qu'ils ont vu. Sur
  1000 courses, bowser passe de 15,0 à 13,9 % de victoires — sous le bruit (0,7 écart-type),
  mais toujours dans le même sens sur les campagnes regardées.
- **Le sursaut est un tirage.** Raté (15 % des cas), le kart attend le coup d'œil
  suivant — jusqu'à 1150 ms. Contre la bleue, c'est la cause principale des cessions
  trop tardives.
- **Affichage : le panneau de debug seulement** (décision du 21/09). La ligne
  « derrière » dit ce qu'il entend (« entend : rouge sur lui », « bleue (sur lui) ») ;
  « regard » dit s'il suit du regard ; « décision » s'il garde son objet pour la
  bleue ou cède la tête. Rien sur la bannière publique.
