'use strict';

// Lecture des circuits dessines.
//
// Un circuit n'est plus quatre nombres dans physics-config.js : c'est un dessin
// dans tracks/, relu au demarrage du service. Le format tient en trois
// caracteres — `X` pour les bords, `x` pour la ligne de depart/arrivee, `B`
// pour une boite a objets — et le reste du fichier est de la prose : c'est un
// .md ordinaire, qui se lit tel quel sur GitHub.
//
//     ```track
//     XXXXXXXXXXXXXXXX
//                B
//        x       B
//     XXXXXXXXXXXXXXXX
//     ```
//
// Le dessin est vu de dessus, la course allant vers la droite, et la derniere
// colonne touche la premiere : le tour boucle. Une colonne vaut CELL_PX pixels
// de monde ; les rangees comprises entre les deux bords se partagent la
// profondeur de la piste, qui elle reste une constante de physique
// (road.minY..road.maxY). C'est pourquoi un `X` au milieu du dessin est refuse :
// une piste qui se resserre demanderait un profil de bords transmis au client
// et une route dessinee colonne par colonne, ce que le bandeau CSS actuel ne
// sait pas faire.
//
// Ce fichier ne connait pas la physique : il rend des coordonnees en cellules.
// C'est `applyTrack` qui les pose sur une config, seul endroit ou le dessin et
// les reglages se rencontrent.

const fs = require('fs');
const path = require('path');

// Un caractere = un motif rouge/blanc de la bordure. C'est l'unite visible la
// plus fine du decor : en dessous, une colonne de dessin ne correspondrait plus
// a rien de reperable a l'ecran.
const CELL_PX = 80;

const FENCE_OPEN = /^\s*```+\s*track\s*$/;
const FENCE_CLOSE = /^\s*```+\s*$/;
const HEADING = /^#\s+(.+?)\s*$/;

function fail(source, line, message) {
    const where = line ? `${source}:${line}` : source;
    throw new Error(`${where} — ${message}`);
}

// Le dessin, extrait de sa cloture. Le reste du fichier est ignore : on n'y
// cherche qu'un titre.
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

// Le dessin en coordonnees de cellules, sans aucune notion de pixel ni de
// profondeur : `applyTrack` s'en charge.
//
// `source` ne sert qu'aux messages d'erreur — un dessin faux doit dire quel
// fichier et quelle ligne relire.
function parseTrack(text, source) {
    const block = extractBlock(text, source);

    // Les lignes vides d'entree et de sortie sont du confort de redaction.
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

    // Les deux bords donnent la longueur du tour. Ils sont pleins et de meme
    // longueur, sans quoi la piste n'aurait ni debut ni fin nets.
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
    const pipes = [];
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

            // Deux couleurs, un seul obstacle. `P` plante un tuyau vert, `p`
            // un rouge, et c'est TOUTE la difference : meme emprise, meme
            // choc, meme place dans les priorites de l'IA. La couleur ne
            // voyage que jusqu'au decor.
            //
            // Elle n'est donc pas un element de plus a apprendre pour dessiner
            // un circuit : un tuyau est un tuyau, et le tracé se juge sur les
            // memes chiffres qu'avant — cf. `narrowestPassage`, qui ne les
            // distingue pas.
            if (ch === 'P' || ch === 'p') {
                pipes.push({
                    col: col,
                    row: i - first - 1,
                    kind: (ch === 'p') ? 'red' : 'green'
                });
                continue;
            }

            fail(source, lineNo(i), `caractere "${ch}" inconnu en colonne ${col}. `
                + 'Le dessin ne connait que X (bord), x (ligne), B (boite), '
                + 'P (pipe vert), p (pipe rouge) et l\'espace.');
        }
    }

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
        // Les pipes sont facultatifs : un circuit sans obstacle reste un
        // circuit. Une ligne et une boite, elles, ne se negocient pas.
        pipes: pipes,
        warnings: []
    };
}

// Le passage le plus etroit de la piste, une fois les pipes poses.
//
// Deux pipes voisins sans etre alignes se recouvrent partiellement, et c'est
// cette zone de recouvrement qui decide du passage : il ne suffit pas de
// regarder chaque colonne dessinee, il faut balayer la piste. Le pas vaut la
// demi-emprise d'un pipe, qui ne peut donc etre saute.
//
// Les intervalles sont en position de centre de kart : `kartVsPipe` porte deja
// la demi-carrosserie, si bien qu'une place libre de zero suffirait a passer en
// theorie. `minPassageY` demande de la marge, parce qu'un kart arrive rarement
// pile dans l'axe.
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

