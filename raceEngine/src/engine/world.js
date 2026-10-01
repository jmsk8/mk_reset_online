// Creation d'un monde : grille de depart, karts, decor, circuit.

import { randomRange, shuffleArray } from './math.js';
import { parkPosition } from './geometry.js';
import { deriveCharacterStats, fastestBoostedSpeed, getNewMomentumTarget } from './stats.js';
import { laneY } from './driving.js';
import { shadowCount, shadowFrom, shadowHi, shadowLo, shadowTo } from './vision.js';
import { countdownDuration } from './race.js';

// Personnages de la course, dans l'ordre de la grille. `startOrder` (arrivee de
// la manche precedente) est repris tel quel pendant un grand prix ; absent ou
// invalide, on tire `roster.perRace` karts au sort.
function pickRoster(cfg, rng, startOrder) {
    const spec = cfg.roster;
    const known = Object.keys(deriveCharacterStats(cfg));

    // L'interrupteur doit couvrir exactement les personnages en config.
    if (!spec || !spec.enabled) {
        throw new Error('cfg.roster.enabled manquant : raceEngine/src/config/bodies.js');
    }
    for (const name of known) {
        if (typeof spec.enabled[name] !== 'boolean') {
            throw new Error(`roster.enabled : ${name} n'y figure pas (true ou false)`);
        }
    }
    for (const name of Object.keys(spec.enabled)) {
        if (!known.includes(name)) {
            throw new Error(`roster.enabled : ${name} n'est pas dans kartStats.characters`);
        }
    }
    if (!Number.isInteger(spec.perRace) || spec.perRace < 1) {
        throw new Error(`roster.perRace vaut ${spec.perRace} : un entier >= 1 est attendu`);
    }

    const enabled = known.filter(name => spec.enabled[name]);
    if (!enabled.length) {
        throw new Error('roster.enabled : aucun personnage actif, pas de course possible');
    }
    const size = Math.min(spec.perRace, enabled.length);

    const keeps = startOrder
        && startOrder.length === size
        && new Set(startOrder).size === size
        && startOrder.every(name => spec.enabled[name] === true);
    if (keeps) return startOrder.slice();

    return shuffleArray(enabled, rng).slice(0, size);
}

