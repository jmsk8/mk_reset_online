// Le pilotage : ce qui fait avancer un kart et ce qui l'en empeche. Vitesses,
// elan, appui en virage, bord de piste, contact entre karts.

export default {
    physics: {
        // La LOI de braquage : ce qui vaut pour tout kart qui tourne. Les
        // manoeuvres se decrivent dans `ai.steering` — elles disent une urgence,
        // pas une physique.
        //
        // Une manoeuvre laterale est toujours une PROFONDEUR A REJOINDRE. La
        // situation dit ou aller, pareil pour les huit karts ; ce qui les separe
        // est le TEMPS qu'ils mettent a y arriver.
        steer: {
            // Reponse du volant : vitesse a laquelle `vy` rejoint la consigne
            // laterale, en 1/s. Se lit comme un delai — `1 / response`, soit 200
            // ms a 5.
            //
            // Commune a tout le plateau, et elle doit le rester : le REFLEXE ne
            // depend pas du kart, seuls ses moyens d'y repondre. Le temps de
            // reaction se regle a cote, dans `ai.reactionBaseMs`.
            response: 5,

            // Un kart lance tourne moins bien qu'un kart au ralenti. `drag` est
            // ce qu'on perd de volant a pleine pointe, `curve` la forme de la
            // perte, `bite` l'allure a partir de laquelle le volant mord
            // entierement. A `drag: 0`, la mecanique disparait.
            //
            // L'allure est rapportee a la POINTE DU KART, comme dans `contact` :
            // un poids plume n'est pas avantage d'avoir une pointe plus basse.
            //
            // `bite` corrige le bas de l'echelle. Sans lui la perte vaut 0 a
            // l'arret, donc un kart IMMOBILE disposait de son volant MAXIMUM : il
            // repartait en crabe apres un tete-a-queue. On ne change pas de
            // direction sans avancer.
            pace: { drag: 0.35, curve: 1.0, bite: 0.5 },

            // LE NOMBRE A BOUGER pour rendre les objets de vitesse plus ou moins
            // joueurs : multiplicateur du volant tant qu'un champignon ou une
            // etoile dure. A 1, ils ne changent rien.
            //
            // Sans lui, l'appui perdu a l'allure (`pace`) faisait du champignon
            // le seul objet qui degradait le pilotage de celui qui le prenait. Le
            // bill n'est pas concerne, il ne pilote pas.
            boostGain: 1.15,

            // Tourner coute de la vitesse. Le poids l'alourdit, le handling et la
            // puissance l'allegent (`stats.cornering`), et l'allure decide du
            // tarif. `cost: 0` desactive tout.
            //
            //     `cost` la perte a plein braquage, a pleine vitesse, pour un
            //                `cornering` de 1. L'effet est LINEAIRE.
            //     `fullLock` ce qui compte pour un plein braquage : la consigne
            //                laterale la plus forte que le pilotage puisse
            //                demander. A tenir avec `ai.dodgeIntensityMax`, sans
            //                quoi `cost` cesse de se lire en pourcentage.
            //     `maxLoss` garde-fou, et rien d'autre : la manoeuvre la plus
            //                violente du pilotage ne monte qu'a 0.67 de plein
            //                braquage.
            //
            // NE PAS LIRE `cost` COMME LE COUT D'UNE MANOEUVRE : c'est un
            // coefficient defini au plein braquage, etat que le pilotage atteint
            // rarement. Ce que ca coute vraiment se mesure — colonne `virage` du
            // banc.
            //
            // Sur une ligne tenue, zero pour tout le monde : le cout ne tombe que
            // pendant les TRANSITIONS. La ligne optimale devient « choisir tot,
            // et tenir ».
            //
            // PIEGE si l'on retouche la formule : `vy` porte DEJA l'agilite du
            // kart. `steerCost` divise par ce que `steerCap` rend pour une
            // consigne de 1, ce qui retire tous les facteurs d'un coup — seule
            // forme qui reste juste si un facteur s'ajoute un jour.
            corner: { cost: 0.018, fullLock: 50, maxLoss: 0.30 }
        },

        // Un mur glissant : infranchissable, sans rebond ni arret. Le kart garde
        // son cap et y perd de la vitesse en raclant — a ne pas confondre avec le
        // tuyau (`pipe`), qui arrete net et fait reculer.
        //
        // Le frottement se declenche sur la seule PRESENCE au bord : celui qu'on
        // y pousse et celui qui s'y colle pour esquiver paient pareil. Rien ici
        // pour les objets, qui gardent leur rebond.
        wall: {
            // Ce que le mur coute, et le seul chiffre a bouger : la vitesse vers
            // laquelle il tire, en fraction de la pointe du kart. Ses voisins,
            // pour se situer — frein de bord de l'IA 0.78, rapetissement 0.50.
            // Racler est plus cher que lever le pied, moins cher que se faire
            // ecraser.
            //
            // Le plancher n'est jamais tout a fait atteint : la relance pousse en
            // sens inverse pendant qu'on frotte. Un lourd, qui relance moins
            // bien, y descend un peu plus bas.
            speedFactor: 0.72,

            // Vitesse a laquelle le frottement mord, en 1/s ; le plafond du malus
            // reste `speedFactor`. 8 vaut une constante de temps de 125 ms. Le
            // baisser rend le mur pardonnable en le touchant du bout de l'aile.
            grip: 8
        },

        // Un contact est un choc, et il se lit sur trois questions.
        //
        //     1. PAR OU ? La boite est tres allongee (60 x 5). L'axe du choc est
        //        celui ou le chevauchement est le plus faible UNE FOIS RAPPORTE a
        //        la demi-boite : c'est ce rapport, et lui seul, qui separe le
        //        coup d'epaule (normale en Y) du tamponnement (normale en X).
        //     2. A QUELLE VITESSE ? L'impulsion vaut la vitesse de rapprochement le
        //        long de cette normale, pas une constante.
        //     3. QUI CEDE ? La masse, de deux facons : elle repartit l'impulsion et
        //        decide de la part de braquage perdue (`steerDeny`). C'est le
        //        second point qui fait qu'un lourd force le passage sur un leger.
        //
        // Les vitesses de choc vivent dans `bumpVy` / `bumpVx`, separees de `vy`
        // : ecrire dans `vy` faisait absorber le choc par le volant en 200 ms,
        // avant meme que les karts se soient decolles.
        contact: {
            // Passes de resolution par tick. Une seule laisse les paquets de
            // trois karts en chevauchement ; au-dela de deux, le gain est
            // invisible.
            iterations: 2,

            // Chevauchement tolere avant de corriger la position, par axe. Sans
            // cette marge, deux karts cote a cote se repoussent d'un cheveu a
            // chaque tick et vibrent.
            slopX: 2,
            slopY: 0.2,

            // Vitesse de resorption du chevauchement, en 1/s ; meme forme que
            // `steer.response`. La monter decolle les karts d'un coup — on
            // retombe sur la teleportation d'avant ; la baisser les laisse se
            // traverser. En 1/s et non en fraction par pas, pour ne pas accrocher
            // le comportement a `TICK_HZ`.
            separationRate: 12,

            // Un contact est un COUP, pas un appui : une impulsion ne part que si
            // les deux karts se RAPPROCHENT encore. Sans cette porte, deux karts
            // colles se raclaient l'un contre l'autre pendant des secondes ; avec
            // elle, le choc part une fois, fort, et c'est fini.
            //
            // Force d'un choc, sans unite : `ejectBase` a l'accrochage le plus
            // lent, plus la vitesse de rapprochement.
            ejectBase: 1.0,

            // Ce que rend la vitesse de rapprochement, en plus du plancher. A 0
            // tout contact ejecte pareil ; au-dela de 1 un tamponnement rend plus
            // qu'il n'a pris.
            restitution: 0.6,

            // Ce que vaut une ejection de force 1, par axe et dans l'unite de
            // l'axe : px/s le long de la piste, profondeur/s en travers. Separes
            // parce que les axes n'ont ni la meme unite ni la meme echelle. C'est
            // ici qu'on dose « ca ejecte assez fort » — mais monter l'un sans les
            // plafonds plus bas ne se voit pas.
            ejectX: 135,
            ejectY: 27,

            // Plafond de la force d'un choc. Sans lui, un bill lance dans un kart
            // a l'arret ejecterait proportionnellement a l'ecart de vitesse, sans
            // borne.
            maxEject: 4,

            // Part du braquage perdue par le kart le plus leger, a masse egale ;
            // la repartition passe ensuite par les masses. Contrairement a
            // l'ejection il s'applique a CHAQUE tick du contact : ce n'est pas
            // une poussee mais un refus d'appui, il ne peut donc pas coller les
            // karts entre eux.
            //
            // C'est le reglage du « il force le passage ». A 1, le leger colle a
            // l'adversaire ne peut plus esquiver tant que le contact dure.
            steerDeny: 0.7,

            // Plafonds des deux canaux. Distincts de `maxEject`, qui ne borne
            // qu'un seul coup : deux chocs rapproches s'ajoutent dans le meme
            // canal. Ce qu'ils autorisent se lit en distance et non en vitesse —
            // un choc dure `decay` (180 ms), donc le kart parcourt un cinquieme
            // de la valeur. Reperes : une pointe vaut 450 a 560 px/s, un ecart
            // d'esquive 5 a 85 de profondeur par seconde.
            maxBumpX: 210,
            maxBumpY: 45,

            // Amortissement des deux canaux de choc, en 1/s : 5.5 vaut 180 ms.
            // Court, et c'est voulu — une ejection doit claquer puis retomber,
            // sinon elle ressemble a la poussee continue qu'elle remplace.
            decay: 5.5,

            // Ce qu'un kart oppose a un choc n'est pas sa masse mais son inertie
            // : `masse ^ massBias * allure ^ speedBias`, l'allure etant sa
            // vitesse du moment rapportee a sa propre pointe. Deux exposants pour
            // deux questions independantes.

            // Ce que le poids pese dans un contact, en exposant sur la masse.
            // Meme forme que `massDragAccel` : le pivot est la masse 1, donc les
            // lourds gagnent exactement ce que les legers perdent, et un plateau
            // de masses egales reste a 50/50.
            //
            // A 1 l'axe poids ne rend que 1.45 entre bowser et koopa ; a 2 le
            // leger encaisse 2.1 fois ce que prend le lourd. Ca deplace qui part
            // le plus loin, qui garde son volant (`steerDeny`), et qui cede le
            // terrain a la separation.
            //
            // Seul levier a poids des contacts : la masse continue de servir a
            // l'acceleration et a la maniabilite sans etre touchee.
            massBias: 2.0,

            // Ce que l'allure pese, meme forme : un exposant qui pivote autour de
            // l'allure 1, soit un kart lance a sa propre pointe. A 0 le contact
            // redevient purement au gabarit ; a 1 l'inertie vaut exactement
            // `masse * vitesse`, ce que la physique lui donne. Au-dela, le boost
            // devient un jeu a lui seul — a 2, un poids plume sous champignon
            // domine un poids lourd lance.
            speedBias: 1.0,

            // Garde-fou, pas un reglage : il ne doit jamais mordre sur une
            // situation normale. Le plancher empeche qu'un recul de tuyau inverse
            // le partage et qu'un kart a l'arret devienne un fantome. Le plafond
            // couvre le bill, seul a depasser sa propre pointe de plus de moitie.
            speedClamp: { min: 0.55, max: 1.80 },

            // Ce que pese un bill, en multiples de la masse du kart sous la
            // carapace. Se lit comme un RAPPORT : a 60 il encaisse un soixantieme
            // de ce qu'il inflige, donc rien de ce qu'il percute ne le devie.
            //
            // Multiplicateur et non terme de `massBias` : un bill n'est pas un
            // kart lourd mais un projectile, et son immunite ne doit pas bouger
            // quand on rejoue l'ecart de poids du plateau. Entre deux bills le
            // facteur s'annule — un bill reste la seule chose qui devie un bill.
            billMassFactor: 60,

            // Un kart en tete-a-queue ne pilote plus, il encaisse — mais il n'est
            // pas un fantome pour autant. Au-dessus de 1, il fait plus obstacle
            // qu'il ne se fait pousser : une carcasse en travers de la piste.
            spinMassFactor: 1.2
        }
    },

    speeds: {
        roadPPS: 250,

        // La croisiere n'est pas la pointe : un kart hors objet vise `topSpeed *
        // (momentumMinRatio + (1 - momentumMinRatio) * momentum)`, ou `momentum`
        // est retire toutes les `momentumDrift*` ms dans uniform(`momentumFloor`,
        // 1) et rejoint a `momentumChangeSpeed`.
        //
        // Aucune statistique n'entre dans cette loi : les huit croisent au meme
        // pourcentage de leur pointe. Ce qui se regle ici est de combien le
        // rythme respire.
        momentumMinRatio: 0.78,

        // LA LARGEUR DE LA BANDE, par le bas : la croisiere va de `minRatio + (1
        // - minRatio) * base` a 100 % de la pointe.
        //
        //       base bande bruit / course chevauchement
        //       0.44 87.7-100 % 4.6 px/s 39 px/s
        //       0.70 93.4-100 % 2.5 px/s 9 px/s ← livre
        //       0.78 95.2-100 % 1.8 px/s aucun
        //
        // Le plateau entier tient dans 5.1 % de pointe : une bande plus large
        // couvre les fiches d'un bruit plus large qu'elles.
        //
        // 0.78 EST LA LIMITE A NE PAS FRANCHIR. Au-dela, le pire moment de bowser
        // reste plus rapide que le meilleur de koopa : plus aucun depassement ne
        // peut naitre de la croisiere, et le peloton devient une procession.
        //
        // `weightGain` releve ce plancher a proportion du poids. A 0 il ne fait
        // rien, et c'est voulu. Il ne sait que RELEVER, et les reprises apres
        // incident ne le lisent pas.
        momentumFloor: { base: 0.70, weightGain: 0 },
        momentumChangeSpeed: 0.25,
        momentumDriftMin: 3000,
        momentumDriftMax: 7000,
        accelerationRate: 150,

        projectileSpeed: 880,
        redShellSpeed: 840,
        redShellTrackingSpeed: 8,
        // Choix de cible de la rouge. Ces trois valeurs decrivent une pente et
        // non un seuil ; le classement se fait dans `redShellTargetScore`.
        //
        // Plancher dur : en dessous, viser est sans effet, l'objet ne s'arme qu'a
        // `itemArmDistance` (110) du tireur. La marge couvre le cas ou la cible
        // freine et vient au-devant de la carapace avant qu'elle soit armee.
        redShellMinTarget: 150,

        // Au-dela, la rouge a tout le temps de se recaler et le candidat vaut son
        // ecart brut ; entre le plancher et ce confort il reste eligible mais
        // penalise. Ce n'est pas la portee de la rouge, qui est infinie.
        redShellComfortTarget: 340,

        // Ce que coute au maximum d'etre au contact, en unites de distance
        // ajoutees a la note. Le monter fait preferer les cibles lointaines, le
        // baisser fait viser au plus pres a tout prix.
        redShellClosePenalty: 260,

        // Champignon, etoile et bill partagent un seul modele. Chacun repond a
        // deux questions :
        //
        //   POINTE  `multiplier`, en multiple de la pointe DU KART : un objet
        //           donne a chacun la sienne, majoree d'autant. Les persos
        //           gardent leur ordre sous objet, et `topSpeed` reste le seul
        //           endroit ou se decide qui est rapide.
        //   MONTEE  `ramp`, en multiples de la relance normale : le kart monte a
        //           `accelerationRate * acceleration * ramp` px/s². C'est la
        //           seule difference entre un leger et un lourd sous le meme
        //           objet, et elle ne joue que sur la montee.
        //
        // Ordres de grandeur depuis la croisiere, du plus vif au plus lourd :
        // champignon 240-390 ms, etoile 75-120 ms, bill 90-145 ms.
        boosts: {
            // Le seul dont la montee se voit : elle mange un cinquieme de sa
            // duree. `durationMs` sert aussi au turbo de depart
            // (`race.turboBoostMs` en fixe la duree, la pointe et la montee
            // viennent d'ici).
            shroom: { multiplier: 1.50, durationMs: 1500, ramp: 10 },

            // Duree fixe, quel que soit le rang. Pointe en dessous de celle du
            // champignon : l'etoile s'achete en duree et en invincibilite, pas en
            // vitesse.
            star: { multiplier: 1.40, durationMs: 6000, ramp: 16 },

            // A garder au-dessus de l'etoile, sinon le bill se fait rattraper par
            // ce qu'il double. Sa duree de vol se negocie au fil des
            // depassements, cf. `bill`.
            bill: { multiplier: 1.65, ramp: 20 }
        },

        // Banane lancee en cloche. La hauteur est un decalage de rendu en pixels,
        // sans effet sur la profondeur de piste.
        bananaLobDistance: 900,
        bananaLobDurationMs: 850,
        bananaLobHeight: 105,
        // Forme de l'arc. En dessous de 1, le sommet arrive plus tot et le depart
        // est plus vertical.
        bananaLobRise: 0.62,

        shellVertical: 1.5
    },

    offsets: {
        // Lu par la physique. Valeurs uniques (PC = mobile) pour des collisions
        // reproductibles quel que soit l'appareil.
        world: {
            // Ou se tient un objet TRAINE, en ecart au centre du porteur. C'est
            // une position du monde et non un reglage de dessin : le moteur y
            // teste l'emprise de l'objet, y largue la banane lachee, et le client
            // lit la valeur dans le `hello`.
            //
            // C'est la moitie du plus gros trainable qui fixe ce recul : a -70,
            // une carapace (48 dessine) ne mord plus que de 4 sur le pare-chocs.
            // Consequence assumee, le bouclier recule d'autant — sa fenetre
            // s'arrete au ras de l'emprise du porteur au lieu de finir dans son
            // corps.
            heldItemBehind: -70,
            shellSpawn: 50
        },
    },

    delays: {
        hitDecelDuration: 1500,
        hitPauseDuration: 500,
        boxRespawn: 1000,
        itemGrant: 3000,
        bananaLife: 40000,
        // Sursis entre le contact et la disparition : le sprite s'effacait avant
        // qu'on ait vu le choc. Sans danger pendant ce delai.
        itemLingerMs: 80,
        invincibilityAfterHit: 3000,
        throwDelayAfterHit: 1000,
        spawnMin: 150,
        spawnMax: 800
    },
};
