// Pilotage : vitesses, elan, appui en virage, bord de piste, contact entre karts.

export default {
    physics: {
        // Loi de braquage commune a tous les karts (les manoeuvres sont dans
        // `ai.steering`).
        steer: {
            // Reponse du volant vers la consigne laterale, en 1/s (200 ms a 5),
            // commune a tous ; le temps de reaction est `ai.reactionBaseMs`.
            response: 5,

            // Perte de volant avec l'allure (rapportee a la pointe du kart) :
            // `drag` a pleine pointe, `curve` forme de la perte, `bite` allure
            // a partir de laquelle le volant mord entierement (pas de volant a
            // l'arret).
            pace: { drag: 0.35, curve: 1.0, bite: 0.5 },

            // Multiplicateur du volant sous champignon ou etoile.
            boostGain: 1.15,

            // Cout du braquage en vitesse (`stats.cornering`, allure) :
            //     `cost`     perte a plein braquage et pleine vitesse, pour un
            //                `cornering` de 1 (lineaire)
            //     `fullLock` consigne laterale du plein braquage (a garder
            //                coherente avec `ai.dodgeIntensityMax`)
            //     `maxLoss`  garde-fou
            // Le cout ne tombe que pendant les transitions de braquage.
            corner: { cost: 0.018, fullLock: 50, maxLoss: 0.30 }
        },

        // Bord de piste : mur glissant, sans rebond ni arret, qui ralentit (a
        // la difference du tuyau).
        wall: {
            // Vitesse vers laquelle le frottement tire, en fraction de la pointe.
            speedFactor: 0.72,

            // Vitesse a laquelle le frottement mord, en 1/s (8 : 125 ms).
            grip: 8
        },

        // Contact entre karts : normale du choc en espace normalise (boite de
        // 60 x 5), impulsion selon la vitesse de rapprochement, partage selon
        // l'inertie. Les chocs passent par `bumpVy` / `bumpVx`, pas par `vy`.
        contact: {
            // Passes de resolution par tick.
            iterations: 2,

            // Chevauchement tolere par axe (evite les vibrations).
            slopX: 2,
            slopY: 0.2,

            // Vitesse de resorption du chevauchement, en 1/s.
            separationRate: 12,

            // Force d'un choc (sans unite) : `ejectBase` plus la vitesse de
            // rapprochement ; seulement si les karts se rapprochent encore.
            ejectBase: 1.0,

            // Part de la vitesse de rapprochement rendue.
            restitution: 0.6,

            // Valeur d'une ejection de force 1, par axe (px/s, profondeur/s).
            ejectX: 135,
            ejectY: 27,

            // Plafond de la force d'un choc.
            maxEject: 4,

            // Part du braquage perdue au contact a masse egale, appliquee a
            // chaque tick (« il force le passage »).
            steerDeny: 0.7,

            // Plafonds des canaux de choc (cumulables entre deux coups).
            maxBumpX: 210,
            maxBumpY: 45,

            // Amortissement des canaux de choc, en 1/s (5.5 : 180 ms).
            decay: 5.5,

            // Inertie de contact : `masse ^ massBias * allure ^ speedBias`.

            // Poids de la masse dans un contact (pivot a la masse 1).
            massBias: 2.0,

            // Poids de l'allure (1 : inertie = masse * vitesse).
            speedBias: 1.0,

            // Garde-fou sur l'allure.
            speedClamp: { min: 0.55, max: 1.80 },

            // Masse d'un bill en multiples de celle du kart (rapport d'immunite).
            billMassFactor: 60,

            // Un kart en tete-a-queue fait obstacle.
            spinMassFactor: 1.2
        }
    },

    speeds: {
        roadPPS: 250,

        // Croisiere hors objet : `topSpeed * (momentumMinRatio + (1 -
        // momentumMinRatio) * momentum)`, `momentum` retire toutes les
        // `momentumDrift*` ms dans uniform(`momentumFloor`, 1).
        momentumMinRatio: 0.78,

        // Plancher du tirage de l'elan (`weightGain` le releve selon le poids) :
        //       base  bande        bruit / course  chevauchement
        //       0.44  87.7-100 %   4.6 px/s        39 px/s
        //       0.70  93.4-100 %   2.5 px/s        9 px/s
        //       0.78  95.2-100 %   1.8 px/s        aucun
        //       0.80  95.6-100 %   1.6 px/s        -3 px/s
        // Au-dessus de 0.78, certains duels ne peuvent plus naitre de la
        // croisiere (bowser/toad et bowser/koopa a 0.80).
        momentumFloor: { base: 0.80, weightGain: 0 },
        momentumChangeSpeed: 0.25,
        momentumDriftMin: 3000,
        momentumDriftMax: 7000,
        accelerationRate: 150,

        projectileSpeed: 880,
        redShellSpeed: 840,
        redShellTrackingSpeed: 8,
        // Choix de cible de la rouge (pente, voir `redShellTargetScore`).
        // Plancher : l'objet ne s'arme qu'a `itemArmDistance` (110).
        redShellMinTarget: 150,

        // Au-dela, le candidat vaut son ecart brut.
        redShellComfortTarget: 340,

        // Penalite maximale d'une cible au contact.
        redShellClosePenalty: 260,

        // Champignon, etoile et bill :
        //   multiplier  pointe, en multiple de la pointe du kart
        //   ramp        montee, en multiples de la relance normale
        // Montee depuis la croisiere : champignon 240-390 ms, etoile 75-120 ms,
        // bill 90-145 ms.
        boosts: {
            // `durationMs` sert aussi au turbo de depart.
            shroom: { multiplier: 1.50, durationMs: 1500, ramp: 10 },

            // Pointe sous celle du champignon (l'etoile vaut par sa duree).
            star: { multiplier: 1.40, durationMs: 6000, ramp: 16 },

            // Au-dessus de l'etoile (duree de vol : voir `bill`).
            bill: { multiplier: 1.65, ramp: 20 }
        },

        // Banane en cloche (hauteur = decalage de rendu).
        bananaLobDistance: 900,
        bananaLobDurationMs: 850,
        bananaLobHeight: 105,
        // Forme de l'arc (sous 1, sommet plus tot).
        bananaLobRise: 0.62,

        shellVertical: 1.5
    },

    offsets: {
        // Valeurs de physique, identiques sur tous les appareils.
        world: {
            // Position de l'objet traine, en ecart au centre du porteur
            // (transmise au client).
            heldItemBehind: -70,
            shellSpawn: 50
        },
    },

    // Cout d'un coup selon sa source :
    //     spinMs        duree du tete-a-queue
    //     keep          part de la vitesse gardee pendant la glissade
    //     invincibleMs  sursis apres la sortie
    // Durees et sursis inspires de Mario Kart 8 Deluxe. Temps perdu par un
    // Mario lance :
    //     choc 1.6 s  eclair 1.7  banane 1.9  verte 3.0  rouge 3.0  bleue 3.5
    // `star` et `bill` : choc d'un kart intouchable. Une source absente leve
    // une erreur.
    hits: {
        star:       { spinMs: 1000, keep: 0.25, invincibleMs: 1000 },
        bill:       { spinMs: 1000, keep: 0.25, invincibleMs: 950 },
        banana:     { spinMs: 1200, keep: 0.20, invincibleMs: 1500 },
        lightning:  { spinMs: 1000, keep: 0.20, invincibleMs: 1500 },
        greenShell: { spinMs: 1500, keep: 0,    invincibleMs: 1500 },
        redShell:   { spinMs: 1500, keep: 0,    invincibleMs: 1500 },
        blueShell:  { spinMs: 2000, keep: 0,    invincibleMs: 1500 }
    },

    delays: {
        boxRespawn: 1000,
        itemGrant: 3000,
        bananaLife: 40000,
        // Delai avant la disparition d'un objet touche (sans danger).
        itemLingerMs: 80,
        throwDelayAfterHit: 1000,
        spawnMin: 150,
        spawnMax: 800
    },
};
