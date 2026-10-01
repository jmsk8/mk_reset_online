// Lecture des circuits dessines dans tracks/ (fichiers .md avec un bloc `track`) :
// `X` pour les bords, `x` pour la ligne, `B` pour une boite, un carre de `P` ou
// de `p` pour un tuyau.
//
//     ```track
//     XXXXXXXXXXXXXXXX
//                B
//        x       B   PP
//                B   PP
//     XXXXXXXXXXXXXXXX
//     ```
//
// Vue de dessus, course vers la droite, la derniere colonne rejoignant la
// premiere. Une colonne vaut CELL_PX px ; les rangees se partagent la profondeur
// de la piste. `applyTrack` pose le resultat sur une config.

import fs from 'node:fs';
import path from 'node:path';

// Une colonne = un motif de la bordure.
const CELL_PX = 80;

const FENCE_OPEN = /^\s*```+\s*track\s*$/;
const FENCE_CLOSE = /^\s*```+\s*$/;
const HEADING = /^#\s+(.+?)\s*$/;

function fail(source, line, message) {
    const where = line ? `${source}:${line}` : source;
    throw new Error(`${where} — ${message}`);
}

// Extrait le bloc du dessin (et le titre) du fichier.
function extractBlock(text, source) {
    const lines = text.split(/\r?\n/);

    let name = null;
    let start = -1;

    for (let i = 0; i < lines.length; i++) {
        if (start === -1) {
            const heading = lines[i].match(HEADING);
            if (heading && !name) name = heading[1];
            if (FENCE_OPEN.test(lines[i])) start = i;
            continue;
        }
        if (FENCE_CLOSE.test(lines[i])) {
            return { name: name, lines: lines.slice(start + 1, i), offset: start + 2 };
        }
    }

    if (start !== -1) fail(source, start + 1, 'bloc ```track jamais referme.');
    fail(source, 0, 'aucun bloc ```track. Un circuit se dessine entre ```track et ```.');
}

// Regroupe les cases de tuyau en carres de 2x2 (`PP`/`PP` vert, `pp`/`pp`
// rouge, sans difference de jeu). La premiere case libre lue est le coin
// haut-gauche de son tuyau : un dessin n'a qu'une lecture, ou il est refuse.
function assemblePipes(inner, cells, columns, lineNo, source) {
    const at = (row, col) => (inner[row] || '')[col] || ' ';
    const used = new Set();
    const key = (row, col) => row * columns + col;
    const pipes = [];

    for (const { col, row } of cells) {
        if (used.has(key(row, col))) continue;

        const ch = at(row, col);
        const other = (ch === 'P') ? 'p' : 'P';

        if (col + 1 >= columns) {
            fail(source, lineNo(row), `pipe coupe par le bord droit en colonne ${col} : `
                + 'un pipe ne se replie pas sur la premiere colonne. Le decaler vers la gauche.');
        }

        for (const [r, c] of [[row, col + 1], [row + 1, col], [row + 1, col + 1]]) {
            if (at(r, c) === other) {
                fail(source, lineNo(row), `pipe en colonne ${col} qui melange P et p : `
                    + 'un pipe est d\'une seule couleur, PP/PP vert ou pp/pp rouge.');
            }
            if (at(r, c) !== ch || used.has(key(r, c))) {
                fail(source, lineNo(row), `pipe incomplet en colonne ${col} : un pipe se `
                    + `dessine en carre de 2×2, ${ch}${ch} au-dessus de ${ch}${ch}.`);
            }
        }

        for (const [r, c] of [[row, col], [row, col + 1], [row + 1, col], [row + 1, col + 1]]) {
            used.add(key(r, c));
        }

        // Coin haut-gauche ; `applyTrack` en deduit le centre.
        pipes.push({ col: col, row: row, kind: (ch === 'p') ? 'red' : 'green' });
    }

    return pipes;
}

