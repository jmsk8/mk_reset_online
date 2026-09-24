// Banc des alertes : ce qu'un kart ENTEND arriver dans son dos — un bill, une
// rouge qui le vise, une bleue qui cherche le premier — et ce qu'il en fait.
//
// Des situations posees a la main, rejouees sur beaucoup de graines : le banc
// rend un TAUX, alertes allumees puis eteintes, sur les memes graines. C'est ce
// qui dit si une alerte COMPLETE le comportement ou le deregle.
//
//     node tools/alerts.js                  les scenarios, avec et sans alertes
//     node tools/alerts.js --seeds 400      plus d'echantillon par scenario
//     node tools/alerts.js --campaign 200   en plus, des courses completes
//
// C'est un test autant qu'un banc : il sort en erreur quand un seuil attendu
// n'est pas tenu. Comme les autres outils il n'ecrit rien dans le moteur — il ne
// fait que basculer `vision.alerts.*.enabled`, sur une COPIE de la config.
import * as PH from '../src/engine/index.js';
import CFG from '../src/config/index.js';
import * as track from '../src/track.js';

const DT = 1 / 30, DT_MS = DT * 1000;

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? Number(args[i + 1]) : fallback;
}
const SEEDS = Math.max(20, argValue('--seeds', 200));
const CAMPAIGN = Math.max(0, argValue('--campaign', 0));

const TRACKS = track.loadTracks(track.resolveTracksDir(import.meta.dirname), CFG);
const BASE = track.applyTrack(CFG, TRACKS[0]);

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

// La meme config, alertes allumees ou eteintes. Rien d'autre ne change : c'est
// la seule difference entre les deux colonnes du banc.
const HAS_ALERTS = !!(BASE.vision && BASE.vision.alerts);

function withAlerts(cfg, on) {
    if (!HAS_ALERTS) return cfg;
    const alerts = {};
    for (const key of Object.keys(cfg.vision.alerts)) {
        const spec = cfg.vision.alerts[key];
        alerts[key] = (spec && typeof spec === 'object' && 'enabled' in spec)
            ? { ...spec, enabled: on && spec.enabled }
            : spec;
    }
    return { ...cfg, vision: { ...cfg.vision, alerts } };
}

// ── La mise en scene ────────────────────────────────────────────────────────

// Les scenarios vont chercher leurs personnages par NOM, puis vident la piste :
// il leur faut le plateau ENTIER, pas les `roster.perRace` karts que le tirage
// de la prod aurait retenus. Sans ca, un scenario sur un personnage non tire
// plantait sur un kart introuvable.
function fullRoster(cfg) {
    const names = Object.keys(cfg.roster.enabled);
    return {
        ...cfg,
        roster: { perRace: names.length, enabled: Object.fromEntries(names.map(n => [n, true])) }
    };
}

// Une course sortie du decompte, videe de son decor et de ses karts : chaque
// scenario ne remet en piste que ceux dont il a besoin. Les tuyaux et les boites
// partent aussi — ils decideraient a la place de ce qu'on mesure.
function stage(cfg, seed) {
    const rng = makeRng(seed);
    const state = PH.createWorldState(fullRoster(cfg), rng, 0, null, null);
    let t = 0;
    while (state.phase === 'countdown') { t += DT_MS; PH.stepPhysics(cfg, state, rng, t, DT); }

    state.pipes.length = 0;
    state.itemBoxes.length = 0;
    state.items.length = 0;
    state.storm = null;
    for (const k of state.karts) k.state = 'grid';

    return { rng, state, t };
}

