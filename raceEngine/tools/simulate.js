'use strict';

// Banc d'essai d'equilibrage.
//
// Enchaine des courses hors horloge : la meme physique que le service, mais
// avancee en boucle serree au lieu d'un setInterval. Une course de 77 secondes
// simulees passe en quelques millisecondes, ce qui rend mesurable ce qu'un soak
// en temps reel ne donnerait qu'apres des heures.
//
//   node tools/simulate.js                    200 courses, grille au hasard
//   node tools/simulate.js --races 5000       plus d'echantillon
//   node tools/simulate.js --chain            grilles enchainees comme en prod
//   node tools/simulate.js --seed 42          tirage reproductible
//   node tools/simulate.js --csv              une ligne par course, pour tableur
//
// Deux facons de mesurer, et elles ne repondent pas a la meme question :
//
//   grille au hasard (defaut) — chaque course repart d'un tirage neuf. C'est ce
//     qu'il faut pour juger les statistiques des karts : la place de depart ne
//     vient plus polluer le resultat.
//
//   --chain — le vainqueur repart en pole, comme le service le fait entre deux
//     courses d'un grand prix. C'est ce qui se passe reellement a l'ecran, mais
//     l'avantage de grille s'y cumule et masque la part des statistiques.

const path = require('path');
const fs = require('fs');

function loadShared(name) {
    const candidates = ['..', '../../frontEnd/static/js'];
    for (const dir of candidates) {
        const full = path.join(__dirname, dir, name);
        if (fs.existsSync(full)) return require(full);
    }
    throw new Error(`${name} introuvable (cherche dans : ${candidates.join(', ')})`);
}

const PH = loadShared('physics.js');
const CFG = loadShared('physics-config.js');

// Meme cadence que le service : changer l'une sans l'autre ferait mesurer une
// physique qui n'est pas celle qui tourne.
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const DT_MS = DT * 1000;

// Garde-fou : une course qui n'aboutit pas ne doit pas figer le banc.
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

// Generateur reproductible (mulberry32) : deux campagnes lancees avec la meme
// graine donnent le meme resultat, ce qui permet de comparer deux reglages sans
// que le hasard s'en mele. Sans `--seed`, on tire une graine au depart et on
// l'affiche, pour pouvoir rejouer la campagne telle quelle.
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
const ROSTER = Object.keys(STATS);

// En dessous de cette fraction de sa propre pointe, un kart est considere comme
// hors rythme. Rapporte a sa pointe et non a une vitesse absolue : sinon un kart
// lent serait compte en retard en permanence, et la mesure ne dirait plus rien
// du temps perdu. La croisiere tourne autour de 0.94, d'ou ce seuil juste en
// dessous : il attrape l'arret et la relance, pas les creux d'elan ordinaires.
const SLOW_RATIO = 0.90;
const N = ROSTER.length;
const LAPS = CFG.race.laps;

// Types distribuables, dans l'ordre de la config. `blueShell` n'y figure pas :
// elle a son propre tirage, hors de la table des poids.
//
// Les objets en orbite (les triples) sont retires de la liste : ils annoncent le
// type de leur enfant et non le leur, si bien qu'un triple banane arrive dans
// les compteurs comme trois bananes. C'est la bonne mesure — trois bananes
// larguees valent trois bananes — mais le type « triple » lui-meme resterait a
// zero et donnerait une ligne trompeuse.
const ORBIT_TYPES = Object.keys(CFG.orbitItems || {});
const ITEM_TYPES = Object.keys(CFG.itemDistribution.items)
    .filter(t => !(CFG.disabledItems || []).includes(t) && !ORBIT_TYPES.includes(t))
    .concat(['blueShell']);

// Tour reel du premier, recalcule ici au lieu de lire `state.leaderLap`.
//
// Un banc de mesure ne doit pas recopier le compteur qu'il observe : c'est
// exactement ainsi qu'un compteur fige passe inapercu. En le derivant des
// distances, une derive du moteur devient visible au lieu d'etre reproduite —
// le controle de coherence plus bas s'en sert.
//
// Le tour se compte en franchissements de ligne, et non en distance parcourue :
// la grille place les karts en amont de la ligne, si bien que leur premiere
// traversee ne couvre pas un tour mais seulement ce bout de piste. Compter en
// distance decalait le changement de tour de 392 unites en moyenne, soit 4 %
// de la course — assez pour declencher l'alerte de coherence a chaque campagne.
// `finishDistance` porte cet ecart, on l'y retrouve sans avoir a le transporter.
function trueLap(state) {
    let leader = null;
    for (const kart of state.karts) {
        if (!leader || kart.totalDistance > leader.totalDistance) leader = kart;
    }
    if (!leader) return 1;

    const gapToLine = leader.finishDistance - LAPS * CFG.world.width;
    const crossings = Math.floor((leader.totalDistance - gapToLine) / CFG.world.width) + 1;
    return Math.min(LAPS, Math.max(1, crossings));
}

