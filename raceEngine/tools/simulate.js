// Banc d'equilibrage : enchaine des courses hors horloge avec la meme physique
// que le service.
//
//   node tools/simulate.js                    200 courses, grille au hasard
//   node tools/simulate.js --races 5000       plus d'echantillon
//   node tools/simulate.js --chain            grilles enchainees comme en prod
//   node tools/simulate.js --seed 42          tirage reproductible
//   node tools/simulate.js --csv              une ligne par course, pour tableur
//   node tools/simulate.js --track anneau     un seul circuit au lieu de tous
//
// La grille au hasard isole l'effet des statistiques ; `--chain` cumule
// l'avantage de grille comme un grand prix.

import * as PH from '../src/engine/index.js';
import CFG from '../src/config/index.js';
import * as track from '../src/track.js';

// Meme cadence que le service.
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const DT_MS = DT * 1000;

// Une course qui n'aboutit pas ne fige pas le banc.
const MAX_TICKS = Math.ceil((CFG.race.maxRaceMs + 60000) / DT_MS);

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? args[i + 1] : fallback;
}

const RACES = Math.max(1, Number(argValue('--races', 200)) || 200);
const CHAIN = args.includes('--chain');
const CSV = args.includes('--csv');
const SEED = Number(argValue('--seed', 0)) || 0;

// Circuits de tracks/, enchaines comme un grand prix (`--track` en isole un).
let TRACKS;
try {
    TRACKS = track.loadTracks(track.resolveTracksDir(import.meta.dirname), CFG);
} catch (err) {
    console.error(`Circuits illisibles : ${err.message}`);
    process.exit(1);
}
const TRACK_FILTER = argValue('--track', null);

function selectTracks() {
    if (!TRACK_FILTER) return TRACKS;

    const needle = TRACK_FILTER.toLowerCase();
    const found = TRACKS.filter(t => t.source.toLowerCase().indexOf(needle) !== -1
        || t.name.toLowerCase().indexOf(needle) !== -1);

    if (!found.length) {
        console.error(`Aucun circuit ne correspond a "${TRACK_FILTER}". Disponibles : `
            + TRACKS.map(t => t.source).join(', '));
        process.exit(1);
    }
    return found;
}

// Configs construites une fois pour toute la campagne.
const RUNNING = selectTracks();
const RACE_CFGS = RUNNING.map(t => track.applyTrack(CFG, t));

// Generateur reproductible (mulberry32) ; sans `--seed`, la graine tiree est
// affichee.
function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const seed = SEED || (Math.random() * 0xFFFFFFFF) >>> 0;
const rng = makeRng(seed);

const STATS = PH.deriveCharacterStats(CFG);
// Personnages pouvant courir ; les taux se rapportent a leurs propres
// participations.
const ROSTER = Object.keys(STATS).filter(name => CFG.roster.enabled[name]);

// Fraction de sa propre pointe sous laquelle un kart est hors rythme (la
// croisiere tourne autour de 0.94).
const SLOW_RATIO = 0.90;
// Karts par course.
const N = Math.min(CFG.roster.perRace, ROSTER.length);
const LAPS = CFG.race.laps;

// Types distribuables ; les triples sont retires (comptes via leur enfant).
const ORBIT_TYPES = Object.keys(CFG.orbitItems || {});
const ITEM_TYPES = Object.keys(CFG.itemDistribution.items)
    .filter(t => !(CFG.disabledItems || []).includes(t) && !ORBIT_TYPES.includes(t))
    .concat(['blueShell']);

// Tour reel du premier, derive des franchissements de ligne (et non de
// `state.leaderLap`) pour detecter une derive du compteur du moteur. La
// longueur du tour vient de la config de la course.
function trueLap(cfg, state) {
    let leader = null;
    for (const kart of state.karts) {
        if (!leader || kart.totalDistance > leader.totalDistance) leader = kart;
    }
    if (!leader) return 1;

    const gapToLine = leader.finishDistance - LAPS * cfg.world.width;
    const crossings = Math.floor((leader.totalDistance - gapToLine) / cfg.world.width) + 1;
    return Math.min(LAPS, Math.max(1, crossings));
}

// Pas « tranquille » : seule l'elan decide de la vitesse (pas d'objet, de bord
// ni de choc ; `bumpVx` sous 1 px/s est ignore).
const CALM_BUMP_EPS = 1;