// Un kart remis en piste, lance, sans rien dans les mains ni dans la tete. Le
// turbo de depart est efface : un champignon residuel protegerait du souffle
// et fausserait tout le banc de la bleue.
function put(cfg, kart, x, y, dist) {
    const w = cfg.world.width;
    kart.state = 'running';
    kart.worldX = ((x % w) + w) % w;
    kart.yPercent = y;
    kart.vy = 0;
    kart.targetVy = 0;
    kart.bumpVy = 0;
    kart.bumpVx = 0;
    kart.absoluteVelocity = kart.stats.topSpeed * 0.95;
    kart.totalDistance = dist;
    // Le classement se lit sur la distance RESTANTE, et la ligne d'arrivee est
    // propre a chaque place de grille. En course les deux se compensent ; ici
    // on pose la distance a la main, donc la ligne doit etre la meme pour tous
    // — sinon un kart double a l'ecran resterait premier au classement.
    kart.finishDistance = 10 * w;
    kart.heldItem = null;
    kart.throwTime = 0;
    kart.trailTime = 0;
    kart.shieldHold = false;
    kart.pendingItemGrantTime = 0;
    kart.boostEndTime = 0;
    kart.starEndTime = 0;
    kart.isInvincible = false;
    kart.preBoostMomentum = -1;
    kart.startStallUntil = 0;
    kart.hitInvincibleUntil = 0;
    kart.brakeUntil = 0;
    kart.plan.threatId = 0;
    kart.plan.kind = '';
    kart.plan.until = 0;
    kart.sight.at = -1e9;
}

// Un objet en main. `natural` : il le lancera a une date tiree comme a la
// reception (`ai.holdItemMin/Max`), faute de quoi il le garde indefiniment —
// c'est ce qui isole une decision de tout le reste.
function give(cfg, state, rng, t, kart, type, natural) {
    kart.heldItem = { id: state.nextItemId++, type: type, holdPosition: 'hands' };
    kart.shotDirection = 1;
    kart.shotAsLeader = false;
    kart.lobbing = false;
    kart.aimError = 0;
    kart.throwTime = natural
        ? t + PH.randomRange(rng, cfg.ai.holdItemMin, cfg.ai.holdItemMax)
        : t + 1e9;
}

function tally(results) {
    const out = {};
    for (const r of results) out[r] = (out[r] || 0) + 1;
    return out;
}

function pct(n, total) {
    return `${((100 * (n || 0)) / total).toFixed(1).padStart(5)} %`;
}

// ── Les scenarios ───────────────────────────────────────────────────────────

// Une carrosserie lancee a 900 px derriere un kart. Le bill file au milieu
// (17.5) et balaie de 6.5 a 28.5 : il faut en SORTIR, pas seulement s'ecarter.
// L'etoile part dans l'axe du kart, et se pilote ensuite comme un kart.
function ramCase(cfg, seed, charName, y, type) {
    const { rng, state, t: t0 } = stage(cfg, seed);
    let t = t0;
    const w = cfg.world.width;
    const kart = state.karts.find(k => k.charName === charName);
    const ram = state.karts.find(k => k !== kart);

    put(cfg, kart, 2000, y, 3 * w);
    put(cfg, ram, 1100, (type === 'bill') ? 17.5 : y, 3 * w - 900);
    give(cfg, state, rng, t, ram, type, false);
    ram.throwTime = t + DT_MS;

    for (let k = 0; k < 240; k++) {
        t += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);
        for (const ev of events) if (ev.type === 'kartHit' && ev.kartId === kart.id) return 'touche';
        if (ram.totalDistance > kart.totalDistance + 200) return 'esquive';
    }
    return 'esquive';
}

