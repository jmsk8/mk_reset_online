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
            massDragAccel: 1.25,

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
            speedPerWeight: 20,
            speedPerPower: 12,

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
            laneTolerance: 12,
            edgeSafetyMargin: 2,
            overtakeMargin: 5,
            wanderMargin: 8
        },
        physics: {
            // Reponse du volant : vitesse a laquelle `vy` rejoint la consigne
            // laterale, en 1/s. Commune a tout le plateau — c'est le point du
            // systeme de maniabilite : un personnage se decale plus ou moins
            // loin qu'un autre, jamais plus ou moins tot.
            //
            // Se lit comme un delai : la constante de temps vaut `1 /
            // steerResponse`, soit 200 ms a 5. Monter la valeur rend le volant
            // sec et les esquives plus faciles pour tout le monde ; la baisser
            // donne des karts qui s'inscrivent en douceur et ratent plus.
            //
            // Le temps de reaction, lui, se regle a cote : `ai.reactionBaseMs`
            // et son jitter.
            steerResponse: 5,

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
            // ecrire dans `vy` faisait absorber le choc par `applySteering` en
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
                // que `steerResponse` : la part corrigee sur un pas vaut
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

            momentumMinRatio: 0.78,
            momentumFloor: { base: 0.44, weightGain: 0 },
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

            returnLane: 20,
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
            // Reduite de 20 % depuis la premiere version (42 / 5.5) : le tuyau
            // etait presque aussi large qu'un kart, et deux d'entre eux ne
            // laissaient plus de porte praticable. La taille dessinee suit dans
            // GAME_CONFIG.visuals.pipe, qui vaut exactement 2 * x.
            hitbox: { x: 33.6, y: 4.4 },

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

            // Distance a laquelle l'IA commence a voir un pipe. Plus loin que
            // `ai.threatMaxDistance` (900) : un objet s'esquive au reflexe, un
            // mur se contourne, et il faut voir venir.
            seeDistance: 1100,

            // Contournement. Le kart choisit un couloir et le rejoint a une
            // vitesse proportionnelle a l'ecart restant : `laneSeekGain`
            // convertit cet ecart en vitesse laterale, `laneSeekSpeed` la
            // plafonne.
            //
            // C'est ce qui donne une diagonale franche qui s'aplatit en
            // arrivant. Une poussee constante — ce que fait l'esquive d'un objet
            // — depasse le couloir puis corrige, et le kart parait hesiter.
            laneSeekGain: 6,
            laneSeekSpeed: 45,

            // En deca de cet ecart, le couloir est considere tenu : le kart
            // arrete de corriger au lieu de trembler autour de sa cible.
            laneTolerance: 0.6,

            // Deux couloirs de largeurs proches a moins que ca se valent : c'est
            // alors le plus proche du kart qui l'emporte. Sans cette marge, un
            // tuyau au milieu enverrait les huit karts du meme cote, celui que
            // l'arithmetique designe au dixieme pres.
            laneTieMargin: 1.5,

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
            // Un circuit qui n'en laisse pas autant est refuse au chargement :
            // un mur de pipes rendrait la course infinissable sans qu'aucune
            // erreur ne soit levee — les karts se cogneraient jusqu'au delai
            // maximum, et le classement d'office ne dirait pas pourquoi.
            minPassageY: 6
        },

        // Objets qu'un kart peut trainer derriere lui.
        trailableItems: ['banana', 'greenShell', 'redShell'],

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
            // comparable. Le plafond evite de s'ecarter d'un objet hors ecran.
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

            // Traversee du mauvais cote : degagement a prendre au-dela de la
            // hitbox, et erreur d'appreciation du temps disponible.
            crossDodgeMargin: 2,
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
            aimLeadMs: 1300,
            aimScanDistance: 900,
            aimErrorMax: 3.5,
            aimSpeed: 12,

            // L'inattention n'est plein tarif que pour une esquive tout juste
            // jouable ; au-dela de dodgeEasyRatio fois la marge necessaire, le
            // tirage ne joue plus.
            dodgeMissChance: 0.1,
            dodgeEasyRatio: 2.5,

            overtakeDetectionRange: 120, overtakeMinDistance: 12, overtakeSideSpeed: 10,
            // Ecart en deca duquel la boite est consideree dans l'axe : le kart
            // tient sa ligne au lieu de la corriger.
            boxDetectionRange: 400, boxSeekIntensity: 25, boxAlignTolerance: 2,
            wanderIntervalMin: 2000, wanderIntervalMax: 6000,
            wanderDurationMin: 500, wanderDurationMax: 1500, wanderSpeed: 4
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
            // 33.6 + 30 et 4.4 + 2.5.
            //
            // Seule la part du tuyau a ete reduite de 20 % : le kart, lui, n'a
            // pas maigri. Rogner les deux aurait fait passer les karts dans des
            // trous ou ils ne tiennent pas.
            kartVsPipe: { x: 63.6, y: 6.9 },
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
