// Banc de l'attention : ce qu'un kart fait de ce qu'il a vu derriere une fois
// revenu devant (D-5), et l'effet du gabarit sur son tirage d'inattention (D-6).
//
//     node tools/attention.js                 les deux volets
//     node tools/attention.js --races 200     D-5 sur plus de courses completes
//     node tools/attention.js --seeds 800     D-6 sur plus de graines
import * as PH from '../src/engine/index.js';
import CFG from '../src/config/index.js';
import * as track from '../src/track.js';

const DT = 1 / 30, DT_MS = DT * 1000;

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? Number(args[i + 1]) : fallback;
}
const RACES = Math.max(0, argValue('--races', 100));
const SEEDS = Math.max(50, argValue('--seeds', 400));

const TRACKS = track.loadTracks(track.resolveTracksDir(import.meta.dirname), CFG);
const RACE_CFGS = TRACKS.map(t => track.applyTrack(CFG, t));
const BASE = RACE_CFGS[0];
const ROSTER = Object.keys(PH.deriveCharacterStats(CFG));
const MAX_TICKS = Math.ceil((CFG.race.maxRaceMs + 60000) / DT_MS);

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

function pct(n, total) {
    return total ? `${(100 * n / total).toFixed(1)} %` : '   -';
}

function placeOf(state, k) {
    return (k.rank === 1) ? 'leader' : (k.rank >= state.rankedCount) ? 'last' : 'pack';
}

const PLACES = ['leader', 'pack', 'last'];
const SHELLS = ['greenShell', 'redShell'];

// ── D-5 : regarder devant en se souvenant de l'arriere ─────────────────────
// Temps passe tourne vers l'arriere, regard devant avec un danger arriere en
// memoire, et decisions prises sur ce souvenir. Une decision est comptee au
// pas ou elle apparait (`scanBack` faux : prise sur le souvenir).

function newAcc() {
    const byPlace = () => Object.fromEntries(PLACES.map(p => [p, 0]));
    return {
        races: 0,
        seen: byPlace(), back: byPlace(),
        mem: byPlace(), memFront: byPlace(),
        // decision -> { front, back }
        acts: {
            giveWayRed: { front: 0, back: 0 },
            giveWayCarrier: { front: 0, back: 0 },
            safetyBack: { front: 0, back: 0 },
            shieldHold: { front: 0, back: 0 },
            counter: { front: 0, back: 0 },
        },
        // Touches par une carapace venue de derriere, selon ce que le kart savait.
        rearHits: { total: 0, looking: 0, dodging: 0, memory: 0, heard: 0, unaware: 0 },
        frontHits: 0,
    };
}

function snapshotKart(k, t) {
    const s = k.sight;
    return {
        x: k.worldX,
        back: s.back,
        scanBack: s.scanBack,
        memory: t - s.dangerAt <= CFG.vision.pressureMemoryMs && s.dangerKind !== '',
        // Porteur qui suit, de memoire (sinon releve du balayage).
        carrier: ('carrierAt' in s)
            ? (t - s.carrierAt <= CFG.vision.pressureMemoryMs)
            : (s.pressure && s.pressureBack),
        plan: k.plan.threatId !== 0 ? k.plan.kind : '',
        threatId: k.plan.threatId,
        heard: !!(k.alert && k.alert.red),
        shieldHold: k.shieldHold,
    };
}