// Une rouge tiree a `gap` px derriere un kart qui tient `held`. Un troisieme kart
// file loin devant : le kart vise n'est pas en tete, il regarde derriere a la
// frequence du peloton.
function redCase(cfg, seed, gap, held) {
    const { rng, state, t: t0 } = stage(cfg, seed);
    let t = t0;
    const w = cfg.world.width;
    const [kart, shooter, hare] = state.karts;

    put(cfg, kart, 2000, 15, 3 * w);
    put(cfg, shooter, 2000 - gap, 15, 3 * w - gap);
    put(cfg, hare, 2000 + w / 3, 30, 3 * w + w / 3);
    if (held) give(cfg, state, rng, t, kart, held, true);

    give(cfg, state, rng, t, shooter, 'redShell', false);
    shooter.throwTime = t + DT_MS;

    let redId = 0;
    for (let k = 0; k < 180; k++) {
        t += DT_MS;
        const heldBefore = kart.heldItem;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);

        for (const ev of events) {
            if (ev.type === 'launchItem' && ev.kartId === shooter.id) redId = ev.itemId;
            if (ev.type === 'kartHit' && ev.kartId === kart.id) return 'touche';
        }
        if (!redId) continue;

        const red = state.items.find(it => it.id === redId);
        if (red && !red.spent && !red.isDead) continue;
        if (kart.isInvincible || kart.isBill) return 'etoile';
        if (heldBefore && !kart.heldItem && heldBefore.holdPosition === 'behind') return 'bouclier';
        return 'perdue';
    }
    return 'perdue';
}

// Une bleue lancee a `launch` px derriere le premier, un poursuivant a
// `follow` px derriere lui (0 : personne). Le premier tient `held`, qu'il lance a
// une date naturelle.
//
// Ce qu'on releve : qui le souffle a pris, et si le premier en est sorti indemne
// parce qu'il etait intouchable.
function blueCase(cfg, seed, launch, follow, held) {
    const { rng, state, t: t0 } = stage(cfg, seed);
    let t = t0;
    const w = cfg.world.width;
    const [leader, chaser, shooter] = state.karts;

    put(cfg, leader, 3000, 15, 3 * w);
    if (follow > 0) put(cfg, chaser, 3000 - follow, 12, 3 * w - follow);
    put(cfg, shooter, 3000 - launch, 25, 3 * w - launch);
    if (held) give(cfg, state, rng, t, leader, held, true);

    give(cfg, state, rng, t, shooter, 'blueShell', false);
    shooter.throwTime = t + DT_MS;

    let blueSeen = false;
    let blastUntil = 0;
    let target = null;
    let leaderHit = false;
    let chaserHit = false;
    let immune = false;
    let yielded = false;

    for (let k = 0; k < 420; k++) {
        t += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);

        for (const ev of events) {
            if (ev.type !== 'kartHit') continue;
            if (ev.kartId === leader.id) leaderHit = true;
            if (follow > 0 && ev.kartId === chaser.id) chaserHit = true;
        }

        if (leader.alert && leader.alert.blueMode === 'yield') yielded = true;

        const blue = state.items.find(it => it.type === 'blueShell');
        if (blue) {
            blueSeen = true;
            if (blue.targetKartId !== null) target = blue.targetKartId;
            if (blue.phase === 'crash' && t + DT_MS >= blue.phaseUntil) {
                immune = (leader.boostEndTime > t || leader.isInvincible);
            }
        }
        const blast = state.items.find(it => it.type === 'blueBlast');
        if (blast && !blastUntil) blastUntil = t + 400;
        if (blastUntil && t > blastUntil) break;
        if (blueSeen && !blue && !blast && !blastUntil) break;
    }

    const who = (target === leader.id) ? 'premier' : (target === chaser.id) ? 'second' : 'autre';
    return { who, leaderHit, chaserHit, immune, yielded };
}

// ── Les tableaux ────────────────────────────────────────────────────────────

function columns(fn) {
    const off = [];
    const on = [];
    const cfgOff = withAlerts(BASE, false);
    const cfgOn = withAlerts(BASE, true);
    for (let s = 1; s <= SEEDS; s++) {
        off.push(fn(cfgOff, 1000 + s));
        if (HAS_ALERTS) on.push(fn(cfgOn, 1000 + s));
    }
    return { off, on };
}

const failures = [];
function expect(label, ok, detail) {
    if (!ok) failures.push(`${label} : ${detail}`);
}

