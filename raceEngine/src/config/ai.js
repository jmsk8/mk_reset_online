// Pilote IA : plans, reflexes, bouclier et profils de braquage.

export default {
    ai: {
        holdItemMin: 500, holdItemMax: 8000,

        // Chance de sortir l'objet derriere soi (en bouclier) selon la place.
        trailChance: { leader: 0.92, pack: 0.6, last: 0.45 },

        // Reconsideration de l'objet quand un danger apparait derriere, une
        // fois par episode (`updateShield`) :
        //   shot       carapace deja lancee : garder le bouclier
        //   carrier    porteur derriere : garder le bouclier (abaisse par
        //              l'agressivite jusqu'a `aggression.trailRatio`), sinon tirer
        //   backThrow  part des tirs qui partent vers le danger
        //   panic      etoile ou bill : chance d'avancer le declenchement
        shield: { shot: 0.98, carrier: 0.90, backThrow: 0.60, panic: 0.80 },

        // Duree de l'objet pose derriere, en multiple de trailHoldMin/Max.
        trailHoldFactor: { leader: 1.8, pack: 1, last: 1 },

        // Probabilite qu'une carapace parte vers l'arriere, par type et par place.
        shellBackwardChance: {
            greenShell: { leader: 1, pack: 0.2, last: 0.05 },
            redShell: { leader: 1, pack: 0.05, last: 0 }
        },

        bananaLobChance: { leader: 0, pack: 0.2, last: 0.7 },
        trailDelayMin: 400, trailDelayMax: 3000,
        trailHoldMin: 1200, trailHoldMax: 6000,

        // Agressivite : rang et ecart au premier (moyenne geometrique), modules
        // par l'etape de course.
        aggression: {
            // Ecart au premier ou le terme distance sature.
            distanceRef: 3000,

            // Part de l'agressivite au depart (pleine au dernier tour).
            startRatio: 0.3,

            // Delais et chance de trainer, en fraction de la normale, a
            // agressivite maximale.
            hurryRatio: 0.35,
            trailRatio: 0.4
        },
        dodgeIntensityMin: 20, dodgeIntensityMax: 50,

        // Fenetre de menace en temps avant impact, combinee (ET) avec un plafond
        // de distance :
        //     objet au sol   temps ET distance
        //     etoile / bill  temps seul
        //     objet traine   distance seule (`trailThreatDistance`)
        threatWindowMs: 900,
        threatMaxDistance: 900,

        // Distance de vue d'un objet traine (au-dela de sa hitbox de 40).
        trailThreatDistance: 260,

        // Frein quand le kart est accule au bord.
        edgeBrakeFactor: 0.78,
        edgeBrakeMs: 700,

        // Erreur d'appreciation de son propre volant au moment de choisir ou
        // se mettre.
        crossJudgeError: 0.25,

        // Portee d'un obstacle (tuyau, objet) qui ferme un cote pour l'esquive
        // (environ une demi-seconde de course).
        dodgeGuardDistance: 500,

        // Latence de reflexe, tiree au sort a chaque menace.
        reactionBaseMs: 280,
        reactionJitterMin: 0.8, reactionJitterMax: 1.35,

        // Visee : recalage sur la cible avant de tirer. `aimScanDistance` borne
        // la designation de cible (dans la limite de `vision.range`).
        aimLeadMs: 1300,
        aimScanDistance: 900,
        aimErrorMax: 3.5,

        // Inattention : pleine pour une esquive tout juste jouable, nulle au-dela
        // de dodgeEasyRatio fois la marge necessaire.
        dodgeMissChance: 0.1,
        dodgeEasyRatio: 2.5,

        overtakeDetectionRange: 120, overtakeMinDistance: 12,
        boxDetectionRange: 400,
        wanderIntervalMin: 2000, wanderIntervalMax: 6000,
        wanderDurationMin: 500, wanderDurationMax: 1500,

        // Ecart vise par une derive de maraude, en profondeur (identique pour tous).
        wanderOffset: 4,

        // Profil par manoeuvre :
        //   speed      plafond de la consigne laterale avant mise a l'echelle
        //              (`steerCap`)
        //   gain       vitesse laterale par unite d'ecart (plein braquage a
        //              `speed / gain`)
        //   tolerance  ecart en deca duquel la cible est tenue
        //   guard      refuse d'aller dans un obstacle vu
        steering: {
            // L'esquive et la precaution tirent leur urgence du plan
            // (`plan.intensity`).
            dodge:    { gain: 20, tolerance: 0.6, guard: false },
            safety:   { gain: 20, tolerance: 0.6, guard: false },

            // Contournement de tuyau : la manoeuvre la plus urgente (mise a
            // l'echelle de l'agilite par `steerCap`).
            pipe:     { speed: 62, gain: 20, tolerance: 0.6, guard: false },

            // Recalage sur une cible avant de tirer.
            aim:      { speed: 12, gain: 6, tolerance: 0.5, guard: true },

            // Sortir de la voie de celui qu'on double.
            overtake: { speed: 10, gain: 6, tolerance: 0.6, guard: true },

            // Aller chercher une boite (tolerance = largeur de l'axe).
            box:      { speed: 25, gain: 6, tolerance: 2, guard: true },

            // Derive de confort, jamais pressee.
            wander:   { speed: 4, gain: 6, tolerance: 0.6, guard: true },

            // Croisiere : vise le point d'arret, donc relache le volant.
            cruise:   { tolerance: 0, guard: false },

            // Bill : vitesse donnee par `bill.centerSpeed`, hors agilite.
            bill:     { gain: 6, tolerance: 0.2, guard: false }
        }
    },
};