// Dessin en coordonnees de cellules (`source` pour les messages d'erreur).
function parseTrack(text, source) {
    const block = extractBlock(text, source);

    const rows = block.lines.map(line => line.replace(/\s+$/, ''));
    let first = 0;
    let last = rows.length - 1;
    while (first <= last && rows[first] === '') first++;
    while (last >= first && rows[last] === '') last--;

    if (last - first < 2) {
        fail(source, block.offset, 'un circuit demande au moins trois lignes : '
            + 'le bord du fond, une rangee de piste, le bord de devant.');
    }

    const lineNo = i => block.offset + i;

    for (let i = first; i <= last; i++) {
        if (rows[i].indexOf('\t') !== -1) {
            fail(source, lineNo(i), 'tabulation dans le dessin : sa largeur depend de '
                + "l'editeur, donc la colonne n'est plus lisible. Mettre des espaces.");
        }
    }

    // Les deux bords, pleins et de meme longueur, donnent la longueur du tour.
    const columns = rows[first].length;
    for (const i of [first, last]) {
        if (!/^X+$/.test(rows[i])) {
            fail(source, lineNo(i), 'la premiere et la derniere ligne du dessin sont les '
                + `bords de piste : que des X. Lue : "${rows[i]}".`);
        }
        if (rows[i].length !== columns) {
            fail(source, lineNo(i), `bords de longueurs differentes (${rows[first].length} `
                + `et ${rows[last].length} colonnes) : le tour n'a pas de longueur.`);
        }
    }

    const boxes = [];
    // Cases de tuyau assemblees une fois le dessin entier lu.
    const pipeCells = [];
    let finishColumn = -1;
    let finishLine = 0;
    const inner = last - first - 1;

    for (let i = first + 1; i < last; i++) {
        const row = rows[i];
        if (row.length > columns) {
            fail(source, lineNo(i), `${row.length} colonnes alors que les bords en font `
                + `${columns} : quelque chose deborde de la piste.`);
        }

        for (let col = 0; col < row.length; col++) {
            const ch = row[col];

            if (ch === ' ' || ch === '.') continue;

            if (ch === 'X') {
                fail(source, lineNo(i), `X en colonne ${col} : une piste de largeur variable `
                    + "n'est pas encore supportee. Les X ne vont que sur les deux lignes de bord.");
            }

            if (ch === 'x') {
                if (finishColumn !== -1 && finishColumn !== col) {
                    fail(source, lineNo(i), `ligne d'arrivee en colonne ${col} alors qu'elle est `
                        + `deja en colonne ${finishColumn} (ligne ${finishLine}) : elle traverse `
                        + 'la piste tout droit, donc une seule colonne.');
                }
                finishColumn = col;
                finishLine = lineNo(i);
                continue;
            }

            if (ch === 'B') {
                boxes.push({ col: col, row: i - first - 1 });
                continue;
            }

            if (ch === 'P' || ch === 'p') {
                pipeCells.push({ col: col, row: i - first - 1 });
                continue;
            }

            fail(source, lineNo(i), `caractere "${ch}" inconnu en colonne ${col}. `
                + 'Le dessin ne connait que X (bord), x (ligne), B (boite), '
                + 'PP/PP (pipe vert), pp/pp (pipe rouge) et l\'espace.');
        }
    }

    const pipes = assemblePipes(rows.slice(first + 1, last), pipeCells, columns,
        r => lineNo(first + 1 + r), source);

    if (finishColumn === -1) {
        fail(source, block.offset, "aucune ligne de depart/arrivee : il manque un x.");
    }
    if (!boxes.length) {
        fail(source, block.offset, 'aucune boite a objets : il manque au moins un B. '
            + 'Sans boite, personne ne recoit rien de la course entiere.');
    }

    return {
        name: block.name || path.basename(source, '.md'),
        source: source,
        columns: columns,
        rows: inner,
        finishColumn: finishColumn,
        boxes: boxes,
        // Tuyaux facultatifs ; ligne et boite obligatoires.
        pipes: pipes,
        warnings: []
    };
}

// Passage le plus etroit une fois les tuyaux poses (balayage au pas d'une
// demi-emprise de tuyau), en positions de centre de kart.
function narrowestPassage(cfg, pipes, width) {
    const hx = cfg.hitboxes.kartVsPipe.x;
    const hy = cfg.hitboxes.kartVsPipe.y;
    const step = Math.max(4, hx / 2);

    let worst = cfg.road.maxY - cfg.road.minY;
    let worstX = 0;

    for (let x = 0; x < width; x += step) {
        const blocked = [];
        for (const pipe of pipes) {
            let d = pipe.x - x;
            if (d < -width * 0.5) d += width;
            if (d > width * 0.5) d -= width;
            if (Math.abs(d) >= hx) continue;
            blocked.push([pipe.y - hy, pipe.y + hy]);
        }
        if (!blocked.length) continue;

        blocked.sort((a, b) => a[0] - b[0]);

        let free = 0;
        let cursor = cfg.road.minY;
        for (const span of blocked) {
            if (span[0] > cursor) free = Math.max(free, span[0] - cursor);
            if (span[1] > cursor) cursor = span[1];
        }
        free = Math.max(free, cfg.road.maxY - cursor);

        if (free < worst) {
            worst = free;
            worstX = x;
        }
    }

    return { free: worst, x: worstX };
}