// ── Une course ──────────────────────────────────────────────────────────────

// Rendue des que le classement est complet : les secondes de tableau des scores
// qui suivent ne produisent plus rien a mesurer.
//
// Deux moments distincts sont releves pour chaque objet — celui ou il est
// ramasse, et celui ou il part. Pour la bleue et l'eclair l'ecart entre les deux
// n'est pas anecdotique : c'est le temps que le porteur le garde en main.
function runRace(startOrder) {
    const state = PH.createWorldState(CFG, rng, 0, startOrder, null);
    let simTime = 0;

    const got = {};      // type -> nombre ramasse
    const gotLap = {};   // type -> [tour] pour chaque ramassage
    const fired = {};    // type -> nombre lance
    const firedLap = {};
    const typeOfItem = new Map(); // itemId -> type, pour relier launchItem
    let lapDrift = 0;             // pas ou le compteur du moteur diverge du reel

    // Ce que la course coute a chaque kart. `hits` compte les tete-a-queue,
    // `slowMs` mesure le temps passe loin de sa vitesse de croisiere : l'arret
    // lui-meme, puis la relance jusqu'a retrouver son rythme. C'est cette
    // seconde valeur qui dit ce que vaut vraiment l'acceleration, l'arret etant
    // de duree fixe pour tout le monde.
    const hits = {};
    const slowMs = {};
    const raceMs = {};
    for (const kart of state.karts) {
        hits[kart.charName] = 0;
        slowMs[kart.charName] = 0;
        raceMs[kart.charName] = 0;
    }

    // Place de chaque kart a la fin de chaque tour. Le releve se fait au moment
    // ou le premier entame le tour suivant, et le dernier tour est renseigne par
    // l'ordre d'arrivee : la trajectoire se lit ainsi d'un bout a l'autre, du
    // premier tour boucle jusqu'au drapeau.
    const lapRanks = [];
    let seenLap = 0;

    function note(bag, bagLap, type, lap) {
        bag[type] = (bag[type] || 0) + 1;
        (bagLap[type] = bagLap[type] || []).push(lap);
    }

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        simTime += DT_MS;
        const events = PH.stepPhysics(CFG, state, rng, simTime, DT);
        const lap = trueLap(state);
        if (state.leaderLap !== lap) lapDrift++;

        if (lap > seenLap) {
            if (seenLap >= 1) {
                const snap = {};
                for (const kart of state.karts) snap[kart.charName] = kart.rank;
                lapRanks[seenLap] = snap;
            }
            seenLap = lap;
        }

        // La grille et le tour d'honneur sont hors sujet : avant le depart tout
        // le monde est a l'arret, apres l'arrivee tout le monde est bride.
        for (const kart of state.karts) {
            if (kart.state === 'grid' || kart.finished) continue;
            raceMs[kart.charName] += DT_MS;
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
            if (ev.type === 'spawnHeldItem') {
                // Les identifiants sont uniques dans une course : ce garde-fou
                // n'est la que pour ne jamais compter deux fois le meme objet.
                if (typeOfItem.has(ev.itemId)) continue;
                typeOfItem.set(ev.itemId, ev.itemType);
                note(got, gotLap, ev.itemType, lap);

            } else if (ev.type === 'launchItem') {
                const type = typeOfItem.get(ev.itemId);
                if (type) note(fired, firedLap, type, lap);

            } else if (ev.type === 'lightningCast') {
                // L'eclair est le seul objet a ne pas passer par `launchItem` :
                // il declenche un orage au lieu de mettre quoi que ce soit en
                // piste, et sort par `lightningCast` + `removeHeldItem`. Sans ce
                // cas, il serait compte comme recu mais jamais comme lance.
                note(fired, firedLap, 'lightning', lap);

            } else if (ev.type === 'raceFinished') {
                // Le dernier tour n'a pas de « tour suivant » pour declencher un
                // releve : c'est l'arrivee qui le fournit.
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
                    hits, slowMs, raceMs
                };
            }
        }
    }
    return null;
}

