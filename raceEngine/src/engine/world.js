// La fabrique d'un monde : grille de depart, karts, decor, circuit.
// Tout ce qu'une course a besoin de savoir avant son premier pas.

import { randomRange, shuffleArray } from './math.js';
import { parkPosition } from './geometry.js';
import { deriveCharacterStats, fastestBoostedSpeed, getNewMomentumTarget } from './stats.js';
import { laneY } from './driving.js';
import { shadowCount, shadowFrom, shadowHi, shadowLo, shadowTo } from './vision.js';
import { countdownDuration } from './race.js';

// `startOrder` est l'ordre d'arrivee de la course precedente : le vainqueur
// repart en pole. Absent, la grille est tiree au sort. `grandPrix` reporte le
// bloc en cours ({ round, points }) ; absent, la course ouvre un bloc neuf.
function createWorldState(cfg, rng, now, startOrder, grandPrix) {
    const roadHeight = cfg.road.maxY - cfg.road.minY;
    const race = cfg.race;
    const countdownMs = countdownDuration(race);

    // Le circuit vient du dessin, pose sur la config par
    // raceEngine/src/track.js. Sans lui il n'y a pas de monde a construire :
    // autant le dire ici plutot que de faire tourner une course sur un tour
    // de largeur NaN, ou personne ne croise jamais de boite.
    const drawnBoxes = cfg.world.itemBoxes;
    if (!cfg.world.width || !drawnBoxes || !drawnBoxes.length) {
        throw new Error('cfg.world sans circuit : appeler track.applyTrack(cfg, circuit) '
            + 'avant createWorldState. Les circuits se dessinent dans tracks/.');
    }

    const itemBoxes = drawnBoxes.map(box => ({
        worldX: box.x,
        y: box.y,
        active: true,
        reactivateTime: 0
    }));

    // Les pipes ne connaissent aucun etat : ni actifs, ni repris, ni
    // detruits. Ils sont recopies ici quand meme, pour que tout le contenu
    // du monde se lise au meme endroit que le reste — et parce qu'un jour
    // l'un d'eux voudra peut-etre bouger.
    const pipes = (cfg.world.pipes || []).map(pipe => ({
        worldX: pipe.x,
        y: pipe.y,
        // Sa couleur, et elle s'arrete la : le moteur ne la lit nulle part.
        // Elle est recopiee pour la meme raison que le reste — tout le
        // contenu du monde se lit au meme endroit, et le decor se dessine
        // depuis l'etat, jamais depuis le tracé.
        kind: pipe.kind || 'green'
    }));

    const statsTable = deriveCharacterStats(cfg);
    const roster = Object.keys(statsTable);
    const names = (startOrder && startOrder.length === roster.length)
        ? startOrder.slice()
        : shuffleArray(roster, rng);

    const karts = [];
    const kartsById = {};

    names.forEach((charName, index) => {
        const row = Math.floor(index / race.grid.lanes.length);
        const col = index % race.grid.lanes.length;

        const gapToLine = race.grid.backOffset + row * race.grid.rowGap + col * race.grid.colStagger;
        let worldX = cfg.world.finishLineX - gapToLine;
        if (worldX < 0) worldX += cfg.world.width;

        const depth = race.grid.lanes[col] + row * race.grid.laneSlope;
        const verticalPos = Math.min(cfg.road.maxY,
                                     Math.max(cfg.road.minY, cfg.road.minY + roadHeight * depth));
        const stats = statsTable[charName];

        const kart = {
            id: index,
            charName: charName,
            worldX: worldX,
            yPercent: verticalPos,
            totalDistance: 0,

            stats: stats,
            absoluteVelocity: 0,
            momentum: 0,
            momentumTarget: getNewMomentumTarget(rng, cfg, stats),
            nextMomentumChange: now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax),

            // Elan mis de cote pendant un objet de vitesse, et ce qu'il
            // restait a son compte a rebours. -1 veut dire « rien en
            // attente » : c'est le seul etat qui autorise la mise de cote,
            // et le seul que produit un incident, qui refait l'elan et n'a
            // donc rien a rendre.
            preBoostMomentum: -1,
            preBoostDriftLeft: 0,
            vy: 0,
            targetVy: 0,

            // Canaux de choc, tenus a l'ecart du pilotage et du moteur.
            // `bumpVy` est en profondeur/s, `bumpVx` en pixels/s. Les deux
            // s'ajoutent au deplacement puis s'amortissent seuls : ecrire un
            // choc dans `vy` le faisait effacer par le volant avant que
            // les karts se soient decolles.
            bumpVy: 0,
            bumpVx: 0,

            // Vitesse le long de la piste sur le tick ecoule, en pixels/s.
            // Relevee a la fin du deplacement et lue par la passe de contact,
            // qui a besoin d'une vitesse de rapprochement reelle — recul de
            // pipe et tete-a-queue compris — et non de la consigne moteur.
            contactSpeed: 0,

            state: 'grid',
            rank: index + 1,

            aiState: 'cruising',

            hitEndTime: 0,

            // Choc contre un pipe. `bumpEndTime` porte l'arret net,
            // `bumpRecoilLeft` ce qu'il reste a reculer. Le sursis est
            // retenu par tuyau : un kart qui vient d'en heurter un doit
            // pouvoir se cogner au suivant.
            bumpEndTime: 0,
            bumpRecoilLeft: 0,
            bumped: false,

            // Ecrase par un kart reste grand. Date et drapeau, comme le
            // reste. La date ne depasse jamais celle du rapetissement : un
            // kart redevenu grand n'est plus plat.
            flatEndTime: 0,
            isFlat: false,

            // Contact en cours avec un tuyau pendant un tete-a-queue : la
            // toupie est bloquee tant qu'il tient, sans que ce soit un choc.
            pipeBlocked: false,
            pipeImmuneUntil: 0,
            lastPipeIndex: -1,

            // Tuyau en cours de contournement, et couloir choisi pour le
            // passer. L'index tient jusqu'a ce que le tuyau soit derriere :
            // c'est ce qui donne une trajectoire au lieu d'une suite
            // d'ecarts.
            pipeTargetIndex: -1,
            pipeLaneY: 0,

            heldItem: null,
            throwTime: 0,
            pendingItemGrantTime: 0,

            boostEndTime: 0,
            starEndTime: 0,
            isInvincible: false,
            hitInvincibleUntil: 0,

            // Rapetissement par l'eclair. La date pilote la simulation, le
            // booleen part dans le snapshot.
            shrinkEndTime: 0,
            isShrunk: false,

            // Bill Ball. `billAhead` retient qui reste a doubler : la vider
            // est ce qui raccourcit le vol.
            isBill: false,
            billStartedAt: 0,
            billEndTime: 0,
            billSlowUntil: 0,
            billAhead: [],

            trailTime: 0,
            brakeUntil: 0,

            // Quand il a traverse une zone de boxes — le coup d'oeil
            // arriere en depend (cf. `vision.boxGlanceMs`) — et l'episode de
            // danger pour lequel il a deja tranche entre bouclier et tir.
            boxPassedAt: -Infinity,
            shieldAt: -Infinity,
            shieldHold: false,

            // Severite du frein en cours, et prochaine occasion de decider
            // de se laisser doubler (cf. `vision.giveWay`).
            brakeFactor: 0,
            giveWayRetryAt: 0,
            shotDirection: 1,
            // Le plan de tir a-t-il ete fait en tete ? Il ne vaut plus rien
            // si le kart s'est fait doubler depuis.
            shotAsLeader: false,
            lobbing: false,
            aimError: 0,

            // Le releve d'un tir vers l'arriere : la profondeur vue lors du
            // coup d'oeil, et sa date. Il se perime (`vision.aimMemoryMs`),
            // et c'est voulu — viser de memoire, c'est viser ou l'autre
            // ETAIT.
            aimTargetY: 0,
            aimTargetAt: -Infinity,

            // Tout ce que le kart a percu au dernier balayage, et rien d'autre :
            // le pilotage ne lit plus le monde. Les deux dates de depart sont
            // decalees kart par kart pour qu'ils ne balayent ni ne tournent la
            // tete tous ensemble.
            sight: {
                at: now - cfg.vision.scanIntervalMs
                    + Math.round(index * cfg.vision.scanIntervalMs / names.length),
                back: false,
                backUntil: 0,

                // Sens du dernier balayage effectue, a distinguer de `back`
                // qui est l'attention du moment (cf. `perceive`).
                scanBack: false,

                nextGlance: now
                    + Math.round(index * cfg.vision.glanceIntervalMs / names.length),

                // Date du dernier coup d'oeil en arriere. C'est elle qui
                // autorise a viser derriere : avoir regarde, et non regarder
                // pendant. Loin dans le passe au depart — personne n'a encore
                // rien vu.
                seenKartY: 0,
                seenKartDist: -1,

                threatId: 0,
                threatKind: '',
                threatY: 0,
                threatTtc: Infinity,
                planGone: false,

                spans: [],
                spanCount: 0,

                // Ce que le balayage a vu passer sans le voir : ce qui
                // tombait dans l'ombre d'un corps plus proche. Purement
                // observable — aucune decision ne le lit. Cf. `perceive`.
                hiddenIds: [],
                hiddenCount: 0,

                // Les ombres elles-memes, telles que la marche les a
                // empilees : deux pentes depuis l'oeil, et les deux
                // distances entre lesquelles elles portent. Observable
                // aussi — la decision les a deja consommees.
                shadowLo: [],
                shadowHi: [],
                shadowFrom: [],
                shadowTo: [],
                shadowCount: 0,

                // Ou etait la camera pendant ce balayage. Sans elle, les
                // pentes ci-dessus ne se rattachent a rien.
                eyeBack: 0,
                eyeY: 0,

                // La portee du balayage courant, avant ou arriere. Elle se
                // deduit du sens et de `vision.range`, mais l'observateur
                // n'a pas a refaire ce choix : ce qui s'affiche doit etre ce
                // que le moteur a regarde.
                scanRange: 0,

                // Les profondeurs des karts qui roulent avec lui — cf.
                // `vision.crowd` et l'encombrement dans `laneRisk`.
                crowdY: [],
                crowdCount: 0,

                pipeIndex: -1,
                pipeDist: 0,
                pipeAheadIndex: -1,
                pipeAheadDist: 0,
                aheadKartY: 0,
                aheadKartDist: -1,
                boxY: 0,
                boxDist: -1,
                pressure: false,
                pressureY: 0,
                pressureId: 0,
                // De quel cote vient le releve ci-dessus : un porteur dans
                // le dos qui peut tirer, ou un porteur devant qui peut
                // lacher. Meme perception, deux decisions.
                pressureBack: false,

                // Le porteur qu'on SUIT, et depuis quand. Meme souvenir
                // date que `dangerAt` plus bas, meme peremption, pour la
                // meme raison : un coup d'oeil arriere ne doit pas effacer
                // ce que le kart a devant lui. Seul un balayage AVANT pose
                // ou leve ce souvenir.
                frontAt: -Infinity,
                frontY: 0,
                frontId: 0,

                // Le danger APERCU DERRIERE, et depuis quand. C'est un souvenir
                // et non un etat : le tirage du coup d'oeil n'a jamais lieu
                // pendant un coup d'oeil, donc il ne peut lire que ce qu'on a vu.
                // Sans lui, le kart oublierait la carapace entre deux
                // clignements.
                //
                // `dangerAt` est rafraichi a chaque coup d'oeil qui le revoit ;
                // `dangerSince` marque le debut de l'EPISODE, ce qui evite de
                // rejouer le choix du bouclier.
                //
                //   'shot'    une carapace en vol, deja lancee
                //   'carrier' quelqu'un derriere qui en porte une
                //   'ram'     une etoile ou un bill : rien a lui opposer
                dangerAt: -Infinity,
                dangerSince: -Infinity,
                dangerKind: '',

                // Les rouges apercues derriere : la plus proche, et combien.
                // Cf. `vision.giveWay`.
                redBehindDist: -1,
                redBehindY: 0,
                redBehindId: 0,
                redBehindCount: 0,

                // Et leur souvenir, sans lequel le releve ci-dessus
                // n'existait que pendant le coup d'oeil. Meme peremption
                // que `dangerAt`, et pose par le seul balayage arriere.
                redMemAt: -Infinity,
                redMemDist: -1,
                redMemY: 0,
                redMemId: 0,
                redMemCount: 0
            },

            // Le plan d'evitement en cours. Il survit a la perte de vue :
            // seule son echeance, ou le constat que la menace est passee,
            // le ferme. Cf. `updatePlan`.
            plan: {
                kind: '',
                threatId: 0,
                threatY: 0,
                laneY: verticalPos,
                dir: 0,
                intensity: 30,
                until: 0,
                reviewAt: 0,
                coarse: false,
                idle: false,
                stuck: false,
                crossing: false
            },

            // Menaces deja jugees : reflexe tire et verdict d'inattention,
            // retenus le temps qu'elles passent. Ecrase le premier
            // emplacement libre ou perime, sinon le plus ancien — cf.
            // `vision.memorySlots` et `vision.memoryMs`. Zero ne designe
            // aucune menace : les objets s'identifient a partir de 1, les
            // karts en negatif.
            judgedId: new Array(cfg.vision.memorySlots).fill(0),
            judgedSeenAt: new Array(cfg.vision.memorySlots).fill(-Infinity),
            judgedReactAt: new Array(cfg.vision.memorySlots).fill(0),
            judgedIgnored: new Array(cfg.vision.memorySlots).fill(false),

            // Prochaine chance de prendre une decision de securite, UNE PAR
            // COTE. Ce qui se retente est la decision et non la perception
            // de celui qui la provoque — mais se ranger devant un porteur
            // et se ranger derriere un porteur sont deux decisions, prises
            // sur deux dangers. Un compteur commun les faisait s'annuler
            // l'une l'autre (cf. `updatePlan`).
            safetyRetryFrontAt: 0,
            safetyRetryBackAt: 0,
            // Prochaine reprise du couloir de tuyau. Zero : le premier
            // couloir choisi est aussitot revisable (cf. steerAroundPipes).
            pipeReviewAt: 0,

            nextWanderTime: now + randomRange(rng, 1000, 5000),
            wanderEndTime: 0,
            wanderY: 0,

            // Gain de volant sous objet de vitesse. Neutre au depart, repose
            // a chaque tick (cf. `stepPhysics`).
            steerBoost: 1,

            // Distance perdue a la contrainte de virage depuis le depart, en
            // pixels de monde. Compteur d'observation, jamais lu par le jeu.
            cornerLostPx: 0,

            lapCount: 0,
            hasPassedFinishLine: false,
            stopped: false,

            // Cinq tours pleins, plus le bout de piste qui separe la place
            // de grille de la ligne. Ce segment initial ne compte pas comme
            // un tour : il vaut moins d'une seconde.
            finishDistance: race.laps * cfg.world.width + gapToLine,
            finished: false,
            finishRank: 0,
            startStallUntil: 0,

            currentSpinFrame: 0,

            // Dernier objet recu, lu par le tirage suivant pour freiner
            // deux fois de suite le meme.
            lastItem: null
        };

        karts.push(kart);
        kartsById[index] = kart;
    });

    return {
        cameraX: parkPosition(cfg, race.parkStartOffset),
        bgCameraX: 0,
        karts: karts,
        kartsById: kartsById,
        items: [],
        itemBoxes: itemBoxes,
        pipes: pipes,
        cachedLeader: null,
        rankedCount: 0,

        phase: 'countdown',
        countdownMs: countdownMs,
        startAt: now + countdownMs,
        resultsAt: 0,
        leaderLap: 1,
        finalSignShown: false,
        flagShown: false,
        finishOrder: [],

        // Grand prix. `gpRound` est le numero de cette course dans le bloc,
        // `gpPoints` le cumul par personnage a l'entree, `racePoints` ce que
        // cette course rapporte — vide tant qu'elle n'est pas close.
        gpRound: (grandPrix && grandPrix.round) || 1,
        gpPoints: Object.assign({}, (grandPrix && grandPrix.points) || null),
        racePoints: {},
        cameraSpeed: cfg.speeds.roadPPS,
        // Panneau tenu par Lakitu : { group, frame, until }.
        sign: { group: 'start', frame: 1, until: now + countdownMs + race.goSignMs },

        nextItemId: 1,
        // Decotes en cours, par type d'objet : absent vaut 1, c'est-a-dire
        // intact. Un type n'y entre qu'une fois sorti au moins une fois.
        itemDecay: {},
        // Garde-fou de delai propre a la bleue, arme des le depart pour ne
        // rien bloquer au premier tour.
        blueShellLastAt: now - cfg.blueShell.cooldownMs,
        // Plancher de vitesse du bill : ne depend que de la config.
        billFloorSpeed: fastestBoostedSpeed(cfg) * cfg.bill.minLeadRatio,
        // Orage en cours, ou null. Un seul a la fois.
        storm: null,
        previousRanking: [],
        lastLeaderboardUpdate: 0
    };
}

export {
    createWorldState,
};