// Pose le dessin sur une copie de la config (colonnes en distances, rangees en
// profondeurs).
function applyTrack(cfg, track) {
    const width = track.columns * CELL_PX;

    // Le tour doit etre plus long que la grille.
    const grid = cfg.race.grid;
    const gridDepth = grid.backOffset + 3 * grid.rowGap + grid.colStagger;
    if (width < gridDepth * 2) {
        fail(track.source, 0, `tour de ${width} px (${track.columns} colonnes) trop court : `
            + `la grille de depart en occupe deja ${gridDepth}. Il en faut au moins `
            + `${Math.ceil((gridDepth * 2) / CELL_PX)} colonnes.`);
    }

    const finishLineX = track.finishColumn * CELL_PX;

    // Rangee du haut = fond de piste (`road.maxY`) ; une seule rangee = milieu.
    const depth = cfg.road.maxY - cfg.road.minY;
    const rowY = row => (track.rows > 1)
        ? cfg.road.maxY - row * (depth / (track.rows - 1))
        : cfg.road.minY + depth / 2;

    const itemBoxes = track.boxes.map(box => ({
        x: box.col * CELL_PX,
        y: rowY(box.row)
    }));

    // Un tuyau se pose au milieu de son carre, entre deux rangees.
    const pipes = track.pipes.map(pipe => ({
        x: (pipe.col + 0.5) * CELL_PX,
        y: rowY(pipe.row + 0.5),
        // Couleur, pour le dessin seulement.
        kind: pipe.kind
    }));

    // Refus au chargement d'un circuit infranchissable.
    if (pipes.length) {
        const passage = narrowestPassage(cfg, pipes, width);
        if (passage.free < cfg.pipe.minPassageY) {
            fail(track.source, 0, `piste bouchee vers x=${Math.round(passage.x)} `
                + `(colonne ${Math.round(passage.x / CELL_PX)}) : il ne reste que `
                + `${passage.free.toFixed(1)} de passage libre en profondeur, il en faut `
                + `${cfg.pipe.minPassageY}. Deplacer ou retirer un pipe (bloc PP/PP ou pp/pp).`);
        }
    }

    // Avertissements de trace (pas des erreurs).
    track.warnings = [];

    // Boite dans la zone de la grille : ramassee des le depart.
    for (const box of itemBoxes) {
        let gap = finishLineX - box.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push(`boite a ${Math.round(gap)} px derriere la ligne, `
                + `dans la grille de depart (profonde de ${gridDepth} px).`);
        }
    }

    for (const pipe of pipes) {
        // Tuyau dans la grille.
        let gap = finishLineX - pipe.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push(`pipe a ${Math.round(gap)} px derriere la ligne, `
                + `dans la grille de depart : le peloton le prendra au feu vert.`);
        }

        // Tuyau devant une boite : boite inatteignable.
        for (const box of itemBoxes) {
            let ahead = box.x - pipe.x;
            if (ahead < -width * 0.5) ahead += width;
            if (ahead > width * 0.5) ahead -= width;
            if (ahead > 0 && ahead < cfg.hitboxes.kartVsPipe.x * 2
                && Math.abs(box.y - pipe.y) < cfg.hitboxes.kartVsPipe.y) {
                track.warnings.push(`pipe juste devant une boite (x=${pipe.x}, `
                    + `profondeur ${pipe.y.toFixed(1)}) : elle sera difficile a prendre.`);
            }
        }
    }

    return Object.assign({}, cfg, {
        world: Object.assign({}, cfg.world, {
            width: width,
            finishLineX: finishLineX,
            itemBoxes: itemBoxes,
            pipes: pipes
        }),
        race: Object.assign({}, cfg.race, {
            // Deux tours plus la marge, pour que la camera se gare sur la ligne.
            cameraApproachDistance: 2 * width + cfg.race.cameraApproachMargin
        })
    });
}

// Dossier des circuits (/app/tracks dans le conteneur, ou dans le depot).
function resolveTracksDir(base) {
    const candidates = [
        process.env.TRACKS_DIR,
        path.join(base, 'tracks'),
        path.join(base, '../tracks'),
        path.join(base, '../../tracks')
    ];

    for (const dir of candidates) {
        if (dir && fs.existsSync(dir)) return dir;
    }

    throw new Error('dossier tracks/ introuvable (cherche dans : '
        + candidates.filter(Boolean).join(', ') + '). '
        + 'Dans le conteneur il est monte par docker-compose : le moteur y est '
        + 'copie, les circuits non, pour se retoucher sans reconstruire l\'image.');
}

// Charge tous les circuits, dans l'ordre des noms de fichiers (ordre des
// manches). Un dessin faux ou infranchissable arrete le chargement (`cfg` sert
// a verifier la geometrie).
function loadTracks(dir, cfg) {
    const files = fs.readdirSync(dir)
        .filter(name => name.toLowerCase().endsWith('.md'))
        .filter(name => name.toLowerCase() !== 'readme.md')
        .sort();

    if (!files.length) {
        throw new Error(`aucun circuit dans ${dir} : il faut au moins un .md dessine. `
            + 'Voir tracks/README.md pour le format.');
    }

    return files.map(name => {
        const full = path.join(dir, name);
        const parsed = parseTrack(fs.readFileSync(full, 'utf8'), name);
        // Verification seulement ; chaque course refait le calcul.
        applyTrack(cfg, parsed);
        return parsed;
    });
}

// Circuit d'une manche (manches comptees a partir de 1, rotation en boucle).
function forRound(tracks, round) {
    return tracks[((round - 1) % tracks.length + tracks.length) % tracks.length];
}

export {
    CELL_PX,
    parseTrack,
    applyTrack,
    narrowestPassage,
    resolveTracksDir,
    loadTracks,
    forRound
};