// ── Campagne ────────────────────────────────────────────────────────────────

const stat = {};
for (const name of ROSTER) {
    stat[name] = { wins: 0, podium: 0, last: 0, sumPos: 0, hits: 0, slowMs: 0, raceMs: 0 };
}

// Places tour par tour. `lapSum` sert la trajectoire moyenne, `lapDist` la
// repartition complete : un kart peut tenir une moyenne honnete en alternant
// tete et fond de peloton, ce que la moyenne seule ne montrerait pas.
const lapSum = {}, lapCount = {}, lapDist = {};
for (const name of ROSTER) {
    lapSum[name] = new Array(LAPS + 1).fill(0);
    lapCount[name] = new Array(LAPS + 1).fill(0);
    lapDist[name] = Array.from({ length: LAPS + 1 }, () => new Array(N).fill(0));
}

// Objets, agreges sur toute la campagne.
const itemTotal = {};                 // type -> total ramasse
const itemFiredTotal = {};            // type -> total lance
const itemPerRace = {};               // type -> [compte par course]
const lapHist = {};                   // type -> tour -> nombre (au ramassage)
const lapHistFired = {};              // type -> tour -> nombre (au lancer)
for (const t of ITEM_TYPES) {
    itemTotal[t] = 0; itemFiredTotal[t] = 0; itemPerRace[t] = [];
    lapHist[t] = new Array(LAPS + 1).fill(0);
    lapHistFired[t] = new Array(LAPS + 1).fill(0);
}

// Ecart entre place de depart et place d'arrivee, pour mesurer ce que vaut la
// grille elle-meme. Une correlation forte dirait que la course se joue au
// depart, ce qui rendrait toute lecture des statistiques trompeuse.
const gridPairs = [];
let aborted = 0;
let totalMs = 0;

// Controles de coherence entre le moteur et ce que le harnais croit observer.
// Ils ne mesurent pas l'equilibrage : ils disent si la mesure elle-meme est
// encore valable apres une modification du jeu.
let lapDriftTicks = 0;
let totalTicks = 0;

let startOrder = null;
const started = Date.now();

if (CSV) console.log('course,' + ROSTER.map((_, i) => 'p' + (i + 1)).join(',')
    + ',bleues,eclairs');

