// Le pilote : ses plans, ses reflexes, son bouclier, ses profils de braquage.

export default {
    ai: {
        holdItemMin: 500, holdItemMax: 8000,

        // Un objet arrive en main, sans hitbox. Le kart decide ensuite, ou non,
        // de le sortir derriere lui. Le premier le fait presque toujours :
        // n'ayant personne a viser, son objet vaut mieux comme bouclier que dans
        // sa main. Le dernier a l'inverse n'a personne derriere a tenir a
        // distance, un objet pose ne lui sert a rien.
        trailChance: { leader: 0.92, pack: 0.6, last: 0.45 },

        // Ce que devient un objet trainable quand un danger apparait DERRIERE,
        // apres que le plan de tir a ete fait. Le plan d'origine se prend a la
        // prise de l'objet, quand le kart ne sait rien de ce qui va le suivre ;
        // ceci le lui fait reconsiderer une fois, et une seule, par episode de
        // danger (cf. `updateShield`).
        //
        //   shot       une carapace deja lancee. Le bouclier est la seule chose
        //              qui la mange, il n'y a plus le temps d'autre chose.
        //   carrier    quelqu'un qui en porte une : reste la possibilite de le
        //              prendre de vitesse, donc un vrai choix.
        //   backThrow  s'il s'en sert plutot que de s'en couvrir, la part qui
        //              part vers le danger.
        //   panic      etoile ou bill ne se trainent pas, ils rendent
        //              intouchable — la meilleure reponse a une rouge. Part des
        //              cas ou le kart avance sa date de declenchement au simple
        //              temps de reaction ; il ne la recule jamais.
        shield: { shot: 0.98, carrier: 0.90, backThrow: 0.60, panic: 0.80 },

        // Duree pendant laquelle l'objet reste pose derriere, en multiple de
        // trailHoldMin/Max. Le premier le garde bien plus longtemps : c'est sa
        // seule protection, et le relacher tot le laisse a nu jusqu'a la boite
        // suivante — soit la moitie d'un tour.
        trailHoldFactor: { leader: 1.8, pack: 1, last: 1 },

        // Probabilite qu'une carapace parte vers l'arriere, par type et par
        // place. Le dernier n'a personne derriere. Le premier est a 1 et le
        // restera : la physique lui interdit de tirer devant lui, ces valeurs ne
        // font que dire la meme chose au meme endroit que les autres.
        shellBackwardChance: {
            greenShell: { leader: 1, pack: 0.2, last: 0.05 },
            redShell: { leader: 1, pack: 0.05, last: 0 }
        },

        // Banane lancee en cloche devant plutot que lachee derriere.
        bananaLobChance: { leader: 0, pack: 0.2, last: 0.7 },
        trailDelayMin: 400, trailDelayMax: 3000,
        trailHoldMin: 1200, trailHoldMax: 6000,

        // Agressivite : un kart mal place joue ses objets plus vite et les garde
        // moins derriere lui. Rang et ecart comptent ensemble, par moyenne
        // geometrique — dernier dans le peloton, ou deuxieme a une demi-piste, ne
        // suffit pas ; il faut les deux. L'etape de course module ensuite le tout
        // : c'est le temps qui reste pour remonter.
        aggression: {
            // Ecart au premier ou le terme distance sature, meme ordre que les
            // paliers d'objets.
            distanceRef: 3000,

            // Part de l'agressivite qui s'exprime au depart. Elle atteint sa
            // pleine valeur au dernier tour, et ne la depasse jamais : etre
            // dernier ne presse a rien tant qu'il reste quatre tours pour
            // revenir.
            startRatio: 0.3,

            // Delais d'attente et probabilite de trainer l'objet, en fraction de
            // leur valeur normale, pour un kart au maximum de son agressivite.
            hurryRatio: 0.35,
            trailRatio: 0.4
        },
        dodgeIntensityMin: 20, dodgeIntensityMax: 50,

        // Perception : le seuil est un TEMPS avant impact et non une distance —
        // une carapace de face approche a plus du triple de la vitesse d'une
        // banane. Le plafond de distance borne l'anticipation : au-dela, la
        // geometrie aura change avant l'arrivee.
        //
        // Rien ici ne dit quoi que ce soit de ce qui est a l'ecran, et ne le peut
        // pas : le moteur ne connait que des px de monde, la largeur visible
        // depend de la fenetre du spectateur, et la simulation est la meme pour
        // tous.
        //
        // LES DEUX SE LISENT EN ET, donc celui qui decide est celui qui devient
        // vrai en dernier — ce qui depend entierement de la vitesse de
        // rapprochement :
        //
        //     banane posee devant ~480 px/s 900 ms = 432 px -> le TEMPS
        //     verte qui rattrape ~400 px/s 900 ms = 360 px -> le TEMPS
        //     verte de face ~1360 px/s 900 ms = 1224 px -> la DISTANCE
        //
        // Et `vision.range.front` plafonne au-dessus des deux. Rendre une verte
        // de face esquivable par un lourd se paie donc en portee de vue, pas en
        // fenetre de temps.
        //
        // Les trois sortes de menace ne sont d'ailleurs pas filtrees pareil :
        //
        //     objet au sol temps ET distance
        //     etoile / bill temps seul (aucun plafond de distance)
        //     objet traine distance seule (`trailThreatDistance`)
        threatWindowMs: 900,
        threatMaxDistance: 900,

        // Un objet traine avance a la vitesse de son porteur : le temps avant
        // impact ne dit rien d'utile, c'est une distance de vue qu'il faut.
        // Largement au-dela de la hitbox de 40.
        trailThreatDistance: 260,

        // Accule au bord, un kart ne peut plus s'ecarter du bon cote : il leve le
        // pied. Face a un objet traine, ralentir suffit a ne plus le rattraper.
        edgeBrakeFactor: 0.78,
        edgeBrakeMs: 700,

        // Erreur d'appreciation : le kart se croit un peu plus vif, ou un peu
        // moins, qu'il ne l'est. Applique a son volant au moment de choisir ou se
        // mettre, elle se propage donc aux deux choses qui en dependent —
        // jusqu'ou il croit pouvoir aller, et ce qu'il croit que le detour lui
        // coute.
        //
        // Le degagement qui l'accompagnait (`crossDodgeMargin`) vit maintenant
        // dans `vision.place.margin.item`, avec les marges des autres corps.
        crossJudgeError: 0.25,

        // Ce qui ferme un cote en plus du bord de piste : un tuyau, ou un autre
        // objet pose la. S'ecarter vers eux, c'est troquer la menace contre une
        // autre — et le tuyau est le mauvais cote du marche.
        //
        // Cette distance dit jusqu'ou en avant ils comptent : environ une
        // demi-seconde de course, la duree d'un ecart. Au-dela, l'ecart sera
        // retombe avant que le kart n'arrive a leur hauteur.
        //
        // Bien plus court que `pipe.seeDistance`, et c'est la difference entre
        // les deux manoeuvres : un tuyau se contourne en trajectoire, en le
        // voyant venir de loin ; une esquive est un reflexe qui ne regarde que le
        // pas suivant.
        dodgeGuardDistance: 500,

        // Latence de reflexe, tiree au sort a chaque menace.
        reactionBaseMs: 280,
        reactionJitterMin: 0.8, reactionJitterMax: 1.35,

        // Visee : le kart se recale sur sa cible avant de tirer. La hitbox
        // verticale d'un objet valant 5, une erreur de cet ordre suffit a rater.
        //
        // `aimScanDistance` borne la designation de cible dans les deux sens, et
        // passe par la vue : on ne vise que ce qu'on voit, occlusion comprise.
        // `vision.range` la borne a son tour — monter cette valeur ne porte donc
        // que sur la visee avant tant que `range.back` reste en dessous.
        aimLeadMs: 1300,
        aimScanDistance: 900,
        aimErrorMax: 3.5,

        // L'inattention n'est plein tarif que pour une esquive tout juste jouable
        // ; au-dela de dodgeEasyRatio fois la marge necessaire, le tirage ne joue
        // plus.
        dodgeMissChance: 0.1,
        dodgeEasyRatio: 2.5,

        overtakeDetectionRange: 120, overtakeMinDistance: 12,
        boxDetectionRange: 400,
        wanderIntervalMin: 2000, wanderIntervalMax: 6000,
        wanderDurationMin: 500, wanderDurationMax: 1500,

        // Ecart vise par une derive de maraude, en profondeur de piste.
        //
        // C'est un ECART et non une vitesse : mise a l'echelle de l'agilite, une
        // vitesse faisait vagabonder les legers sur trois fois plus de piste que
        // les lourds. Tout le monde vise le meme decalage ; les lourds mettent
        // seulement plus longtemps a l'atteindre, et les plus lourds ne
        // l'atteignent pas dans la fenetre.
        wanderOffset: 4,

        // Un profil par manoeuvre, et c'est deliberement verbeux : ces valeurs
        // etaient celles du contournement de tuyau, empruntees en silence par
        // l'esquive et par la precaution. Les manoeuvres partagent la loi de
        // pilotage, pas l'urgence.
        //
        //   speed      plafond de la consigne laterale, avant mise a l'echelle du
        //              kart (`steerCap`). C'est l'urgence de la manoeuvre.
        //   gain       ce que vaut une unite d'ecart restant en vitesse laterale.
        //              Il decide surtout du seuil de PLEIN BRAQUAGE, `speed /
        //              gain` : en deca, le kart n'utilise qu'une fraction de son
        //              volant. A 6 pour le contournement ce seuil valait un tiers
        //              de la piste — le kart planifiait vif et roulait mou, un
        //              ecart de 3 unites chiffre a 154 ms en prenait 1167. Ce qui
        //              protege du depassement n'est pas ce gain mais
        //              `steerSettle`, qui corrige a l'endroit ou le kart
        //              S'ARRETERAIT et non a sa position.
        //   tolerance  en deca, la cible est tenue et le kart cesse de corriger,
        //              sinon il tremble autour.
        //   guard      refuse d'envoyer le kart dans ce qu'il a vu. L'esquive, le
        //              contournement et la precaution ne l'ont pas : eux
        //              traversent sciemment, apres avoir juge la place eux-memes.
        steering: {
            // L'esquive et la precaution tirent leur urgence du plan
            // (`plan.intensity`) et non d'ici : une esquive se tire entre
            // `dodgeIntensityMin` et `dodgeIntensityMax`, une precaution vaut
            // `vision.safety.speed`. C'est ce qui les rend reconnaissables a
            // l'oeil.
            //
            // `gain: 20` — plein braquage des 2.5 unites d'ecart. Une esquive qui
            // n'engage pas tout ce qu'elle a n'est pas une esquive.
            dodge:    { gain: 20, tolerance: 0.6, guard: false },
            safety:   { gain: 20, tolerance: 0.6, guard: false },

            // Le contournement de tuyau : la manoeuvre la plus urgente du jeu,
            // au-dessus de l'esquive la plus franche (`dodgeIntensityMax`, 50).
            // Rien d'excessif — c'est le seul obstacle CERTAIN du circuit. Une
            // carapace peut manquer sa cible, un kart peut s'ecarter, un tuyau ne
            // fait ni l'un ni l'autre.
            //
            // Elle ne rend personne egal : `steerCap` la met a l'echelle de
            // l'agilite, donc bowser en tire 14 u/s la ou koopa en tire 64. Et
            // depuis que le placement compte l'imprecision propre de chaque kart
            // (`place.slop`), le poids se paie sur le CHOIX du couloir et non
            // plus seulement sur le temps mis a le rejoindre.
            //
            // `gain: 20` — plein braquage des 3.1 unites : le kart arrive ou il
            // avait decide d'aller, au prix de 5 % de deplacement lateral en
            // plus.
            pipe:     { speed: 62, gain: 20, tolerance: 0.6, guard: false },

            // Se recaler sur une cible avant de tirer. Tolerance serree : la
            // hitbox verticale d'un objet vaut 5, viser large revient a ne pas
            // viser.
            aim:      { speed: 12, gain: 6, tolerance: 0.5, guard: true },

            // Sortir de la voie de celui qu'on double.
            overtake: { speed: 10, gain: 6, tolerance: 0.6, guard: true },

            // Aller chercher une boite. La tolerance est celle de l'axe : deja
            // dedans, le kart tient sa ligne au lieu de la corriger.
            box:      { speed: 25, gain: 6, tolerance: 2, guard: true },

            // La derive de confort. Elle n'accomplit rien et ne doit donc jamais
            // presser : c'est la manoeuvre la plus frequente de la course, et la
            // seule qui n'ait aucune decision derriere.
            wander:   { speed: 4, gain: 6, tolerance: 0.6, guard: true },

            // La croisiere. Elle ne rejoint rien — elle vise l'endroit ou le
            // kart s'arreterait — donc `steer` la juge tenue d'entree et se
            // contente de relacher le volant. `speed` et `gain` ne seront jamais
            // lus : les ecrire laisserait croire qu'elle pilote.
            //
            // Elle a remplace le retour a la ligne d'avant l'ecart, qui visait
            // une profondeur memorisee au lieu de la note de placement. Sur une
            // piste sans virage, ou `yPercent` est une profondeur et non une
            // trajectoire, il n'y a pas de ligne a retrouver.
            cruise:   { tolerance: 0, guard: false },

            // Le bill. Sa vitesse vient de `bill.centerSpeed` : il ne pilote pas,
            // il devie — et `steerCap` le laisse hors de l'agilite comme de
            // l'appui a l'allure, sans quoi un bill lance a pleine vitesse ne
            // pourrait plus contourner le tuyau qu'il vise.
            bill:     { gain: 6, tolerance: 0.2, guard: false }
        }
    },
};
