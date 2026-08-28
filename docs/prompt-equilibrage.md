# Mission : rendre les trois axes de statistiques réellement concurrents

## Contexte

Jeu de course de karts, 8 personnages, moteur physique partagé entre le front et
le service de course. Chaque perso répartit **15 points** entre trois axes —
`weight` / `power` / `handling`, chacun dans [0, 10] — qui sont convertis en
statistiques dérivées (pointe, accélération, agilité, masse).

L'intention de design est un triangle : des builds différents, des façons de
gagner différentes, aucun dominant. **Ce n'est pas ce qui se produit.** Sur 1000
courses, les taux de victoire vont de 15.5 % à 6.3 % pour un attendu de 12.5 %,
et l'écart est structurel, pas statistique (bruit à ±1.0 point).

## Fichiers

- `frontEnd/static/js/physics.js` — le moteur. `deriveCharacterStats` construit
  les stats dérivées ; la boucle de déplacement est dans `stepPhysics`.
- `frontEnd/static/js/physics-config.js` — tous les coefficients (`kartStats`,
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

## Le modèle actuel

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
  modification doit rester dans les fichiers partagés `physics*.js`.
- Style du code : commentaires en français **sans accents**, qui expliquent le
  pourquoi et pas le quoi. Suis ce qui existe.
