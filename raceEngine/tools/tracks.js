'use strict';

// Relecture des circuits dessines, hors service.
//
// Le moteur refuse de demarrer sur un dessin faux — c'est ce qu'on veut en
// production, mais pas au moment ou l'on dessine. Cet outil fait la meme lecture
// et dit la meme chose, sans rien lancer :
//
//   node tools/tracks.js            verifie tous les circuits et les resume
//   node tools/tracks.js --order    ce que ca donne sur un grand prix entier
//
// Il traduit surtout le dessin en chiffres : combien de pixels fait le tour, ou
// tombe la ligne, a quelle profondeur chaque boite se pose. C'est la seule facon
// de verifier qu'un trace fait bien ce qu'on croyait dessiner.

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

const CFG = loadShared('physics-config.js');
const track = require('../track');

const args = process.argv.slice(2);
const SHOW_ORDER = args.includes('--order');

let dir;
let tracks;
try {
    dir = track.resolveTracksDir(path.join(__dirname, '..'));
    tracks = track.loadTracks(dir, CFG);
} catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
}

console.log(`${tracks.length} circuit(s) dans ${dir}\n`);

let warned = 0;

for (const circuit of tracks) {
    let cfg;
    try {
        cfg = track.applyTrack(CFG, circuit);
    } catch (err) {
        console.error(`✗ ${err.message}`);
        process.exit(1);
    }

    const width = cfg.world.width;

    // Duree d'un tour a la vitesse de defilement : c'est la mesure qui parle,
    // bien plus qu'un nombre de pixels. Cinq tours font la course.
    const lapSeconds = width / cfg.speeds.roadPPS;

    console.log(`── ${circuit.name}  [${circuit.source}]`);
    console.log(`   tour     ${circuit.columns} colonnes = ${width} px`
        + `  (~${lapSeconds.toFixed(1)} s le tour, ~${(lapSeconds * cfg.race.laps).toFixed(0)} s la course)`);
    console.log(`   ligne    colonne ${circuit.finishColumn} = ${cfg.world.finishLineX} px`);
    console.log(`   piste    ${circuit.rows} rangees sur ${cfg.road.minY}..${cfg.road.maxY} de profondeur`);
    console.log(`   camera   approche a ${cfg.race.cameraApproachDistance} px de l'arrivee`);

    // Les boites sont regroupees par colonne : c'est ainsi qu'un pilote les
    // rencontre — un rideau a franchir, pas des boites eparpillees. Et leur
    // place dans le tour decide du rythme des objets, ce que le dessin ne dit
    // pas a l'oeil.
    const columns = new Map();
    for (const box of cfg.world.itemBoxes) {
        if (!columns.has(box.x)) columns.set(box.x, []);
        columns.get(box.x).push(box.y);
    }

    console.log(`   boites   ${cfg.world.itemBoxes.length} en ${columns.size} rideau(x)`);
    for (const [x, depths] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
        let after = x - cfg.world.finishLineX;
        if (after < 0) after += width;
        console.log(`            x=${x} (${Math.round((after / width) * 100)} % du tour apres la ligne)`
            + `  profondeurs ${depths.map(y => y.toFixed(1)).join(', ')}`);
    }

    // Les pipes, et surtout ce qu'ils laissent passer. Un trace se juge la :
    // un passage juste au-dessus du minimum se franchit, mais huit karts n'y
    // tiennent pas de front.
    if (cfg.world.pipes.length) {
        console.log(`   pipes    ${cfg.world.pipes.length} : `
            + cfg.world.pipes.map(p => `x=${p.x} y=${p.y.toFixed(1)}`).join('  |  '));

        const passage = track.narrowestPassage(cfg, cfg.world.pipes, width);
        console.log(`   passage  ${passage.free.toFixed(1)} de libre au plus etroit `
            + `(vers x=${Math.round(passage.x)}), minimum exige ${cfg.pipe.minPassageY}`);
    }

    for (const warning of circuit.warnings) {
        console.log(`   ⚠ ${warning}`);
        warned++;
    }
    console.log('');
}

if (SHOW_ORDER) {
    console.log(`Grand prix de ${CFG.grandPrix.races} manches :`);
    for (let round = 1; round <= CFG.grandPrix.races; round++) {
        console.log(`   manche ${round} — ${track.forRound(tracks, round).name}`);
    }
    console.log('');
}

console.log(warned
    ? `✓ ${tracks.length} circuit(s) lisible(s), ${warned} avertissement(s).`
    : `✓ ${tracks.length} circuit(s) lisible(s), rien a signaler.`);