function raceRun(cfg, seed, acc) {
    const rng = makeRng(seed);
    // Tirage de production (`roster`).
    const grid = PH.pickRoster(cfg, rng, null);
    const state = PH.createWorldState(cfg, rng, 0, grid, null);
    let t = 0;

    const before = new Map();
    const shells = new Map();

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        before.clear();
        for (const k of state.karts) before.set(k.id, snapshotKart(k, t));
        shells.clear();
        for (const it of state.items) {
            if (it.isDead || it.spent || SHELLS.indexOf(it.type) === -1) continue;
            shells.set(it.id, it.worldX);
        }

        t += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);

        if (state.phase === 'racing') {
            for (const k of state.karts) {
                if (k.state !== 'running' || k.finished) continue;
                const place = placeOf(state, k);
                const now = snapshotKart(k, t);
                const was = before.get(k.id);

                acc.seen[place]++;
                if (now.back) acc.back[place]++;
                if (now.memory) {
                    acc.mem[place]++;
                    if (!now.back) acc.memFront[place]++;
                }

                const side = now.scanBack ? 'back' : 'front';
                // Ceder le passage a un porteur (le plan designe le kart).
                if (now.plan === 'giveWay' && was.plan !== 'giveWay') {
                    const other = state.kartsById[-1 - now.threatId];
                    const red = other && other.heldItem && other.heldItem.type === 'redShell';
                    acc.acts[red ? 'giveWayRed' : 'giveWayCarrier'][side]++;
                }
                if (now.plan === 'safety' && was.plan !== 'safety' && now.carrier
                    && (k.sight.carrierId === now.threatId
                        || (k.sight.pressureBack && k.sight.pressureId === now.threatId))) {
                    acc.acts.safetyBack[side]++;
                }
                if (now.shieldHold && !was.shieldHold) acc.acts.shieldHold[side]++;
            }
        }

        // Contre-attaque : carapace tiree vers l'arriere vers un porteur qui suit.
        if (state.phase === 'racing') {
            for (const ev of events) {
                if (ev.type !== 'launchItem') continue;
                const was = before.get(ev.kartId);
                const it = state.items.find(i => i.id === ev.itemId);
                if (!was || !it || SHELLS.indexOf(it.type) === -1 || !(it.vx < 0)) continue;
                if (was.carrier) acc.acts.counter[was.scanBack ? 'back' : 'front']++;
            }
        }

        // Touches : carapace disparue ce pas-ci, la plus proche de la victime avant le pas.
        const alive = new Set();
        for (const it of state.items) if (!it.isDead && !it.spent) alive.add(it.id);
        for (const ev of events) {
            if (ev.type !== 'kartHit') continue;
            const was = before.get(ev.kartId);
            if (!was) continue;
            let best = null;
            let bestDist = Infinity;
            for (const [id, x] of shells) {
                if (alive.has(id)) continue;
                const d = PH.getShortestDistance(cfg, x, was.x);
                if (Math.abs(d) < Math.abs(bestDist)) { bestDist = d; best = id; }
            }
            if (best === null || Math.abs(bestDist) > 150) continue;
            if (bestDist >= 0) { acc.frontHits++; continue; }

            const h = acc.rearHits;
            h.total++;
            if (was.back) h.looking++;
            else if (was.plan) h.dodging++;
            else if (was.memory) h.memory++;
            else if (was.heard) h.heard++;
            else h.unaware++;
        }

        if (events.some(ev => ev.type === 'raceFinished')) break;
    }
    acc.races++;
}

