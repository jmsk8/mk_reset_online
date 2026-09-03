// Banc de scenario : une situation posee a la main, et la trace de ce que le kart
// en fait, tick par tick. `simulate.js` dit SI le pilotage marche ; celui-ci dit
// POURQUOI il a fait ce qu'il a fait. Ni l'un ni l'autre n'ecrit dans le moteur.
//
//     node tools/scenario.js
//
// Une ligne ne sort que lorsque quelque chose change. Les colonnes : profondeur,
// vitesse laterale, manoeuvre, menace retenue et son delai, plan qui commande,
// profondeur visee, drapeaux du plan.
//
// Ajouter un cas, c'est une ligne `run(...)` en bas de fichier. Les autres karts
// restent sur la grille, pour isoler une decision.
import * as PH from '../src/engine/index.js';
import CFG from '../src/config/index.js';
import * as track from '../src/track.js';

const DT = 1 / 30, DT_MS = DT * 1000;
const tracks = track.loadTracks(track.resolveTracksDir(import.meta.dirname), CFG);
const cfg = track.applyTrack(CFG, tracks[0]);

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

// Ce que le systeme de braquage PROMET, en clair : la situation dit ou aller,
// et seul le temps d'y arriver change d'un kart a l'autre. C'est la grandeur
// que rien ne mesurait, et elle se lit d'un coup d'oeil ici.
//
// Deux allures, parce qu'elles ne se valent plus : un kart lance a moins
// d'appui qu'un kart au ralenti (`physics.steer.pace`).
function steerTable() {
    const table = PH.deriveCharacterStats(cfg);
    const trip = cfg.hitboxes.itemVsKart.y + cfg.ai.crossDodgeMargin;   // degager un objet
    const dodge = (cfg.ai.dodgeIntensityMin + cfg.ai.dodgeIntensityMax) * 0.5;

    console.log(`\n=== temps de manoeuvre : degager ${trip} unites, profil esquive ===`);
    console.log('kart       agilite   a l\'arret   a pleine pointe');

    for (const name of Object.keys(table)) {
        const kart = { stats: table[name], isBill: false, contactSpeed: 0, steerBoost: 1 };

        const still = PH.steerDelay(cfg, PH.steerCap(cfg, kart, dodge), trip);
        kart.contactSpeed = table[name].topSpeed;
        const flat = PH.steerDelay(cfg, PH.steerCap(cfg, kart, dodge), trip);

        console.log(`${name.padEnd(9)} ${table[name].agility.toFixed(3).padStart(7)}`
            + `${still.toFixed(0).padStart(11)} ms ${flat.toFixed(0).padStart(13)} ms`);
    }
}

// scenario : { pipeY, itemY, itemGapPx, kartY }
// L'objet est pose `itemGapPx` AVANT le tuyau, tous deux devant le kart.
function run(name, sc, seed) {
    const rng = makeRng(seed);
    const state = PH.createWorldState(cfg, rng, 0, null, null);
    let t = 0;

    // Sortir du decompte.
    while (state.phase === 'countdown') { t += DT_MS; PH.stepPhysics(cfg, state, rng, t, DT); }

    // Un seul kart en piste : on isole la decision.
    const kart = state.karts[0];
    for (const other of state.karts) if (other !== kart) other.state = 'grid';

    kart.worldX = 1000;
    kart.yPercent = sc.kartY;
    kart.vy = 0;
    kart.absoluteVelocity = 450;
    kart.heldItem = null;
    kart.plan.threatId = 0;
    kart.pipeTargetIndex = -1;
    kart.sight.at = -1e9;

    // Un seul tuyau, pose devant.
    state.pipes.length = 0;
    state.pipes.push({ worldX: kart.worldX + 900, y: sc.pipeY });
    state.itemBoxes.length = 0;

    // Une banane, posee entre le kart et le tuyau.
    state.items.length = 0;
    PH.spawnLaunchedItem(cfg, state, rng, t, kart, 'banana', 9001,
        kart.worldX + 900 - sc.itemGapPx, sc.itemY, [], 1);
    const item = state.items[0];
    item.vx = 0;
    // Sans ca l'objet ne peut pas toucher son lanceur (itemArmDistance).
    item.ownerId = null;

    console.log(`\n=== ${name} ===`);
    console.log(`kart y=${sc.kartY}   banane y=${sc.itemY}   tuyau y=${sc.pipeY}`
        + `   (banane a ${sc.itemGapPx} px devant le tuyau)`);
    console.log('   t    y     vy   etat      menace  ttc   plan    laneY  drapeaux');

    let lastLine = '';
    for (let k = 0; k < 90; k++) {
        t += DT_MS;
        PH.stepPhysics(cfg, state, rng, t, DT);
        if (kart.state !== 'running') { console.log(`  ${t.toFixed(0).padStart(4)}  TOUCHE`); break; }

        const s = kart.sight, p = kart.plan;
        const flags = [
            s.back ? 'dos' : '',
            p.idle ? 'inerte' : '',
            p.stuck ? 'accule' : '',
            p.crossing ? 'traverse' : '',
            p.coarse ? 'approx' : ''
        ].filter(Boolean).join(',');

        const line = `${kart.yPercent.toFixed(1).padStart(5)} `
            + `${kart.vy.toFixed(1).padStart(6)}  ${kart.aiState.padEnd(9)} `
            + `${(s.threatKind || '-').padEnd(6)} `
            + `${(s.threatTtc === Infinity ? '-' : s.threatTtc.toFixed(0)).padStart(4)}  `
            + `${(p.threatId || '-').toString().padEnd(6)} `
            + `${p.threatId ? p.laneY.toFixed(1).padStart(5) : '    -'}  ${flags}`;
        if (line !== lastLine) console.log(`  ${t.toFixed(0).padStart(4)} ${line}`);
        lastLine = line;
    }
    const d = PH.getShortestDistance(cfg, state.pipes[0].worldX, kart.worldX);
    console.log(`  -> fin : y=${kart.yPercent.toFixed(1)}  tuyau y=${sc.pipeY}`
        + `  ecart au tuyau=${Math.abs(kart.yPercent - sc.pipeY).toFixed(1)}`
        + `  dist=${d.toFixed(0)}  etat=${kart.state}`);
}

