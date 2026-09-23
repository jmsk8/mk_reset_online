// Banc de la rouge : une rouge tiree sur une cible, un tuyau entre les deux. Elle
// doit le contourner et garder sa cible (O-3, cf.
// docs/banner/audit-decision-objets-2026-09-17.md).
//
//     node tools/redshell.js                les situations, 300 graines chacune
//     node tools/redshell.js --seeds 1000   plus d'echantillon
//
// Comme les autres outils il n'ecrit rien dans le moteur : il pose la scene a la
// main, tire, et regarde ce que la rouge devient.
import * as PH from '../src/engine/index.js';
import CFG from '../src/config/index.js';
import * as track from '../src/track.js';

const DT = 1 / 30, DT_MS = DT * 1000;

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? Number(args[i + 1]) : fallback;
}
const SEEDS = Math.max(20, argValue('--seeds', 300));

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

function pct(n, total) {
    return total ? `${(100 * n / total).toFixed(1)} %` : '   -';
}

// Un kart remis en piste, lance, les mains vides.
function put(cfg, kart, x, y) {
    kart.state = 'running';
    kart.worldX = x;
    kart.yPercent = y;
    kart.vy = 0;
    kart.targetVy = 0;
    kart.bumpVy = 0;
    kart.bumpVx = 0;
    kart.absoluteVelocity = 450;
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

// sc : { shooterY, targetY, gap, pipes: [{ at, y }] }. `gap` : distance de la
// cible devant le tireur ; `at` : position du tuyau devant le tireur.
function fire(cfg, seed, sc) {
    const rng = makeRng(seed);
    const state = PH.createWorldState(cfg, rng, 0, null, null);
    let t = 0;
    while (state.phase === 'countdown') { t += DT_MS; PH.stepPhysics(cfg, state, rng, t, DT); }

    state.itemBoxes.length = 0;
    state.items.length = 0;
    state.storm = null;
    for (const k of state.karts) k.state = 'grid';

    const shooter = state.karts[0];
    const target = state.karts[1];
    put(cfg, shooter, 1000, sc.shooterY);
    put(cfg, target, 1000 + sc.gap, sc.targetY);

    state.pipes.length = 0;
    for (const p of sc.pipes) state.pipes.push({ worldX: 1000 + p.at, y: p.y });

    PH.spawnLaunchedItem(cfg, state, rng, t, shooter, 'redShell', 9001,
        shooter.worldX + 40, shooter.yPercent, [], 1);
    const red = state.items[state.items.length - 1];
    if (red.targetKartId !== target.id) return 'sans cible';

    for (let k = 0; k < 150; k++) {
        t += DT_MS;
        const events = PH.stepPhysics(cfg, state, rng, t, DT);
        if (events.some(ev => ev.type === 'kartHit' && ev.kartId === target.id)) return 'touche';
        if (red.spent || red.isDead || state.items.indexOf(red) === -1) {
            // Brisee sans toucher : sur un tuyau, si elle en est au contact.
            for (const p of state.pipes) {
                const dx = Math.abs(PH.getShortestDistance(cfg, red.worldX, p.worldX));
                if (dx < cfg.pipe.hitbox.x * 1.5) return 'tuyau';
            }
            return 'autre';
        }
    }
    return 'autre';
}

const CASES = [
    ['tuyau dans l\'axe, cible dans l\'axe',
        { shooterY: 17, targetY: 17, gap: 700, pipes: [{ at: 350, y: 17 }] }],
    ['tuyau dans l\'axe, cible decalee',
        { shooterY: 12, targetY: 22, gap: 700, pipes: [{ at: 350, y: 17 }] }],
    ['tuyau proche du tireur (200 px)',
        { shooterY: 17, targetY: 17, gap: 700, pipes: [{ at: 200, y: 17 }] }],
    ['tuyau contre le bord, tout le monde au bord',
        { shooterY: 4, targetY: 4, gap: 700, pipes: [{ at: 350, y: 4 }] }],
    ['deux tuyaux, un couloir au milieu',
        { shooterY: 17, targetY: 17, gap: 700, pipes: [{ at: 350, y: 5 }, { at: 350, y: 30 }] }],
    ['deux tuyaux, le couloir ferme d\'un cote',
        { shooterY: 20, targetY: 20, gap: 700, pipes: [{ at: 350, y: 20 }, { at: 350, y: 8 }] }],
    ['temoin : aucun tuyau',
        { shooterY: 17, targetY: 17, gap: 700, pipes: [] }],
];

console.log(`=== la rouge et le tuyau (${SEEDS} graines par situation) ===`);
console.log('situation                                        touche     tuyau     autre');
for (const [name, sc] of CASES) {
    const out = { touche: 0, tuyau: 0, autre: 0, 'sans cible': 0 };
    for (let s = 0; s < SEEDS; s++) out[fire(BASE, 30000 + s, sc)]++;
    const n = SEEDS - out['sans cible'];
    console.log(`${name.padEnd(46)}${pct(out.touche, n).padStart(9)}`
        + `${pct(out.tuyau, n).padStart(10)}${pct(out.autre, n).padStart(10)}`
        + (out['sans cible'] ? `   (${out['sans cible']} sans cible)` : ''));
}
