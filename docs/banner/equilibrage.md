# Mission : rendre les trois axes de statistiques réellement concurrents

> **État actuel : voir « Calage MK8D (2026-09-24) » juste en dessous.** Le reste du fichier
> est la mission d'origine, gardée pour son historique : son « modèle actuel » et ses mesures
> datent d'avant ce calage.

## Calage MK8D (2026-09-24)

Stats, tailles et emprises recalées sur des mesures de Mario Kart 8 Deluxe, chaque
personnage sur le même kart. Le système de stats (3 axes, budget 15) et la loi des emprises
(`deriveBodies`) sont conservés : seuls leurs entrées et quatre réglages ont bougé. Le moteur
C++ n'a pas suivi : chaque écart est listé dans
[moteur-cpp-avancement.md](moteur-cpp-avancement.md) §7.

### La source

| | Poids | Maniab. | Accél. | Vitesse | L (cm) | H (cm) |
|---|---|---|---|---|---|---|
| Bowser | 4,5 | 2,5 | 3 | 4,8 | 10,2 | 13,5 |
| DK | 4 | 3 | 3,2 | 4,5 | 10 | 11,4 |
| Mario | 3,8 | 3,5 | 3,5 | 4 | 9,2 | 9,3 |
| Luigi | 3,8 | 3,8 | 3,5 | 4 | 9,2 | 9,9 |
| Yoshi, Peach | 3,2 | 3,8 | 3,8 | 3,8 | 9,2 | 10,2 / 9 |
| Birdo | 3,2 | 3,8 | 3,8 | 3,8 | 9,2 | 10,2 (crâne) / 11,8 (nœud) |
| Daisy | 3 | 3,8 | 3,8 | 3,8 | 9,2 | 8,5 |
| Toad | 2,8 | 4,2 | 4 | 3,2 | 7,7 | 8,1 |
| Koopa | 2,5 | 4,5 | 4 | 3 | 7,2 | 8,3 |

Barres sur 6 ; L et H mesurés à l'écran (27 pouces), vue de derrière. Les barres donnent un
**ordre** et des écarts relatifs, pas des grandeurs physiques : un écart de 37 % en barre de
vitesse n'est pas 37 % de pointe dans le jeu.

### Les stats — `kartStats.characters`

Quatre personnages changent, placés au plus près de leurs valeurs MK8D dans l'enveloppe
existante (bowser et koopa la bornent et ne bougent pas) :

| | Avant | Après | Pourquoi |
|---|---|---|---|
| DK | 8/5/2 | **7/5/3** | plus près de Mario que de Bowser |
| Luigi | 4/6/5 | **5/4/6** | le poids de Mario, un cran de maniabilité en plus |
| Birdo | 5/4/6 | **4/5/6** | identique à Yoshi et Peach |
| Peach | 3/6/6 | **4/5/6** | identique à Yoshi et Birdo |

L'ordre des clés est celui du tirage du roster : le changer change les grilles à graine
égale.

### Les tailles — dans les PNG, jamais dans le code

La taille d'un kart se règle dans son **fichier** : le moteur mesure les PNG
(`scripts/sprite-metrics.py`) et en tire l'emprise, qui décrit donc toujours ce qui est
dessiné.

- `assets-src/karts/<perso>/` : les originaux, jamais modifiés.
- `scripts/resize-karts.py` : table `FACTEUR`, redimensionnement au **plus proche voisin**
  (palette et bords francs conservés) vers `frontEnd/static/img/`. Relançable : il repart
  toujours des originaux.

| | Facteur | Origine |
|---|---|---|
| Bowser | 10,2 / 9,2 = ×1,109 | L MK8D |
| DK | 10,0 / 9,2 × 0,95 = ×1,033 | L MK8D, −5 % à l'œil |
| Birdo | ×0,95 | à l'œil (les mesures le donnaient juste) |
| Toad, Koopa | ×0,86 | calage largeur + hauteur (L seule donnait 0,837 et 0,783) |
| Les autres | ×1 | gabarit de référence, fichier recopié tel quel |

Tous les sprites SNES partagent le même châssis (112 px de large au ras des roues) : c'est
lui que le facteur met à l'échelle. Toad et Koopa font partie des karts de référence : les
retoucher déplace légèrement l'échelle de tous les autres.