// Un kart devant, dans l'axe, qui porte un objet dangereux. Rien n'est lance :
// c'est la decision de securite qu'on regarde, pas une esquive.
function runCarrier(name, sc, seed) {
    const rng = makeRng(seed);
    const state = PH.createWorldState(cfg, rng, 0, null, null);
    let t = 0;
    while (state.phase === 'countdown') { t += DT_MS; PH.stepPhysics(cfg, state, rng, t, DT); }

    const kart = state.karts[0];
    const carrier = state.karts[1];
    for (const other of state.karts) if (other !== kart && other !== carrier) other.state = 'grid';

    state.pipes.length = 0;
    state.itemBoxes.length = 0;
    state.items.length = 0;

    kart.worldX = 1000;
    kart.yPercent = sc.kartY;
    kart.vy = 0;
    kart.absoluteVelocity = 450;
    kart.heldItem = null;
    kart.plan.threatId = 0;
    kart.safetyRetryFrontAt = 0;
    kart.safetyRetryBackAt = 0;
    kart.sight.at = -1e9;
    kart.sight.frontAt = -Infinity;

    carrier.worldX = kart.worldX + sc.aheadPx;
    carrier.yPercent = sc.carrierY;
    carrier.absoluteVelocity = 450;
    carrier.vy = 0;
    // Objet en main, jamais lance : on isole la seule presence de l'objet.
    carrier.heldItem = { id: 7001, type: sc.itemType, holdPosition: sc.holdPosition };
    carrier.throwTime = t + 1e6;

    console.log(`\n=== ${name} ===`);
    console.log(`kart y=${sc.kartY}   porteur y=${sc.carrierY} a ${sc.aheadPx} px devant`
        + `   objet=${sc.itemType} (${sc.holdPosition})`);
    console.log('   t    y     vy   etat      plan     laneY  drapeaux');

    let last = '';
    for (let k = 0; k < 150; k++) {
        t += DT_MS;
        PH.stepPhysics(cfg, state, rng, t, DT);
        carrier.throwTime = t + 1e6;
        if (kart.state !== 'running') { console.log(`  ${t.toFixed(0).padStart(4)}  TOUCHE`); break; }

        const s = kart.sight, p = kart.plan;
        const flags = [s.back ? 'dos' : '', s.pressure ? 'latent' : ''].filter(Boolean).join(',');
        const line = `${kart.yPercent.toFixed(1).padStart(5)} ${kart.vy.toFixed(1).padStart(6)}  `
            + `${kart.aiState.padEnd(9)} ${(p.kind || '-').padEnd(7)} `
            + `${p.threatId ? p.laneY.toFixed(1).padStart(5) : '    -'}  ${flags}`;
        if (line !== last) console.log(`  ${t.toFixed(0).padStart(4)} ${line}`);
        last = line;
    }
    console.log(`  -> fin : y=${kart.yPercent.toFixed(1)}  porteur y=${sc.carrierY}`
        + `  ecart=${Math.abs(kart.yPercent - carrier.yPercent).toFixed(1)}`);
}

steerTable();

runCarrier('porteur devant dans l\'axe, verte en main',
    { kartY: 15, carrierY: 15, aheadPx: 200, itemType: 'greenShell', holdPosition: 'held' }, 4242);

runCarrier('porteur devant dans l\'axe, banane trainee',
    { kartY: 15, carrierY: 15, aheadPx: 250, itemType: 'banana', holdPosition: 'behind' }, 4242);

runCarrier('porteur devant HORS de l\'axe (rien ne doit bouger)',
    { kartY: 15, carrierY: 25, aheadPx: 200, itemType: 'greenShell', holdPosition: 'held' }, 4242);

runCarrier('porteur devant dans l\'axe, mais champignon (inoffensif)',
    { kartY: 15, carrierY: 15, aheadPx: 200, itemType: 'shroom', holdPosition: 'held' }, 4242);

// La banane est dans l'axe du kart ; le tuyau ferme le cote naturel de l'esquive.
run('banane dans l\'axe, tuyau du cote de l\'esquive naturelle',
    { kartY: 15, itemY: 15, pipeY: 22, itemGapPx: 300 }, 12345);

// Le tuyau est de l'autre cote : l'esquive naturelle est libre.
run('banane dans l\'axe, tuyau de l\'autre cote',
    { kartY: 15, itemY: 15, pipeY: 8, itemGapPx: 300 }, 12345);

// Objet et tuyau alignes : il faut passer a cote des deux.
run('banane pile devant le tuyau, meme profondeur',
    { kartY: 15, itemY: 15, pipeY: 15, itemGapPx: 200 }, 12345);

// Tuyau au milieu, banane sur le seul couloir libre.
run('banane posee dans le couloir que le tuyau laisse',
    { kartY: 15, itemY: 22, pipeY: 15, itemGapPx: 250 }, 12345);