function ramTable(type, depths) {
    console.log(`\n=== ${type} lance a 900 px derriere, ${SEEDS} graines — taux de touche ===`);
    console.log('kart     prof.   sans alerte   avec alerte');
    const rows = {};
    for (const name of ['bowser', 'mario', 'koopa']) {
        for (const y of depths) {
            const { off, on } = columns((cfg, seed) => ramCase(cfg, seed, name, y, type));
            const a = tally(off).touche || 0;
            const b = HAS_ALERTS ? (tally(on).touche || 0) : null;
            rows[`${name}@${y}`] = { off: a, on: b };
            console.log(`${name.padEnd(8)} ${String(y).padStart(5)}   ${pct(a, SEEDS)}   `
                + (b === null ? '      -' : pct(b, SEEDS)));
        }
    }
    return rows;
}

function redTable() {
    console.log(`\n=== rouge tiree dans le dos, ${SEEDS} graines ===`);
    console.log('ecart  en main     issue        sans alerte   avec alerte');
    const rows = {};
    for (const held of ['banana', 'greenShell', 'star', null]) {
        for (const gap of [200, 400, 700]) {
            const { off, on } = columns((cfg, seed) => redCase(cfg, seed, gap, held));
            const a = tally(off);
            const b = tally(on);
            rows[`${held}@${gap}`] = { off: a, on: b };
            for (const issue of ['touche', 'bouclier', 'etoile', 'perdue']) {
                if (!a[issue] && !b[issue]) continue;
                console.log(`${String(gap).padStart(5)}  ${String(held || '-').padEnd(10)}  `
                    + `${issue.padEnd(10)}   ${pct(a[issue], SEEDS)}   `
                    + (HAS_ALERTS ? pct(b[issue], SEEDS) : '      -'));
            }
        }
    }
    return rows;
}

function blueTable() {
    console.log(`\n=== bleue sur le premier, ${SEEDS} graines ===`);
    console.log('lancee  suiveur  en main  |  vise le 1er   1er touche   2e touche   1er intouchable');
    const rows = {};
    for (const held of [null, 'shroom', 'star']) {
        for (const launch of [1500, 3000]) {
            for (const follow of [0, 150, 300]) {
                if (held && follow === 300) continue;
                const { off, on } = columns((cfg, seed) => blueCase(cfg, seed, launch, follow, held));
                const line = (list) => {
                    const n = list.length;
                    const c = (f) => list.filter(f).length;
                    return `${pct(c(r => r.who === 'premier'), n)}   ${pct(c(r => r.leaderHit), n)}   `
                        + `${pct(c(r => r.chaserHit), n)}   ${pct(c(r => r.immune), n)}`;
                };
                const head = `${String(launch).padStart(6)}  ${String(follow || '-').padStart(7)}  `
                    + `${String(held || '-').padEnd(7)}  |`;
                console.log(`${head} sans  ${line(off)}`);
                if (HAS_ALERTS) console.log(`${' '.repeat(head.length - 1)}| avec  ${line(on)}`);
                rows[`${held}@${launch}@${follow}`] = { off, on };
            }
        }
    }
    return rows;
}

// ── La campagne ─────────────────────────────────────────────────────────────
//
// Les scenarios disent si une alerte FAIT ce qu'on attend d'elle. La campagne dit
// si elle ne DEREGLE rien d'autre : des courses completes, grille et circuit tires
// comme en production, rejouees alertes eteintes puis allumees sur les memes
// graines.
//
// Ce qu'on y regarde :
//   - les tete-a-queue par course, toutes causes confondues ;
//   - la part du temps passee a regarder derriere, par place — c'est le prix de
//     l'ouie, et la vue devant est ce qu'elle coute ;
//   - l'issue de chaque rouge tiree sur une cible, et de chaque bleue ;
//   - les victoires par personnage, pour voir si l'alerte avantage un gabarit.

const ROSTER = Object.keys(PH.deriveCharacterStats(CFG));
const RACE_CFGS = TRACKS.map(t => track.applyTrack(CFG, t));
const MAX_TICKS = Math.ceil((CFG.race.maxRaceMs + 60000) / DT_MS);