// Un pas tranquille est de la croisiere (sur ou au-dessus de la cible d'elan,
// a CRUISE_EPS pres) ou une remontee (en dessous).
const CRUISE_EPS = 0.02;

// Sous la moitie de sa cible, le kart repart d'un arret.
const DEEP_RATIO = 0.5;

// Meme formule que `getMomentumSpeed` dans le moteur (non exportee).
function targetSpeedOf(cfg, kart) {
    const minRatio = cfg.speeds.momentumMinRatio;
    return kart.stats.topSpeed * (minRatio + (1.0 - minRatio) * kart.momentum);
}

function isCalm(cfg, kart, now) {
    return kart.state === 'running'
        && !kart.finished
        && kart.startStallUntil <= now
        && !kart.isBill
        && kart.starEndTime <= now
        && kart.boostEndTime <= now
        && kart.billSlowUntil <= now
        && kart.shrinkEndTime <= now
        && kart.brakeUntil <= now
        && kart.bumpEndTime <= now
        && Math.abs(kart.bumpVx) < CALM_BUMP_EPS
        && kart.yPercent < cfg.road.maxY
        && kart.yPercent > cfg.road.minY;
}

// ── Une course ──────────────────────────────────────────────────────────────

// Une course, rendue des que le classement est complet. Ramassage et lancer
// sont releves separement.
function runRace(startOrder, cfg) {
    const state = PH.createWorldState(cfg, rng, 0, startOrder, null);
    let simTime = 0;

    const got = {}; // type -> nombre ramasse
    const gotLap = {}; // type -> [tour] pour chaque ramassage
    const fired = {}; // type -> nombre lance
    const firedLap = {};
    const typeOfItem = new Map(); // itemId -> type, pour relier launchItem
    let lapDrift = 0; // pas ou le compteur du moteur diverge du reel

    // Tete-a-queue (`hits`) et temps passe hors rythme (`slowMs`) par kart.
    const hits = {};
    // Chocs contre un tuyau, comptes a part.
    const bumps = {};
    const slowMs = {};
    const raceMs = {};
    // Distance reellement couverte (sur `totalDistance`), pour la vitesse
    // moyenne observee.
    const dist = {};
    const prevDist = {};
    // Meme mesure sur les pas tranquilles encadres des deux cotes.
    const calmDist = {};
    const calmMs = {};
    const prevCalm = {};
    // Scission du temps tranquille : `cruiseMs + catchMs = calmMs`.
    const cruiseDist = {};
    const cruiseMs = {};
    const catchMs = {};
    const deepMs = {};
    const prevSettled = {};
    for (const kart of state.karts) {
        hits[kart.charName] = 0;
        bumps[kart.charName] = 0;
        slowMs[kart.charName] = 0;
        raceMs[kart.charName] = 0;
        dist[kart.charName] = 0;
        prevDist[kart.charName] = kart.totalDistance;
        calmDist[kart.charName] = 0;
        calmMs[kart.charName] = 0;
        prevCalm[kart.charName] = false;
        cruiseDist[kart.charName] = 0;
        cruiseMs[kart.charName] = 0;
        catchMs[kart.charName] = 0;
        deepMs[kart.charName] = 0;
        prevSettled[kart.charName] = false;
    }

    // Place de chaque kart a la fin de chaque tour (le dernier par l'ordre
    // d'arrivee).
    const lapRanks = [];
    let seenLap = 0;

    function note(bag, bagLap, type, lap) {
        bag[type] = (bag[type] || 0) + 1;
        (bagLap[type] = bagLap[type] || []).push(lap);
    }

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        simTime += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, simTime, DT);
        const lap = trueLap(cfg, state);
        if (state.leaderLap !== lap) lapDrift++;

        if (lap > seenLap) {
            if (seenLap >= 1) {
                const snap = {};
                for (const kart of state.karts) snap[kart.charName] = kart.rank;
                lapRanks[seenLap] = snap;
            }
            seenLap = lap;
        }

        // Grille et tour d'honneur exclus.
        for (const kart of state.karts) {
            // Le repere avance aussi pour les karts hors mesure.
            const moved = kart.totalDistance - prevDist[kart.charName];
            prevDist[kart.charName] = kart.totalDistance;

            const calm = isCalm(cfg, kart, simTime);
            const target = targetSpeedOf(cfg, kart);
            const settled = kart.absoluteVelocity >= target * (1 - CRUISE_EPS);

            if (calm && prevCalm[kart.charName]) {
                calmDist[kart.charName] += moved;
                calmMs[kart.charName] += DT_MS;

                // Encadre des deux cotes.
                if (settled && prevSettled[kart.charName]) {
                    cruiseDist[kart.charName] += moved;
                    cruiseMs[kart.charName] += DT_MS;
                } else {
                    catchMs[kart.charName] += DT_MS;
                    if (kart.absoluteVelocity < target * DEEP_RATIO) {
                        deepMs[kart.charName] += DT_MS;
                    }
                }
            }
            prevCalm[kart.charName] = calm;
            prevSettled[kart.charName] = settled;

            if (kart.state === 'grid' || kart.finished) continue;
            raceMs[kart.charName] += DT_MS;
            dist[kart.charName] += moved;
            if (kart.state !== 'running'
                || kart.absoluteVelocity < SLOW_RATIO * kart.stats.topSpeed) {
                slowMs[kart.charName] += DT_MS;
            }
        }

        for (const ev of events) {
            if (ev.type === 'kartHit') {
                hits[state.kartsById[ev.kartId].charName]++;
                continue;
            }
            if (ev.type === 'kartBumped') {
                bumps[state.kartsById[ev.kartId].charName]++;
                continue;
            }
            if (ev.type === 'spawnHeldItem') {
                // Garde-fou contre un double comptage.
                if (typeOfItem.has(ev.itemId)) continue;
                typeOfItem.set(ev.itemId, ev.itemType);
                note(got, gotLap, ev.itemType, lap);

            } else if (ev.type === 'launchItem') {
                const type = typeOfItem.get(ev.itemId);
                if (type) note(fired, firedLap, type, lap);

            } else if (ev.type === 'lightningCast') {
                // L'eclair sort par `lightningCast` + `removeHeldItem`, pas par
                // `launchItem`.
                note(fired, firedLap, 'lightning', lap);

            } else if (ev.type === 'raceFinished') {
                // Releve du dernier tour, a l'arrivee.
                const finalSnap = {};
                state.finishOrder.forEach((id, i) => {
                    finalSnap[state.kartsById[id].charName] = i + 1;
                });
                lapRanks[LAPS] = finalSnap;

                return {
                    lapRanks,
                    order: state.finishOrder.map(id => state.kartsById[id].charName),
                    grid: state.karts.map(k => k.charName),
                    ms: simTime,
                    got, gotLap, fired, firedLap, lapDrift, ticks: tick + 1,
                    hits, bumps, slowMs, raceMs, dist, calmDist, calmMs,
                    cruiseDist, cruiseMs, catchMs, deepMs,
                    // Distance perdue en virage, mesuree par le moteur.
                    cornerPx: Object.fromEntries(state.karts.map(k => [k.charName, k.cornerLostPx]))
                };
            }
        }
    }
    return null;
}