for (let r = 0; r < RACES; r++) {
    const grid = CHAIN && startOrder ? startOrder : PH.shuffleArray(ROSTER.slice(), rng);
    const race = runRace(grid);

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

    for (const name of ROSTER) {
        stat[name].hits += race.hits[name] || 0;
        stat[name].slowMs += race.slowMs[name] || 0;
        stat[name].raceMs += race.raceMs[name] || 0;
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

// Aucune course close : le rapport n'aurait que des NaN a montrer. Mieux vaut
// dire ce qui ne va pas — c'est le symptome d'une course qui n'atteint jamais sa
// condition d'arret, pas d'un desequilibre.
if (done === 0) {
    console.error(`\nAucune des ${RACES} courses n'a abouti en ${MAX_TICKS} pas simules.`);
    console.error('La condition d\'arret n\'est jamais atteinte : verifier race.stopAtFinisher,');
    console.error('race.maxRaceMs et race.cameraApproachDistance dans physics-config.js.');
    process.exit(1);
}

if (CSV) process.exit(0);

// ── Rapport ─────────────────────────────────────────────────────────────────

function pct(n, d) { return d ? (100 * n / d) : 0; }
function pad(s, w) { return String(s).padEnd(w); }
function padL(s, w) { return String(s).padStart(w); }

const p0 = 1 / N;
// Ecart-type attendu d'un taux de victoire si tous les karts se valaient. Sans
// ce repere, on lit un ecart de deux points comme un desequilibre alors qu'il
// n'est que du bruit d'echantillonnage.
const sigma = Math.sqrt(p0 * (1 - p0) / Math.max(done, 1)) * 100;

const grandTotal = ITEM_TYPES.reduce((s, t) => s + itemTotal[t], 0);

// Coherence entre le moteur et ce que le harnais croit observer. Ces controles
// ne mesurent pas l'equilibrage : ils disent si la mesure elle-meme tient encore
// apres une modification du jeu. Un tableau vide se lit trop facilement comme un
// resultat, alors qu'il ne signale qu'un evenement renomme.
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
console.log(`temps simule : ${Math.round(totalMs / 1000)} s   temps reel : ${elapsed.toFixed(1)} s`
    + `   acceleration : x${Math.round(totalMs / 1000 / Math.max(elapsed, 0.001))}`);

// ── Karts ───────────────────────────────────────────────────────────────────

const rows = ROSTER.slice().sort((a, b) => stat[b].wins - stat[a].wins);
const w = Math.max(...ROSTER.map(n => n.length), 6);

console.log('');
console.log(pad('kart', w) + padL('poi/pui/man', 13)
    + padL('top', 6) + padL('acc', 6) + padL('agi', 6) + padL('masse', 7)
    + padL('victoires', 12) + padL('podium', 9) + padL('dernier', 9) + padL('place moy.', 12));
console.log('-'.repeat(w + 13 + 6 + 6 + 6 + 7 + 12 + 9 + 9 + 12));

for (const name of rows) {
    const s = stat[name];
    const c = STATS[name];
    const winPct = pct(s.wins, done);
    // Ecart a l'attendu, en ecarts-types : au-dela de 2, ce n'est plus du bruit.
    const z = sigma > 0 ? (winPct - 100 * p0) / sigma : 0;
    const flag = Math.abs(z) >= 2 ? (z > 0 ? ' ++' : ' --') : '   ';

    console.log(
        pad(name, w)
        + padL(`${c.raw.weight}/${c.raw.power}/${c.raw.handling}`, 13)
        + padL(Math.round(c.topSpeed), 6) + padL(c.acceleration.toFixed(2), 6)
        + padL(c.agility.toFixed(2), 6) + padL(c.mass.toFixed(2), 7)
        + padL(winPct.toFixed(1) + ' %' + flag, 12)
        + padL(pct(s.podium, done).toFixed(1) + ' %', 9)
        + padL(pct(s.last, done).toFixed(1) + ' %', 9)
        + padL((s.sumPos / done).toFixed(2), 12)
    );
}

console.log('');
console.log(`budget : ${CFG.kartStats.budget} points par kart, chaque axe dans `
    + `[${CFG.kartStats.minPoints}, ${CFG.kartStats.maxPoints}]`);

// Ce que la course coute. Sans ces deux colonnes, impossible de dire si
// l'agilite sert a quelque chose : un kart peut perdre parce qu'il est lent, ou
// parce qu'il se fait toucher deux fois plus souvent. Les taux de victoire seuls
// ne les distinguent pas.
console.log('');
console.log('Ce que la course coute a chaque kart');
console.log(pad('kart', w) + padL('agi', 6) + padL('touches', 10)
    + padL('hors rythme', 13) + padL('part de course', 16));
console.log('-'.repeat(w + 6 + 10 + 13 + 16));
for (const name of rows) {
    const s = stat[name];
    console.log(pad(name, w)
        + padL(STATS[name].agility.toFixed(2), 6)
        + padL((s.hits / done).toFixed(2), 10)
        + padL((s.slowMs / done / 1000).toFixed(1) + ' s', 13)
        + padL(pct(s.slowMs, s.raceMs).toFixed(1) + ' %', 16));
}
console.log('');
console.log(`  touches : tete-a-queue subis par course. hors rythme : temps passe`);
console.log(`  sous ${(SLOW_RATIO * 100).toFixed(0)} % de sa propre pointe, arret et relance compris.`);
console.log(`attendu si tous egaux : ${(100 * p0).toFixed(1)} % de victoires, place moyenne ${((N + 1) / 2).toFixed(2)}`);
console.log(`bruit d'echantillonnage a ${done} courses : +/- ${sigma.toFixed(1)} point (1 ecart-type)`);
console.log('  ++ / -- signale un ecart d\'au moins 2 ecarts-types, soit ce qui ne s\'explique plus par le hasard');

// La repartition des places a l'arrivee n'est pas reprise ici : elle figure en
// bas, comme dernier tour du releve par tour, ou elle se lit dans la continuite
// du chemin parcouru plutot qu'isolee.

// Trajectoire : la place moyenne tour apres tour. C'est ici qu'un schema se
// voit — un kart qui part devant et recule, ou l'inverse, alors que sa place
// finale ne dit rien du chemin parcouru.
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
    console.log('  ' + pad('kart', w) + ROSTER.map((_, i) => padL('P' + (i + 1), 7)).join(''));
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

// Les deux objets de course : ils sont rares, uniques ou presque, et leur
// moment d'arrivee est un reglage a part entiere. D'ou un traitement separe.
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