function raceRun(cfg, seed) {
    const rng = makeRng(seed);
    // Le tirage de la prod (`roster`) : `perRace` karts parmi les actives.
    const grid = PH.pickRoster(cfg, rng, null);
    const state = PH.createWorldState(cfg, rng, 0, grid, null);
    let t = 0;

    const out = {
        hits: 0,
        look: { leader: 0, pack: 0, last: 0 },
        seen: { leader: 0, pack: 0, last: 0 },
        red: { touche: 0, bouclier: 0, etoile: 0, autre: 0 },
        blue: { n: 0, cible: 0, autres: 0, premier: 0 },
        winner: null,
        grid: grid
    };

    const reds = new Map();    // id -> cible
    const blues = new Map();   // id -> { cible, premier au lancer }
    const blasts = [];         // { until, cible, cibleTouchee, autres }

    for (let tick = 0; tick < MAX_TICKS; tick++) {
        t += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);

        const hitNow = new Set();
        const lostNow = new Set();
        for (const ev of events) {
            if (ev.type === 'kartHit') { out.hits++; hitNow.add(ev.kartId); }
            if (ev.type === 'removeHeldItem') lostNow.add(ev.kartId);
        }

        if (state.phase === 'racing') {
            for (const k of state.karts) {
                if (k.state !== 'running' || k.finished) continue;
                const place = (k.rank === 1) ? 'leader'
                    : (k.rank >= state.rankedCount) ? 'last' : 'pack';
                out.seen[place]++;
                if (k.sight.back) out.look[place]++;
            }
        }

        // Les rouges : la cible au premier pas ou elle en a une, l'issue au pas
        // ou elle disparait.
        const alive = new Set();
        for (const it of state.items) {
            if (it.isDead || it.spent) continue;
            alive.add(it.id);
            if (it.type === 'redShell' && it.targetKartId !== null && !reds.has(it.id)) {
                reds.set(it.id, it.targetKartId);
            }
            if (it.type === 'blueShell') {
                if (!blues.has(it.id)) {
                    const lead = state.karts.find(k => k.rank === 1);
                    blues.set(it.id, { cible: null, premier: lead ? lead.id : -1 });
                }
                if (it.targetKartId !== null) blues.get(it.id).cible = it.targetKartId;
            }
        }
        for (const [id, target] of reds) {
            if (alive.has(id)) continue;
            reds.delete(id);
            const victim = state.kartsById[target];
            if (hitNow.has(target)) out.red.touche++;
            else if (victim && (victim.isInvincible || victim.isBill)) out.red.etoile++;
            else if (lostNow.has(target)) out.red.bouclier++;
            else out.red.autre++;
        }
        for (const [id, b] of blues) {
            if (alive.has(id)) continue;
            blues.delete(id);
            out.blue.n++;
            if (b.cible !== null && b.cible !== b.premier) out.blue.premier++;
            blasts.push({ until: t + 400, cible: b.cible, touchee: false, autres: 0 });
        }
        for (const bl of blasts) {
            if (t > bl.until) continue;
            for (const id of hitNow) {
                if (id === bl.cible) bl.touchee = true;
                else bl.autres++;
            }
        }

        if (events.some(ev => ev.type === 'raceFinished')) {
            out.winner = state.kartsById[state.finishOrder[0]].charName;
            break;
        }
    }

    for (const bl of blasts) {
        if (bl.touchee) out.blue.cible++;
        out.blue.autres += bl.autres;
    }
    return out;
}

