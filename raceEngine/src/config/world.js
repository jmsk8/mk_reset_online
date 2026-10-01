// Monde et deroulement : piste, tour, course, grand prix.

export default {
    world: {
        // Longueur du tour, ligne d'arrivee et boites viennent du circuit dessine
        // dans tracks/ (`applyTrack`, src/track.js) : `width`, `finishLineX`,
        // `itemBoxes`.

        // Soleil, dans le fond en parallaxe.
        sunX: 1920
    },

    road: {
        // Profondeur de la piste ; les rangees dessinees s'y repartissent (haut
        // au fond = maxY, bas au premier plan = minY).
        minY: 0,

        // Une unite vaut 3.6 px (`bodies.depthPx`) : la piste couvre toute la
        // bande d'asphalte.
        maxY: 35,

        // Marge de securite au bord de la piste.
        edgeSafetyMargin: 2,
        overtakeMargin: 5,
        wanderMargin: 8
    },

    // Deroulement d'une course (durees en ms, distances en unites monde).
    // Grand prix : blocs de `races` courses ; scores remis a zero et grille
    // tiree au sort a chaque bloc.
    grandPrix: {
        races: 4,
        // Points par place d'arrivee, du premier au dernier.
        points: [10, 8, 6, 5, 4, 3, 2, 1]
    },

    race: {
        laps: 5,

        // Duree totale du decompte = countdownHoldMs + 2 * lightIntervalMs.
        countdownHoldMs: 3000,
        lightIntervalMs: 1500,

        // Garde-fou : le client masque Lakitu quand la ligne sort de sa fenetre.
        goSignMs: 5000,

        // Arrivees avant la cloture (les retardataires sont classes d'office).
        stopAtFinisher: 7,

        // Duree du tableau des scores : entre deux courses, puis apres la
        // derniere du grand prix.
        resultsDelayMs: 10000,
        finalResultsDelayMs: 20000,

        // Au-dela, les karts encore en piste sont classes d'office.
        maxRaceMs: 180000,

        // Grille en deux lignes diagonales : `lanes` = profondeur de depart,
        // `laneSlope` = ajout par rang.
        //     colonne 0   y 3.15 -> 8.93     colonne 1   y 24.85 -> 30.63
        // Profondeur totale = backOffset + 3 * rowGap + colStagger (720 px), a
        // garder visible sur telephone avec parkStartOffset. Le tour doit faire
        // au moins le double (verifie par track.js).
        grid: {
            backOffset: 120,
            rowGap: 170,
            colStagger: 90,
            lanes: [0.09, 0.71],
            laneSlope: 0.055
        },

        // Sinon, depart rate.
        startTurboChance: 0.8,
        startNormalChance: 0.1,
        turboBoostMs: 1200,
        failStallMs: 1000,

        finishedSpeedRatio: 0.6,

        // Ecart a la ligne de la camera garee (negatif : ligne a droite du centre).
        parkStartOffset: 0,
        parkFinishOffset: -150,

        // Distance du premier a la ligne quand le drapeau sort.
        flagDistance: 1400,

        // La camera ne fait que ralentir pour se garer quand le leader franchit
        // la ligne : l'approche commence deux tours avant la fin, plus cette
        // marge (distance posee par `applyTrack`).
        cameraApproachMargin: 40,
        cameraMinSpeedRatio: 0.35,
        cameraMaxCatchupRatio: 1
    },
};