// ── Campagne ────────────────────────────────────────────────────────────────

const stat = {};
for (const name of ROSTER) {
    stat[name] = { races: 0, wins: 0, podium: 0, last: 0, sumPos: 0, hits: 0, bumps: 0, slowMs: 0, raceMs: 0, dist: 0, calmDist: 0, calmMs: 0,
        cruiseDist: 0, cruiseMs: 0, catchMs: 0, deepMs: 0, cornerPx: 0 };
}

// Places tour par tour : moyenne (`lapSum`) et repartition (`lapDist`).
const lapSum = {}, lapCount = {}, lapDist = {};
for (const name of ROSTER) {
    lapSum[name] = new Array(LAPS + 1).fill(0);
    lapCount[name] = new Array(LAPS + 1).fill(0);
    lapDist[name] = Array.from({ length: LAPS + 1 }, () => new Array(N).fill(0));
}

// Objets, agreges sur toute la campagne.
const itemTotal = {}; // type -> total ramasse
const itemFiredTotal = {}; // type -> total lance
const itemPerRace = {}; // type -> [compte par course]
const lapHist = {}; // type -> tour -> nombre (au ramassage)
const lapHistFired = {}; // type -> tour -> nombre (au lancer)
for (const t of ITEM_TYPES) {
    itemTotal[t] = 0; itemFiredTotal[t] = 0; itemPerRace[t] = [];
    lapHist[t] = new Array(LAPS + 1).fill(0);
    lapHistFired[t] = new Array(LAPS + 1).fill(0);
}

