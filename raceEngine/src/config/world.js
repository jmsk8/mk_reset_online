// Le monde et son deroulement : la piste, le tour, la course, le grand prix.

export default {
    world: {
        // La geometrie du circuit — longueur du tour, ligne d'arrivee, boites a
        // objets — se dessine dans tracks/ et vient se poser sur cette config au
        // demarrage (`applyTrack`, dans raceEngine/src/track.js). Ce qu'il ajoute
        // ici : `width`, `finishLineX`, `itemBoxes`. Appeler `createWorldState`
        // sans cette etape refuse de demarrer plutot que de simuler un monde
        // vide.

        // Le soleil, lui, n'est pas sur la piste : il est pose dans le fond en
        // parallaxe, que le dessin ne decrit pas.
        sunX: 1920
    },

    road: {
        // La largeur de la piste reste ici : elle ne varie pas le long du tour.
        // Les rangees dessinees d'un circuit se repartissent sur cet intervalle —
        // celle du haut au fond (maxY), celle du bas au premier plan (minY). Le
        // dessin donne la finesse de placement, pas la largeur.
        minY: 0,

        // 35 ET NON 30 : la route etait deja peinte. La piste dessinee EST la
        // bande d'asphalte, et elle s'arretait a 30 — il restait donc 5 unites de
        // bitume au fond sur lesquelles rien ne roulait jamais.
        //
        // Ce n'est PAS un changement d'echelle : une unite vaut toujours 3.6 px
        // (`bodies.depthPx`), la piste est simplement PLUS LONGUE de cinq unites.
        // C'est ce qui rend le changement sur — aucune des quarante constantes en
        // profondeur du fichier ne change de sens.
        //
        // La piste gagne 16.7 % de profondeur reelle, ce qui paie le tuyau devenu
        // rond (cf. `pipe.hitbox`), et le decor ne bouge pas d'un pixel. En
        // echange les karts vont desormais jusqu'au bord de l'asphalte :
        // `edgeSafetyMargin` devient la seule chose qui les tient a distance de
        // la bordure.
        //
        // Les traces existants se redistribuent — `rowY` repartit les rangees
        // dessinees sur `minY..maxY`, donc un tuyau de la rangee 1 sur 4 passe de
        // y=20 a y=23.3. Relire `make race-tracks` apres ce changement.
        maxY: 35,

        // La piste n'a aucune notion de voie : `laneTolerance` vit dans
        // `vision.threatLane`, c'est une distance de perception et non une
        // propriete du trace.
        edgeSafetyMargin: 2,
        overtakeMargin: 5,
        wanderMargin: 8
    },

    // Deroulement d'une course. Durees en millisecondes, distances en unites
    // monde.
    //
    // Grand prix : les courses s'enchainent par blocs de `races`, chacune
    // rapportant les points de `points` selon la place a l'arrivee. Le bloc fini,
    // les scores repartent de zero et la grille est tiree au sort.
    grandPrix: {
        races: 4,
        // Indexe par place d'arrivee, du premier au dernier. Une place au-dela de
        // ce tableau ne rapporte rien : allonger la liste suffit pour un plateau
        // plus grand.
        points: [10, 8, 6, 5, 4, 3, 2, 1]
    },

    race: {
        laps: 5,

        // Duree totale du decompte = countdownHoldMs + 2 * lightIntervalMs.
        countdownHoldMs: 3000,
        lightIntervalMs: 1500,

        // Le client masque Lakitu des que la ligne sort de sa fenetre, dont il
        // est seul a connaitre la largeur. Ce delai n'est qu'un garde-fou : sans
        // lui, le feu vert reparaitrait a chaque passage de la ligne, toutes les
        // quinze secondes.
        goSignMs: 5000,

        // Lakitu etant ancre sur la ligne, le panneau n'est vu que si la camera
        // passe devant pendant ce delai.
        finalSignMs: 6000,

        // La course s'arrete des que ce nombre de karts a franchi la ligne : les
        // retardataires sont classes d'office dans l'ordre ou ils roulent.
        // Attendre le dernier ne montrait qu'un kart seul en piste.
        stopAtFinisher: 7,

        // Duree du tableau des scores : la premiere valeur entre deux courses, la
        // seconde apres la derniere du grand prix, ou il faut le temps de lire le
        // classement general. L'animation (arrivee -> compteur -> remaniement, cf
        // `banner/results.js`) prend deja plus de 5 s a elle seule.
        resultsDelayMs: 10000,
        finalResultsDelayMs: 20000,

        // Au-dela, les karts encore en piste sont classes d'office.
        maxRaceMs: 180000,

        // Deux lignes paralleles filant en diagonale : `lanes` donne leur
        // profondeur de depart, `laneSlope` ce que chaque rang y ajoute.
        //
        // La grille respire un peu plus qu'avant, sur les deux axes. En longueur
        // les karts se suivaient a 75-80 px pour une hitbox de 60 (`kartVsKart.x`)
        // — legal, mais assez serre pour qu'un depart turbo se joue dans la
        // carrosserie du voisin ; ils sont maintenant a 80-90. En profondeur les
        // deux colonnes s'ecartent, et la diagonale s'accentue avec elles, sans
        // quoi elargir l'une refermait l'autre.
        //
        //     colonne 0   y 3.15 -> 8.93     colonne 1   y 24.85 -> 30.63
        //
        // Les deux extremes restent hors de la bande de frottement
        // (`edgeSafetyMargin`, soit y < 2 ou y > 33) : personne ne demarre en
        // payant le bord.
        //
        // Profondeur totale = backOffset + 3 * rowGap + colStagger, soit 720 px
        // contre 665. A tenir avec parkStartOffset dans les ~600 unites visibles
        // d'un telephone, sinon le fond de grille sort du cadre — c'est LE prix de
        // cet ecartement, et le seul. Cette meme profondeur borne aussi le
        // chargement d'un trace (`track.js`) : elle exige un tour deux fois plus
        // long qu'elle, et signale les boites ou les pipes poses dedans.
        grid: {
            backOffset: 120,
            rowGap: 170,
            colStagger: 90,
            lanes: [0.09, 0.71],
            laneSlope: 0.055
        },

        // Le reste des tirages est un depart rate.
        startTurboChance: 0.8,
        startNormalChance: 0.1,
        turboBoostMs: 1200,
        failStallMs: 1000,

        finishedSpeedRatio: 0.6,

        // Ecart a la ligne de la camera garee. Elle designe le centre de la vue :
        // negatif place la ligne a droite du centre, positif a gauche.
        parkStartOffset: 0,
        parkFinishOffset: -150,

        // Le drapeau a damier sort bien plus tard que le repositionnement de la
        // camera : Lakitu ne se penche qu'a l'approche reelle du premier, soit
        // environ trois secondes avant son passage.
        flagDistance: 1400,

        // La camera n'accelere jamais : elle ne fait que ralentir pour se garer
        // pile quand le leader franchit la ligne, puis s'y bloque.
        //
        // C'est ce qui impose d'ouvrir l'approche deux tours avant la fin : au
        // pire elle doit couvrir un tour complet, et a sa vitesse normale il lui
        // faut le temps que met le leader a parcourir ces deux tours.
        //
        // La distance d'approche elle-meme n'est donc pas un reglage mais un
        // calcul : deux tours du circuit en cours, plus cette marge. C'est
        // `applyTrack` qui la pose, une fois la longueur du tour connue — sans
        // quoi chaque nouveau dessin demanderait de la recalculer a la main, et
        // le jour ou on l'oublierait la camera raterait la ligne. Sur l'anneau
        // d'origine : 2 * 7680 + 40 = 15400, la valeur qui a toujours tourne.
        cameraApproachMargin: 40,
        cameraMinSpeedRatio: 0.35,
        cameraMaxCatchupRatio: 1
    },
};
