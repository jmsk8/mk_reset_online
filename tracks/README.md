# Circuits du banner

Un circuit se dessine. Ce dossier ne contient pas de code : chaque `.md` est un
tracé, lu par le moteur de course au démarrage et traduit en vrai circuit.

```track
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
     x        B
     x                 PP
     x        B        PP
     x
     x        B
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

Le dessin est vu **de dessus**, la course allant **vers la droite**, et la
dernière colonne touche la première : le tour boucle.

## L'alphabet

| Caractère | Sens |
|---|---|
| `X` | bord de piste — uniquement la première et la dernière ligne du dessin |
| `x` | ligne de départ/arrivée — une seule colonne, dessinée sur autant de rangées qu'on veut |
| `B` | boîte à objets — une par caractère |
| `PP` au-dessus de `PP` | pipe vert — un obstacle infranchissable, facultatif, dessiné en carré de 2×2 |
| `pp` au-dessus de `pp` | pipe rouge — le même obstacle, l'autre peinture |
| espace ou `.` | bitume libre |

## L'échelle

- **une colonne = 80 px de monde**, soit un motif rouge/blanc de la bordure.
  96 colonnes font donc un tour de 7680 px, parcouru en une trentaine de
  secondes ;
- **les rangées entre les deux bords se partagent la profondeur de la piste.**
  La rangée du haut est le fond de la piste, celle du bas le premier plan. Avec
  dix rangées, une boîte tombe tous les 3,9 de profondeur, de 35 à 0.

Le nombre de rangées n'est qu'une résolution de dessin : il ne change pas la
largeur de la piste, qui reste fixée par `road.minY`/`road.maxY` dans
[src/config/world.js](../raceEngine/src/config/world.js). Dessiner huit
rangées au lieu de quatre donne simplement plus de finesse pour placer une
boîte ou un pipe.

### Combien de rangées dessiner

Deux choses dépendent du nombre de rangées :

- **répartir les boîtes sur toute la profondeur** : il faut que (boîtes − 1)
  divise (rangées − 1). Quatre boîtes sur dix rangées : une toutes les 3 ;
- **poser un pipe pile au milieu (17,5)** : un pipe se centre *entre* deux
  rangées, donc il faut un nombre **pair** de rangées.

| Rangées | Pas | 3 boîtes | 4 boîtes | 5 boîtes | Pipe au milieu |
|---|---|---|---|---|---|
| 7 | 5,8 | toutes les 3 | toutes les 2 | — | non |
| 9 | 4,4 | toutes les 4 | — | toutes les 2 | non |
| **10** | 3,9 | — | **toutes les 3** | — | **oui** |
| 13 | 2,9 | toutes les 6 | toutes les 4 | toutes les 3 | non |

**Dix rangées est le réglage de référence** : les quatre boîtes tombent à 35,
23,3, 11,7 et 0, et le couloir central existe. Chaque circuit reste libre de
choisir le sien.

La longueur, elle, ne se choisit pas : **une colonne vaut toujours 80 px**. Ajouter
des colonnes allonge le tour, ça ne l'affine pas.

## Les pipes

Un carré de quatre `P` plante un tuyau sur la piste. C'est le seul élément du
monde de masse infinie : il ne bouge pas, ne se détruit pas, et ne cède jamais.

```
PP      pp
PP      pp
vert    rouge
```

Le tuyau se pose **au centre du carré** : entre ses deux colonnes, et entre ses
deux rangées. Le carré n'est qu'un symbole : il ne dit rien de la taille du tuyau
en course, qui se déduit de son dessin (voir plus bas).

Un carré de `p` en plante un **rouge**, et la couleur est *tout* ce qui change : même
emprise, même choc, même place dans les priorités de l'IA, même compte dans le
passage le plus étroit. Rien dans le moteur ne la lit — elle voyage jusqu'au
décor et s'arrête là. Mélange les deux librement, ça ne se juge qu'à l'œil.

- **un kart** qui le percute de face est arrêté net, reculé de 90 px, et repart
  de zéro — son accélération décide donc de ce que le choc lui coûte, ce qui
  fait payer les lourds plus cher que les vifs ;
- **une carapace rouge** s'y brise ;
- **une carapace verte** rebondit sur la face touchée et repart de travers. Elle
  supporte 10 rebonds, tuyaux et bords de piste confondus, puis se détruit. Une
  fois renvoyée par un tuyau, **elle peut toucher celui qui l'a tirée** — c'est
  la seule situation du jeu où une carapace revient sur son lanceur ;
- **une étoile** le traverse comme s'il n'était pas là. Le tuyau sursaute et se
  remet en place ;
- **un Bill Ball** le contourne — c'est la seule chose qu'un Bill regarde encore ;
- **une carapace bleue** le survole : elle vole déjà au-dessus de la piste.

### Où les poser

Un tuyau est **rond** : son emprise au sol est un disque, aussi profond qu'il est
long. C'est ce qui le rend cher en profondeur — il bloque **9,2 de chaque côté**
de la ligne où il est dessiné, soit 53 % d'une piste profonde de 35. Un seul
tuyau laisse encore de quoi passer partout, mais deux mal placés ferment le
circuit — et un circuit fermé est refusé au chargement, pas découvert en course.

Sur un dessin à **10 rangées**, un pipe se centre à l'une de ces neuf
profondeurs, selon la rangée du haut de son carré :

| rangée du haut | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|---|
| profondeur | 33,1 | 29,2 | 25,3 | 21,4 | **17,5** | 13,6 | 9,7 | 5,8 | 1,9 |

Deux pipes sur la même colonne, repérés par la rangée du haut de leur carré :

| deux pipes aux rangées | passage | |
|---|---|---|
| 0 + 8 | 12,7 | large — les deux bords opposés |
| 0 + 7 · 1 + 8 | 8,8 | juste |
| du même côté du milieu (0 à 4, ou 4 à 8) | 8,3 à 20 | large |
| tout le reste (0 + 5, 2 + 6, 3 + 8…) | 0,5 à 5 | **refusé** |

Le piège est contre-intuitif : **deux tuyaux côte à côte au milieu ne font pas une
porte, ils font un mur.** Leurs zones bloquées fusionnent dès qu'ils sont séparés
de moins de 18,4 en profondeur — soit plus de la moitié de la piste. La seule
paire qui tienne est celle des deux tuyaux **du même côté**, ou celle des deux
bords opposés.

Pour une porte à deux passages, il faut *un seul* pipe au milieu — il laisse 8,3
de chaque côté, de quoi faire passer un kart (profond de 6,3) sans confort.

C'est la rangée du haut **4** — un carré sur les rangées 4 et 5, au milieu exact
de dix rangées — qui donne cette porte centrale.

### Pipes collés

Deux carrés peuvent se toucher : `PPPP` sur deux rangées fait deux pipes côte à
côte, `PP` sur quatre rangées deux pipes l'un au-dessus de l'autre, et un vert
peut toucher un rouge. Le dessin se découpe dans le sens de lecture : la
première case de pipe rencontrée est le coin haut-gauche d'un carré, et ainsi de
suite. Un dessin n'a donc qu'une lecture possible — ou aucune, et il est refusé.

```
PPPP       PP         PPpp
PPPP       PPPP       PPpp
            PP