// Ecart entre place de depart et d'arrivee (poids de la grille).
const gridPairs = [];
let aborted = 0;
let totalMs = 0;

// Controles de coherence entre le moteur et le banc.
let lapDriftTicks = 0;
let totalTicks = 0;

let startOrder = null;
const started = Date.now();

if (CSV) console.log('course,' + Array.from({ length: N }, (_, i) => 'p' + (i + 1)).join(',')
    + ',bleues,eclairs');

for (let r = 0; r < RACES; r++) {
    // Tirage de production ; en mode enchaine, la grille reprend l'arrivee
    // precedente a l'interieur d'un grand prix.
    const cfg = RACE_CFGS[r % RACE_CFGS.length];
    const opensGrandPrix = r % CFG.grandPrix.races === 0;
    const grid = CHAIN && startOrder && !opensGrandPrix
        ? startOrder
        : PH.pickRoster(cfg, rng, null);
    const race = runRace(grid, cfg);

    if (!race) { aborted++; continue; }
    totalMs += race.ms;
    lapDriftTicks += race.lapDrift;
    totalTicks += race.ticks;

    for (let lap = 1; lap <= LAPS; lap++) {
        const snap = race.lapRanks[lap];
        if (!snap) continue;
        for (const name in snap) {
            const pos = snap[name];
            if (!(pos >= 1 && pos <= N)) continue;
            lapSum[name][lap] += pos;
            lapCount[name][lap]++;
            lapDist[name][lap][pos - 1]++;
        }
    }

    for (const name of race.grid) stat[name].races++;

    for (const name of ROSTER) {
        stat[name].hits += race.hits[name] || 0;
        stat[name].bumps += race.bumps[name] || 0;
        stat[name].slowMs += race.slowMs[name] || 0;
        stat[name].raceMs += race.raceMs[name] || 0;
        stat[name].dist += race.dist[name] || 0;
        stat[name].calmDist += race.calmDist[name] || 0;
        stat[name].calmMs += race.calmMs[name] || 0;
        stat[name].cruiseDist += race.cruiseDist[name] || 0;
        stat[name].cruiseMs += race.cruiseMs[name] || 0;
        stat[name].catchMs += race.catchMs[name] || 0;
        stat[name].deepMs += race.deepMs[name] || 0;
        stat[name].cornerPx += (race.cornerPx && race.cornerPx[name]) || 0;
    }

    race.order.forEach((name, index) => {
        const s = stat[name];
        s.sumPos += index + 1;
        if (index === 0) s.wins++;
        if (index < 3) s.podium++;
        if (index === N - 1) s.last++;
        gridPairs.push([race.grid.indexOf(name) + 1, index + 1]);
    });

    for (const t of ITEM_TYPES) {
        const n = race.got[t] || 0;
        itemTotal[t] += n;
        itemPerRace[t].push(n);
        itemFiredTotal[t] += race.fired[t] || 0;
        for (const lap of (race.gotLap[t] || [])) {
            if (lap >= 1 && lap <= LAPS) lapHist[t][lap]++;
        }
        for (const lap of (race.firedLap[t] || [])) {
            if (lap >= 1 && lap <= LAPS) lapHistFired[t][lap]++;
        }
    }

    if (CSV) console.log((r + 1) + ',' + race.order.join(',')
        + ',' + (race.got.blueShell || 0) + ',' + (race.got.lightning || 0));
    startOrder = race.order;
}

const done = RACES - aborted;
const elapsed = (Date.now() - started) / 1000;

// Aucune course close : une course n'atteint pas sa condition d'arret.
if (done === 0) {
    console.error(`\nAucune des ${RACES} courses n'a abouti en ${MAX_TICKS} pas simules.`);
    console.error('La condition d\'arret n\'est jamais atteinte : verifier race.stopAtFinisher');
    console.error('et race.maxRaceMs dans src/config/world.js, ainsi que la longueur des circuits');
    console.error('de tracks/ — cinq tours d\'un trace trop long depassent le delai maximum.');
    process.exit(1);
}

if (CSV) process.exit(0);