// `grandPrix` : bloc en cours ({ round, points }) ; absent, nouveau bloc.
function createWorldState(cfg, rng, now, startOrder, grandPrix) {
    const roadHeight = cfg.road.maxY - cfg.road.minY;
    const race = cfg.race;
    const countdownMs = countdownDuration(race);

    // Le circuit (src/track.js) est obligatoire.
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

    // Tuyaux recopies dans l'etat avec le reste du monde.
    const pipes = (cfg.world.pipes || []).map(pipe => ({
        worldX: pipe.x,
        y: pipe.y,
        // Couleur, pour le decor seulement.
        kind: pipe.kind || 'green'
    }));

    const statsTable = deriveCharacterStats(cfg);
    const names = pickRoster(cfg, rng, startOrder);

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

            // Elan mis de cote pendant un objet de vitesse (-1 : rien en attente).
            preBoostMomentum: -1,
            preBoostDriftLeft: 0,
            vy: 0,
            targetVy: 0,

            // Canaux de choc, separes du volant : `bumpVy` en profondeur/s,
            // `bumpVx` en px/s, amortis seuls.
            bumpVy: 0,
            bumpVx: 0,

            // Vitesse reelle le long de la piste sur le tick (px/s), pour les contacts.
            contactSpeed: 0,

            state: 'grid',
            rank: index + 1,

            aiState: 'cruising',

            hitEndTime: 0,
            // Duree, vitesse gardee et sursis du dernier coup (`hits`).
            hitDuration: 0,
            hitKeepSpeed: 0,
            hitInvincibleMs: 0,

            // Choc contre un tuyau : arret net, recul restant, sursis par tuyau.
            bumpEndTime: 0,
            bumpRecoilLeft: 0,
            bumped: false,

            // Ecrase par un kart reste grand (jamais au-dela du rapetissement).
            flatEndTime: 0,
            isFlat: false,

            // Toupie bloquee contre un tuyau.
            pipeBlocked: false,
            pipeImmuneUntil: 0,
            lastPipeIndex: -1,

            // Tuyau en cours de contournement et couloir choisi.
            pipeTargetIndex: -1,
            pipeLaneY: 0,

            heldItem: null,
            throwTime: 0,
            pendingItemGrantTime: 0,

            boostEndTime: 0,
            starEndTime: 0,
            isInvincible: false,
            hitInvincibleUntil: 0,

            // Rapetissement par l'eclair (date pour la simulation, booleen pour le snapshot).
            shrinkEndTime: 0,
            isShrunk: false,

            // Bill : `billAhead` = karts restant a doubler.
            isBill: false,
            billStartedAt: 0,
            billEndTime: 0,
            billSlowUntil: 0,
            billAhead: [],

            trailTime: 0,
            brakeUntil: 0,

            // Dernier passage dans une zone de boites (`vision.boxGlanceMs`) et
            // episode de danger deja tranche.
            boxPassedAt: -Infinity,
            shieldAt: -Infinity,
            shieldHold: false,

            // Severite du frein en cours et prochaine decision de ceder (`vision.giveWay`).
            brakeFactor: 0,
            giveWayRetryAt: 0,
            shotDirection: 1,
            // Plan de tir fait en tete.
            shotAsLeader: false,
            lobbing: false,
            aimError: 0,

            // Releve d'un tir vers l'arriere : profondeur et date (`vision.aimMemoryMs`).
            aimTargetY: 0,
            aimTargetAt: -Infinity,

            // Perception du dernier balayage ; dates de depart decalees par kart.
            sight: {
                at: now - cfg.vision.scanIntervalMs
                    + Math.round(index * cfg.vision.scanIntervalMs / names.length),
                back: false,
                backUntil: 0,

                // Sens du dernier balayage (`back` : attention du moment).
                scanBack: false,

                nextGlance: now
                    + Math.round(index * cfg.vision.glanceIntervalMs / names.length),

                // Dernier coup d'oeil arriere (autorise la visee arriere).
                seenKartY: 0,
                seenKartDist: -1,

                threatId: 0,
                threatKind: '',
                threatY: 0,
                threatTtc: Infinity,
                planGone: false,

                spans: [],
                spanCount: 0,

                // Corps caches par l'ombre d'un plus proche (observation seulement).
                hiddenIds: [],
                hiddenCount: 0,

                // Ombres du balayage : pentes depuis l'oeil et distances (observation).
                shadowLo: [],
                shadowHi: [],
                shadowFrom: [],
                shadowTo: [],
                shadowCount: 0,

                // Position de la camera pendant le balayage.
                eyeBack: 0,
                eyeY: 0,

                // Portee du balayage courant.
                scanRange: 0,

                // Profondeurs des karts voisins (`vision.crowd`).
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
                // Porteur dans le dos (peut tirer) ou devant (peut lacher).
                pressureBack: false,
                // Distance dans le sens du regard.
                pressureDist: 0,

                // Porteur qui nous suit, et depuis quand (pose par un balayage arriere).
                carrierAt: -Infinity,
                carrierY: 0,
                carrierId: 0,
                carrierDist: 0,

                // Porteur qu'on suit, et depuis quand (pose par un balayage avant).
                frontAt: -Infinity,
                frontY: 0,
                frontId: 0,

                // Danger apercu derriere, et depuis quand (`dangerSince` : debut
                // de l'episode) :
                //   'shot'    carapace en vol
                //   'carrier' porteur derriere
                //   'ram'     etoile ou bill
                dangerAt: -Infinity,
                dangerSince: -Infinity,
                dangerKind: '',

                // Rouges apercues derriere : la plus proche, et combien (`vision.giveWay`).
                redBehindDist: -1,
                redBehindY: 0,
                redBehindId: 0,
                redBehindCount: 0,

                // Souvenir des rouges, meme peremption que `dangerAt`.
                redMemAt: -Infinity,
                redMemDist: -1,
                redMemY: 0,
                redMemId: 0,
                redMemCount: 0,

                // Kart le plus proche derriere et ce qu'il gagne en px/s (bleue).
                rearKartDist: -1,
                rearKartY: 0,
                rearKartId: 0,
                rearKartRel: 0,
                rearMemAt: -Infinity,
                rearMemDist: -1,
                rearMemY: 0,
                rearMemId: 0,
                rearMemRel: 0
            },

            // Ce qu'il entend (voir `hear`).
            alert: {
                // Etoile ou bill dans le dos : le plus pressant et son delai ;
                // `watch` : suivi du regard jusqu'a la decision.
                ram: false,
                ramTtc: Infinity,
                ramId: -1,
                ramAt: -Infinity,
                ramStartled: false,
                watch: false,

                // Coup d'oeil immediat (consomme par `updateGlance`).
                startle: false,

                // Rouge qui le vise, jugee a la premiere ecoute.
                redId: 0,
                redReactAt: 0,
                redIgnored: false,
                red: false,

                // Bleue qui le concerne, jugee a la premiere ecoute (`hearBlue`).
                blueId: 0,
                blueReactAt: 0,
                blueIgnored: false,
                blueBias: 1,
                blueYield: false,
                blueStartled: false,
                // Etat de la bleue a ce pas.
                blue: false,
                blueEta: Infinity,
                blueOnMe: false,
                bluePhase: '',
                blueLook: false,
                // Reaction : '' rien, 'cover' garde l'objet, 'yield' cede la tete,
                // 'hang' reste en retrait (`updateBlue`).
                blueMode: '',
                blueFireAt: 0,
                savedThrowTime: 0,
                yieldBlueId: 0,
                yieldTriedId: 0,
                yieldUntil: 0,
                hangUntil: 0
            },

            // Plan d'evitement en cours (`updatePlan`).
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

            // Menaces deja jugees (`vision.memorySlots`, `vision.memoryMs`) ;
            // 0 = aucune, objets a partir de 1, karts en negatif.
            judgedId: new Array(cfg.vision.memorySlots).fill(0),
            judgedSeenAt: new Array(cfg.vision.memorySlots).fill(-Infinity),
            judgedReactAt: new Array(cfg.vision.memorySlots).fill(0),
            judgedIgnored: new Array(cfg.vision.memorySlots).fill(false),

            // Prochaine decision de securite, une par cote.
            safetyRetryFrontAt: 0,
            safetyRetryBackAt: 0,
            // Prochaine revision du couloir de tuyau.
            pipeReviewAt: 0,

            nextWanderTime: now + randomRange(rng, 1000, 5000),
            wanderEndTime: 0,
            wanderY: 0,

            // Gain de volant sous objet de vitesse (pose a chaque tick).
            steerBoost: 1,

            // Distance perdue en virage, en px (observation).
            cornerLostPx: 0,

            lapCount: 0,
            hasPassedFinishLine: false,
            stopped: false,

            // Cinq tours plus la distance de la grille a la ligne.
            finishDistance: race.laps * cfg.world.width + gapToLine,
            finished: false,
            // Zone de dernier tour (race.js).
            finalLapSign: false,
            finishRank: 0,
            startStallUntil: 0,

            currentSpinFrame: 0,

            // Dernier objet recu, pour eviter deux fois le meme.
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

        // Grand prix : numero de la course, cumul par personnage, points de la course.
        gpRound: (grandPrix && grandPrix.round) || 1,
        gpPoints: Object.assign({}, (grandPrix && grandPrix.points) || null),
        racePoints: {},
        cameraSpeed: cfg.speeds.roadPPS,
        // Panneau de Lakitu : { group, frame, until }.
        sign: { group: 'start', frame: 1, until: now + countdownMs + race.goSignMs },

        nextItemId: 1,
        // Decotes par type d'objet (absent = 1).
        itemDecay: {},
        // Delai de la bleue, arme des le depart.
        blueShellLastAt: now - cfg.blueShell.cooldownMs,
        billFloorSpeed: fastestBoostedSpeed(cfg) * cfg.bill.minLeadRatio,
        // Orage en cours, ou null.
        storm: null,
        previousRanking: [],
        lastLeaderboardUpdate: 0
    };
}

export {
    createWorldState,
    pickRoster,
};
