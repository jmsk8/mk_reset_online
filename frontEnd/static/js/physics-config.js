// Constantes de simulation du banner SMK.
//
// Tout ce qui est ici est lu par physics.js et par lui seul : c'est l'etat du
// monde, pas son apparence. Les constantes purement visuelles (chemins d'assets,
// tailles en px, z-index, breakpoint mobile) vivent dans GAME_CONFIG, en tete de
// smk-banner.js, et ne doivent jamais remonter ici.
//
// Ce fichier est destine a devenir la configuration du serveur de course
// autoritatif (voir docs/MIGRATION_BANNER_WSS.md) : le client n'en gardera
// qu'une poignee de valeurs, recues du serveur au moment de la connexion.
// Wrapper UMD identique a celui de physics.js, pour etre chargeable tel quel
// par le navigateur comme par Node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BannerPhysicsConfig = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    return {
        kartStats: {
            budget: 15,
            minPoints: 0,
            maxPoints: 10,

            mass:  { min: 0.72, max: 1.25 },
            force: { min: 0.85, max: 1.40 },
            grip:  { min: 0.45, max: 1.32 },

            // Forme de l'axe handling : `grip = lerp(min, max, handling ^ gripCurve)`.
            //
            // A 1, l'axe est droit et chaque point de handling vaut le meme
            // grip. Le plateau tenait alors dans un rapport de x2 entre le
            // meilleur et le pire, et tout le monde sauf Koopa se pilotait
            // comme un kart maniable — les poids moyens compris.
            //
            // Au-dessus de 1, la courbe s'ecrase par le bas : seuls les tres
            // gros scores de handling gardent leur grip, le reste decroche de
            // plus en plus vite. Le sommet, lui, ne bouge pas — c'est ce qui
            // permet de resserrer le plateau sans toucher au kart de reference.
            //
            // Regler ce couple, c'est deplacer le milieu sans deplacer le haut :
            // `gripCurve` monte, et `grip.min` descend. `grip.max` se recale
            // ensuite pour que Koopa — handling 9, le meilleur du plateau, et le
            // kart de reference : c'est lui qui a la maniabilite voulue — retombe
            // sur son agilite de 1.548. Reperes en agilite Mario / Bowser, a
            // massDragAgility 1.70 :
            //
            //   curve 1.6  min 0.62  max 1.28 -> 0.905 / 0.475   (rapport x3.26)
            //   curve 2.1  min 0.52  max 1.30 -> 0.720 / 0.396   (rapport x3.91)
            //   curve 2.5  min 0.45  max 1.32 -> 0.619 / 0.334   (rapport x4.64)
            //   curve 2.8  min 0.40  max 1.36 -> 0.553 / 0.296   (rapport x5.23)
            //
            // La courbe frappe selon le handling, donc tout le plateau a la
            // fois. Pour viser les lourds en particulier, c'est
            // `massDragAgility` plus bas — les deux se combinent, et `grip.max`
            // se recale a chaque fois.
            gripCurve: 2.5,

            // Ce que la masse coute a l'acceleration, en exposant :
            // `acceleration = force / masse ^ massDragAccel`.
            //
            // L'exposant fait pivoter tout le plateau autour de la masse 1, soit
            // le poids moyen : le monter creuse l'ecart des deux cotes a la
            // fois, les legers gagnant autant que les lourds perdent. Mario, pile
            // au milieu, ne bouge pas — c'est ce qui en fait la reference.
            //
            // Passe de 0.90 a 1.25 pour accentuer l'ecart leger/lourd sur la
            // relance. Sur un retour a la vitesse de croisiere depuis l'arret —
            // ce que coute un item ou un pipe — Toad passe de 1.84 s a 1.68 s et
            // Bowser de 2.99 s a 3.18 s : l'ecart entre les deux extremes passe
            // de x1.62 a x1.89. Le plateau ne se reordonne pas, il s'etire.
            //
            // La plage de masse (0.72 a 1.25) etant etroite, l'exposant est un
            // levier doux : chaque dixieme ne vaut qu'environ 0.05 s aux deux
            // bouts. Le pousser au-dela de ~1.5 rend les lourds injouables
            // depuis les pipes, qui remettent les karts a l'arret plusieurs fois
            // par tour, bien avant de rendre les legers spectaculaires.
            massDragAccel: 1.75,

            // Garde-fou contre une combinaison de stats absurde, pas un reglage :
            // il ne doit jamais mordre sur le plateau en place, sinon il ecrete
            // en silence l'effet qu'on vient de regler. Le plafond suit
            // l'exposant : monte de 1.55 a 1.85 avec le passage a 1.25, ou Toad
            // atteint 1.628 et l'ancien plafond lui aurait pris la moitie de son
            // gain. Bowser, a 0.899, reste loin du plancher.
            accelClamp: { min: 0.75, max: 1.85 },

            // Ce que la masse coute a la maniabilite, en exposant :
            // `agilite = grip / masse ^ massDragAgility`. Meme forme que
            // `massDragAccel`, mais l'axe vise est le poids et non la puissance.
            //
            // C'est le levier a poids, la ou `gripCurve` est le levier a
            // handling : il pivote autour de la masse 1 — le poids moyen — donc
            // il ne touche presque pas le milieu du plateau et mord surtout aux
            // deux bouts. Monte de 0.90 a 1.70 pour enfoncer les lourds sans
            // redescendre les moyens.
            //
            // 1.70 est le plafond pratique : au-dela, le gain rendu aux tres
            // legers fait repasser Toad devant Koopa et le haut du plateau se
            // reordonne. Pour aller plus loin, il ne reste que `gripCurve`.
            massDragAgility: 1.70,
            // Le plancher suit les deux leviers ci-dessus : a curve 2.5 et
            // massDragAgility 1.70, Bowser tombe a 0.334, la ou le plancher
            // d'origine (0.60) lui aurait rendu en silence les deux cinquiemes
            // de la maniabilite qu'on vient de lui retirer. Comme pour l'accel,
            // c'est un garde-fou contre une stat absurde, pas un reglage : il ne
            // doit jamais mordre sur le plateau en place, d'ou la marge.
            agilityClamp: { min: 0.25, max: 1.70 },

            // ── La tenue en virage ───────────────────────────────────────
            //
            // `cornering = handling ^ cornerGripGain * puissance ^ cornerPowerGain
            //              / poids ^ cornerMassDrag`
            //
            // C'est elle qui decide de ce que tourner coute en vitesse
            // (`corner.cost` plus bas, et `steerCost` dans le moteur). Trois
            // exposants, un par axe, et ils n'agissent QUE la : regler la tenue
            // en virage d'un lourd ne touche pas a la vitesse a laquelle il
            // tourne, qui reste le domaine de `massDragAgility`.
            //
            // Cette separation est le point. La tenue s'est d'abord deduite de
            // la maniabilite — plus court, et `massDragAgility` gouvernait alors
            // les deux : impossible de creuser le cout d'un lourd sans le rendre
            // aussi plus pataud, ni l'inverse.
            //
            // Les valeurs livrees reproduisent exactement `agility * force`,
            // d'ou `cornerMassDrag` egal a `massDragAgility`. Bouger l'un ne
            // bouge plus l'autre.

            // LE LEVIER A POIDS. Meme forme que `massDragAccel` et
            // `massDragAgility`, donc meme lecture : l'exposant pivote autour de
            // la masse 1 — le poids moyen — si bien que Mario ne bouge pas et
            // que les deux bouts s'ecartent symetriquement. C'est un levier
            // d'ECART, pas de severite : pour la severite, `corner.cost`.
            //
            // Il n'y a pas de plafond : monter l'exposant creuse l'ecart aussi
            // loin qu'on veut. Ce qu'il fait est exact et se calcule de tete —
            // le rapport entre deux karts est multiplie par
            // `(masse_lourd / masse_leger) ^ ecart d'exposant`, soit 1.45 puissance
            // cet ecart pour les deux extremes du plateau. De 1.70 a 5.00, le
            // rapport bowser/koopa passe ainsi de 4.4x a 15.0x.
            //
            // A 0, le poids ne coute plus rien en virage ; il reste l'ecart que
            // le handling et la puissance creusent seuls. C'est l'interrupteur de
            // cet axe-la, pas de la mecanique — pour l'eteindre entierement,
            // `corner.cost: 0`.
            //
            // CE QUE CA COUTE VRAIMENT NE S'ECRIT PAS ICI. Une manoeuvre reelle
            // n'atteint pas le plein braquage, et la part de la course passee a
            // tourner ne se devine pas : tout chiffre pose dans ce commentaire
            // serait perime au premier reglage. Le banc le MESURE, colonne
            // `virage` de « Ce que la course coute a chaque kart ». C'est le seul
            // endroit ou lire l'effet de cet exposant.
            cornerMassDrag: 5.00,

            // Ce que le handling rabat sur ce cout. A 1, un point de handling
            // vaut son plein rendement ; a 0, le handling ne tient plus rien en
            // virage et il ne reste que le poids et la puissance.
            //
            // A noter : l'axe handling est deja courbe en amont par `gripCurve`,
            // qui vaut pour les deux stats. Cet exposant se pose par-dessus.
            cornerGripGain: 1.0,

            // Ce que la puissance rabat sur ce cout — un moteur qui pousse fort
            // ramene plus vite le kart dans son elan quand il s'inscrit.
            //
            // Levier doux : la plage de `force` (0.85 a 1.40) etant etroite, il
            // ne separe bowser (puissance 5) de koopa (puissance 4) que de 5 %.
            cornerPowerGain: 1.0,

            // ── La pointe ────────────────────────────────────────────────
            //
            // `topSpeed = speedBase + speedPerWeight * poids + speedPerPower * puissance`,
            // les deux axes normalises dans [0, 1]. Additif, et c'est le point :
            // chaque coefficient se lit directement en px/s gagnes entre un
            // score de 0 et un score de 10, sans que l'autre axe s'en mele.
            //
            // Le poids mene, la puissance suit — c'est ce qui rend le poids
            // payant. Un kart lourd achete sa pointe et la paie deux fois, en
            // acceleration et en maniabilite (masse, cf. `massDrag*`) ; un kart
            // leger fait l'echange inverse. La puissance, elle, s'achete
            // surtout en relance : elle ne vaut ici qu'un appoint.
            //
            // L'ENVELOPPE EST LE REGLAGE SENSIBLE DU JEU, et de loin. Mesure au
            // banc : la pointe pese environ 0.5 point de taux de victoire par
            // px/s d'ecart entre deux karts. Les 35 px/s d'ecart de l'ancien
            // modele valaient donc a eux seuls 17 points de taux de victoire —
            // assez pour renverser tout le reste du systeme. Ne pas elargir
            // `speedPerWeight` sans elargir d'autant ce que la masse coute.
            //
            // Repere de conversion pour arbitrer : 1 s de temps de course vaut
            // environ 4.5 px/s de pointe, soit ~2 points de taux de victoire.
            speedBase: 490,
            speedPerWeight: 35,
            speedPerPower: 10,

            characters: {
                bowser: { weight: 9, power: 5, handling: 1 },
                dk:     { weight: 8, power: 5, handling: 2 },
                mario:  { weight: 5, power: 5, handling: 5 },
                luigi:  { weight: 4, power: 6, handling: 5 },
                yoshi:  { weight: 4, power: 5, handling: 6 },
                peach:  { weight: 3, power: 6, handling: 6 },
                toad:   { weight: 2, power: 5, handling: 8 },
                koopa:  { weight: 2, power: 4, handling: 9 }
            }
        },
        world: {
            // La geometrie du circuit — longueur du tour, ligne d'arrivee,
            // boites a objets — ne vit plus ici : elle se dessine dans tracks/
            // et vient se poser sur cette config au demarrage
            // (raceEngine/track.js, `applyTrack`). Un circuit dessine se relit,
            // se compare et se change sans toucher au moteur ; quatre nombres
            // en dur ne se voyaient qu'une fois a l'ecran.
            //
            // Ce que `applyTrack` ajoute ici : `width`, `finishLineX`,
            // `itemBoxes`. Appeler `createWorldState` sans cette etape est une
            // erreur, et refuse de demarrer plutot que de simuler un monde vide.

            // Le soleil, lui, n'est pas sur la piste : il est pose dans le fond
            // en parallaxe, que le dessin ne decrit pas.
            sunX: 1920
        },
        road: {
            // La largeur de la piste, elle, reste ici : elle ne varie pas le
            // long du tour. Les rangees dessinees entre les deux bords d'un
            // circuit se repartissent sur cet intervalle — la rangee du haut au
            // fond (maxY), celle du bas au premier plan (minY). Le dessin donne
            // donc la finesse de placement, pas la largeur.
            minY: 0,
            maxY: 30,

            // `laneTolerance` vit maintenant dans `vision.threatLane` : c'est
            // une distance de perception, pas une propriete du trace. La piste
            // n'a aucune notion de voie par ailleurs.
            edgeSafetyMargin: 2,
            overtakeMargin: 5,
            wanderMargin: 8
        },
        physics: {
            // ── Le braquage ──────────────────────────────────────────────
            //
            // La LOI de braquage : ce qui vaut pour tout kart qui tourne, quelle
            // que soit la raison. Les manoeuvres, elles, se decrivent ailleurs —
            // `ai.steering` — parce qu'elles disent une urgence, pas une
            // physique.
            //
            // Le modele tient en une phrase : une manoeuvre laterale est
            // toujours une PROFONDEUR A REJOINDRE. La situation dit ou aller, et
            // elle le dit pareil pour les huit karts ; ce qui les separe est le
            // TEMPS qu'ils mettent a y arriver.
            steer: {
                // Reponse du volant : vitesse a laquelle `vy` rejoint la
                // consigne laterale, en 1/s. Commune a tout le plateau, et elle
                // doit le rester — c'est la moitie du systeme de maniabilite :
                // le REFLEXE ne depend pas du kart, seuls ses moyens d'y
                // repondre en dependent.
                //
                // Se lit comme un delai : la constante de temps vaut
                // `1 / response`, soit 200 ms a 5. Monter la valeur rend le
                // volant sec pour tout le monde ; la baisser donne des karts qui
                // s'inscrivent en douceur et ratent plus.
                //
                // Le temps de reaction, lui, se regle a cote : `ai.reactionBaseMs`
                // et son jitter.
                response: 5,

                // ── L'appui perdu a l'allure ─────────────────────────────
                //
                // Un kart lance tourne moins bien qu'un kart au ralenti. C'est
                // la seule chose que la vitesse d'avance dit au braquage, et
                // elle manquait : jusqu'ici un kart a l'arret contre un tuyau
                // changeait de ligne exactement aussi vite qu'a pleine pointe.
                //
                // `drag` est ce qu'on perd de volant a pleine pointe, `curve`
                // la forme de la perte entre l'arret et la pointe. A `drag: 0`
                // la mecanique disparait et on retrouve trait pour trait le
                // comportement d'avant : c'est l'interrupteur.
                //
                // L'allure est rapportee a la POINTE DU KART, comme dans
                // `contact` : ce qui compte n'est pas de rouler vite dans
                // l'absolu mais d'etre lance pour soi. Un poids plume n'est pas
                // avantage d'avoir une pointe plus basse.
                //
                // Effet de bord voulu, et il tombe du bon cote : la remise en
                // route apres un incident se fait a allure reduite, donc avec
                // du volant en plus. Un kart qui repart se replace ; un kart
                // lance tient sa ligne.
                pace: { drag: 0.35, curve: 1.0 },

                // ── Le volant sous objet de vitesse ──────────────────────
                //
                // LE NOMBRE A BOUGER pour rendre les objets de vitesse plus ou
                // moins joueurs. Multiplicateur applique au volant tant qu'un
                // champignon ou une etoile dure. A 1, ils ne changent rien.
                //
                // A 1.20, un kart sous objet gagne 20 % de volant. L'appui perdu
                // a l'allure (`pace` ci-dessus) en reprend une partie — il roule
                // a 1.5 fois sa pointe — si bien qu'il tourne au net environ 16 %
                // mieux qu'en croisiere ordinaire. C'est le sens voulu : un
                // champignon lance ET degage, il ne rend pas pataud au moment
                // precis ou l'on double.
                //
                // Sans lui, l'appui a l'allure faisait l'inverse : le champignon
                // etait le seul objet qui degradait le pilotage de celui qui le
                // prenait.
                //
                // Le bill n'est pas concerne : `steerCap` le laisse hors des
                // trois facteurs, il ne pilote pas.
                boostGain: 1.15,

                // ── La contrainte de virage ─────────────────────────────
                //
                // Tourner coute de la vitesse. Le poids l'alourdit, le handling
                // et la puissance l'allegent (`stats.cornering`), et l'allure
                // decide du tarif : a l'arret on tourne pour rien, lance on paie
                // plein pot.
                //
                // `cost: 0` DESACTIVE tout, proprement et sans rien d'autre a
                // toucher. C'est l'interrupteur.
                //
                //   `cost`     : la perte a plein braquage, a pleine vitesse,
                //                pour un kart de `cornering` valant 1. Se lit en
                //                fraction de la vitesse d'avance, et l'effet est
                //                LINEAIRE : doubler `cost` double toutes les
                //                pertes du tableau ci-dessous.
                //   `fullLock` : ce qui compte pour un plein braquage. C'est la
                //                consigne laterale la plus forte que le pilotage
                //                puisse demander — a tenir avec
                //                `ai.dodgeIntensityMax`, sans quoi `cost` cesse
                //                de se lire en pourcentage.
                //   `maxLoss`  : garde-fou, et RIEN D'AUTRE. Mesure au banc de
                //                scenario : la manoeuvre la plus violente du
                //                pilotage — une esquive a consigne 50 depuis la
                //                croisiere — ne monte qu'a 0.52 de plein
                //                braquage, et une rejointe de couloir en pleine
                //                relance a 0.67. Le plafond ne se declenche donc
                //                dans aucun cas de jeu ; il est la pour qu'un
                //                `cost` absurde ne puisse pas arreter un kart.
                //
                // NE PAS LIRE `cost` COMME LE COUT D'UNE MANOEUVRE. Il se
                // definit au plein braquage, un etat que le pilotage atteint
                // rarement : la loi de rejointe aplatit la consigne bien avant
                // la cible, si bien qu'un ecart de 7 unites n'en consomme que la
                // moitie et qu'il faut une traversee de 20 unites pour y arriver.
                // `cost` est un COEFFICIENT, pas une prevision.
                //
                // Ce que ca coute vraiment se MESURE, et nulle part ailleurs :
                // colonne `virage` du banc (« Ce que la course coute a chaque
                // kart »), en pixels perdus par course et en part de la distance.
                // Le moteur tient le compteur au moment ou il applique la
                // contrainte — c'est le seul endroit qui connaisse les
                // conditions du tick, et la seule facon d'avoir un chiffre qui
                // reste vrai quand on change les exposants.
                //
                // Sur une ligne tenue, zero pour tout le monde : `steer` coupe
                // la consigne des que la cible est tenue, si bien que le cout ne
                // tombe que pendant les TRANSITIONS. La ligne optimale devient
                // « choisir tot, et tenir ».
                //
                // ATTENTION AU PIEGE si l'on retouche la formule : `vy` porte
                // DEJA l'agilite du kart. Facturer `|vy|` punit l'agile ;
                // diviser une seule fois par l'agilite s'annule exactement et ne
                // produit rien. `steerCost` divise par ce que `steerCap` rend
                // pour une consigne de 1, ce qui retire tous les facteurs d'un
                // coup — c'est la seule forme qui reste juste si un facteur
                // s'ajoute un jour.
                //
                // Le test de non-regression est ecrit d'avance : le banc mesurait
                // les huit karts en croisiere a 94.0-94.2 % de leur propre
                // pointe. Cette colonne DOIT maintenant diverger, et dans
                // l'ordre du poids. Si elle reste plate, c'est que le cout
                // s'annule quelque part.
                corner: { cost: 0.018, fullLock: 50, maxLoss: 0.30 }
            },

            // ── Le bord de piste ─────────────────────────────────────────
            //
            // Un mur glissant : infranchissable, mais sans rebond ni arret. Le
            // kart garde son cap, il y perd seulement de la vitesse en raclant.
            // A ne pas confondre avec le tuyau (`pipe`), qui lui arrete net,
            // fait reculer et fige le sprite sur une pose de choc.
            //
            // Le frottement se declenche sur la seule PRESENCE au bord, pas sur
            // un choc : etre plaque contre le mur suffit. Un kart qui s'y fait
            // pousser et un kart qui doit s'y coller pour esquiver paient donc
            // exactement pareil, ce qui est bien le meme prix a payer.
            //
            // Il n'y a rien ici pour les objets : carapaces et bananes gardent
            // leur rebond, le mur n'est glissant que pour les karts.
            wall: {
                // Ce que le mur coute, et c'est le seul chiffre a bouger pour
                // durcir ou adoucir la mecanique : la vitesse vers laquelle il
                // tire, en fraction de la pointe du kart. A 1 il ne coute plus
                // rien ; a 0.5 longer le mur revient a se prendre un eclair.
                //
                // A comparer a ses deux voisins pour se situer : le frein de
                // bord de l'IA vaut 0.78 (`ai.edgeBrakeFactor`) et le
                // rapetissement 0.50 (`lightning.speedFactor`). Racler est plus
                // cher que lever le pied, moins cher que se faire ecraser.
                //
                // Le plancher n'est jamais tout a fait atteint : la relance du
                // moteur pousse en sens inverse pendant qu'on frotte, et
                // l'equilibre se pose `accelerationRate * acceleration / grip`
                // au-dessus — une vingtaine de px/s aux reglages actuels. Un
                // lourd, qui relance moins bien, y descend donc un peu plus bas
                // qu'un vif : le mur coute a chacun ce que vaut sa reprise.
                speedFactor: 0.72,

                // Vitesse a laquelle le frottement mord, en 1/s, et rien de
                // plus — le plafond du malus reste `speedFactor`. Se lit comme
                // les autres taux du moteur : 8 vaut une constante de temps de
                // 125 ms, donc un mur qui se fait sentir presque tout de suite.
                //
                // Le baisser rend le mur pardonnable en le touchant du bout de
                // l'aile, et ne se paie qu'en y restant ; le monter fait payer
                // le moindre frottement plein tarif.
                grip: 8
            },

            // ── Contact entre karts ──────────────────────────────────────
            //
            // Un contact n'est plus un saut de position : c'est un choc, et il
            // se lit sur trois questions, dans cet ordre.
            //
            //   1. PAR OU ? La boite de contact est un rectangle tres allonge
            //      (60 x 5). L'axe du choc est celui ou le chevauchement est le
            //      plus faible **une fois rapporte a la demi-boite** : chevaucher
            //      de 2 en profondeur sur 5 est plus profond que chevaucher de 20
            //      en longueur sur 60. Ce rapport, et lui seul, separe le coup
            //      d'epaule (normale en Y) du tamponnement (normale en X).
            //
            //   2. A QUELLE VITESSE ? L'impulsion vaut la vitesse de
            //      rapprochement le long de cette normale, pas une constante. Se
            //      laisser rattraper de 5 px/s et emboutir a 200 px/s ne peuvent
            //      pas produire le meme choc.
            //
            //   3. QUI CEDE ? Toujours la masse, et de deux facons : elle
            //      repartit l'impulsion, et elle decide de quelle part de son
            //      braquage chacun perd (`steerDeny`). C'est le second point qui
            //      fait qu'un lourd force le passage sur un leger.
            //
            // Les vitesses de choc vivent dans `bumpVy` / `bumpVx`, deux canaux
            // separes de `vy` et de la vitesse moteur. C'est indispensable :
            // ecrire dans `vy` faisait absorber le choc par le volant (`steer`) en
            // 200 ms, avant meme que les karts se soient decolles.
            contact: {
                // Passes de resolution par tick. Une seule passe laisse les
                // paquets de trois karts en chevauchement : le kart du milieu est
                // repousse par l'un dans l'autre. Deux suffisent, au-dela le gain
                // est invisible.
                iterations: 2,

                // Chevauchement tolere avant de corriger la position, par axe.
                // Sans cette marge, deux karts cote a cote se repoussent d'un
                // cheveu a chaque tick et vibrent.
                slopX: 2,
                slopY: 0.2,

                // Vitesse de resorption du chevauchement, en 1/s. Meme forme
                // que `steer.response` : la part corrigee sur un pas vaut
                // `separationRate * dt`, bornee a 1. A 12 et 30 Hz, un contact
                // perd 40 % de son chevauchement par passe. Monter la valeur
                // decolle les karts d'un coup — on retombe sur la
                // teleportation d'avant ; la baisser les laisse se traverser
                // quand ils se rejoignent vite.
                //
                // Exprime en 1/s et non en fraction par pas pour que le
                // comportement ne soit pas silencieusement accroche a
                // `TICK_HZ` cote serveur.
                separationRate: 12,

                // ── L'ejection ───────────────────────────────────────────
                //
                // Un contact est un COUP, pas un appui. La regle qui le tient :
                // une impulsion ne part que si les deux karts se RAPPROCHENT
                // encore. Des qu'ils s'ecartent, plus rien ne les pousse — seule
                // la separation de position finit le travail.
                //
                // C'est ce qui separe un choc net d'une bousculade molle.
                // Pousser a chaque tick tant que les carrosseries se touchent
                // donnait deux karts colles qui se raclaient l'un contre
                // l'autre sur des secondes ; avec la porte du rapprochement, le
                // choc part une fois, fort, et le contact est fini.
                //
                // Force d'un choc, sans unite : `ejectBase` a l'accrochage le
                // plus lent, plus la vitesse de rapprochement. A 1, le choc vaut
                // exactement `ejectX` / `ejectY` avant partage des masses.
                ejectBase: 1.0,

                // Ce que rend la vitesse de rapprochement, en plus du plancher.
                // 0 = tout contact ejecte pareil, quelle que soit l'allure ;
                // au-dela de 1 un tamponnement rend plus qu'il n'a pris.
                restitution: 0.6,

                // Ce que vaut une ejection de force 1, par axe et dans l'unite
                // de l'axe : pixels/s le long de la piste, profondeur/s en
                // travers. Les deux sont separes parce que les axes n'ont ni la
                // meme unite ni la meme echelle — 60 px de boite contre 5 de
                // profondeur. C'est ici qu'on dose « ca ejecte assez fort ».
                //
                // Ces deux-la et les deux plafonds plus bas se tiennent : monter
                // l'un sans l'autre ne se voit pas, le plafond rognant le
                // supplement avant qu'il arrive au kart.
                ejectX: 135,
                ejectY: 27,

                // Plafond de la force d'un choc. Sans lui, un bill lance a
                // pleine vitesse dans un kart a l'arret produirait une ejection
                // proportionnelle a l'ecart de vitesse, sans borne.
                maxEject: 4,

                // Part du braquage perdue par le kart le plus leger, a masse
                // egale. La repartition passe ensuite par les masses : contre un
                // adversaire deux fois plus lourd, on en perd les deux tiers.
                //
                // Contrairement a l'ejection, celui-ci s'applique a CHAQUE tick
                // du contact : ce n'est pas une poussee, c'est un refus d'appui.
                // Il ne peut donc pas coller les karts entre eux — il ne fait
                // qu'annuler la part de volant qui pousse dans l'autre.
                //
                // C'est le reglage du « il force le passage ». A 0, chacun garde
                // son cap et le lourd ne pese plus que par l'ejection ; a 1, le
                // leger colle a l'adversaire perd tout appui et ne peut plus
                // esquiver du tout tant que le contact dure.
                steerDeny: 0.7,

                // Plafonds des deux canaux, en pixels/s et en profondeur/s.
                // Distincts de `maxEject`, qui ne borne qu'un seul coup : deux
                // chocs rapproches s'ajoutent dans le meme canal, et
                // l'amortissement ne les efface pas assez vite pour l'empecher.
                //
                // Ce qu'ils autorisent se lit en distance, pas en vitesse : un
                // choc dure le temps de `decay`, soit 180 ms, donc le kart
                // parcourt environ un cinquieme de la valeur ci-dessous. A 210
                // et 45, une ejection franche vaut les trois quarts d'une
                // longueur de kart le long de la piste et un quart de la largeur
                // de piste en travers.
                //
                // Les ordres de grandeur qui les encadrent : une pointe vaut
                // 450 a 560 px/s, et un ecart d'esquive va de 5 a 85 de
                // profondeur par seconde selon la maniabilite.
                maxBumpX: 210,
                maxBumpY: 45,

                // Amortissement des deux canaux de choc, en 1/s. Se lit comme
                // un delai : 5.5 vaut une constante de temps de 180 ms. Court,
                // et c'est voulu — une ejection doit claquer puis retomber. Un
                // amortissement long etale le coup et le fait ressembler a la
                // poussee continue qu'il remplace.
                decay: 5.5,

                // ── L'inertie d'un contact ───────────────────────────────
                //
                // Ce qu'un kart oppose a un choc n'est pas sa masse mais son
                // inertie : `masse ^ massBias * allure ^ speedBias`, ou l'allure
                // est sa vitesse du moment rapportee a sa propre pointe.
                //
                // Deux exposants pour deux questions independantes — combien le
                // GABARIT compte, et combien l'ALLURE compte — et on peut tourner
                // l'un sans toucher a l'autre.

                // Ce que le poids pese dans un contact, en exposant sur la
                // masse : `masse ^ massBias`. Meme forme que `massDragAccel` et
                // `massDragAgility`, et meme lecture — le pivot est la masse 1,
                // soit le poids moyen, donc les lourds gagnent exactement ce que
                // les legers perdent et un plateau de masses egales reste a
                // 50/50 quoi qu'on mette ici.
                //
                // A 1, le contact prend la masse telle quelle, et l'axe poids ne
                // rend que 1.45 entre bowser et koopa : le choc etait presque
                // equitable la ou on attend qu'un poids lourd fasse valoir son
                // poids. A 2, le leger encaisse 2.1 fois ce que prend le lourd.
                //
                // Ce que ca deplace, dans l'ordre de ce qui se voit :
                // qui part le plus loin apres l'ejection, qui garde son volant
                // (`steerDeny`), et qui cede le terrain a la separation. Le
                // monter donne au lourd un jeu de bulldozer ; le baisser vers 1
                // rend les contacts a la trajectoire plutot qu'au gabarit.
                //
                // C'est le seul levier a poids des contacts, et il n'agit que
                // la : la masse continue de servir a l'acceleration et a la
                // maniabilite sans etre touchee.
                massBias: 2.0,

                // Ce que l'allure pese, meme forme et meme lecture : un exposant
                // qui pivote autour de l'allure 1, soit un kart lance a sa
                // propre pointe. Aller plus vite que d'habitude fait donc peser
                // plus lourd, aller moins vite fait peser moins.
                //
                // A 0, l'allure ne compte plus et on retombe sur le contact
                // purement au gabarit : un kart sous champignon encaisse son
                // propre tamponnement comme s'il etait a l'arret. A 1, l'inertie
                // vaut exactement la quantite de mouvement, `masse * vitesse`,
                // et c'est le reglage honnete — celui qui rend au choc ce que la
                // physique lui donne.
                //
                // Au-dela de 1 le boost devient un jeu a lui seul : a 2, un
                // poids plume sous champignon domine un poids lourd lance. C'est
                // jouable, mais ce n'est plus de l'inertie.
                //
                // Repere : sous champignon (allure 1.5 contre 0.9 en croisiere),
                // un kart pese 1.67 fois plus a speedBias 1 — de quoi tenir tete
                // a un lourd sans le renverser.
                speedBias: 1.0,

                // Garde-fou sur l'allure, pas un reglage : il ne doit jamais
                // mordre sur une situation normale. Le plancher empeche deux
                // choses — qu'un recul de tuyau, qui rend une vitesse negative,
                // inverse le partage, et qu'un kart a l'arret devienne un
                // fantome que tout traverse. Le plafond couvre le bill, seul a
                // depasser sa propre pointe de plus de moitie.
                speedClamp: { min: 0.55, max: 1.80 },

                // Ce que pese un bill dans un contact, en multiples de la masse
                // qu'aurait le kart sous la carapace. Il ne se lit pas comme un
                // poids mais comme un RAPPORT : a 60, un bill encaisse environ
                // un soixantieme de ce qu'il inflige — assez pour que rien de ce
                // qu'il percute ne le devie de sa ligne.
                //
                // C'est un multiplicateur et non un terme de `massBias` : le
                // bill n'est pas un kart lourd, c'est un projectile, et son
                // immunite ne doit pas bouger quand on rejoue l'ecart de poids
                // du plateau.
                //
                // Deux bills portent tous les deux ce facteur, qui s'annule
                // entre eux : ils retombent sur un partage moitie-moitie,
                // attenue par `bill.pushFactor`. Un bill reste donc la seule
                // chose qui devie un bill, et ce chiffre n'a pas a le dire.
                //
                // Le monter davantage ne se verrait plus : a 60 la deviation
                // residuelle vaut deja un tiers de profondeur, que le
                // recentrage du bill (`bill.centerSpeed`) efface aussitot.
                billMassFactor: 60,

                // Un kart en tete-a-queue ne pilote plus, il encaisse — mais il
                // n'est plus un fantome pour autant. Ce facteur majore sa masse :
                // au-dessus de 1, il fait plus obstacle qu'il ne se fait pousser,
                // ce qui est le comportement d'une carcasse qui derape en travers
                // de la piste.
                spinMassFactor: 1.2
            }
        },
        speeds: {
            roadPPS: 250,

            // ── L'elan ───────────────────────────────────────────────────
            //
            // La croisiere n'est pas la pointe : un kart hors objet vise
            // `topSpeed * (momentumMinRatio + (1 - momentumMinRatio) * momentum)`,
            // ou `momentum` est retire toutes les `momentumDrift*` ms dans
            // uniform(`momentumFloor`, 1) et rejoint a `momentumChangeSpeed`.
            //
            // Aucune statistique n'entre dans cette loi : c'est un
            // multiplicateur de la pointe, et les huit karts croisent donc au
            // meme pourcentage de la leur. Ce qui se regle ici n'est pas qui est
            // rapide — c'est de combien le rythme respire.
            momentumMinRatio: 0.78,

            // LA LARGEUR DE LA BANDE, par le bas : la croisiere va de
            // `minRatio + (1 - minRatio) * base` a 100 % de la pointe.
            //
            //     base    bande        bruit sur une course   chevauchement
            //     0.44    87.7-100 %        4.6 px/s          39 px/s
            //     0.70    93.4-100 %        2.5 px/s           9 px/s   ← livre
            //     0.78    95.2-100 %        1.8 px/s           aucun
            //
            // Le plateau entier tient dans 5.1 % de pointe : une bande a 12.3 %
            // couvrait les fiches d'un bruit deux fois et demie plus large
            // qu'elles, a l'ecran comme au banc.
            //
            // 0.78 EST LA LIMITE A NE PAS FRANCHIR. Au-dela, le pire moment de
            // bowser reste plus rapide que le meilleur de koopa : plus aucun
            // depassement ne peut naitre de la croisiere et le peloton devient
            // une procession, que seuls les objets et les incidents animent.
            //
            // `weightGain` releve ce plancher a proportion du poids. A 0 il ne
            // fait rien, et c'est voulu : les lourds gagnent deja au-dessus de
            // l'attendu. A noter s'il devait servir un jour — il ne sait que
            // RELEVER, et les reprises apres incident ne le lisent pas.
            momentumFloor: { base: 0.70, weightGain: 0 },
            momentumChangeSpeed: 0.25,
            momentumDriftMin: 3000,
            momentumDriftMax: 7000,
            accelerationRate: 150,

            projectileSpeed: 880,
            redShellSpeed: 840,
            redShellTrackingSpeed: 8,
            // Choix de cible de la rouge. Ces trois valeurs decrivent une pente,
            // pas un seuil : le classement des candidats se fait dans
            // redShellTargetScore(), cote physique.
            //
            // Plancher dur. En dessous, viser est sans effet : l'objet ne s'arme
            // qu'a `itemArmDistance` (110) du tireur et traverse tout avant. La
            // marge au-dessus de 110 couvre le cas ou la cible freine et vient
            // au-devant de la carapace avant qu'elle soit armee.
            redShellMinTarget: 150,

            // Au-dela, la rouge a tout le temps de se recaler : le candidat vaut
            // son ecart brut. Entre le plancher et ce confort, il reste eligible
            // mais penalise. Ce n'est pas la portee de la rouge, qui est infinie
            // — c'est la distance a partir de laquelle une cible est « facile ».
            redShellComfortTarget: 340,

            // Ce que coute au maximum d'etre au contact, en unites de distance
            // ajoutees a la note d'un candidat colle au plancher. Le monter fait
            // preferer les cibles lointaines et ramene le comportement d'avant ;
            // le baisser fait viser au plus pres a tout prix.
            redShellClosePenalty: 260,

            // ── Vitesse sous objet ───────────────────────────────────────
            //
            // Champignon, etoile et bill partagent un seul modele, et c'est tout
            // ce qu'il y a a regler ici. Chacun repond a deux questions :
            //
            //   POINTE : `multiplier`, en multiple de la pointe du kart. C'est
            //   la seule chose qui la fixe — un objet ne donne pas la meme
            //   vitesse a tout le monde, il donne a chacun la sienne, majoree
            //   d'autant. Les persos gardent donc leur ordre sous objet, et
            //   `topSpeed` reste le seul endroit ou se decide qui est rapide.
            //
            //   MONTEE : `ramp`, en multiples de la relance normale. La pointe
            //   n'est jamais instantanee : le kart y monte a
            //   `accelerationRate * acceleration * ramp` px/s². Le facteur
            //   `acceleration` est ce qui met un leger legerement devant un
            //   lourd sous le meme objet — c'est la seule difference entre eux,
            //   et elle ne joue que sur la montee, jamais sur la pointe.
            //
            // Regler la montee se lit en une phrase : `ramp: 6` veut dire « six
            // fois plus vif qu'une relance normale ». Le baisser rend l'objet
            // mou a la prise sans toucher a ce qu'il finit par donner ; le
            // monter le ramene vers le coup de fouet instantane d'avant.
            //
            // Ordres de grandeur des reglages ci-dessous, mesures depuis la
            // croisiere, du plus vif (koopa) au plus lourd (bowser) :
            // champignon 240-390 ms, etoile 75-120 ms, bill 90-145 ms.
            boosts: {
                // Le champignon est le seul dont la montee se voit : elle mange
                // un cinquieme de sa duree. C'est ce qui le distingue de
                // l'etoile, qui dure quatre fois plus longtemps pour une pointe
                // plus basse.
                //
                // `durationMs` sert aussi au turbo de depart (race.turboBoostMs
                // en fixe la duree, la pointe et la montee viennent d'ici).
                shroom: { multiplier: 1.50, durationMs: 1500, ramp: 10 },

                // Duree fixe, identique quel que soit le rang. La pointe est en
                // dessous de celle du champignon : l'etoile ne s'achete pas en
                // vitesse de pointe mais en duree et en invincibilite.
                star: { multiplier: 1.40, durationMs: 6000, ramp: 16 },

                // A garder au-dessus de l'etoile, sinon le bill se fait
                // rattraper par ce qu'il double. Sa duree de vol n'est pas ici :
                // elle se negocie au fil des depassements, cf. `bill`.
                bill: { multiplier: 1.65, ramp: 20 }
            },

            // Banane lancee en cloche. La hauteur est un decalage de rendu en
            // pixels, sans effet sur la profondeur de piste.
            bananaLobDistance: 900,
            bananaLobDurationMs: 850,
            bananaLobHeight: 105,
            // Forme de l'arc. En dessous de 1, le sommet arrive plus tot et le
            // depart est plus vertical.
            bananaLobRise: 0.62,

            shellVertical: 1.5
        },
        offsets: {
            // Lu par la physique. Valeurs uniques (PC = mobile) pour des collisions
            // reproductibles quel que soit l'appareil.
            world: {
                heldItemBehind: -50,
                shellSpawn: 50
            },
        },
        delays: {
            hitDecelDuration: 1500,
            hitPauseDuration: 500,
            boxRespawn: 1000,
            itemGrant: 3000,
            bananaLife: 40000,
            // Sursis entre le contact et la disparition : le sprite s'effacait
            // avant qu'on ait vu le choc. Sans danger pendant ce delai.
            itemLingerMs: 80,
            invincibilityAfterHit: 3000,
            throwDelayAfterHit: 1000,
            spawnMin: 150,
            spawnMax: 800
        },
        // Objets retires du jeu. Un type liste ici voit son poids force a 0 dans
        // tous les paliers, sans qu'il faille toucher aux tableaux ci-dessous : le
        // reste du palier est renormalise automatiquement. Pour desactiver un objet,
        // ajouter simplement son nom ici, par exemple :
        //     disabledItems: ['tripleRedShell', 'star']
        // Les trois triples sont en place et testes, mais mis de cote pour le
        // moment : vider cette liste suffit a les remettre en jeu.
        disabledItems: ['tripleBanana', 'tripleGreenShell', 'tripleRedShell'],
        // Objets en orbite : `count` exemplaires tournent autour du kart et servent
        // de bouclier, `child` etant l'objet reellement largue a chaque activation.
        // Ajouter une entree ici suffit a creer un nouveau triple.
        orbitItems: {
            tripleBanana:     { child: 'banana' },
            tripleGreenShell: { child: 'greenShell' },
            tripleRedShell:   { child: 'redShell' }
        },
        // Geometrie commune a toutes les orbites. Lu par la physique : rayons en
        // coordonnees monde (px pour radiusX, pourcentage de route pour radiusY)
        // donc identiques PC et mobile, la mise a l'echelle mobile s'appliquant
        // deja au conteneur entier.
        orbit: {
            count: 3,
            orbitSpeed: 2.6,
            radiusX: 62,
            radiusY: 3.2,
            dropIntervalMin: 1200,
            dropIntervalMax: 3500
        },
        // Distribution des objets. Une seule mecanique pour tout le monde, bleue
        // comprise : cinq mesures normalisees entre 0 et 1 (p rang, d ecart au
        // premier, s etape de course, g ecart au kart de devant, i isolement du
        // peloton) donnent une pression unique :
        //
        //   pression = (rankShare * p + (1 - rankShare) * d)
        //            * (stageBoost.base + stageBoost.gain * s)
        //            * (packBoost.base  + packBoost.gain  * i)
        //
        // Les objets tactiques (banane, verte, rouge, champignon) suivent leurs
        // propres courbes sur p/d/s/g ; les objets puissants (etoile, bill,
        // eclair) ne lisent que la pression, avec un seuil d'ouverture chacun.
        // Ajouter un objet = une entree dans `items`, rien a renormaliser.
        itemDistribution: {
            // Unites monde. Un tour vaut world.width, ~500 u/s : 3500 ~= 7 s de
            // retard, la ou l'echelle sature.
            distanceRef: 3500,
            // Etalement du peloton et ecart au kart de devant, memes unites.
            spreadRef: 4000,
            gapRef: 1200,

            // Part de l'etalement global dans l'isolement, le reste allant a
            // l'ecart local (g).
            spreadShare: 0.65,

            // Part du rang dans la pression, le reste allant a l'ecart au premier.
            rankShare: 0.45,

            // Etape de course, effet leger : x0.85 au depart, x1.15 a l'arrivee.
            // Les verrous `minStage` de chaque objet decident du calendrier.
            stageBoost: { base: 0.85, gain: 0.30 },

            // Peloton, effet fort : x0.55 peloton colle, x1 course eclatee.
            packBoost: { base: 0.48, gain: 0.52 },

            // Poids de l'objet deja recu au ramassage precedent, multiplie par
            // ceci. A 1, neutralise.
            repeatPenalty: 0.4,

            // Profil de chaque objet : une courbe est une liste de facteurs
            // multiplies entre eux (1 quand absent) :
            //
            //   { rise: [a, b], floor: f }   f en a (0 par defaut), 1 en b
            //   { fall: [a, b], depth: p }   1 en a, 1 - p en b (p = 1 par defaut)
            //   { bell: c, width: w }        1 en c, 0 a c - w et c + w
            //
            // Courbes disponibles : `rank` (p), `dist` (d), `stage` (s), `gap` (g).
            // `packBonus` s'applique a tous : poids x (1 + packBonus * (1 - i)).
            //
            // Verrous, facultatifs, poids force a 0 hors condition :
            //   minStage, minRank, lastRanks, minDist, unique
            //
            // Decote, pour toute la course et non le seul porteur :
            //   decay        chaque exemplaire distribue multiplie par ceci le
            //                poids du suivant
            //   regenPerLap  ce que la decote regagne par tour du premier
            items: {
                // --- Objets tactiques -------------------------------------
                // Seuls ceux-la restent non nuls en p = 0 : le premier n'a que
                // banane et verte.

                // Objet de tete : decroit avec le rang, chute avec l'ecart sans
                // s'annuler (depth 0.90 laisse un dixieme du poids).
                banana: {
                    base: 100,
                    rank:  [{ fall: [0, 1], depth: 0.80 }],
                    dist:  [{ fall: [0, 0.50], depth: 0.85 }, { fall: [0.45, 0.75], depth: 0.90 }],
                    stage: [{ fall: [0, 1], depth: 0.25 }],
                    packBonus: 0.30
                },

                // Culmine en deuxieme/troisieme. Meme traitement que la banane
                // a grand ecart.
                greenShell: {
                    base: 95,
                    rank:  [{ rise: [0, 0.30], floor: 0.55 }, { fall: [0.30, 1], depth: 0.55 }],
                    dist:  [{ fall: [0, 0.55], depth: 0.80 }, { fall: [0.50, 0.82], depth: 0.90 }],
                    stage: [{ fall: [0, 1], depth: 0.20 }],
                    packBonus: 0.35
                },

                // Nul pour le premier. Cible le kart de rang superieur, donc
                // `gap` commande ; `dist` ne garde qu'un role de fond.
                redShell: {
                    base: 95,
                    rank:  [{ rise: [0, 0.14] }, { fall: [0.55, 1], depth: 0.45 }],
                    dist:  [{ bell: 0.35, width: 0.72 }],
                    gap:   [{ fall: [0.55, 1.20] }],
                    packBonus: 0.20
                },

                // Seul objet de remontee sans condition d'etape. Plancher d'ecart
                // pour rester present en peloton colle, s'efface a tres grand
                // ecart.
                shroom: {
                    base: 70,
                    rank:  [{ rise: [0, 0.14] }],
                    dist:  [{ rise: [0, 0.45], floor: 0.30 }, { fall: [0.70, 1], depth: 0.55 }],
                    packBonus: 0.45
                },

                // --- Objets puissants -------------------------------------
                // Trois seuils decales sur la meme pression. `minStage` tient le
                // calendrier : rien au tour 1, etoile au tour 2, bill et eclair
                // a partir du tour 3.

                star: {
                    base: 58,
                    power: { open: 0.28, full: 0.66 },
                    minStage: 0.20,
                    minRank: 2
                },

                bill: {
                    base: 34,
                    power: { open: 0.45, full: 0.86 },
                    minStage: 0.40,
                    minRank: 4,
                    minDist: 0.30
                },

                // Tombe sur toute la piste, ne vise personne. Un seul en
                // circulation, jamais pendant un orage. Decote un peu plus
                // severe que la bleue (0.35 contre 0.45).
                lightning: {
                    // Releve pour compenser le reflux ci-dessous : sans ca,
                    // ecreter le dernier tour reduirait le nombre d'orages par
                    // course au lieu de les redistribuer. Cale sur une mesure :
                    // a 24 le banc rendait 0.38 orage par course contre 0.55
                    // avant le reflux, d'ou ce nouveau palier.
                    base: 35,
                    power: { open: 0.58, full: 0.95 },
                    minStage: 0.45,
                    lastRanks: 3,
                    minDist: 0.40,
                    unique: true,
                    decay: 0.35,
                    regenPerLap: 0.25,

                    // Reflux marque : sans lui, pres des deux tiers des orages
                    // tombaient au dernier tour. La profondeur est forte, mais
                    // elle ne mord que sur les 28 derniers pourcents de la
                    // course — avant `from`, rien n'est touche.
                    lateFade: { from: 0.72, to: 1.00, depth: 0.95 }
                },

                // --- Triples (desactives, voir disabledItems) --------------
                // Defensifs : pesent en tete et milieu de peloton, s'effacent a
                // l'arriere.
                tripleBanana: {
                    base: 40,
                    rank:  [{ fall: [0.30, 1], depth: 0.90 }],
                    dist:  [{ fall: [0, 0.55], depth: 0.85 }, { fall: [0.55, 0.90] }],
                    stage: [{ fall: [0, 1], depth: 0.25 }],
                    packBonus: 0.30
                },
                tripleGreenShell: {
                    base: 40,
                    rank:  [{ rise: [0, 0.15], floor: 0.50 }, { fall: [0.35, 0.85] }],
                    dist:  [{ fall: [0, 0.60], depth: 0.80 }, { fall: [0.60, 0.95] }],
                    stage: [{ fall: [0, 1], depth: 0.20 }],
                    packBonus: 0.35
                },
                tripleRedShell: {
                    base: 40,
                    rank:  [{ rise: [0, 0.14] }, { fall: [0.60, 1], depth: 0.60 }],
                    dist:  [{ bell: 0.35, width: 0.55 }],
                    packBonus: 0.20
                }
            }
        },
        // Carapace bleue : tirage a part, joue avant les poids de
        // itemDistribution. Declenchee par l'echappee du premier, pas par
        // l'ecart du tireur.
        //
        //   chance = baseChance * montee(stageWindow)
        //          * (leadFloor + leadGain * echappee) * poids de rang * decote
        blueShell: {
            baseChance: 0.14,

            // Nulle avant, pleine apres : les ecarts des deux premiers tours sont
            // encore ceux de la grille. La borne haute est calee sur le
            // quatrieme tour et non sur l'arrivee, pour que le pic de
            // probabilite tombe la plutot qu'au dernier tour.
            stageWindow: { from: 0.35, to: 0.75 },

            // Reflux de fin de course, meme mecanique que pour l'eclair. Plus
            // doux ici : la bleue penchait moins vers le dernier tour, sa montee
            // n'etant pas portee par la pression mais par l'echappee du premier.
            lateFade: { from: 0.72, to: 1.00, depth: 0.30 },

            // Echappee du premier sur le deuxieme, rapportee a leadRef.
            leadRef: 2200,
            leadFloor: 0.30,
            leadGain: 0.95,

            // Poids par rang ; absent = jamais de bleue.
            rankWeights: { 3: 0.65, 4: 0.65, 5: 1.00, 6: 1.00, 7: 0.75 },

            // Chaque bleue lancee multiplie la chance par `decay`, regagnee
            // ensuite de `regenPerLap` a chaque tour du premier.
            decay: 0.45,
            regenPerLap: 0.30,

            // Garde-fou dur : jamais deux bleues coup sur coup.
            cooldownMs: 12000,

            // Trajet en ligne droite au milieu de la piste, au-dessus de tout.
            speed: 1500,
            // Hauteur en vol, puis une fois sur la cible.
            cruiseHop: 72,
            orbitHop: 118,
            catchDistance: 70,
            // Elle file tout droit sans cible, puis se verrouille sur le premier
            // a cette distance. Le verrou est definitif : c'est ce kart qu'elle
            // frappe, meme s'il se fait doubler avant l'impact.
            lockDistance: 800,
            // Au-dela, elle se verrouille sur le premier ou qu'il soit.
            maxCruiseMs: 9000,

            // Un tour autour de la cible, puis surplomb, puis chute.
            orbitTurns: 1,
            orbitMs: 800,
            orbitRadiusX: 85,
            orbitRadiusY: 4,
            hoverMs: 450,
            crashMs: 130,
            // Elle se poste devant le kart avant de plonger, puis pique encore
            // pendant la chute : en 130 ms il parcourt 65 unites, viser sa
            // position exacte reviendrait a lui tomber derriere.
            hoverLead: 48,
            crashLead: 95,

            // Dome qui s'etend depuis le point d'impact : chaque kart est touche
            // a l'instant ou le front l'atteint.
            blastRadiusX: 180,
            blastRadiusY: 8.5,
            blastMs: 300
        },

        // Eclair : conditions de sortie dans itemDistribution.items.lightning.
        // Ici, seulement ce qui suit le lancer.
        lightning: {
            // Rythme de l'orage, en ms depuis le lancer. `strikeAt` est
            // l'instant unique ou tout arrive d'un coup : le ciel bascule dans le
            // noir, les eclairs tombent, et le malus s'applique. A zero, il n'y a
            // donc aucun temps de chargement — c'est une coupure franche, comme
            // la foudre. Le monter reintroduirait un ciel qui se charge avant la
            // frappe, mais l'assombrissement ne serait alors plus simultane des
            // eclairs. Le jour revient sur la fin de `totalMs`.
            strikeAt: 0,
            totalMs: 2600,

            // Malus. La vitesse est divisee et le kart reduit pour toute la duree.
            speedFactor: 0.5,
            scale: 0.5,

            // Duree du rapetissement. Le leader paie plein tarif, celui qui est
            // deja largue s'en sort vite : l'eclair vient du fond de grille, il
            // n'a pas a enfoncer ceux qui y sont deja.
            //
            // Ces deux bornes sont atteintes quoi qu'on regle en dessous : le
            // premier prend `shrinkMsMax`, le dernier largue au-dela de
            // `shrinkFalloffDistance` prend `shrinkMsMin`.
            shrinkMsMax: 10000,
            shrinkMsMin: 2000,

            // Ecart au premier a partir duquel on ne paie plus que le minimum.
            shrinkFalloffDistance: 3500,

            // ── L'ecrasement ─────────────────────────────────────────────
            //
            // Un kart rapetisse passe sous un kart reste normal : il ne se fait
            // pas bousculer, il se fait rouler dessus. C'est le seul contact du
            // jeu ou les deux karts ne s'echangent rien — le gros ne sent rien,
            // le petit garde sa trajectoire, et tout le prix est dans l'etat qui
            // suit.
            //
            // Une etoile ou un bill n'ecrasent pas : ils blessent, et le petit
            // part en tete-a-queue comme devant n'importe quel objet. Ecraser est
            // une affaire de gabarit, pas de puissance.
            //
            // Duree maximale, et non duree ferme : l'aplatissement s'arrete a
            // la fin du rapetissement s'il tombe avant. On n'ecrase que ce qui
            // est petit, donc redevenir grand rend sa forme au kart.
            //
            // Le marche va dans les deux sens, et c'est ce qui le rend juste :
            // se faire ecraser au dernier moment ne coute presque rien, et en
            // echange l'ecrasement ne retarde JAMAIS le retour a la taille
            // normale. Le rapetissement garde son propre calendrier.
            flatMs: 3000,

            // Ce que coute d'etre aplati, en facteur de vitesse. Il s'applique
            // par-dessus tout le reste, `speedFactor` compris : un kart a la
            // fois petit et aplati roule a 0.5 * 0.9. Ca ne l'arrete pas — c'est
            // un kart qui traine, pas un kart en panne.
            flatSpeedFactor: 0.9,

            // Ce qui decide entre les deux bornes : la part du RANG face a celle
            // de la DISTANCE, entre 0 et 1.
            //
            // A 0, seul l'ecart compte — deux karts au coude a coude paient
            // rigoureusement pareil, et mener ne coute rien de plus qu'etre
            // deuxieme a un cheveu. A 1, seule la place compte, et un premier
            // avec un tour d'avance paie autant qu'un premier talonne.
            //
            // Entre les deux, chaque place gagnee vaut d'office
            // `(shrinkMsMax - shrinkMsMin) * shrinkRankWeight / (places - 1)`
            // de malus en plus, ecart nul ou pas : a 0.35 et huit karts, 400 ms
            // par place. C'est ce qui fait qu'un premier au coude a coude reste
            // petit un peu plus longtemps que son second — assez pour que mener
            // se paie, trop peu pour effacer un ecart reel.
            //
            // Le monter rapproche l'eclair d'une sanction du classement ; le
            // baisser le rend a la geographie de la course.
            shrinkRankWeight: 0.35
        },

        // Bill Ball. Ce n'est pas un projectile : le kart lui-meme se transforme
        // et fonce au milieu de la piste, comme l'etoile est un etat et non un
        // objet lance. Tout est reglable ici, rien n'est en dur dans la physique.
        bill: {
            // Sa vitesse de croisiere et sa montee vivent avec celles des deux
            // autres objets, dans `speeds.boosts.bill` : les trois ne se reglent
            // qu'en les comparant. Ce qui reste ici est ce qui n'appartient
            // qu'au bill.
            //
            // A savoir en la reglant : la baisser rallonge le vol pour de bon,
            // et pas seulement a l'oeil. Moins vite veut dire moins de karts
            // doubles par seconde, donc moins de `overtakeCostMs` retires.
            // Vitesse et duree sont liees par la.

            // Marge minimale du bill sur la meilleure pointe qu'un autre objet
            // permet, tous personnages confondus : son multiplicateur ne le
            // compare qu'a lui-meme.
            minLeadRatio: 1.08,

            // Duree du vol. Chaque kart double la raccourcit de `overtakeCostMs`,
            // sans jamais tomber sous `minDurationMs` : le bill sert a remonter,
            // pas a prendre la tete et a s'y installer. Mettre `overtakeCostMs` a
            // 0 rend la duree fixe.
            durationMs: 7000,
            overtakeCostMs: 800,
            minDurationMs: 3000,

            // Retour au calme. La vitesse redescend lineairement de la vitesse de
            // croisiere a celle du kart sur cette duree ; le kart a deja repris sa
            // forme, il finit seulement sur son elan.
            slowdownMs: 1000,

            // Recentrage : le bill rejoint le milieu de la piste a cette vitesse,
            // en pourcents de profondeur par seconde, et n'en bouge plus.
            centerSpeed: 25,

            // Ce qu'il balaie au passage, a tenir en face de la taille dessinee.
            //
            // `x` est le long de la piste, le meme axe que la largeur du sprite a
            // l'ecran, et le monde est a l'echelle 1:1 du pixel : `x` vaut donc la
            // demi-largeur dessinee. A 198 % de la largeur d'un kart (soit 198 px),
            // 99 place le front de collision pile au bord du dessin. Toucher a la
            // taille du bill dans .kart-bill sans reporter la moitie ici casse cet
            // accord. Reference : kartVsKart vaut 60 pour un kart de 100 %.
            //
            // `y` est la profondeur de piste, pas la hauteur du sprite : les deux
            // n'ont aucun rapport, la profondeur etant portee par la position du
            // kart et non par son image. Il ne suit donc PAS l'agrandissement.
            // A 11 sur une piste de 30 de profond, le bill part du milieu et
            // balaie de 4 a 26 : les deux bords restent des refuges. Le doubler
            // couvrirait toute la piste et le rendrait inevitable.
            hitbox: { x: 99, y: 11 },

            // Degagement pris pour contourner un pipe, au-dela de la hitbox. Le
            // bill ne manoeuvre pas, il devie : juste ce qu'il faut pour passer
            // a cote, et il revient au milieu aussitot apres.
            pipeClearance: 3,

            // Deux bills ne se font aucun degat, mais ils partagent la voie du
            // milieu : ils se bousculent, a cette fraction de la poussee normale.
            // A 0, ils se traverseraient — le seul endroit du jeu ou deux karts
            // s'ignoreraient completement.
            pushFactor: 0.45
        },

        // Le pipe : le seul element du monde de masse infinie. Il ne bouge pas,
        // ne se detruit pas, et ne cede jamais — il se contourne. Il se dessine
        // par un `P` dans tracks/, comme une boite par un `B`.
        pipe: {
            // Aucune constante ne convertit ici la profondeur en pixels, et
            // c'est voulu. Le rebond choisit sa face en comparant des durees —
            // depuis combien de temps chacune a ete franchie — et une duree se
            // compare a une duree quelle que soit l'unite de l'axe. Un facteur
            // pixels-par-profondeur aurait ete une convention de plus a tenir
            // face a la hauteur reelle de la banniere, qui n'est pas la meme sur
            // mobile (§6.1 du document de migration).

            // Emprise au sol, en unites natives : `x` en pixels de monde, `y` en
            // profondeur. Le tuyau est rond a l'ecran, sa hitbox est une boite,
            // comme toutes les autres du moteur. Une carapace rebondit sur ses
            // faces, et c'est la face touchee qui decide de l'angle.
            //
            // `y` est bien plus plat que le sprite n'est large, et c'est
            // volontaire : la piste ne fait que 30 unites de profondeur pour 108
            // px a l'ecran. Une emprise aussi profonde que large en boucherait
            // les trois quarts a elle seule, et deux pipes fermeraient le
            // circuit.
            //
            // Reduite de 20 % en `x` depuis la premiere version (42 / 5.5) : le
            // tuyau etait presque aussi large qu'un kart, et deux d'entre eux ne
            // laissaient plus de porte praticable. La taille dessinee suit dans
            // GAME_CONFIG.visuals.pipe, qui vaut exactement 2 * x.
            //
            // `y` suit maintenant LE MEME APLATISSEMENT QUE LE KART, et c'est ce
            // qui lui donne sa valeur. La piste fait 30 unites de profondeur
            // pour 108 px a l'ecran, d'ou :
            //
            //   kart   30.0 px de large  x   9.0 px de fond   ->  3.33 : 1
            //   pipe   33.6 px de large  x  10.1 px de fond   ->  3.33 : 1
            //
            // A 5.5 puis 4.4, il etait aplati a 2.12 : 1 seulement — 12 % plus
            // large qu'un kart mais 76 % plus profond. Rien ne le justifiait, et
            // ca se payait sur le seul endroit ou la profondeur compte : les
            // couloirs. Un tuyau a y=20 ne laissait que 3.1 unites vers le fond,
            // dont le point de confort tombait a moins d'une unite du mur — donc
            // toujours penalise par `vision.cost.edge`, donc jamais choisi. Le
            // cote large gagnait quelle que soit la position du kart.
            //
            // A 2.8, ce meme couloir fait 4.7 et son point de confort se pose a
            // plus de 2 unites du mur : le cout de bord tombe a zero et la
            // bascule entre les deux cotes redevient purement geometrique — le
            // kart prend le cote ou il est deja. Aucune regle n'a ete ecrite
            // pour ca, c'est la geometrie qui cessait d'etre fausse.
            hitbox: { x: 33.6, y: 2.8 },

            // Ce qu'un choc frontal coute a un kart. Bien moins qu'un objet
            // (2000 ms de tete-a-queue) : un mur se croise a chaque tour, un
            // objet non.
            bumpMs: 600,
            // Recul, en pixels de monde et en millisecondes. Il entame aussi la
            // distance parcourue : position et progression restent cousues.
            recoilPx: 90,
            recoilMs: 250,
            // Sursis avant qu'un nouveau choc soit possible. Sans lui, un kart
            // encore au contact rejouerait le choc a chaque pas de simulation.
            immuneMs: 700,
            // Poussee laterale donnee au choc, vers le cote le plus degage. Sans
            // elle, un kart pousse par le peloton resterait plaque contre le
            // tuyau jusqu'a la fin de la course, et le chien de garde du service
            // se contenterait de le constater.
            slideAway: 18,

            // Distance a laquelle un BILL voit un tuyau. Les karts, eux, n'ont
            // plus de portee a eux : ils voient par `vision.range`, comme pour
            // tout le reste. Un bill n'a pas de vue — il ne pilote pas, il vole
            // — et c'est la seule chose qu'il lui reste a regarder, d'ou cette
            // constante restee ici.
            //
            // A tenir avec `vision.range.front`, qui vaut la meme chose : un
            // kart n'a aucune raison de voir un mur moins loin qu'un bill.
            seeDistance: 1100,

            // Contournement : le kart choisit un couloir et le rejoint. Le
            // comment se regle avec les autres manoeuvres laterales, dans
            // `ai.steering.pipe` — elles partagent une seule loi de pilotage, et
            // c'est la qu'on voit d'un coup d'oeil ce que chacune en fait.
            //
            // Ce qui reste ici ne concerne que le trace : ou l'on a le droit de
            // passer, pas comment on y va.

            // `laneTieMargin` a disparu. Elle departageait deux couloirs « de
            // largeurs proches » en faveur du plus proche du kart — mais a 1.5
            // pres, et le plus large gagnait des que l'ecart depassait ca. Face
            // a 11 contre 3, elle ne se jouait donc jamais, et aucun kart
            // n'empruntait un passage serre. Le depart se fait maintenant sur la
            // note complete (`chooseLane`), ou la proximite est un terme parmi
            // les autres et non un dernier recours.

            // Vertes : nombre de rebonds tolere, pipes et bords de piste
            // confondus. Au suivant, la carapace se detruit. C'est aussi ce qui
            // donne enfin une duree de vie a une verte, qui n'en avait aucune.
            maxShellBounces: 10,

            // Integration des projectiles par sous-pas. A 880 px/s et 45 degres,
            // une verte traverse la piste en un dixieme de seconde : en un seul
            // pas de 33 ms elle avancerait de 8 unites de profondeur, soit plus
            // que la hitbox d'un kart (5) — elle enjamberait ses victimes sans
            // les toucher. Chaque sous-pas est borne a cette avance.
            maxSubStepY: 1.5,
            maxSubSteps: 12,

            // Marge de degagement apres un rebond, en fraction du rayon. Sans
            // elle, la carapace repart depuis la surface exacte de l'ellipse,
            // y rentre au sous-pas suivant et vibre sur place.
            escapeMargin: 0.06,

            // Passage libre minimal, mesure en positions de centre de kart : la
            // demi-carrosserie est deja dans `kartVsPipe`, si bien qu'un
            // passage de zero se franchirait en theorie. Celui-ci demande de la
            // marge, parce qu'un kart arrive rarement pile dans l'axe.
            //
            // A 6, un pipe pose au milieu de la piste passe des deux cotes
            // (7 de libre de chaque cote, pour un kart profond de 5), et deux
            // pipes qui ne laissent qu'un couloir de moins de 6 sont refuses.
            // Le monter a 8 refuserait le cas le plus naturel de tous : un seul
            // tuyau au centre.
            //
            // ATTENTION : ce seuil ne concerne PLUS QUE LE CHARGEMENT. Le
            // pilotage ne s'en sert plus — il note les couloirs au lieu de les
            // refuser, et sait donc emprunter un passage plus serre que 6 quand
            // c'est le moins cher. Et `narrowestPassage` mesure la piste
            // physique complete, sans marge de bord : un circuit accepte ici
            // est bien un circuit franchissable.
            //
            // Un circuit qui n'en laisse pas autant est refuse au chargement :
            // un mur de pipes rendrait la course infinissable sans qu'aucune
            // erreur ne soit levee — les karts se cogneraient jusqu'au delai
            // maximum, et le classement d'office ne dirait pas pourquoi.
            minPassageY: 6
        },

        // Objets qu'un kart peut trainer derriere lui.
        trailableItems: ['banana', 'greenShell', 'redShell'],

        // ── La vue ───────────────────────────────────────────────────────────
        //
        // Un kart ne reagit qu'a ce qu'il voit, il ne regarde qu'un cote a la
        // fois, et un corps solide lui bouche la vue. Tout ce qui suit regle
        // cette perception, et elle seule : ce qu'il en fait ensuite se regle
        // dans `ai`.
        //
        // Le systeme est identique pour tout le plateau, et la PORTEE le restera
        // (cf. `range`) : personne ne voit plus loin que son voisin. Les
        // statistiques de pilote — vision de jeu, brain, sang-froid — viendront
        // plus tard moduler ce qu'un kart FAIT de ce qu'il voit : son reflexe
        // (`ai.reactionBaseMs`), son inattention (`ai.dodgeMissChance`), la
        // qualite de sa decision (`reviewChance`, `safety.chance`). D'ici la,
        // personne n'est mieux place que son voisin pour voir venir, ni pour
        // bien decider.
        vision: {
            // Portee du regard, en pixels de monde. L'avant porte plus loin :
            // de face on lit la piste, derriere on jette un oeil.
            //
            // L'avant vaut `pipe.seeDistance` — la plus longue portee du
            // moteur. Rien ne sert de voir un objet plus loin que l'obstacle
            // qui commande deja la trajectoire.
            //
            // ── LA PORTEE EST LA MEME POUR TOUT LE PLATEAU ───────────────
            //
            // C'est une invariante, pas un reglage provisoire : aucun kart ne
            // voit plus loin qu'un autre, et rien ici ne se module par
            // personnage. Ce que des statistiques de pilote pourront moduler un
            // jour, c'est ce qu'un kart FAIT de ce qu'il voit — son reflexe, son
            // attention, la qualite de sa decision — jamais la distance a
            // laquelle il voit.
            //
            // La seule variation est le SENS du regard, et elle vaut pour les
            // huit de la meme facon.
            //
            // Ces distances ne se rapportent a aucune largeur affichee : le
            // moteur ne connait que des pixels de monde, la fenetre du
            // spectateur ne lui parvient jamais, et la meme simulation sert tous
            // les spectateurs quelle que soit leur taille d'ecran.
            range: { front: 1100, back: 700 },

            // ── La voie ──────────────────────────────────────────────────
            //
            // Bande de profondeur dans laquelle un objet est tenu pour etant sur
            // la route du kart, donc a surveiller. A ne pas confondre avec le
            // DEGAGEMENT (`hitboxes.itemVsKart.y` + `ai.crossDodgeMargin` = 7),
            // qui dit ou l'objet passe a cote pour de bon.
            //
            // Elle est plus large que le degagement, et elle doit l'etre : le
            // kart comme l'objet bougent en profondeur pendant le temps avant
            // impact, et une esquive doit COMMENCER avant d'etre pile dans
            // l'axe. Un objet traine se suit sur plusieurs secondes a faible
            // vitesse relative ; le resserrer au degagement revient a ne le voir
            // qu'une fois dedans — trop tard pour un kart lourd, qui met plus
            // d'une seconde a couvrir sept unites en croisiere.
            //
            // Elle a valu 7 le temps d'un essai, et les karts sont devenus
            // incapables d'esquiver quoi que ce soit : les carapaces trainees en
            // particulier n'etaient plus vues du tout. Constat a l'ecran. La
            // resserrer est peut-etre juste sur le principe — un objet a 10
            // unites ne peut pas toucher — mais alors il faut ouvrir la fenetre
            // de temps en echange, et ca se mesure au banc.
            //
            // Elle vivait dans `road.laneTolerance` : la piste n'a aucune notion
            // de voie, c'est une distance de perception et sa place est ici.
            threatLane: 12,

            // Periode du balayage. La perception n'a aucune raison de tourner a
            // la cadence de l'affichage : le reflexe le plus court du plateau
            // dure 224 ms (`ai.reactionBaseMs` au bas de son jitter), et un
            // retard de perception cinq fois plus petit ne se voit pas.
            //
            // C'est a la fois l'economie — la phase etant decalee par `kart.id`,
            // un ou deux karts balayent par frame au lieu de huit — et un modele
            // honnete : l'attention a un tic.
            //
            // Le pilotage, lui, reste a la cadence pleine. `steer` est
            // un filtre : le sous-echantillonner ferait trembler le volant.
            scanIntervalMs: 80,

            // ── Ce qui bouche la vue ─────────────────────────────────────
            //
            // Seuls les corps solides masquent : un kart, un bill, un tuyau. Un
            // objet au sol est trop petit pour cacher quoi que ce soit — il
            // ferme un passage, il n'aveugle pas.
            //
            // La vue etant de cote, l'ombre ne s'elargit pas avec la distance :
            // elle occupe la meme tranche de profondeur quel que soit
            // l'eloignement. Masquer revient donc a tester une appartenance a un
            // intervalle, et c'est ce qui rend l'occlusion presque gratuite.
            //
            // `shadowGain` multiplie la demi-profondeur reelle du corps. A 1
            // l'ombre est exactement le gabarit — un kart profond de 5 sur une
            // piste de 30 ne cache presque rien. Monter la valeur rend le
            // masquage franc sans toucher a aucune hitbox : c'est le seul
            // reglage de la force de l'occlusion.
            shadowGain: 2.0,

            // Une rouge traque : elle arrive dans l'axe et par l'arriere, soit
            // exactement le cas ou un kart la precede et la masque. Soumise a
            // l'occlusion comme les autres, elle deviendrait inevitable.
            //
            // Dans le jeu d'origine, c'est le son qui previent. Ici c'est cette
            // exception, et le tirage d'inattention (`ai.dodgeMissChance`) garde
            // sa part de hasard.
            seeHomingThroughCover: true,

            // ── Le coup d'oeil derriere ──────────────────────────────────
            //
            // Regarder derriere coupe la vue de face : c'est une substitution,
            // pas un ajout. Le kart y gagne les menaces qui le rattrapent — une
            // carapace tiree vers l'avant n'arrive jamais autrement — et y perd
            // le trafic devant lui, le temps du coup d'oeil.
            //
            // Les tuyaux echappent a la regle : un pilote connait son circuit.
            // Le coup d'oeil lui retire la perception du TRAFIC, pas la memoire
            // du DECOR. Sans cette exception, un kart s'encastrerait dans un mur
            // parce qu'il regardait ailleurs — spectaculairement bete, et
            // invisible pour le spectateur qui, lui, voit le tuyau.
            glanceIntervalMs: 1400,
            glanceDurationMs: 350,

            // Probabilite de tourner la tete, par place. Le premier n'a que
            // l'arriere a surveiller ; le dernier n'a personne derriere et tout
            // a rattraper devant. Interpole lineairement sur le rang.
            backChanceLeader: 0.55,
            backChanceLast: 0.10,

            // ── Le danger latent ─────────────────────────────────────────
            //
            // Quelqu'un qui PEUT vous atteindre, mais n'a encore rien lance. Deux
            // formes : derriere, un kart qui peut tirer vers l'avant — une
            // carapace, en main ou en orbite ; devant, un kart qui porte de quoi
            // finir derriere lui — verte, banane ou rouge. C'est la meme
            // situation vue des deux bouts : partager sa profondeur avec
            // quelqu'un d'arme.
            //
            // Les deux bouts ne demandent pas la meme chose, et c'est voulu : une
            // banane ne menace que celui qui SUIT son porteur, une carapace en
            // orbite ne menace que celui qui le PRECEDE. Le moteur a un predicat
            // par sens (`isTrailable`, `isArmedForward`) plutot qu'un seul
            // emprunte a la visee, qui laissait l'orbite dans l'ecart.
            //
            // Il ne devient jamais une esquive — il n'y a rien a esquiver — mais
            // il vaut une precaution : se ranger hors de l'axe. Ce qui l'empeche
            // de degenerer en zigzag permanent est la condition d'ALIGNEMENT,
            // posee dans le moteur et non ici : tout le monde porte quelque
            // chose, presque personne n'est pile dans la ligne.
            //
            // Il se percoit comme tout le reste, occlusion comprise : un porteur
            // cache derriere un autre kart ne fait fuir personne.
            //
            // Distance au-dela de laquelle une ligne de tir ne se partage plus.
            // Bornee par `range` du cote regarde — on ne devine pas plus loin
            // qu'on ne voit.
            pressureRange: 700,

            // Vise dans le dos, on regarde derriere plus souvent.
            //
            // Le gain porte sur la CADENCE du coup d'oeil, pas sur sa
            // probabilite. Le temps moyen entre deux coups d'oeil valant
            // `glanceIntervalMs / chance`, les deux formes sont la meme loi —
            // sauf qu'une probabilite sature a 1. A 0.55 de base pour le
            // premier, multiplier la chance par 2.2 donnait 1.21 : le gain
            // tombait dans le vide pour celui qui a le plus de raisons de
            // regarder derriere. En fond de peloton, ou rien ne saturait, les
            // deux formes coincident exactement.
            pressureGlanceGain: 2.2,

            // Duree de vie du releve « quelqu'un d'arme derriere moi ».
            //
            // Ce n'est pas un confort, c'est ce qui rend le gain ci-dessus
            // atteignable. Le tirage du coup d'oeil n'a jamais lieu PENDANT un
            // coup d'oeil : au moment ou il tombe, le dernier balayage regardait
            // forcement devant. Lu sur le balayage courant, le gain repondait
            // donc a un porteur situe DEVANT — l'exact contraire de ce qu'il
            // nomme, et zero chance de se declencher sur le cas pour lequel il
            // est ecrit.
            //
            // A tenir au-dessus de `glanceIntervalMs` (1400), sans quoi le
            // souvenir se perime avant le tirage suivant et le gain redevient
            // inerte. A 2500, une seule observation presse deux ou trois
            // tirages, puis on oublie.
            pressureMemoryMs: 2500,

            // Et on se retourne franchement quand c'est SOI qui prepare un tir
            // vers l'arriere : viser dans le peloton demande de le regarder.
            //
            // C'est ce qui rend le tir arriere jouable pour celui qui le recoit.
            // Sans lui, le tireur se recalait parfaitement sur une cible qu'il ne
            // regardait pas : la carapace partait dans l'axe a tous les coups, et
            // le vise n'avait qu'un reflexe d'esquive pour s'en sortir. Avec lui,
            // il en a deux — le coup d'oeil du tireur lui laisse le temps de se
            // decaler, s'il a pris cette decision.
            //
            // Monter la valeur rend le tireur plus adroit, pas plus rapide : il
            // trouve son moment plus souvent, il ne vise pas mieux.
            //
            // Comme `pressureGlanceGain`, il porte sur la cadence du coup d'oeil
            // et non sur sa probabilite : c'est la meme loi sans le plafond, et
            // les deux gains se composent alors sans se manger l'un l'autre.
            aimGlanceGain: 2.0,

            // Duree de vie du RELEVE : la profondeur vue pendant le coup d'oeil,
            // sur laquelle le tireur se recale ensuite, tourne vers l'avant.
            //
            // Ce n'est pas un delai de confort, c'est la parade. Viser de memoire,
            // c'est viser ou l'autre ETAIT : plus le releve vieillit, plus la
            // cible a eu le temps de bouger. C'est de la que vient la chance du
            // poursuivant, et elle ne coute aucun tirage — celui qui se decale
            // apres avoir ete releve se fait manquer, celui qui tient sa ligne se
            // fait toucher.
            //
            // Le monter rend les tirs arriere plus surs, le baisser rend le
            // decalage de securite plus payant. C'est le meme curseur vu des deux
            // bouts.
            //
            // Il faut aussi que le tireur ait le temps de se recaler apres son
            // coup d'oeil : bien en dessous de `ai.aimLeadMs` (1300), sinon le
            // releve se perime avant qu'il ait fini de viser.
            aimMemoryMs: 900,

            // ── La decision de securite ──────────────────────────────────
            //
            // C'EST LE REGLAGE DU DOSAGE, et il est plus sensible qu'il n'en a
            // l'air. A 1, plus personne ne prend jamais de carapace dans le dos
            // et la moitie du jeu d'objets ne sert plus a rien. A 0, les karts
            // restent colles derriere une verte jusqu'a ce qu'elle parte.
            //
            // `retryMs` est le temps avant de retenter apres un refus : le
            // danger, lui, n'a pas disparu, et un kart qui a laisse passer sa
            // chance doit pouvoir se raviser sans que ce soit immediat.
            //
            // `holdMs` est la duree du decalage. Assez long pour depasser le
            // porteur ou le laisser filer, assez court pour ne pas figer la
            // trajectoire d'un kart dont le danger s'est eloigne tout seul.
            //
            // `speed` est la douceur du geste : bien en dessous de
            // `ai.dodgeIntensityMin`, parce qu'il n'y a pas urgence. C'est ce qui
            // distingue une precaution d'une esquive a l'oeil du spectateur.
            safety: {
                chance: 0.5,
                retryMs: 900,
                holdMs: 2000,
                speed: 14
            },

            // ── Le plan ──────────────────────────────────────────────────
            //
            // Une decision prise ne se defait pas parce que le regard s'est
            // porte ailleurs. Elle tient jusqu'a son echeance, ou jusqu'a ce que
            // le kart CONSTATE que la menace est passee — une absence
            // d'observation ne constate rien.
            //
            // `holdAfterMs` est ce qu'on ajoute au temps avant impact pour poser
            // l'echeance : de quoi laisser l'objet passer pour de bon avant de
            // relacher.
            holdAfterMs: 500,

            // Recalcul de trajectoire. A chaque intervalle, une chance de
            // reprendre le placement avec la perception fraiche : meilleur trou,
            // ligne affinee. Rate, la revision est repoussee d'un intervalle.
            //
            // C'est le seul endroit ou la precision d'un kart se joue apres la
            // decision initiale, et donc le point d'accroche naturel de la
            // future stat `brain`. Commun a tous pour l'instant.
            reviewIntervalMs: 400,
            reviewChance: 0.5,

            // Et le tirage sur cet intervalle. Il ne rend pas les karts
            // meilleurs, il les rend DIFFERENTS : a cadence fixe, huit karts
            // qui voient la meme piste rejouent la meme decision aux memes
            // instants et finissent en file indienne derriere le meme couloir.
            //
            // C'est aussi ce qui simule un cerveau plus ou moins rapide, et
            // c'est donc la que se branchera la future stat de decision — un
            // pilote vif reprend souvent sa ligne et l'affine a mesure qu'il
            // approche, un lent s'engage tot et n'y revient pas.
            //
            // Meme plage pour tous aujourd'hui. A 1 / 1, la cadence redevient
            // fixe : c'est l'interrupteur.
            reviewJitterMin: 0.6, reviewJitterMax: 1.6,

            // ── La table de cout ─────────────────────────────────────────
            //
            // Ce que coute un choc, en millisecondes perdues. C'est la monnaie
            // commune qui remplace l'ordre fige des manoeuvres : entre deux
            // dangers, le plus urgent l'emporte au score `cout / temps restant`.
            //
            // Les valeurs ne sont pas des reglages, elles se lisent ailleurs
            // dans ce fichier :
            //   spin : delays.hitDecelDuration + delays.hitPauseDuration
            //   pipe : pipe.bumpMs + pipe.recoilMs, plus 90 px de recul
            //
            // C'est ce rapport de 1 a 2.4 qui fait qu'un kart accepte de froler
            // un tuyau pour eviter une carapace, et jamais l'inverse.
            //
            // L'arbitrage vaut EN CONTINU, et pas seulement a la decision : une
            // esquive en cours cede au tuyau des que celui-ci devient le plus
            // urgent, puis la reprend. Sans ca la table ne tranchait qu'une fois,
            // et une menace qui reste en vue — une rouge qui traque, par
            // exemple, sa cible tenant sa ligne par construction — repoussait
            // l'echeance de son plan jusqu'a l'impact : le contournement de
            // tuyau ne tournait plus de toute la poursuite.
            // Les deux valeurs neuves ne sont pas des delais lus ailleurs — ni
            // l'une ni l'autre ne pose de pause — mais des equivalents en temps
            // perdu, du meme ordre que ce qu'elles coutent vraiment :
            //
            //   kart : une bousculade. Elle ne stoppe pas, elle deplace. Et le
            //          corps peut s'ecarter tout seul, ce qu'aucun autre ne
            //          fait — d'ou le prix le plus bas des trois corps.
            //   edge : le frottement du mur, qui tire la vitesse a
            //          `physics.wall.speedFactor` (0.72) tant qu'on est dessus.
            //          C'est le prix d'un FROLEMENT — deux ou trois dixiemes de
            //          seconde — et non d'un raclage prolonge : la note s'en
            //          sert pour juger un couloir de bord, ou le kart passe pres
            //          du mur sans s'y coller.
            //
            //          Il a valu 200 (une seconde pleine de raclage), et c'etait
            //          assez pour rendre TOUT couloir de bord inatteignable : le
            //          point de bascule entre les deux cotes d'un tuyau tombait
            //          a y=22.7 pour koopa, or `road.wanderMargin` (8) borne la
            //          ligne naturelle a 22. Aucun kart n'etait jamais assez
            //          haut pour que le couloir etroit gagne, et le trace avait
            //          beau le dessiner, personne ne le prenait. A 80, la
            //          bascule redescend a 20.4-21.1 : dans la bande, donc
            //          jouable, et toujours en faveur du large a mi-piste.
            //
            // L'ordre compte plus que les valeurs exactes : spin > pipe > kart >
            // edge. C'est lui qui dit quel obstacle on accepte de froler pour en
            // eviter un autre, et il se lit d'un coup d'oeil ici.
            cost: { spin: 2000, pipe: 850, kart: 300, edge: 80 },

            // ── Le placement ─────────────────────────────────────────────
            //
            // Ou se mettre en profondeur. Une note en millisecondes, la meme
            // monnaie que `cost` : ce qu'on RISQUE a un endroit, plus ce que
            // coute d'y aller. Cf. `laneRisk` / `chooseLane`.
            place: {
                // Ce que pese un detour face a un risque.
                //
                // A 1, une seconde de braquage vaut une seconde perdue en choc
                // — le kart accepte de traverser la piste pour eviter un
                // tete-a-queue (2000 ms), pas pour eviter un frottement de bord
                // (200 ms). C'est ce qui produit « pas de danger, pas de
                // virage » sans qu'aucune regle ne le dise : sans risque, la
                // note la plus basse est celle de sa propre ligne.
                //
                // Le monter rend les karts casaniers, le baisser les fait
                // zigzaguer pour des gains minuscules. A 0, ils traversent la
                // piste pour un dixieme de risque.
                detour: 1.0,

                // Chance de retenir l'option qu'on vient de regarder.
                //
                // Le kart descend le classement des couloirs et s'arrete a
                // chaque marche avec cette probabilite : il prend donc le
                // meilleur 75 fois sur 100, le deuxieme 19 fois, le troisieme 5.
                // Une erreur reste une option qui existait — jamais une
                // absurdite, jamais un mur.
                //
                // A 1 le kart est parfait : c'est l'interrupteur pour mesurer au
                // banc ce que l'imperfection coute. Meme valeur pour les huit
                // tant qu'aucune stat de pilote n'existe ; le jour ou elle
                // arrive, c'est CE nombre qu'elle module, et lui seul.
                chance: 0.75,

                // Le confort qu'on aimerait garder autour de chaque corps, au
                // dela de sa hitbox. Ce ne sont plus des refus : les entamer
                // coute, en proportion de ce qu'on entame.
                //
                // C'est tout le correctif du couloir serre. Ces marges etaient
                // fondues dans les hitboxes avant d'etre comparees, si bien
                // qu'un passage de 3.1 unites en valait 1.1 et se faisait
                // refuser — le kart ne savait meme pas qu'il y avait un trou.
                // Elles sont maintenant portees a part, et un passage serre
                // reste choisissable quand il est le moins cher de la piste.
                //
                // `item` valait `ai.crossDodgeMargin`, au milieu des reglages
                // d'esquive : c'est un degagement, sa place est avec les autres.
                margin: { pipe: 1.5, item: 2, kart: 1 },

                // L'imprecision d'un kart, en unites de profondeur par unite de
                // volant (cf. `laneSlop`). Elle s'ajoute a la bande morte du
                // braquage et gonfle chaque obstacle d'autant, pour ce kart-la
                // seulement.
                //
                // C'est ce qui distingue « le passage est trop petit » de « le
                // kart est trop imprecis pour ce passage ». Sans elle, la note
                // jugeait les huit karts capables de se poser au dixieme
                // d'unite : un couloir de 3 unites passait pour tous, et les
                // lourds s'y coincaient.
                //
                // A 8, en croisiere : ~0.8 pour koopa, ~1.6 pour bowser. Un
                // couloir de fond de 3.1 unites est donc jouable pour l'un et
                // refuse a l'autre — un passage serre est un passage pour les
                // vifs, et c'est le trace qui decide a qui il s'adresse.
                //
                // A 0, tous les karts se croient chirurgicaux : c'est
                // l'interrupteur, et c'est l'etat d'avant.
                slop: 8,

                // Ce que vaut une boite, en millisecondes gagnees. Seul terme
                // negatif de la note : une occasion, pas un risque.
                //
                // La collecte etait une manoeuvre a part, placee APRES le
                // contournement de tuyau. Des lors que le contournement s'engage
                // tot — ce qu'il fait depuis qu'un tuyau est un mur sur toute la
                // portee du regard — elle n'etait plus jamais atteinte sur un
                // circuit charge. Une occasion ne se classe pas avant ou apres
                // un mur : elle se pese contre lui.
                //
                // A 400, le kart accepte de longer le bord pour une boite (200)
                // et refuse de traverser devant un tuyau (850) ou une carapace
                // (2000) pour elle. C'est l'arbitrage qu'on veut voir, et il ne
                // s'ecrit nulle part : il tombe de l'ordre des couts.
                //
                // A 0, les karts ignorent les boites qui ne sont pas pile sur
                // leur ligne.
                boxBonus: 400,

                // Ce qu'un nouveau couloir doit gagner pour qu'on lache celui
                // qu'on suit, en millisecondes.
                //
                // C'est le prix de l'ENGAGEMENT. Chaque reprise peut renvoyer un
                // couloir different — le trafic bouge, la portee de braquage se
                // raccourcit a mesure qu'on approche, et un tirage sur quatre ne
                // retient pas le meilleur (`chance`). Sans seuil, le kart
                // repartait dans l'autre sens a mi-parcours, ce qui se voit
                // exactement comme un manque d'agilite : il n'etait pas lent, il
                // faisait deux fois la moitie du chemin.
                //
                // 150 ms, soit un cinquieme d'un choc de tuyau : un couloir
                // devenu mauvais perd bien plus que ca et la reprise se fait
                // quand meme. Ce que ce seuil coupe, c'est le changement d'avis
                // a prix nul.
                //
                // A 0, le kart reconsidere tout a chaque reprise.
                commit: 150,

                // Ce que coute d'entamer TOUT le confort d'un corps sans
                // toucher sa limite dure, en fraction de ce que coute le
                // contact.
                //
                // Il valait 1 sans etre ecrit nulle part : la rampe de
                // `laneRisk` montait jusqu'au cout plein. Passer au ras d'un
                // tuyau se notait donc 850 — exactement le prix de le percuter —
                // alors que traverser la piste entiere en coute 600 a un vif et
                // 1900 a un lourd. Un passage serre etait toujours battu par le
                // grand contournement, y compris quand le kart etait DEJA dedans
                // et qu'il n'avait qu'a le tenir. C'est le defaut que le
                // decoupage limite dure / marge de confort devait justement
                // corriger, et la rampe le reintroduisait par la note.
                //
                // Ce n'est pas la meme chose et ca ne doit pas se noter pareil :
                // la limite dure est un fait — `laneRisk` y rend l'infini, un
                // tuyau ne se traverse pas — la marge est un CONFORT, et
                // l'imprecision du kart est deja comptee a part (`slop`).
                //
                // A 0.35, froler un tuyau vaut 300 ms : quatre fois un
                // frottement de bord (80), un tiers du choc. Le kart prend le
                // passage serre quand il est deja pres, et traverse quand la
                // traversee est vraiment moins chere — c'est-a-dire quand il est
                // vif et qu'il a le temps.
                //
                // A 1 on retrouve l'ancien comportement : le contournement
                // systematique. A 0, il rase tout sans jamais preferer l'air
                // libre.
                graze: 0.35,

                // Ce que vaut un deplacement REPORTE face au meme deplacement
                // fait tout de suite.
                //
                // Un mur plus lointain que celui qu'on aborde ne coute pas un
                // choc : il coute d'avoir a en sortir plus tard (cf. la dette
                // dans `laneRisk`). Mais plus tard n'est pas maintenant — ce
                // deplacement se fera sous un horizon plus court, dans un trafic
                // qui aura bouge, et avec une reprise qui peut le rater. Le
                // majorer, c'est dire au kart de preferer, a prix egal, le
                // couloir qui degage AUSSI la suite.
                //
                // A 2, sur l'anneau du Moai : les tuyaux touches passent de 0.26
                // a 0.09 par tour, et de 0.90 a 0.12 pour bowser — l'optimum est
                // un plateau large (1.5 a 2.5) et il se retrouve identique sur
                // des champs de tuyaux tires au hasard, donc il n'est pas taille
                // pour ce trace.
                //
                // A 1 le kart sous-estime ce qu'il doit et s'engage trop : il
                // prend le couloir proche et decouvre trop tard qu'il faut en
                // sortir. Au-dela de 3 il redevient aussi frileux que l'ancien
                // refus, et cesse de prendre la ligne haute.
                debt: 2
            },

            // Menaces deja jugees que le kart garde en tete. Un seul
            // emplacement — ce qu'il y avait — suffit tant qu'une menace en
            // chasse une autre pour de bon ; deux menaces qui alternent en
            // urgence, une banane et une verte, refaisaient alors le tirage de
            // reflexe a chaque bascule. Le kart pouvait redecouvrir sans fin un
            // objet qu'il avait deja decide d'ignorer.
            //
            // Quatre couvrent tout ce qu'un kart croise dans la meme seconde.
            memorySlots: 4,

            // Duree de vie d'un verdict, comptee depuis la DERNIERE fois que la
            // menace a ete vue. Tant qu'elle reste sous les yeux, le verdict
            // tient : ce qui se perime est l'absence, pas l'observation.
            //
            // Sans elle, un verdict etait definitif. Une verte jugee « pas vue »
            // au premier passage le restait ses dix rebonds durant, quelle que
            // soit la geometrie ensuite ; et une menace revenue apres un long
            // detour retrouvait un reflexe deja echu, donc franchi d'avance —
            // elle etait esquivee sans le moindre temps de reaction.
            //
            // Un peu au-dela de `ai.threatWindowMs` (900) plus `holdAfterMs`
            // (500) : de quoi couvrir une menace qui va jusqu'au bout, pas une
            // situation qui s'est refaite entre-temps.
            memoryMs: 1500
        },

        ai: {
            holdItemMin: 500, holdItemMax: 8000,

            // Un objet arrive en main, sans hitbox. Le kart decide ensuite, ou
            // non, de le sortir derriere lui. Le premier le fait presque
            // toujours : n'ayant personne a viser, son objet vaut mieux comme
            // bouclier que dans sa main. Le dernier a l'inverse n'a personne
            // derriere a tenir a distance, un objet pose ne lui sert a rien.
            trailChance: { leader: 0.92, pack: 0.6, last: 0.45 },

            // Duree pendant laquelle l'objet reste pose derriere, en multiple de
            // trailHoldMin/Max. Le premier le garde bien plus longtemps : c'est
            // sa seule protection, et le relacher tot le laisse a nu jusqu'a la
            // boite suivante — soit la moitie d'un tour.
            trailHoldFactor: { leader: 1.8, pack: 1, last: 1 },

            // Probabilite qu'une carapace parte vers l'arriere, par type et par
            // place. Le dernier n'a personne derriere. Le premier est a 1 et le
            // restera : la physique lui interdit de tirer devant lui, ces
            // valeurs ne font que dire la meme chose au meme endroit que les
            // autres.
            shellBackwardChance: {
                greenShell: { leader: 1, pack: 0.2, last: 0.05 },
                redShell: { leader: 1, pack: 0.05, last: 0 }
            },

            // Banane lancee en cloche devant plutot que lachee derriere.
            bananaLobChance: { leader: 0, pack: 0.2, last: 0.7 },
            trailDelayMin: 400, trailDelayMax: 3000,
            trailHoldMin: 1200, trailHoldMax: 6000,

            // Agressivite : un kart mal place joue ses objets plus vite et les
            // garde moins derriere lui. Rang et ecart comptent ensemble, par
            // moyenne geometrique — dernier dans le peloton, ou deuxieme a une
            // demi-piste, ne suffit pas ; il faut les deux. L'etape de course
            // module ensuite le tout : c'est le temps qui reste pour remonter.
            aggression: {
                // Ecart au premier ou le terme distance sature, meme ordre que
                // les paliers d'objets.
                distanceRef: 3000,

                // Part de l'agressivite qui s'exprime au depart. Elle atteint sa
                // pleine valeur au dernier tour, et ne la depasse jamais : etre
                // dernier ne presse a rien tant qu'il reste quatre tours pour
                // revenir.
                startRatio: 0.3,

                // Delais d'attente et probabilite de trainer l'objet, en
                // fraction de leur valeur normale, pour un kart au maximum de
                // son agressivite.
                hurryRatio: 0.35,
                trailRatio: 0.4
            },
            dodgeIntensityMin: 20, dodgeIntensityMax: 50,

            // Perception : le seuil est un temps avant impact, non une distance.
            // Une carapace de face approche a plus du triple de la vitesse d'une
            // banane — a distance egale, le temps pour reagir n'a rien de
            // comparable.
            //
            // Le plafond de distance borne l'anticipation : au-dela, la
            // geometrie aura change avant l'arrivee — la carapace rebondit, le
            // kart se fait bousculer — et s'engager dessus revient a manoeuvrer
            // pour une situation qui n'aura pas lieu.
            //
            // Il ne dit RIEN de ce qui est a l'ecran, et ne le peut pas : le
            // moteur ne connait que des pixels de monde. La largeur visible
            // depend de la fenetre du spectateur (`smk-banner.js`, au rendu
            // seul), elle differe d'un spectateur a l'autre, et la simulation
            // est la meme pour tous. Aucun reglage de perception ne doit s'y
            // adosser, ici ou ailleurs.
            //
            // ATTENTION, les deux se lisent en ET : une menace demande les deux
            // vrais, donc celui qui DECIDE est celui qui devient vrai en
            // dernier. Ca depend entierement de la vitesse de rapprochement, et
            // le partage n'est pas celui qu'on lit.
            //
            //   banane posee devant   ~480 px/s   900 ms = 432 px   -> le TEMPS
            //   verte qui rattrape    ~400 px/s   900 ms = 360 px   -> le TEMPS
            //   verte de face        ~1360 px/s   900 ms = 1224 px  -> la DISTANCE
            //
            // La fenetre de temps ne decide donc de rien pour les carapaces de
            // face — le cas meme qui sert a la justifier deux lignes plus haut.
            // Une verte de face est vue a 900 px, soit ~660 ms avant impact,
            // dont 224 a 378 de reflexe.
            //
            // Et il y a un TROISIEME plafond au-dessus : `vision.range.front`
            // (1100), qui decide de ce qui entre dans le balayage. Pour que la
            // fenetre de temps devienne maitresse sur une verte de face, il
            // faudrait les deux distances au-dela de ~1240 px — monter ce seul
            // plafond a 1100 ne ferait que passer la main a la portee du regard.
            //
            // Une verte de face esquivable par un kart lourd se paie donc en
            // portee de vue, pas en fenetre de temps. C'est un changement
            // d'equilibrage, pas une correction : a passer au banc.
            //
            // Enfin, les trois sortes de menace ne sont pas filtrees pareil, et
            // ca ne se voit qu'en les mettant cote a cote :
            //
            //   objet au sol   temps ET distance   (les deux ci-dessous)
            //   etoile / bill  temps seul          (aucun plafond de distance)
            //   objet traine   distance seule      (`trailThreatDistance`)
            //
            // Chacun se defend a sa ligne — un objet traine avance a la vitesse
            // de son porteur, son temps avant impact ne dit rien ; une etoile se
            // rapproche trop lentement pour que 900 ms portent loin. Mais c'est
            // trois regles, pas une, et rien d'autre ne le dit.
            threatWindowMs: 900,
            threatMaxDistance: 900,

            // Un objet traine avance a la vitesse de son porteur : le temps
            // avant impact ne dit rien d'utile, c'est une distance de vue qu'il
            // faut. Largement au-dela de la hitbox de 40.
            trailThreatDistance: 260,

            // Accule au bord, un kart ne peut plus s'ecarter du bon cote : il
            // leve le pied. Face a un objet traine, ralentir suffit a ne plus le
            // rattraper.
            edgeBrakeFactor: 0.78,
            edgeBrakeMs: 700,

            // Erreur d'appreciation : le kart se croit un peu plus vif, ou un
            // peu moins, qu'il ne l'est. Applique a son volant au moment de
            // choisir ou se mettre, elle se propage donc aux deux choses qui en
            // dependent — jusqu'ou il croit pouvoir aller, et ce qu'il croit que
            // le detour lui coute.
            //
            // Le degagement qui l'accompagnait (`crossDodgeMargin`) vit
            // maintenant dans `vision.place.margin.item`, avec les marges des
            // autres corps.
            crossJudgeError: 0.25,

            // Ce qui ferme un cote, en plus du bord de piste : un tuyau, ou un
            // autre objet pose la. S'ecarter vers eux, c'est troquer la menace
            // contre une autre — et le tuyau est le mauvais cote du marche, une
            // carapace coute deux secondes de tete-a-queue quand un mur en
            // coute six dixiemes plus le recul.
            //
            // Cette distance dit jusqu'ou en avant ils comptent : environ une
            // demi-seconde de course, la duree d'un ecart. Au-dela, l'ecart sera
            // retombe avant que le kart n'arrive a leur hauteur, et fermer un
            // cote pour un tuyau si lointain reviendrait a freiner pour rien.
            //
            // Bien plus court que pipe.seeDistance (1100), et c'est la meme
            // difference qu'entre les deux manoeuvres : un tuyau se contourne en
            // trajectoire, en le voyant venir de loin ; une esquive est un
            // reflexe qui ne regarde que le pas suivant.
            dodgeGuardDistance: 500,

            // Latence de reflexe, tiree au sort a chaque menace.
            reactionBaseMs: 280,
            reactionJitterMin: 0.8, reactionJitterMax: 1.35,

            // Visee : le kart se recale sur sa cible avant de tirer. La hitbox
            // verticale d'un objet valant 5, une erreur de cet ordre suffit a
            // rater.
            //
            // `aimScanDistance` borne la designation de cible dans les deux
            // sens, et elle passe desormais par la vue des deux cotes : on ne
            // vise que ce qu'on voit, occlusion comprise. Celui qui se cache
            // derriere un autre ne se fait donc pas prendre pour cible, devant
            // comme derriere.
            //
            // `vision.range` la borne a son tour : 900 mord devant (portee
            // 1100), mais c'est la portee du regard qui mord derriere (700).
            // Monter cette valeur ne porte donc que sur la visee avant tant que
            // `range.back` reste en dessous.
            aimLeadMs: 1300,
            aimScanDistance: 900,
            aimErrorMax: 3.5,

            // L'inattention n'est plein tarif que pour une esquive tout juste
            // jouable ; au-dela de dodgeEasyRatio fois la marge necessaire, le
            // tirage ne joue plus.
            dodgeMissChance: 0.1,
            dodgeEasyRatio: 2.5,

            overtakeDetectionRange: 120, overtakeMinDistance: 12,
            boxDetectionRange: 400,
            wanderIntervalMin: 2000, wanderIntervalMax: 6000,
            wanderDurationMin: 500, wanderDurationMax: 1500,

            // Ecart vise par une derive de maraude, en profondeur de piste.
            //
            // C'est un ECART et non une vitesse, et le changement n'est pas
            // cosmetique : une vitesse de derive mise a l'echelle de l'agilite
            // faisait vagabonder les legers sur trois fois plus de piste que les
            // lourds. Tout le monde vise maintenant le meme decalage ; les
            // lourds mettent seulement plus longtemps a l'atteindre, et les plus
            // lourds ne l'atteignent pas dans la fenetre de derive. C'est
            // exactement ce qu'on veut voir a l'ecran.
            wanderOffset: 4,

            // ── Les profils de braquage ──────────────────────────────────
            //
            // Un profil par manoeuvre, et c'est deliberement verbeux : ces
            // valeurs etaient auparavant celles du contournement de tuyau,
            // empruntees en silence par l'esquive et par la precaution. Regler
            // le tuyau retouchait donc trois manoeuvres a la fois, sans que rien
            // ne le signale. Elles partagent la loi de pilotage, pas l'urgence.
            //
            //   `speed`     : le plafond de la consigne laterale, avant mise a
            //                 l'echelle du kart (`steerCap`). C'est l'urgence de
            //                 la manoeuvre.
            //   `gain`      : ce que vaut une unite d'ecart restant en vitesse
            //                 laterale. C'est lui qui aplatit la trajectoire en
            //                 fin de course au lieu de la couper net.
            //   `tolerance` : en deca, la cible est consideree tenue et le kart
            //                 arrete de corriger — sinon il tremble autour.
            //   `guard`     : refuse d'envoyer le kart dans ce qu'il a vu.
            //                 L'esquive, le contournement et la precaution ne
            //                 l'ont pas, et c'est voulu : eux traversent
            //                 sciemment, apres avoir juge la place eux-memes.
            steering: {
                // L'esquive et la precaution tirent leur urgence du plan
                // (`plan.intensity`) et non d'ici : une esquive se tire au sort
                // entre `dodgeIntensityMin` et `dodgeIntensityMax`, une
                // precaution vaut `vision.safety.speed`. C'est ce qui les rend
                // reconnaissables a l'oeil.
                dodge:    { gain: 6, tolerance: 0.6, guard: false },
                safety:   { gain: 6, tolerance: 0.6, guard: false },

                // Le contournement de tuyau. C'est la manoeuvre la plus urgente
                // du jeu, et sa vitesse le dit : au-dessus de l'esquive la plus
                // franche (`dodgeIntensityMax`, 50).
                //
                // Rien d'excessif — c'est le seul obstacle CERTAIN du circuit.
                // Une carapace peut manquer sa cible, un kart peut s'ecarter, un
                // tuyau ne fait ni l'un ni l'autre : on arrive dessus. A 45 les
                // karts paraissaient laborieux dans une sequence de tuyaux,
                // faute d'autorite pour rejoindre leur couloir.
                //
                // Elle ne rend personne egal : `steerCap` la met a l'echelle de
                // l'agilite, donc bowser en tire 14 u/s la ou koopa en tire 64.
                // Et depuis que le placement compte l'imprecision propre de
                // chaque kart (`place.slop`), le poids se paie sur le CHOIX du
                // couloir — un lourd renonce aux passages serres — et non plus
                // seulement sur le temps mis a le rejoindre.
                //
                // Note pour l'equilibrage : `deplacement-karts-stats.md` (D-2)
                // proposait au contraire de la BAISSER vers 18, pour que le
                // budget lateral discrimine les karts. Ce reglage-la va dans
                // l'autre sens, et c'est assume — la discrimination passe
                // maintenant par `slop`, qui ne coute pas de fluidite.
                pipe:     { speed: 62, gain: 6, tolerance: 0.6, guard: false },

                // Se recaler sur une cible avant de tirer. Tolerance serree : la
                // hitbox verticale d'un objet vaut 5, viser large revient a ne
                // pas viser.
                aim:      { speed: 12, gain: 6, tolerance: 0.5, guard: true },

                // Sortir de la voie de celui qu'on double.
                overtake: { speed: 10, gain: 6, tolerance: 0.6, guard: true },

                // Aller chercher une boite. La tolerance est celle de l'axe :
                // deja dedans, le kart tient sa ligne au lieu de la corriger.
                box:      { speed: 25, gain: 6, tolerance: 2, guard: true },

                // La derive de confort. Elle n'accomplit rien et ne doit donc
                // jamais presser : c'est la manoeuvre la plus frequente de la
                // course, et la seule qui n'ait aucune decision derriere.
                wander:   { speed: 4, gain: 6, tolerance: 0.6, guard: true },

                // Le retour a sa ligne, une fois l'ecart fini. Tolerance large :
                // rentrer au dixieme pres n'a aucun interet, et la viser
                // relancait une correction a chaque bousculade.
                home:     { speed: 20, gain: 6, tolerance: 1, guard: true },

                // Le bill. Sa vitesse vient de `bill.centerSpeed` : il ne pilote
                // pas, il devie — et `steerCap` le laisse hors de l'agilite
                // comme de l'appui a l'allure, sans quoi un bill lance a pleine
                // vitesse ne pourrait plus contourner le tuyau qu'il vise.
                bill:     { gain: 6, tolerance: 0.2, guard: false }
            }
        },
        // Distance dont un objet doit s'ecarter de son lanceur avant de pouvoir le
    // toucher : protege du lancer, sans immuniser pour autant.
    itemArmDistance: 110,

    hitboxes: {
            // Boite de contact d'une PAIRE de karts : un ecart entre centres,
            // comme toutes les hitboxes du moteur. La physique la lit par
            // `kartHalfExtents()`, qui en rend la moitie pour chaque kart et
            // resomme les deux — detour inutile aujourd'hui, ou tous les karts
            // ont la meme emprise, mais c'est par la que passera une carrosserie
            // plus large pour les lourds sans rien changer au reste.
            kartVsKart: { x: 60, y: 5 },
            itemVsKart: { x: 40, y: 5 },
            // Kart contre pipe. Comme les autres, c'est un ecart entre centres :
            // l'emprise du tuyau (pipe.hitbox) plus la demi-carrosserie. Un kart
            // vaut 60 en x et 5 en profondeur face a un autre kart, d'ou
            // 33.6 + 30 et 2.8 + 2.5.
            //
            // Seule la part du tuyau a ete reduite de 20 % : le kart, lui, n'a
            // pas maigri. Rogner les deux aurait fait passer les karts dans des
            // trous ou ils ne tiennent pas.
            kartVsPipe: { x: 63.6, y: 5.3 },
            // itemVsKart.y elargi de radiusY : l'objet oscille en profondeur avec
            // son orbite, ce supplement lui rend la meme tolerance effective qu'un
            // objet pose (5) pour une victime qui roule sur la meme voie.
            orbitItemVsKart: { x: 40, y: 8 },
            itemBox: { x: 10, y: 8 }
        },

        // Deroulement d'une course. Durees en millisecondes, distances en
        // unites monde.
        // Grand prix : les courses s'enchainent par blocs de `races`, chacune
        // rapportant les points de `points` selon la place a l'arrivee. Le bloc
        // fini, les scores repartent de zero et la grille est tiree au sort.
        grandPrix: {
            races: 4,
            // Indexe par place d'arrivee, du premier au dernier. Une place
            // au-dela de ce tableau ne rapporte rien : allonger la liste suffit
            // pour un plateau plus grand.
            points: [10, 8, 6, 5, 4, 3, 2, 1]
        },

        race: {
            laps: 5,

            // Duree totale du decompte = countdownHoldMs + 2 * lightIntervalMs.
            countdownHoldMs: 3000,
            lightIntervalMs: 1500,

            // Le client masque Lakitu des que la ligne sort de sa fenetre, dont
            // il est seul a connaitre la largeur. Ce delai n'est qu'un
            // garde-fou : sans lui, le feu vert reparaitrait a chaque passage
            // de la ligne, toutes les quinze secondes.
            goSignMs: 5000,

            // Lakitu etant ancre sur la ligne, le panneau n'est vu que si la
            // camera passe devant pendant ce delai.
            finalSignMs: 6000,

            // La course s'arrete des que ce nombre de karts a franchi la ligne :
            // les retardataires sont classes d'office dans l'ordre ou ils
            // roulent. Attendre le dernier ne montrait qu'un kart seul en piste.
            stopAtFinisher: 7,

            // Duree du tableau des scores : la premiere valeur entre deux
            // courses, la seconde apres la derniere du grand prix, ou il faut
            // le temps de lire le classement general. L'animation du tableau
            // (arrivee -> compteur -> remaniement, cf smk-banner.js) prend
            // deja plus de 5s a elle seule, d'ou la marge laissee ici pour
            // encore admirer le resultat une fois pose.
            resultsDelayMs: 10000,
            finalResultsDelayMs: 20000,

            // Au-dela, les karts encore en piste sont classes d'office.
            maxRaceMs: 180000,

            // Deux lignes paralleles filant en diagonale : `lanes` donne leur
            // profondeur de depart, `laneSlope` ce que chaque rang y ajoute.
            //
            // Profondeur totale = backOffset + 3 * rowGap + colStagger. A tenir
            // avec parkStartOffset dans les ~600 unites visibles d'un
            // telephone, sinon le fond de grille sort du cadre.
            grid: {
                backOffset: 120,
                rowGap: 155,
                colStagger: 80,
                lanes: [0.13, 0.66],
                laneSlope: 0.045
            },

            // Le reste des tirages est un depart rate.
            startTurboChance: 0.8,
            startNormalChance: 0.1,
            turboBoostMs: 1200,
            failStallMs: 1000,

            finishedSpeedRatio: 0.6,

            // Ecart a la ligne de la camera garee. Elle designe le centre de la
            // vue : negatif place la ligne a droite du centre, positif a gauche.
            parkStartOffset: 0,
            parkFinishOffset: -150,

            // Le drapeau a damier sort bien plus tard que le repositionnement de
            // la camera : Lakitu ne se penche qu'a l'approche reelle du premier,
            // soit environ trois secondes avant son passage.
            flagDistance: 1400,

            // La camera n'accelere jamais : elle ne fait que ralentir pour se
            // garer pile quand le leader franchit la ligne, puis s'y bloque.
            //
            // C'est ce qui impose d'ouvrir l'approche deux tours avant la fin :
            // au pire elle doit couvrir un tour complet, et a sa vitesse normale
            // il lui faut le temps que met le leader a parcourir ces deux tours.
            //
            // La distance d'approche elle-meme n'est donc pas un reglage mais un
            // calcul : deux tours du circuit en cours, plus cette marge. C'est
            // `applyTrack` qui la pose, une fois la longueur du tour connue —
            // sans quoi chaque nouveau dessin demanderait de la recalculer a la
            // main, et le jour ou on l'oublierait la camera raterait la ligne.
            // Sur l'anneau d'origine : 2 * 7680 + 40 = 15400, la valeur qui a
            // toujours tourne.
            cameraApproachMargin: 40,
            cameraMinSpeedRatio: 0.35,
            cameraMaxCatchupRatio: 1
        },

        // Cadence d'animation des carapaces, en ms par frame. Lu par la physique :
        // c'est elle qui fait avancer `currentFrame`, le client ne fait que
        // afficher la frame courante.
        itemAnim: {
            greenShell: { animSpeed: 100 },
            redShell: { animSpeed: 100 },
            blueShell: { animSpeed: 90 },
            bill: { animSpeed: 70 }
        }
    };
});