// ── Rapport ─────────────────────────────────────────────────────────────────

function pct(n, d) { return d ? (100 * n / d) : 0; }
function pad(s, w) { return String(s).padEnd(w); }
function padL(s, w) { return String(s).padStart(w); }

const p0 = 1 / N;
// Ecart-type attendu d'un taux de victoire si tous les karts se valaient, sur
// les courses courues par ce kart.
const sigmaOf = runs => Math.sqrt(p0 * (1 - p0) / Math.max(runs, 1)) * 100;
const meanRuns = done * N / Math.max(ROSTER.length, 1);
const sigma = sigmaOf(meanRuns);
// Par course courue.
const per = (v, s) => v / Math.max(s.races, 1);

const grandTotal = ITEM_TYPES.reduce((s, t) => s + itemTotal[t], 0);

// Controles de coherence (validite de la mesure).
const health = [];
if (grandTotal === 0) {
    health.push('Aucun objet compte : l\'evenement `spawnHeldItem` a disparu ou change de nom.');
}
if (lapDriftTicks > totalTicks * 0.02) {
    health.push(`state.leaderLap diverge du tour reel sur ${pct(lapDriftTicks, totalTicks).toFixed(0)} % des pas :`
        + ' le compteur du moteur ne suit plus la course.');
}

console.log('');
if (health.length) {
    console.log('/!\\  Coherence moteur/harnais');
    for (const h of health) console.log('     ' + h);
    console.log('');
}
console.log(`Banc d'equilibrage — ${done} courses` + (aborted ? ` (${aborted} abandonnees)` : ''));
console.log(`grille : ${CHAIN ? 'enchainee (vainqueur en pole)' : 'tiree au sort a chaque course'}`
    + `   graine : ${seed}`);
// Nombre de tuyaux affiche : principal facteur d'ecart entre campagnes.
console.log(`circuits : ${RUNNING.map(t => `${t.name} (${t.columns} col, `
    + `${t.pipes.length} pipe${t.pipes.length > 1 ? 's' : ''})`).join(', ')}`
    + (RUNNING.length > 1 ? '   enchaines a tour de role' : ''));
console.log(`temps simule : ${Math.round(totalMs / 1000)} s   temps reel : ${elapsed.toFixed(1)} s`
    + `   acceleration : x${Math.round(totalMs / 1000 / Math.max(elapsed, 0.001))}`);

// ── Karts ───────────────────────────────────────────────────────────────────

const rows = ROSTER.slice().sort((a, b) => stat[b].wins - stat[a].wins);
const w = Math.max(...ROSTER.map(n => n.length), 6);

console.log('');
console.log(pad('kart', w) + padL('poi/pui/man', 13)
    + padL('top', 6) + padL('acc', 6) + padL('agi', 6) + padL('tenue', 8) + padL('masse', 7)
    + padL('victoires', 12) + padL('podium', 9) + padL('dernier', 9) + padL('place moy.', 12)
    + padL('courues', 9));
console.log('-'.repeat(w + 13 + 6 + 6 + 6 + 8 + 7 + 12 + 9 + 9 + 12 + 9));

for (const name of rows) {
    const s = stat[name];
    const c = STATS[name];
    const winPct = pct(s.wins, s.races || 1);
    // Ecart a l'attendu en ecarts-types (au-dela de 2 : significatif).
    const sig = sigmaOf(s.races);
    const z = sig > 0 ? (winPct - 100 * p0) / sig : 0;
    const flag = Math.abs(z) >= 2 ? (z > 0 ? ' ++' : ' --') : '   ';

    console.log(
        pad(name, w)
        + padL(`${c.raw.weight}/${c.raw.power}/${c.raw.handling}`, 13)
        + padL(Math.round(c.topSpeed), 6) + padL(c.acceleration.toFixed(2), 6)
        + padL(c.agility.toFixed(2), 6) + padL(c.cornering.toFixed(2), 8)
        + padL(c.mass.toFixed(2), 7)
        + padL(winPct.toFixed(1) + ' %' + flag, 12)
        + padL(pct(s.podium, s.races || 1).toFixed(1) + ' %', 9)
        + padL(pct(s.last, s.races || 1).toFixed(1) + ' %', 9)
        + padL(per(s.sumPos, s).toFixed(2), 12)
        + padL(s.races, 9)
    );
}