Pour changer une taille : modifier `FACTEUR`, relancer `resize-karts.py` puis
`sprite-metrics.py`, recopier le bloc imprimé dans `bodies.sprite`.

### Les emprises — `deriveBodies`

- **Longueur** : largeur du sprite de profil (`side-right`), inchangé.
- **Largeur** : écart **roue à roue**, lu sur le sprite de dos (`back`, rangée la plus large
  des 20 % du bas). Elle se tirait de la **surface** du profil, qui comptait la hauteur et la
  carrure du pilote, et la taille deux fois (une surface suit le carré de l'échelle) : Bowser
  sortait ×1,51 plus large que Luigi, pour ×1,12 roue à roue et ×1,11 en MK8D. Ce qui touche,
  c'est le kart. Le sprite de face a été écarté : DK y lève les bras, 9 px de trop.

| | Longueur | Largeur (unités) | Largeur (px PC) |
|---|---|---|---|
| Bowser | 82,9 | 7,05 | 25,4 |
| DK | 82,9 | 6,66 | 24,0 |
| Yoshi | 80,2 | 6,37 | 22,9 |
| Mario, Peach, Daisy | 75,5 | 6,37 | 22,9 |
| Luigi | 74,8 | 6,31 | 22,7 |
| Birdo | 71,5 | 6,03 | 21,7 |
| Toad | 64,0 | 5,46 | 19,7 |
| Koopa | 64,0 | 5,40 | 19,5 |
| *Référence* | *75,0* | *6,25* | *22,5* |

Le client suit sans rien recopier : l'écart de l'objet tenu en main est maintenant mis à
l'échelle du kart (`render.js`), il flottait au-dessus des petits.

### Deux réglages

- **`massDragAccel` 1,75 → 1,0** (`bodies.js`). L'accélération de Koopa dépassait celle de
  Bowser de 83 %, pour 33 % en MK8D ; à 1,0 : 38 %. Sur un départ arrêté, en ligne droite,
  Bowser recolle Koopa en **12 s au lieu de 20** (un tour dure ~18 s). C'est ce qui décidait de
  la course des lourds : arrêtés au premier tour, ils ne revenaient plus.
- **`momentumFloor.base` 0,70 → 0,80** (`driving.js`). La croisière va de 95,6 à 100 % de la
  pointe : la pointe décide plus, le hasard moins. Franchit sciemment la limite de 0,78 :
  Bowser/Toad et Bowser/Koopa ne peuvent plus se dépasser en croisière seule (le commentaire
  de la config donne les seuils suivants). Effet sur l'équilibre non séparable du bruit sur
  une seule graine.

### Le coût d'un coup — `hits` (`driving.js`)

Tous les coups coûtaient la même chose : 1,5 s de glissade, 0,5 s d'arrêt, relance de zéro.
Ils dépendent désormais de ce qui frappe : durée du tête-à-queue (proportions MK8D, 1 s à
1,5 s, la bleue un cran au-dessus) et **part de sa vitesse que le kart garde** (`keep`),
pendant la glissade et à la sortie. C'est `keep` qui fait la différence : la relance pèse
autant que le tête-à-queue.

| Source | Tête-à-queue | Garde | Sursis ensuite | Temps perdu (Mario lancé) |
|---|---|---|---|---|
| Choc étoile / bill | 1,0 s | 25 % | 1,0 / 0,95 s | 1,6 s |
| Éclair | 1,0 s | 20 % | 1,5 s | 1,7 s (plus le rapetissement) |
| Banane | 1,2 s | 20 % | 1,5 s | 1,9 s |
| Verte, rouge | 1,5 s | 0 | 1,5 s | 3,0 s |
| Bleue | 2,0 s | 0 | 1,5 s | 3,5 s |
| *Avant (tous)* | *2,0 s* | *0* | *3,0 s* | *3,3 s* |

Le sursis (`invincibleMs`) reprend les valeurs MK8D telles quelles. À 3 s pour tous, il
protégeait deux fois plus longtemps : un kart touché traversait ensuite le peloton sans
risque. L'éclair et le souffle de la bleue passent outre, comme avant.

L'éclair passe sous la banane dans ce chiffre (1,0 s de toupie contre 1,2), mais il
rapetisse en plus le kart, ce que la table ne compte pas.

L'IA, elle, estime encore tout coup au même prix (`vision.cost.spin`, 2000 ms) : elle évite
une banane comme une carapace.

**C'est un réglage de ressenti, pas d'équilibre.** Une course dure 2,8 % de moins (moins de
temps hors rythme pour tous), le sursis MK8D fait toucher plus souvent (2,6 à 3,0 fois par
course au lieu de 2,5 à 2,8), mais l'écart lourds / légers n'en bouge pas. Deux graines
(2814382103 et 325234882), 1000 courses chacune, bruit ±0,85 point sur la moyenne :

| | Victoires (moyenne) | Écart à 12,5 |
|---|---|---|
| Bowser | 15,6 % | **+3,1** |
| DK | 15,4 % | **+2,9** |
| Luigi | 14,1 % | +1,6 |
| Birdo | 12,4 % | −0,1 |
| Peach | 12,3 % | −0,2 |
| Yoshi, Toad | 11,6 % | −0,9 |
| Mario | 11,4 % | −1,1 |
| Daisy | 11,3 % | −1,2 |
| Koopa | 9,4 % | **−3,1** |

Garder moins de vitesse devrait pénaliser surtout les lourds, qui relancent moins bien ;
l'éclair, passé de l'arrêt net à 20 %, joue dans l'autre sens, et les deux s'annulent. Les
victoires suivent le poids : c'est la relance (`massDragAccel` à 1,0) et la pointe qui
décident, plus le coût des coups.

Leçon de bruit, au passage : sur une graine puis sur deux, Yoshi est sorti 3,5 points sous
Peach, aux stats identiques, et on l'a attribué à sa langue qui allonge son emprise. Avec la
table suivante, l'écart a disparu (11,6 contre 12,3). Deux graines ne départagent pas le
milieu du plateau.

### Résultats — 1000 courses, graine 2814382103

| | Victoires avant → après | Place moy. avant → après | Tuyaux / course après |
|---|---|---|---|
| Mario | 15,3 ++ → 15,4 ++ | 4,41 → 4,32 | 1,00 |
| Bowser | 14,8 → 14,3 | 4,79 → 4,66 | 1,38 |
| DK | 15,1 ++ → 13,9 | 4,69 → 4,46 | 1,10 |
| Peach | 11,5 → 13,3 | 4,34 → 4,47 | 1,05 |
| Yoshi | 13,2 → 13,1 | 4,41 → 4,48 | 1,06 |
| Luigi | 11,6 → 11,5 | 4,36 → 4,61 | 1,01 |
| Toad | 11,3 → 11,2 | 4,37 → 4,55 | 0,62 |
| Daisy | 11,4 → 11,0 | 4,37 → 4,51 | 0,91 |
| Birdo | 10,7 → 10,6 | 4,79 → 4,51 | 0,86 |
| Koopa | 10,0 -- → 10,6 | 4,46 → 4,44 | 0,48 |

Le résultat ne tient pas dans les victoires seules, qui bougent peu, mais dans la **forme** :
les lourds ne jouent plus à quitte ou double (Bowser dernier dans 19,6 % des courses au
départ, jusqu'à 23,9 % une fois agrandi, 15,3 % à la fin — ses chocs de tuyau, doublés par
l'agrandissement, sont revenus à leur niveau de départ avec la largeur roue à roue) et les
places moyennes se resserrent (4,32 à 4,66, contre 4,14 à 4,82 au milieu du chantier). Le « ++ » de
Mario est du bruit : ni ses stats ni sa taille n'ont bougé, et d'une campagne à l'autre un
kart varie de 2 à 4 points sans cause.

### Reste

- **Lourds devant, Koopa derrière** (±3 points, confirmé sur deux graines) : piste retenue,
  `massDragAccel` vers 1,2, à trancher sur 5 graines contre 1,0 et 1,4. Puis le banc **par
  circuit** (1 à 5 tuyaux).
- **L'IA et le prix des coups** : lui donner la table `hits` pour qu'elle évite une
  carapace plus volontiers qu'une banane.
- **Longueur au châssis** : la langue de Yoshi allonge encore son emprise (80,2 contre 75,5).
  Délicat : la longueur fixe aussi l'échelle de dessin, et un pilote qui déborde d'un seul
  côté décentrerait l'emprise. Rien au banc ne le réclame (cf. la leçon de bruit plus haut).
- **Moteur C++** : §7 de [moteur-cpp-avancement.md](moteur-cpp-avancement.md).
- **Vignettes** de Birdo et Daisy (`-pp.png`) : grain plus fin que les autres (5 px au lieu
  de 8), celle de Daisy en 115×110 au lieu de 105×123.

## Contexte

Jeu de course de karts, 8 personnages, moteur physique partagé entre le front et
le service de course.

> **Depuis le 2026-09-23 : 10 personnages, 8 par course** (Birdo et Daisy, tirage à
> l'ouverture de chaque grand prix, interrupteurs `roster.enabled` dans
> `raceEngine/src/config/bodies.js`). Le banc tire comme la prod et rapporte chaque taux aux
> courses que le kart a **courues** (colonne `courues`), plus au total. Le bruit se lit donc
> sur ~80 % des courses de la campagne. Ce qui suit décrit la mission d'origine, à 8. Chaque perso répartit **15 points** entre trois axes —
`weight` / `power` / `handling`, chacun dans [0, 10] — qui sont convertis en
statistiques dérivées (pointe, accélération, agilité, masse).

L'intention de design est un triangle : des builds différents, des façons de
gagner différentes, aucun dominant. **Ce n'est pas ce qui se produit.** Sur 1000
courses, les taux de victoire vont de 15.5 % à 6.3 % pour un attendu de 12.5 %,
et l'écart est structurel, pas statistique (bruit à ±1.0 point).

## Fichiers

- `raceEngine/src/engine/` — le moteur. `stats.js` / `deriveCharacterStats` construit
  les stats dérivées ; la boucle de déplacement est dans `stepPhysics`.
- `raceEngine/src/config/` — tous les coefficients (`kartStats`,
  `speeds`, `physics`, `pipe`, `itemDistribution`…).
- `raceEngine/tools/simulate.js` — banc de mesure hors horloge. Il **charge** le
  moteur et la config sans jamais les modifier : il observe. ~1000 courses en
  26 s, soit x3600 temps réel.
- `tracks/` — les tracés. **Il n'y en a qu'un actuellement** (Anneau du Moai,
  96 colonnes, 7 pipes). C'est une limite importante, voir la réserve en bas.

## Lancer le banc

```
make race-sim RACES=1000 SEED=2814382103
```

`SEED` rend la campagne reproductible — indispensable pour comparer deux
réglages sans que le hasard s'en mêle. Sans `SEED`, une graine est tirée et
affichée. Autres options : `CHAIN=1` (vainqueur en pole, comme en prod),
`CSV=1`, `TRACK=<nom>`.

## Le modèle au moment de la mission

```js
norm.X       = raw.X / 10
mass         = lerp(0.72, 1.25, norm.weight)
force        = lerp(0.85, 1.40, norm.power)
grip         = lerp(0.45, 1.32, norm.handling ** 2.5)   // gripCurve = 2.5
traction     = 0.65 + 0.70 * norm.weight

topSpeed     = 450 + 110 * norm.power * traction
acceleration = clamp(force / mass ** 1.25,  0.75, 1.85)
agility      = clamp(grip  / mass ** 1.70,  0.25, 1.70)
```

Et le régime de vitesse en course, hors objet et hors choc :

```js
// cible tirée toutes les 3–7 s dans uniform(momentumFloor, 1.0)
// momentumFloor = { base: 0.44, weightGain: 0 }   ← weightGain est à ZÉRO
targetSpeed = topSpeed * (0.78 + 0.22 * momentum)
// la vitesse rejoint la cible à accelerationRate(150) * acceleration px/s²
// la descente est 4× plus lente que la montée
```

## Mesures déjà faites — 1000 courses, graine 2814382103

```
kart    poi/pui/man   top   acc   agi   victoires  dernier   pipes  vit. moy.
luigi         4/6/5   511  1.29  0.68      15.5 %    9.0 %    1.08        440
peach         3/6/6   507  1.39  0.86      14.8 %    8.1 %    1.03        439
dk            8/5/2   517  0.95  0.37      14.1 %   14.5 %    1.29        437
bowser        9/5/1   520  0.90  0.33      13.8 %   17.3 %    1.35        437
yoshi         4/5/6   501  1.23  0.78      13.6 %   11.4 %    0.93        437
mario         5/5/5   505  1.15  0.62      12.0 %   13.6 %    1.06        437
toad          2/5/8   493  1.43  1.31       9.9 %   11.7 %    0.88        437
koopa         2/4/9   485  1.36  1.55       6.3 %   14.4 %    0.74        434
```

Le banc décompose aussi le régime « tranquille » — les pas où rien d'autre que
l'élan ne décide de la vitesse (ni objet, ni choc, ni bord de piste, ni
freinage) — en croisière installée sur sa cible / rattrapage sous sa cible :

```
kart     acc  croisiere  % pointe  rattrapage  dont relance  vit. tranq.
luigi   1.29        481    94.0 %       5.1 s         2.2 s          463
peach   1.39        477    94.0 %       4.6 s         2.0 s          460
dk      0.95        485    94.0 %       7.4 s         3.4 s          459
bowser  0.90        489    94.0 %       8.3 s         3.8 s          459
yoshi   1.23        472    94.1 %       5.1 s         2.2 s          454
mario   1.15        475    94.1 %       5.9 s         2.6 s          454
toad    1.43        465    94.1 %       4.2 s         1.8 s          450
koopa   1.36        456    94.2 %       4.2 s         1.9 s          442
```

Corrélation place de départ → place d'arrivée : **r = 0.088**. La grille ne
décide de rien, les écarts viennent bien des statistiques.

## Ce qui est établi

**1. Le régime de croisière est identique pour les huit karts : 94.0 % à 94.2 %
de leur propre pointe.** Cohérent avec la config (`weightGain: 0` rend la
distribution de `momentum` identique pour tous, et `momentumChangeSpeed` ne
dépend d'aucune stat). La croisière en px/s n'est donc rien d'autre que
`topSpeed × 0.94`, rang pour rang.

**2. Tout l'écart de vitesse tranquille vient du rattrapage, pas de la
croisière.** Bowser a la meilleure croisière du plateau (489) et finit à 459 ;
koopa a la pire (456) et finit à 442. Pendant le rattrapage tout le monde rampe
à la même allure (~230–250 px/s, soit la moitié de la croisière) — la seule
variable est la **durée**.

**3. Le rattrapage se factorise proprement.** Rapport bowser/koopa = 1.98 :
   - incidents subis 4.38 vs 3.49 par course → facteur **1.25** (c'est l'agilité)
   - taux de remontée, acc 0.90 vs 1.36 → facteur **1.51** (c'est l'accélération)
   - produit 1.89, contre 1.98 observé.

   Donc l'accélération vaut ~2× l'agilité, et **les deux n'agissent que par ce
   seul canal**. Aucune des deux ne touche à la croisière.

**4. Le canal en question ne représente que 4 à 8 s sur ~97 s de course.** Les
deux stats défensives se partagent 6 % du temps ; la pointe tient les 94 %
restants. C'est le cœur du problème.

**5. `power` est un axe strictement dominant.** Valeurs marginales par point :

   | | topSpeed | accélération | agilité |
   |---|---|---|---|
   | +1 power  | **+10.2 px/s** | **+0.060** | 0 |
   | +1 weight | +3.85 px/s | −0.092 | négative |

   Un point de power achète 2.6× plus de pointe **et** améliore l'accélération
   au lieu de la détruire. Il n'a aucune contrepartie. Le plateau se range
   presque parfaitement par power : les deux karts en power 6 sont 1er et 2e,
   le seul en power 4 est dernier avec 6.3 %.

**6. La cause est la forme multiplicative**, pas les coefficients :
   `∂top/∂weight = 7.7 × norm.power`. Le rendement du weight **dépend du
   power**, si bien que lâcher un point de power dévalue simultanément les deux
   autres axes. J'ai vérifié qu'aucun réglage de `traction` ne le corrige :
   avec `gain: 0.30 / base: 0.85` le rapport power/weight passe de 2.6 à 6 —
   ça empire. Tant que le weight n'agit qu'à l'intérieur de ce que le power
   ouvre, sa valeur reste bornée par le power.

**7. Le coût dominant de la course est une taxe forfaitaire.** La durée du
tête-à-queue (`hitEndTime`) est identique pour tous et pèse ~20 s des 22–28 s
de temps perdu par course. **Aucune des trois stats n'y touche.**

## Ce qui est réfuté

**Le slalom ne coûte rien.** `applySteering` ne modifie que `vy` ; les seuls
facteurs qui rognent `effectiveSpeed` sont le bridage après arrivée,
`edgeBrakeFactor`, l'éclair et la descente de bill — aucun n'est lié au
braquage. Confirmé indépendamment par la mesure : si le slalom coûtait, les
karts agiles auraient une croisière plus basse en % de leur pointe ; elle est à
94 % pour tout le monde.

**`momentumFloor.weightGain` n'est pas le levier.** Le monter relèverait la
croisière des lourds, qui gagnent déjà au-dessus de l'attendu. Ça aggraverait.

## Deux pistes envisagées — à challenger, pas à appliquer telles quelles

**A. Rendre `topSpeed` additif** :
`speedBase + speedPerPower × power + speedPerWeight × weight`. Supprime le
rendement croissant du power et redonne au weight un rendement propre. À
enveloppe de vitesse constante (485–520), j'estime `speedPerPower ≈ 60` et
`speedPerWeight ≈ 45` — **estimation non vérifiée, à caler au banc**.

**B. Indexer la durée du tête-à-queue sur l'agilité**, pour faire passer le
handling de 6 % à ~25 % de la course en zone d'influence.

Ces deux pistes sont les miennes après analyse ; elles peuvent être mauvaises.
Une solution différente et mieux fondée est bienvenue.

## Réserve importante

Tout ce qui précède repose sur **une seule campagne, sur un seul circuit**
(7 pipes). Le ratio 94 % / 6 % dépend directement du nombre de pipes : un tracé
qui en aurait 15 élargirait mécaniquement la fenêtre des stats défensives sans
qu'on touche à quoi que ce soit. **Générer un tracé chargé en pipes et vérifier
si le diagnostic tient est la première chose à faire** — si la fenêtre passe
seule de 6 % à 15 %, la piste B devient inutile.

## Ce que j'attends

1. **Reproduire et challenger le diagnostic.** Ne prends pas mes chiffres pour
   argent comptant : relance le banc, vérifie les valeurs marginales, cherche
   ce que j'ai raté. Les points 1 à 7 sont des affirmations à contrôler.
2. **Tester la sensibilité au circuit** avant toute restructuration.
3. **Proposer une solution argumentée**, et la valider au banc : campagnes de
   1000 courses à graine fixe, avant / après, sur tous les tracés disponibles.
   Le critère : taux de victoire dans le bruit (12.5 % ± 2 σ = ±2 points) pour
   les huit karts, **sans** que les trois axes deviennent équivalents — l'idée
   est que des builds différents gagnent différemment, pas qu'ils gagnent
   pareil. Regarde aussi la répartition des places : bowser est bimodal (13.8 %
   de P1 et 17.3 % de P8), ce qui est un profil légitime à préserver.
4. **Isoler les changements.** Un changement, une campagne, une conclusion.
5. Si une conclusion ne tient pas, dis-le franchement plutôt que de la sauver.

## Contraintes

- **Ne rien commiter.** Je fais mes commits moi-même.
- Le budget de 15 points, les 8 persos et les fiches actuelles sont
  modifiables si c'est justifié, mais chaque changement de fiche doit être
  argumenté par une mesure.
- `simulate.js` est un **observateur** : il ne doit jamais modifier le moteur.
  Attention, il recopie `getMomentumSpeed` (fonction `targetSpeedOf`) faute
  d'export — si tu changes cette formule dans le moteur, la décomposition
  mentira sans rien signaler.
- Le moteur tourne à l'identique côté front et côté service : toute
  modification doit rester dans `raceEngine/src/engine/` et `raceEngine/src/config/`.
- Style du code : commentaires en français **sans accents**, qui expliquent le
  pourquoi et pas le quoi. Suis ce qui existe.
