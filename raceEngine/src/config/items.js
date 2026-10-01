// Objets : liste, distribution et effets.

export default {
    // Objets desactives (poids force a 0). Les triples sont prets : vider la
    // liste suffit a les remettre en jeu.
    disabledItems: ['tripleBanana', 'tripleGreenShell', 'tripleRedShell'],

    // Triples : `count` exemplaires en orbite (bouclier), `child` largue a
    // chaque activation.
    orbitItems: {
        tripleBanana:     { child: 'banana' },
        tripleGreenShell: { child: 'greenShell' },
        tripleRedShell:   { child: 'redShell' }
    },

    // Geometrie des orbites en coordonnees monde (radiusX en px, radiusY en
    // profondeur).
    orbit: {
        count: 3,
        orbitSpeed: 2.6,
        radiusX: 62,
        radiusY: 3.2,
        dropIntervalMin: 1200,
        dropIntervalMax: 3500
    },

    // Distribution : cinq mesures dans [0, 1] (p rang, d ecart au premier, s
    // etape de course, g ecart au kart de devant, i isolement) donnent :
    //
    //     pression = (rankShare * p + (1 - rankShare) * d) * (stageBoost.base +
    //              stageBoost.gain * s) * (packBoost.base + packBoost.gain * i)
    //
    // Objets tactiques : courbes propres sur p/d/s/g ; objets puissants : la
    // pression seule, avec un seuil chacun.
    itemDistribution: {
        // Ecart ou l'echelle sature (~7 s de retard a ~500 u/s).
        distanceRef: 3500,
        spreadRef: 4000,
        gapRef: 1200,

        // Part de l'etalement global dans l'isolement (le reste : ecart local g).
        spreadShare: 0.65,

        rankShare: 0.45,

        // Effet de l'etape : x0.85 au depart, x1.15 a l'arrivee.
        stageBoost: { base: 0.85, gain: 0.30 },

        // Effet du peloton : x0.55 colle, x1 eclate.
        packBoost: { base: 0.48, gain: 0.52 },

        // Multiplicateur du poids de l'objet deja recu au ramassage precedent.
        repeatPenalty: 0.4,

        // Courbes (produit de facteurs, 1 si absente) :
        //     { rise: [a, b], floor: f }  f en a (0 par defaut), 1 en b
        //     { fall: [a, b], depth: p }  1 en a, 1 - p en b (p = 1 par defaut)
        //     { bell: c, width: w }       1 en c, 0 a c - w et c + w
        // sur `rank` (p), `dist` (d), `stage` (s), `gap` (g). `packBonus` :
        // poids x (1 + packBonus * (1 - i)).
        // Verrous : minStage, minRank, lastRanks, minDist, unique.
        // Decote pour toute la course : `decay` par exemplaire distribue,
        // `regenPerLap` regagne par tour du premier.
        items: {
            // --- Objets tactiques (seuls banane et verte pour le premier) ---

            // Objet de tete : decroit avec le rang et l'ecart (sans s'annuler).
            banana: {
                base: 100,
                rank:  [{ fall: [0, 1], depth: 0.80 }],
                dist:  [{ fall: [0, 0.50], depth: 0.85 }, { fall: [0.45, 0.75], depth: 0.90 }],
                stage: [{ fall: [0, 1], depth: 0.25 }],
                packBonus: 0.30
            },

            // Culmine en deuxieme/troisieme place.
            greenShell: {
                base: 95,
                rank:  [{ rise: [0, 0.30], floor: 0.55 }, { fall: [0.30, 1], depth: 0.55 }],
                dist:  [{ fall: [0, 0.55], depth: 0.80 }, { fall: [0.50, 0.82], depth: 0.90 }],
                stage: [{ fall: [0, 1], depth: 0.20 }],
                packBonus: 0.35
            },

            // Nul pour le premier ; `gap` commande.
            redShell: {
                base: 95,
                rank:  [{ rise: [0, 0.14] }, { fall: [0.55, 1], depth: 0.45 }],
                dist:  [{ bell: 0.35, width: 0.72 }],
                gap:   [{ fall: [0.55, 1.20] }],
                packBonus: 0.20
            },

            // Remontee sans condition d'etape.
            shroom: {
                base: 70,
                rank:  [{ rise: [0, 0.14] }],
                dist:  [{ rise: [0, 0.45], floor: 0.30 }, { fall: [0.70, 1], depth: 0.55 }],
                packBonus: 0.45
            },

            // --- Objets puissants : etoile au tour 2, bill et eclair au tour 3 ---

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

            // Un seul en circulation, jamais pendant un orage.
            lightning: {
                // Releve pour compenser le reflux de fin de course.
                base: 35,
                power: { open: 0.58, full: 0.95 },
                minStage: 0.45,
                lastRanks: 3,
                minDist: 0.40,
                unique: true,
                decay: 0.35,
                regenPerLap: 0.25,

                // Reflux sur les 28 derniers pourcents de la course.
                lateFade: { from: 0.72, to: 1.00, depth: 0.95 }
            },

            // --- Triples (desactives) : defensifs, en tete et milieu de peloton ---
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

    // Carapace bleue : tirage a part avant les poids, declenche par l'echappee
    // du premier :
    //     chance = baseChance * montee(stageWindow) * (leadFloor + leadGain *
    //            echappee) * poids de rang * decote
    blueShell: {
        baseChance: 0.14,

        // Fenetre d'etape (pic au quatrieme tour).
        stageWindow: { from: 0.35, to: 0.75 },

        // Reflux de fin de course, plus doux que l'eclair.
        lateFade: { from: 0.72, to: 1.00, depth: 0.30 },

        // Echappee du premier sur le deuxieme, rapportee a leadRef.
        leadRef: 2200,
        leadFloor: 0.30,
        leadGain: 0.95,

        // Poids par rang ; absent = jamais de bleue.
        rankWeights: { 3: 0.65, 4: 0.65, 5: 1.00, 6: 1.00, 7: 0.75 },

        // Decote par bleue lancee, regagnee de `regenPerLap` par tour du premier.
        decay: 0.45,
        regenPerLap: 0.30,

        // Delai minimal entre deux bleues.
        cooldownMs: 12000,

        speed: 1500,
        // Hauteur en vol, puis sur la cible.
        cruiseHop: 72,
        orbitHop: 118,
        catchDistance: 70,
        // Verrou definitif sur le premier a cette distance.
        lockDistance: 800,
        // Au-dela, verrou sur le premier ou qu'il soit.
        maxCruiseMs: 9000,

        orbitTurns: 1,
        orbitMs: 800,
        orbitRadiusX: 85,
        orbitRadiusY: 4,
        hoverMs: 450,
        crashMs: 130,
        // Centre du souffle, devant le kart vise : la bleue se poste a
        // `hoverLead` puis pique jusqu'a `crashLead`. Decide surtout qui d'autre
        // le dome emporte (devant ou derriere la cible).
        hoverLead: 48,
        crashLead: 55,

        // Dome qui s'etend depuis l'impact.
        blastRadiusX: 180,
        blastRadiusY: 8.5,
        blastMs: 300
    },

    // Eclair : effets apres le lancer (distribution dans itemDistribution).
    lightning: {
        // Rythme de l'orage en ms depuis le lancer ; `strikeAt` : noir, eclairs
        // et malus d'un coup.
        strikeAt: 0,
        totalMs: 2600,

        // Malus de vitesse pendant le rapetissement.
        speedFactor: 0.5,
        scale: 0.5,

        // Duree du rapetissement, maximale pour le premier.
        shrinkMsMax: 10000,
        shrinkMsMin: 2000,

        // Ecart au premier a partir duquel on ne paie que le minimum.
        shrinkFalloffDistance: 3500,

        // Un kart rapetisse est aplati par un kart normal (etoile et bill le
        // blessent plutot). Duree prevue, ecretee a la fin du rapetissement.
        flatMs: 3000,

        // Duree minimale d'ecrasement (le rapetissement attend si besoin).
        crushHoldMs: 1500,

        // Facteur de vitesse d'un kart aplati, cumule avec `speedFactor`.
        flatSpeedFactor: 0.9,

        // Part du rang face a la distance dans la duree du rapetissement (0 :
        // distance seule, 1 : rang seul). A 0.35 et huit karts : 400 ms par place.
        shrinkRankWeight: 0.35
    },

    // Bill Ball : le kart se transforme et fonce au milieu de la piste.
    bill: {
        // Vitesse et montee : voir `speeds.boosts.bill`.

        // Marge minimale sur la meilleure pointe d'un autre objet.
        minLeadRatio: 1.08,

        // Duree du vol, raccourcie de `overtakeCostMs` par kart double (plancher
        // `minDurationMs`).
        durationMs: 7000,
        overtakeCostMs: 800,
        minDurationMs: 3000,

        // Descente lineaire vers la vitesse du kart apres le vol.
        slowdownMs: 1000,

        // Vitesse de recentrage, en profondeur par seconde.
        centerSpeed: 25,

        // Zone balayee : `x` = demi-largeur dessinee (a garder coherente avec
        // `.kart-bill`), `y` = profondeur de piste.
        hitbox: { x: 99, y: 11 },

        // Degagement autour d'un tuyau.
        pipeClearance: 3,

        // Bousculade entre intouchables, en fraction de la poussee normale.
        pushFactor: 0.45
    },

    trailableItems: ['banana', 'greenShell', 'redShell'],

    // Distance avant qu'un objet puisse toucher son lanceur.
    itemArmDistance: 110,

    // Cadence d'animation des carapaces, en ms par frame.
    itemAnim: {
        greenShell: { animSpeed: 100 },
        redShell: { animSpeed: 100 },
        blueShell: { animSpeed: 90 },
        bill: { animSpeed: 70 }
    }
};