function campaign(races) {
    const sum = (on) => {
        const acc = {
            races: 0, hits: 0,
            look: { leader: 0, pack: 0, last: 0 }, seen: { leader: 0, pack: 0, last: 0 },
            red: { touche: 0, bouclier: 0, etoile: 0, autre: 0 },
            blue: { n: 0, cible: 0, autres: 0, premier: 0 },
            wins: Object.fromEntries(ROSTER.map(n => [n, 0])),
            // Courses courues par personnage : il n'est plus aligne a chaque
            // course, ses victoires se rapportent a SES participations.
            runs: Object.fromEntries(ROSTER.map(n => [n, 0]))
        };
        for (let i = 0; i < races; i++) {
            const cfg = withAlerts(RACE_CFGS[i % RACE_CFGS.length], on);
            const r = raceRun(cfg, 50000 + i);
            acc.races++;
            acc.hits += r.hits;
            for (const p of ['leader', 'pack', 'last']) {
                acc.look[p] += r.look[p];
                acc.seen[p] += r.seen[p];
            }
            for (const k of Object.keys(acc.red)) acc.red[k] += r.red[k];
            for (const k of Object.keys(acc.blue)) acc.blue[k] += r.blue[k];
            if (r.winner) acc.wins[r.winner]++;
            for (const n of r.grid) acc.runs[n]++;
        }
        return acc;
    };

    const off = sum(false);
    const on = sum(true);

    console.log(`\n=== campagne : ${races} courses completes, memes graines ===`);
    console.log('                                  sans alerte   avec alerte');
    const row = (label, a, b) => console.log(`${label.padEnd(34)}${String(a).padStart(11)}   ${String(b).padStart(11)}`);
    row('tete-a-queue par course', (off.hits / races).toFixed(2), (on.hits / races).toFixed(2));
    for (const p of ['leader', 'pack', 'last']) {
        row(`regard arriere, ${p}`, pct(off.look[p], off.seen[p] || 1), pct(on.look[p], on.seen[p] || 1));
    }
    const redN = (acc) => Object.values(acc.red).reduce((a, b) => a + b, 0) || 1;
    for (const k of Object.keys(off.red)) {
        row(`rouges ciblees : ${k}`, pct(off.red[k], redN(off)), pct(on.red[k], redN(on)));
    }
    row('bleues', off.blue.n, on.blue.n);
    row('  cible touchee', pct(off.blue.cible, off.blue.n || 1), pct(on.blue.cible, on.blue.n || 1));
    row('  cible autre que le 1er au lancer', pct(off.blue.premier, off.blue.n || 1), pct(on.blue.premier, on.blue.n || 1));
    row('  autres karts pris par bleue', (off.blue.autres / (off.blue.n || 1)).toFixed(2), (on.blue.autres / (on.blue.n || 1)).toFixed(2));
    console.log('victoires (par course courue)');
    for (const n of ROSTER) {
        row(`  ${n}`, pct(off.wins[n], off.runs[n] || 1), pct(on.wins[n], on.runs[n] || 1));
    }

    return { off, on };
}

const bill = ramTable('bill', [9, 13, 17.5, 22, 26]);
const star = ramTable('star', [6, 17.5, 29]);
const red = redTable();
const blue = blueTable();

const camp = (CAMPAIGN > 0 && HAS_ALERTS) ? campaign(CAMPAIGN) : null;