function reportD5(acc) {
    console.log(`\n=== D-5 : l'attention en course (${acc.races} courses completes) ===`);
    console.log('                          premier    peloton    dernier');
    const row = (label, fn) => console.log(label.padEnd(24)
        + PLACES.map(p => fn(p).padStart(11)).join(''));
    row('tourne vers l\'arriere', p => pct(acc.back[p], acc.seen[p]));
    row('danger arriere en tete', p => pct(acc.mem[p], acc.seen[p]));
    row('  ... en regardant devant', p => pct(acc.memFront[p], acc.mem[p]));

    console.log('\nDecisions sur un danger arriere, selon le sens du balayage qui les a prises :');
    console.log('                          face route   dos tourne   part sur souvenir');
    const LABELS = {
        giveWayRed: 'cede (rouge en main)',
        giveWayCarrier: 'cede (autre porteur)',
        safetyBack: 'se range',
        shieldHold: 'garde son bouclier',
        counter: 'lui tire dessus',
    };
    for (const [key, v] of Object.entries(acc.acts)) {
        const name = LABELS[key];
        const n = v.front + v.back;
        console.log(`  ${name.padEnd(22)}${String(v.front).padStart(11)}${String(v.back).padStart(13)}`
            + `${pct(v.front, n).padStart(20)}`);
    }

    const h = acc.rearHits;
    console.log(`\nTouches par une carapace venue de derriere : ${h.total}`
        + ` (et ${acc.frontHits} venues de devant). Au moment du choc, le kart :`);
    console.log(`  regardait derriere             ${pct(h.looking, h.total).padStart(8)}`);
    console.log(`  esquivait (plan en cours)      ${pct(h.dodging, h.total).padStart(8)}`);
    console.log(`  regardait devant, SAVAIT       ${pct(h.memory, h.total).padStart(8)}`
        + '   <- souvenir sans reaction');
    console.log(`  l'avait entendue (rouge)       ${pct(h.heard, h.total).padStart(8)}`);
    console.log(`  n'en savait rien               ${pct(h.unaware, h.total).padStart(8)}`);
}

// ── D-6 : le tirage d'inattention depend-il du gabarit ? ──────────────────
// `missChance` est etalonne sur l'agilite de reference, mais la fenetre de
// menace depend du kart. Situation identique pour tous (seul en piste, banane
// droit devant, pas de coup d'oeil arriere) : marge a la premiere perception,
// verdict du tirage, puis issue. A allure commune, puis a l'allure propre.

const BANANA_ID = 9001;

// Plateau complet (les scenarios cherchent leurs personnages par nom).
function fullRoster(cfg) {
    const names = Object.keys(cfg.roster.enabled);
    return {
        ...cfg,
        roster: { perRace: names.length, enabled: Object.fromEntries(names.map(n => [n, true])) }
    };
}

function missCase(cfg, seed, charName, speedOf, gapPx, laneY) {
    const rng = makeRng(seed);
    const state = PH.createWorldState(fullRoster(cfg), rng, 0, null, null);
    let t = 0;
    while (state.phase === 'countdown') { t += DT_MS; PH.stepPhysics(cfg, state, rng, t, DT); }

    state.pipes.length = 0;
    state.itemBoxes.length = 0;
    state.items.length = 0;
    state.storm = null;
    for (const k of state.karts) k.state = 'grid';

    const kart = state.karts.find(k => k.charName === charName);
    const speed = speedOf(kart);
    kart.state = 'running';
    kart.worldX = 1000;
    kart.yPercent = laneY;
    kart.vy = 0;
    kart.targetVy = 0;
    kart.bumpVy = 0;
    kart.bumpVx = 0;
    kart.absoluteVelocity = speed;
    kart.heldItem = null;
    kart.boostEndTime = 0;
    kart.starEndTime = 0;
    kart.isInvincible = false;
    kart.preBoostMomentum = -1;
    kart.startStallUntil = 0;
    kart.hitInvincibleUntil = 0;
    kart.plan.threatId = 0;
    kart.plan.kind = '';
    kart.plan.until = 0;
    kart.sight.at = -1e9;
    kart.judgedId.fill(0);

    PH.spawnLaunchedItem(cfg, state, rng, t, kart, 'banana', BANANA_ID,
        kart.worldX + gapPx, laneY, [], 1);
    const item = state.items[0];
    item.vx = 0;
    item.vy = 0;
    item.flightUntil = 0;
    item.hop = 0;
    item.ownerId = null;
    item.shooterId = -1;
    item.armed = true;

    let judged = null;
    for (let k = 0; k < 240; k++) {
        kart.sight.nextGlance = Infinity;
        kart.sight.backUntil = 0;
        // Meme allure jusqu'au verdict.
        if (!judged) kart.absoluteVelocity = speed;

        t += DT_MS;
        PH.stepPhysics(cfg, state, rng, t, DT);

        if (!judged) {
            const slot = kart.judgedId.indexOf(BANANA_ID);
            if (slot >= 0) {
                const dx = PH.getShortestDistance(cfg, item.worldX, kart.worldX);
                judged = { ignored: kart.judgedIgnored[slot], spareMs: (dx / speed) * 1000 };
            }
        }
        if (kart.state !== 'running') return { judged, hit: true };
        if (PH.getShortestDistance(cfg, item.worldX, kart.worldX) < -200) break;
    }
    return { judged, hit: false };
}