console.log('');
console.log(`budget : ${CFG.kartStats.budget} points par kart, chaque axe dans `
    + `[${CFG.kartStats.minPoints}, ${CFG.kartStats.maxPoints}]`);
console.log('  tenue : `stats.cornering`, ce qui tient le kart quand il tourne —');
console.log('  plus c\'est HAUT, moins tourner lui coute. C\'est un diviseur, pas une');
console.log('  perte. Ce que le virage coute vraiment se lit plus bas, colonne `virage`.');

// Couts de course : chocs et temps hors rythme.
console.log('');
console.log('Ce que la course coute a chaque kart');
console.log(pad('kart', w) + padL('agi', 6) + padL('touches', 10) + padL('pipes', 8)
    + padL('virage', 9) + padL('% dist.', 9)
    + padL('hors rythme', 13) + padL('part de course', 16)
    + padL('vit. moy.', 11) + padL('% pointe', 10)
    + padL('vit. tranq.', 13) + padL('% pointe', 10) + padL('part tranq.', 13));
console.log('-'.repeat(w + 6 + 10 + 8 + 9 + 9 + 13 + 16 + 11 + 10 + 13 + 10 + 13));
for (const name of rows) {
    const s = stat[name];
    const meanSpeed = s.raceMs ? s.dist / (s.raceMs / 1000) : 0;
    const calmSpeed = s.calmMs ? s.calmDist / (s.calmMs / 1000) : 0;
    console.log(pad(name, w)
        + padL(STATS[name].agility.toFixed(2), 6)
        + padL(per(s.hits, s).toFixed(2), 10)
        + padL(per(s.bumps, s).toFixed(2), 8)
        + padL(Math.round(per(s.cornerPx, s)) + ' px', 9)
        + padL(pct(s.cornerPx, s.dist + s.cornerPx).toFixed(2) + ' %', 9)
        + padL((per(s.slowMs, s) / 1000).toFixed(1) + ' s', 13)
        + padL(pct(s.slowMs, s.raceMs).toFixed(1) + ' %', 16)
        + padL(Math.round(meanSpeed), 11)
        + padL(pct(meanSpeed, STATS[name].topSpeed).toFixed(1) + ' %', 10)
        + padL(Math.round(calmSpeed), 13)
        + padL(pct(calmSpeed, STATS[name].topSpeed).toFixed(1) + ' %', 10)
        + padL(pct(s.calmMs, s.raceMs).toFixed(1) + ' %', 13));
}
console.log('');
console.log(`  touches : tete-a-queue subis par course. pipes : chocs contre un`);
console.log(`  tuyau, par course. virage : distance perdue par course a la`);
console.log(`  contrainte de virage (physics.steer.corner), relevee dans le moteur`);
console.log(`  et non estimee — c'est la seule facon d'en avoir un chiffre qui ne`);
console.log(`  mente pas quand on change les exposants. % dist. : ce que cela`);
console.log(`  represente de la distance qu'il aurait couverte sans elle.`);
console.log(`  hors rythme : temps passe`);
console.log(`  sous ${(SLOW_RATIO * 100).toFixed(0)} % de sa propre pointe, arret et relance compris.`);
console.log('  vit. moy. : distance reellement couverte divisee par le temps passe en');
console.log('  course, grille et tour d\'honneur exclus. % pointe : ce que cela');
console.log('  represente de sa vitesse de pointe — c\'est la part de sa pointe que le');
console.log('  kart exploite vraiment, une fois les objets et le trafic deduits.');
console.log('  vit. tranq. : la meme mesure, mais sur les seuls pas ou rien d\'autre');
console.log('  que l\'elan ne decide de la vitesse — ni objet, ni choc, ni bord de');
console.log('  piste, ni freinage. C\'est le rythme de croisiere nu, celui que');
console.log('  `momentum` produit a lui seul. part tranq. : la part de la course');
console.log('  passee dans ce regime — un kart souvent bouscule la voit fondre.');
// Decomposition du regime tranquille : croisiere pure et remontee apres arret.
console.log('');
console.log('Le regime tranquille, decompose');
console.log(pad('kart', w) + padL('acc', 6) + padL('croisiere', 11) + padL('% pointe', 10)
    + padL('rattrapage', 12) + padL('dont relance', 14) + padL('vit. tranq.', 13));