// ── Les engagements ─────────────────────────────────────────────────────────
//
// Ce que les alertes promettent, et ce qu'elles promettent de NE PAS faire. Les
// seuils laissent la place du hasard : `tol` vaut deux ecarts-types et demi de
// l'ecart entre deux taux independants, au pire cas (p = 0.5). Ils sont a revoir
// si l'on regle les alertes, jamais a elargir pour faire passer un banc.
if (HAS_ALERTS) {
    const n = SEEDS;
    const tol = 2.5 * Math.sqrt(0.5 / n);
    const r = (count) => count / n;
    const f = (x) => `${(100 * x).toFixed(1)} %`;

    // Etoile et bill : aucune situation n'empire, et l'ensemble s'ameliore.
    for (const [type, rows] of [['bill', bill], ['star', star]]) {
        let off = 0;
        let on = 0;
        for (const [key, row] of Object.entries(rows)) {
            off += row.off;
            on += row.on;
            expect(`${type} ${key}`, r(row.on) <= r(row.off) + tol,
                `touche ${f(r(row.on))} avec l'alerte, ${f(r(row.off))} sans`);
        }
        expect(`${type}, ensemble`, on < off, `${on} touches avec l'alerte, ${off} sans`);
    }

    // La rouge entendue : couvert quand il en a le temps et de quoi se couvrir ;
    // rien de change quand il n'a rien.
    for (const gap of [400, 700]) {
        for (const held of ['banana', 'greenShell']) {
            const row = red[`${held}@${gap}`];
            expect(`rouge ${held} a ${gap} px`, r(row.on.bouclier || 0) >= 0.85,
                `bouclier ${f(r(row.on.bouclier || 0))}, attendu 85 % au moins`);
        }
        const row = red[`star@${gap}`];
        expect(`rouge, etoile en main a ${gap} px`, r(row.on.etoile || 0) >= 0.85,
            `etoile ${f(r(row.on.etoile || 0))}, attendu 85 % au moins`);
    }
    for (const gap of [200, 400, 700]) {
        const row = red[`null@${gap}`];
        expect(`rouge sans objet a ${gap} px`,
            Math.abs(r(row.on.touche || 0) - r(row.off.touche || 0)) <= tol,
            `touche ${f(r(row.on.touche || 0))} avec, ${f(r(row.off.touche || 0))} sans`);
    }

    // La bleue.
    const hitRate = (list) => list.filter(x => x.leaderHit).length / list.length;
    const immuneRate = (list) => list.filter(x => x.immune).length / list.length;
    for (const launch of [1500, 3000]) {
        for (const follow of [0, 150]) {
            const starRow = blue[`star@${launch}@${follow}`];
            expect(`bleue, etoile en main (${launch}/${follow})`, hitRate(starRow.on) <= 0.15,
                `1er touche ${f(hitRate(starRow.on))}, attendu 15 % au plus`);

            // Le champignon est le geste DIFFICILE : il doit sauver souvent, sans
            // devenir une assurance.
            const shroomRow = blue[`shroom@${launch}@${follow}`];
            const im = immuneRate(shroomRow.on);
            expect(`bleue, champignon en main (${launch}/${follow})`, im >= 0.5 && im <= 0.9,
                `intouchable ${f(im)}, attendu entre 50 et 90 %`);
        }

        // Personne derriere : il ne freine jamais pour rien.
        const alone = blue[`null@${launch}@0`];
        const braked = alone.on.filter(x => x.yielded).length;
        expect(`bleue, premier seul (${launch})`, braked === 0,
            `il a cede la tete ${braked} fois sans personne a qui la ceder`);
    }

    // Ceder marche quand le temps le permet, et celui qui a cede sort du souffle.
    const yieldRow = blue['null@3000@150'];
    expect('bleue, ceder la tete (3000/150)',
        hitRate(yieldRow.on) <= 0.75 && hitRate(yieldRow.on) <= hitRate(yieldRow.off) - 0.2,
        `1er touche ${f(hitRate(yieldRow.on))} avec, ${f(hitRate(yieldRow.off))} sans`);
    for (const key of ['null@3000@150', 'null@3000@300']) {
        const spared = blue[key].on.filter(x => x.who !== 'premier');
        const caught = spared.filter(x => x.leaderHit).length;
        expect(`bleue, apres avoir cede (${key})`, caught <= Math.max(1, 0.1 * spared.length),
            `${caught} pris par le souffle sur ${spared.length} qui avaient cede`);
    }

    // La campagne : rien de deregle ailleurs.
    if (camp) {
        const { off, on } = camp;
        expect('campagne, tete-a-queue', on.hits <= off.hits * 1.03,
            `${(on.hits / on.races).toFixed(2)} par course avec, ${(off.hits / off.races).toFixed(2)} sans`);
        for (const p of ['leader', 'pack', 'last']) {
            const a = off.look[p] / (off.seen[p] || 1);
            const b = on.look[p] / (on.seen[p] || 1);
            expect(`campagne, regard arriere ${p}`, b - a <= 0.02,
                `${f(b)} du temps avec, ${f(a)} sans`);
        }
    }
}

if (failures.length) {
    console.log(`\n${failures.length} seuil(s) non tenu(s) :`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
}
console.log('\nok');