2 pipes    2 pipes    1 vert, 1 rouge
```

Collés ne veut pas dire franchissables : deux pipes l'un au-dessus de l'autre se
séparent de 7,8 de profondeur, et leur emprise commune ferme les trois quarts de
la piste. Le passage le plus étroit les juge comme n'importe quels autres.

`make race-tracks` affiche le passage le plus étroit d'un tracé. C'est le chiffre
à regarder : un passage juste au-dessus du minimum se franchit, mais huit karts
n'y tiennent pas de front, et le peloton s'y bouscule à chaque tour.

## Ce qui est refusé

Le moteur préfère ne pas démarrer plutôt que de courir sur un tracé douteux. Un
`X` au milieu du dessin est refusé explicitement : **une piste de largeur
variable n'est pas encore supportée.** Elle demanderait un profil de bords
transmis à chaque spectateur et une route redessinée colonne par colonne — le
bandeau CSS actuel ne sait afficher qu'une route de largeur constante.

Sont refusés aussi : des bords de longueurs différentes, une ligne d'arrivée sur
deux colonnes, un circuit sans `x` ou sans `B`, une tabulation dans le dessin,
un pipe incomplet (un `P` seul, trois `P` en ligne, une forme en L…), un pipe
qui mélange `P` et `p`, un pipe coupé par le bord droit du dessin, un tour trop
court pour que la grille de départ y tienne, et **des pipes qui ne
laissent pas 6 de passage libre**.

Ce dernier refus est le plus important de tous : un circuit bouché ne planterait
pas. Les karts se cogneraient au même tuyau jusqu'au délai maximum, la course
serait close sur un classement d'office, et rien dans les journaux ne dirait que
le tracé est en cause.

## Ce qu'une longueur change

Le tour n'est pas obligé de faire 96 colonnes, mais sa longueur ne se choisit
pas à la légère : elle est la seule mesure du jeu que le dessin déplace.

- **la distribution des objets** se règle en distances absolues
  (`distanceRef: 3500`, `spreadRef: 4000` dans `raceEngine/src/config/items.js`). Sur un tour
  deux fois plus court, un même retard en pixels représente une bien plus grosse
  part de la course, et la compensation frappe plus fort ;
- **la course entière** dure cinq tours et doit rester sous `race.maxRaceMs`
  (180 s). `make race-tracks` affiche la durée estimée ;
- **un tour trop court** ne peut pas contenir la grille de départ. Le moteur
  refuse en dessous de 17 colonnes.

Après un tracé d'une longueur inhabituelle, `make race-sim` dit ce que
l'équilibrage est devenu.

## L'ordre des manches

Un grand prix compte quatre courses et parcourt le dossier **dans l'ordre des
noms de fichiers** — d'où les préfixes `01-`, `02-`. Avec deux circuits, les
quatre manches alternent. Avec un seul, elles se courent toutes au même endroit,
comme avant.

## Dessiner puis vérifier

```sh
make race-tracks            # relit les tracés et les traduit en chiffres
make race-tracks ORDER=1    # + l'ordre des manches d'un grand prix
make restart-race           # relit le dossier et repart sur un grand prix neuf
```

`make race-tracks` est le bon réflexe après chaque coup de crayon : il dit où
tombe la ligne, à quel pourcentage du tour arrivent les boîtes et combien de
temps dure une course. Un tracé se juge sur ces chiffres bien plus que sur son
allure dans l'éditeur.

Le dossier étant monté en lecture seule dans le conteneur, retoucher un `.md` et
lancer `make restart-race` suffit à voir le circuit tourner : aucune image à
reconstruire.

Pour l'équilibrage, `make race-sim` enchaîne tous les circuits comme le fait un
grand prix ; `make race-sim TRACK=anneau` n'en mesure qu'un.