// Le dessin pose sur une config de physique : c'est le seul endroit ou une
// colonne devient une distance et une rangee une profondeur.
//
// Rend une config neuve plutot que de modifier celle recue : deux courses d'un
// meme grand prix ne tournent pas sur le meme circuit, et la config de l'une ne
// doit rien laisser dans celle de l'autre.
function applyTrack(cfg, track) {
    const width = track.columns * CELL_PX;

    // La grille se deploie en amont de la ligne. Si le tour est plus court que
    // ce qu'elle occupe, le fond de grille depasse la ligne par l'arriere et
    // les karts partent avec un tour d'avance sur eux-memes.
    const grid = cfg.race.grid;
    const gridDepth = grid.backOffset + 3 * grid.rowGap + grid.colStagger;
    if (width < gridDepth * 2) {
        fail(track.source, 0, `tour de ${width} px (${track.columns} colonnes) trop court : `
            + `la grille de depart en occupe deja ${gridDepth}. Il en faut au moins `
            + `${Math.ceil((gridDepth * 2) / CELL_PX)} colonnes.`);
    }

    const finishLineX = track.finishColumn * CELL_PX;

    // Rangee du haut = fond de piste = road.maxY, puisque yPercent est une
    // hauteur a l'ecran : plus c'est haut, plus c'est loin. Une seule rangee
    // dessinee ne designe aucun bord en particulier, donc le milieu.
    const depth = cfg.road.maxY - cfg.road.minY;
    const rowY = row => (track.rows > 1)
        ? cfg.road.maxY - row * (depth / (track.rows - 1))
        : cfg.road.minY + depth / 2;

    const itemBoxes = track.boxes.map(box => ({
        x: box.col * CELL_PX,
        y: rowY(box.row)
    }));

    const pipes = track.pipes.map(pipe => ({
        x: pipe.col * CELL_PX,
        y: rowY(pipe.row),
        // Elle ne sert qu'au dessin. Rien de ce qui suit — passage le plus
        // etroit, avertissements, priorites — ne la regarde.
        kind: pipe.kind
    }));

    // Un mur de pipes ne provoquerait aucune erreur : les karts se cogneraient
    // jusqu'au delai maximum, et la course serait close sur un classement
    // d'office. Rien dans les journaux ne dirait que le circuit est en cause —
    // d'ou ce refus au chargement, seul endroit ou le probleme est visible.
    if (pipes.length) {
        const passage = narrowestPassage(cfg, pipes, width);
        if (passage.free < cfg.pipe.minPassageY) {
            fail(track.source, 0, `piste bouchee vers x=${Math.round(passage.x)} `
                + `(colonne ${Math.round(passage.x / CELL_PX)}) : il ne reste que `
                + `${passage.free.toFixed(1)} de passage libre en profondeur, il en faut `
                + `${cfg.pipe.minPassageY}. Deplacer ou retirer un pipe (P ou p).`);
        }
    }

    // Ce qui se dessine sans etre faux, mais qui se joue mal. Un avertissement
    // et non un refus : c'est un choix de trace, pas une erreur de dessin.
    track.warnings = [];

    // Une boite posee dans l'ombre de la grille est ramassee par le peloton dans
    // la seconde qui suit le depart, avant meme que qui que ce soit ait pu
    // manoeuvrer pour l'avoir.
    for (const box of itemBoxes) {
        let gap = finishLineX - box.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push(`boite a ${Math.round(gap)} px derriere la ligne, `
                + `dans la grille de depart (profonde de ${gridDepth} px).`);
        }
    }

    for (const pipe of pipes) {
        // Un pipe dans la grille, c'est huit karts a l'arret qui se le
        // partagent au feu vert — voire un kart qui demarre dedans.
        let gap = finishLineX - pipe.x;
        if (gap < 0) gap += width;
        if (gap > 0 && gap < gridDepth) {
            track.warnings.push(`pipe a ${Math.round(gap)} px derriere la ligne, `
                + `dans la grille de depart : le peloton le prendra au feu vert.`);
        }

        // Un pipe pose devant une boite la rend inatteignable : le kart qui la
        // vise doit precisement passer la ou le tuyau ne le laisse pas.
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
            // Deux tours pleins, plus la marge de la config : la camera ne
            // sait que ralentir, il lui faut ce couloir pour se garer pile sur
            // la ligne. Derivee et non ecrite en dur, sinon chaque circuit
            // d'une autre longueur redemanderait le calcul a la main.
            cameraApproachDistance: 2 * width + cfg.race.cameraApproachMargin
        })
    });
}

// Le dossier des circuits, cherche la ou il se trouve selon qu'on tourne dans le
// conteneur (monte en /app/tracks) ou dans le depot.
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
        + 'Dans le conteneur il est monte par docker-compose, comme physics.js.');
}

// Tous les circuits du dossier, dans l'ordre des noms de fichiers : c'est cet
// ordre qui devient celui des manches d'un grand prix, donc il se pilote en
// nommant les fichiers 01-, 02-, ...
//
// Un dessin faux arrete le chargement au lieu d'etre saute : un circuit qui
// disparait en silence de la rotation se remarquerait trois courses plus tard.
//
// `cfg` sert a valider la geometrie ici et pas plus tard. Le dessin seul ne dit
// pas si la piste est franchissable : il faut les hitbox pour le savoir. Poser
// cette verification au chargement, et non au depart d'une course, est ce qui
// fait la difference entre un service qui refuse de demarrer avec un message et
// un service qui tourne puis meurt a la premiere connexion — en boucle, parce
// que le conteneur le relance.
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
        // Le resultat est jete : seules les erreurs qu'il leve nous interessent.
        // Chaque course refera le calcul sur sa propre config.
        applyTrack(cfg, parsed);
        return parsed;
    });
}

// Le circuit d'une manche. Le grand prix compte ses courses a partir de 1, et la
// rotation reboucle : quatre manches sur deux circuits alternent, ce qui reste
// un grand prix jouable.
function forRound(tracks, round) {
    return tracks[((round - 1) % tracks.length + tracks.length) % tracks.length];
}

module.exports = {
    CELL_PX,
    parseTrack,
    applyTrack,
    narrowestPassage,
    resolveTracksDir,
    loadTracks,
    forRound
};