console.log('-'.repeat(w + 6 + 11 + 10 + 12 + 14 + 13));
for (const name of rows) {
    const s = stat[name];
    const cruiseSpeed = s.cruiseMs ? s.cruiseDist / (s.cruiseMs / 1000) : 0;
    const calmSpeed = s.calmMs ? s.calmDist / (s.calmMs / 1000) : 0;
    console.log(pad(name, w)
        + padL(STATS[name].acceleration.toFixed(2), 6)
        + padL(Math.round(cruiseSpeed), 11)
        + padL(pct(cruiseSpeed, STATS[name].topSpeed).toFixed(1) + ' %', 10)
        + padL((per(s.catchMs, s) / 1000).toFixed(1) + ' s', 12)
        + padL((per(s.deepMs, s) / 1000).toFixed(1) + ' s', 14)
        + padL(Math.round(calmSpeed), 13));
}
console.log('');
console.log('  croisiere : vitesse tenue pendant les seuls pas ou le kart est deja');
console.log('  sur sa cible d\'elan. rattrapage : temps par course passe tranquille');
console.log('  mais SOUS cette cible — le moteur n\'a rien pour le signaler, seule la');
console.log('  cible le revele. dont relance : la part de ce rattrapage passee sous');
console.log(`  ${(DEEP_RATIO * 100).toFixed(0)} % de la cible, soit un redemarrage apres arret et non un`);
console.log('  simple retard de suivi.');
const cruiseRatios = ROSTER.map(n => stat[n].cruiseMs
    ? 100 * (stat[n].cruiseDist / (stat[n].cruiseMs / 1000)) / STATS[n].topSpeed : 0);
const cruiseSpread = Math.max(...cruiseRatios) - Math.min(...cruiseRatios);
console.log(`  ecart de croisiere entre le meilleur et le pire : ${cruiseSpread.toFixed(1)} point`
    + ' de sa propre pointe.');
console.log(cruiseSpread < 1
    ? '  Sous un point : le regime de croisiere est le meme pour tous, et tout'
      + ' l\'ecart\n  de vitesse tranquille vient du rattrapage.'
    : '  Au-dessus d\'un point : suivre sa cible coute vraiment quelque chose, et'
      + ' l\'acceleration\n  agit sur la vitesse et pas seulement sur la relance.');

console.log(`attendu si tous egaux : ${(100 * p0).toFixed(1)} % de victoires, place moyenne ${((N + 1) / 2).toFixed(2)}`);
console.log(`bruit d'echantillonnage a ${Math.round(meanRuns)} courses courues par kart `
    + `(${N} places, ${ROSTER.length} personnages) : +/- ${sigma.toFixed(1)} point (1 ecart-type)`);
console.log('  ++ / -- signale un ecart d\'au moins 2 ecarts-types, soit ce qui ne s\'explique plus par le hasard');

// Trajectoire : place moyenne tour apres tour.
console.log('');
console.log('Place moyenne a la fin de chaque tour');
console.log(pad('kart', w) + Array.from({ length: LAPS }, (_, i) => padL('T' + (i + 1), 8)).join('')
    + padL('T1 -> T' + LAPS, 12));
console.log('-'.repeat(w + 8 * LAPS + 12));
for (const name of rows) {
    const mean = lap => lapCount[name][lap] ? lapSum[name][lap] / lapCount[name][lap] : 0;
    const drift = mean(LAPS) - mean(1);
    console.log(pad(name, w)
        + Array.from({ length: LAPS }, (_, i) => padL(mean(i + 1).toFixed(2), 8)).join('')
        + padL((drift >= 0 ? '+' : '') + drift.toFixed(2), 12));
}
console.log('');
console.log(`  T${LAPS} est l'arrivee. La derniere colonne est le deplacement net :`);
console.log('  negatif = le kart gagne des places au fil de la course, positif = il en perd.');

console.log('');
console.log('Repartition des places, tour par tour (%)');
for (let lap = 1; lap <= LAPS; lap++) {
    console.log('');
    console.log(`  fin du tour ${lap}` + (lap === LAPS ? ' (arrivee)' : ''));
    console.log('  ' + pad('kart', w) + Array.from({ length: N }, (_, i) => padL('P' + (i + 1), 7)).join(''));
    console.log('  ' + '-'.repeat(w + 7 * N));
    for (const name of rows) {
        const tot = lapCount[name][lap] || 1;
        console.log('  ' + pad(name, w)
            + lapDist[name][lap].map(v => padL(pct(v, tot).toFixed(1), 7)).join(''));
    }
}