function missTable(label, speedOf) {
    const stats = PH.deriveCharacterStats(BASE);
    console.log(`\n--- ${label} ---`);
    console.log('kart       agilite  vitesse  marge au verdict   rate le tirage   touche   jamais vue');
    const rows = [];
    for (const name of ROSTER) {
        let n = 0, ignored = 0, hit = 0, spare = 0, unseen = 0;
        let speed = 0;
        for (let s = 0; s < SEEDS; s++) {
            const r = missCase(BASE, 70000 + s, name, k => (speed = speedOf(k)), 1600, 15);
            if (!r.judged) { unseen++; if (r.hit) hit++; continue; }
            n++;
            spare += r.judged.spareMs;
            if (r.judged.ignored) ignored++;
            if (r.hit) hit++;
        }
        rows.push({ name, miss: n ? ignored / n : 0 });
        console.log(`${name.padEnd(9)} ${stats[name].agility.toFixed(3).padStart(7)}`
            + `${speed.toFixed(0).padStart(9)}`
            + `${(n ? (spare / n).toFixed(0) : '-').padStart(13)} ms`
            + `${pct(ignored, n).padStart(17)}`
            + `${pct(hit, SEEDS).padStart(9)}`
            + `${String(unseen).padStart(13)}`);
    }
    const lo = Math.min(...rows.map(r => r.miss));
    const hi = Math.max(...rows.map(r => r.miss));
    console.log(`  ecart de tirage entre gabarits : ${(100 * (hi - lo)).toFixed(1)} points`
        + ` (plafond du tirage : ${(100 * BASE.ai.dodgeMissChance).toFixed(0)} %)`);
}

// Meme question quand la menace apparait tard : a courte distance la marge est
// la meme pour tous, plus loin les lourds la voient plus tot.
const GAPS = [250, 350, 450, 600, 800];

function gapSweep() {
    console.log('\n--- tirage rate selon la distance d\'apparition (meme allure, 450 px/s) ---');
    console.log('kart     ' + GAPS.map(g => `${g} px`.padStart(10)).join(''));
    for (const name of ROSTER) {
        const cells = GAPS.map(gap => {
            let n = 0, ignored = 0;
            for (let s = 0; s < SEEDS; s++) {
                const r = missCase(BASE, 90000 + s, name, () => 450, gap, 15);
                if (!r.judged) continue;
                n++;
                if (r.judged.ignored) ignored++;
            }
            return pct(ignored, n).padStart(10);
        });
        console.log(name.padEnd(9) + cells.join(''));
    }
}

function reportD6() {
    console.log(`\n=== D-6 : le tirage d'inattention par gabarit (${SEEDS} graines par kart) ===`);
    console.log('Banane posee a 1600 px, dans l\'axe, kart seul, sans coup d\'oeil arriere.');
    missTable('meme allure pour tous (450 px/s) : seule la fenetre differe', () => 450);
    missTable('allure propre (95 % de la pointe) : la course reelle', k => k.stats.topSpeed * 0.95);
    gapSweep();
}

// ── Execution ───────────────────────────────────────────────────────────────

if (RACES > 0) {
    const acc = newAcc();
    for (let i = 0; i < RACES; i++) raceRun(RACE_CFGS[i % RACE_CFGS.length], 50000 + i, acc);
    reportD5(acc);
}
reportD6();