// ── Objets ──────────────────────────────────────────────────────────────────

const iw = Math.max(...ITEM_TYPES.map(t => t.length), 10);

console.log('');
console.log('Objets recus, moyenne par course');
console.log(pad('objet', iw) + padL('par course', 12) + padL('part', 8) + padL('lances', 9));
console.log('-'.repeat(iw + 12 + 8 + 9));

for (const t of ITEM_TYPES.slice().sort((a, b) => itemTotal[b] - itemTotal[a])) {
    console.log(pad(t, iw)
        + padL((itemTotal[t] / done).toFixed(2), 12)
        + padL(pct(itemTotal[t], grandTotal).toFixed(1) + ' %', 8)
        + padL((itemFiredTotal[t] / done).toFixed(2), 9));
}

// Bleue et eclair, rares, traites a part.
const RARE = ['blueShell', 'lightning'].filter(t => ITEM_TYPES.includes(t));

if (RARE.length) {
    console.log('');
    console.log('Bleue et eclair — frequence');
    console.log(pad('objet', iw) + padL('par course', 12) + padL('0', 8) + padL('1', 8)
        + padL('2', 8) + padL('3+', 8) + padL('tour moy.', 11));
    console.log('-'.repeat(iw + 12 + 8 * 4 + 11));

    for (const t of RARE) {
        const counts = itemPerRace[t];
        const buckets = [0, 0, 0, 0];
        for (const n of counts) buckets[Math.min(n, 3)]++;

        let sumLap = 0, nLap = 0;
        for (let lap = 1; lap <= LAPS; lap++) { sumLap += lap * lapHist[t][lap]; nLap += lapHist[t][lap]; }

        console.log(pad(t, iw)
            + padL((itemTotal[t] / done).toFixed(2), 12)
            + buckets.map(b => padL(pct(b, done).toFixed(0) + ' %', 8)).join('')
            + padL(nLap ? (sumLap / nLap).toFixed(2) : '-', 11));
    }

    console.log('');
    console.log('Bleue et eclair — tour ou l\'objet est recu (% de ses apparitions)');
    console.log(pad('objet', iw) + Array.from({ length: LAPS }, (_, i) => padL('T' + (i + 1), 8)).join(''));
    console.log('-'.repeat(iw + 8 * LAPS));
    for (const t of RARE) {
        const tot = itemTotal[t] || 1;
        console.log(pad(t, iw)
            + Array.from({ length: LAPS }, (_, i) => padL(pct(lapHist[t][i + 1], tot).toFixed(0), 8)).join(''));
    }

    console.log('');
    console.log('Bleue et eclair — tour ou l\'objet part (% de ses lancers)');
    console.log(pad('objet', iw) + Array.from({ length: LAPS }, (_, i) => padL('T' + (i + 1), 8)).join(''));
    console.log('-'.repeat(iw + 8 * LAPS));
    for (const t of RARE) {
        const tot = itemFiredTotal[t] || 1;
        console.log(pad(t, iw)
            + Array.from({ length: LAPS }, (_, i) => padL(pct(lapHistFired[t][i + 1], tot).toFixed(0), 8)).join(''));
    }
}

// ── Grille ──────────────────────────────────────────────────────────────────

if (gridPairs.length > 1) {
    const n = gridPairs.length;
    const mx = gridPairs.reduce((s, p) => s + p[0], 0) / n;
    const my = gridPairs.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (const [x, y] of gridPairs) {
        num += (x - mx) * (y - my); dx += (x - mx) ** 2; dy += (y - my) ** 2;
    }
    const r = (dx && dy) ? num / Math.sqrt(dx * dy) : 0;
    console.log('');
    console.log(`Correlation place de depart -> place d'arrivee : r = ${r.toFixed(3)}`);
    console.log(r > 0.5
        ? '  Forte : la course se joue largement sur la grille.'
        : (r > 0.2
            ? '  Moderee : la grille compte, sans decider.'
            : '  Faible : la grille de depart ne determine pas le resultat.'));
}

console.log('');
