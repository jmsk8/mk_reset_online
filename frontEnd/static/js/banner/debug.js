// Le HUD de debug : la carte de piste, la couche de vision, les emprises.
//
// Rien ici ne tourne hors de `GAME_CONFIG.debugMode`. C'est un instrument
// d'observation : il lit l'etat, il ne l'ecrit jamais.

// La carte de debug : une portion de piste vue de dessus, l'abscisse en longueur,
// l'ordonnee en PROFONDEUR. Ce qui s'y dessine vient du serveur et de lui seul
// (`visionTuple`) — le client ne refait aucun calcul de perception.
//
// Une FENETRE et non le tour entier : un tour fait 3840 px de long pour 126 de
// profondeur, soit 30 : 1 contre 6 : 1 pour le cadre. Les deux axes ne
// partageaient donc pas la meme echelle et aucune forme ne ressemblait a
// elle-meme. Mettre les axes a la meme echelle sur un tour entier ne laisse que
// 22 px de profondeur, ou un kart mesure un pixel.
//
// La fenetre est donc centree sur le kart observe et dessinee a l'ECHELLE 1 : un
// pixel de monde pour un pixel de carte. Ca coute la hauteur de la piste en page,
// et une partie du champ du kart sort du dessin — en echange, une distance
// mesuree a l'ecran est la vraie distance.

// La profondeur dans le SENS DE LA SCENE : le fond de piste en haut, le bord
// proche en bas, comme la banniere le montre. Les extremites sont rentrees de
// quelques pour cent, les marques etant centrees sur leur point.
const DEPTH_PAD = 7;

function depthPct(y) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 50;
    const t = (y - lo) / (hi - lo);
    const inner = 100 - DEPTH_PAD * 2;
    return Math.max(0, Math.min(100, DEPTH_PAD + (1 - t) * inner));
}

// La fenetre : le bord gauche et la largeur, en px de monde. Recalcules a chaque
// image — elle suit le kart observe.
let mapView = { start: 0, span: 1 };

let mapHudHeight = 0;

// Combien de px de monde vaut UNE unite de profondeur, ici et maintenant.
//
// Le moteur n'a pas cette constante et n'en veut pas : la banniere n'a pas la
// meme hauteur sur mobile et sur PC. Elle se mesure donc la ou la scene la
// definit — un kart se pose a `bottom: yPercent%` de son conteneur.
function depthToWorldPx() {
    // Mesuree par `refreshLayoutMetrics()`, jamais ici : cette fonction est
    // appelee depuis le rendu, et une lecture du DOM a cet endroit serait la pire
    // de toutes.
    //
    // La bande ROULABLE, et non la scene ni l'asphalte : la scene a grandi quand
    // la bordure mordait sur le decor, l'asphalte deborde derriere la piste. Les
    // trois ont rendu le meme nombre longtemps, ce qui rendait la confusion
    // invisible.
    const band = WORLD.roadMaxY - WORLD.roadMinY;
    const h = viewMetrics.roadBandHeight;
    // Repli : la valeur PC, celle que `bodies.depthPx` pose en config moteur et
    // dont descendent l'aplatissement du kart et la rondeur du tuyau.
    return (h > 0 && band > 0) ? h / band : 3.6;
}

// Largeur de la bande d'arrivee, en px de monde. Mesuree sur l'element du decor
// plutot que recopiee : c'est le CSS qui la decide, et une copie finirait par
// mentir. La mesure se prend dans `refreshLayoutMetrics()` — c'est une largeur de
// mise en page, prise avant la mise a l'echelle mobile, donc bien en px de MONDE.
function finishBandWidth() {
    // Repli sur la valeur du CSS, le temps que le decor soit mesurable.
    return cachedFinishBand > 0 ? cachedFinishBand : 60;
}

// Recentre la fenetre et remet le cadre a l'echelle.
//
// L'ECHELLE EST UN, et c'est elle la donnee : un kart mesure sur la carte les 60
// x 18 px qu'il occupe au sol. Tout le reste en decoule — la largeur du cadre se
// choisit en CSS, la fenetre vaut cette largeur, la hauteur vaut la profondeur de
// piste.
//
// C'est l'inverse de la version precedente, qui fixait la fenetre sur la portee
// de vue et en deduisait une echelle de 0.58 : tout le champ tenait dans le
// cadre, mais les corps y faisaient la moitie de leur taille.
function updateMapView(hud) {
    const vis = WORLD.vision;

    // Largeur prise dans le cache, jamais relue ici : `clientWidth` tombe apres
    // les ecritures de style de `renderState`, et le navigateur doit alors
    // recalculer toute la mise en page. La carte etait le premier outil fausse
    // par la mesure qu'elle declenchait.
    const frame = viewMetrics.hudWidth || WORLD.width;
    const span = Math.max(1, Math.min(frame, WORLD.width));

    // Le kart observe fait le centre — c'est sa vue qu'on lit. Sans lui, la
    // camera.
    let centre = renderCameraX;
    if (focusedKartId !== null) {
        const watched = worldState.kartsById[focusedKartId];
        if (watched) centre = watched.worldX;
    }

    // Le cadre penche du cote ou le kart REGARDE : il voit 1400 px devant pour
    // 1000 derriere, et a echelle 1 ce qu'on sacrifie doit etre l'arriere. Le
    // decalage est borne au quart de la fenetre pour que le kart ne se retrouve
    // jamais sur un bord.
    const quarter = span / 4;
    let bias = vis ? (vis.rangeFront - vis.rangeBack) / 2 : 0;
    if (bias > quarter) bias = quarter;
    if (bias < -quarter) bias = -quarter;

    mapView.span = span;
    mapView.start = centre - span / 2 + bias;

    // Echelle 1 : la bande vaut la profondeur de piste, en px de monde. Pas
    // d'arrondi — le cadre porte `DEPTH_PAD` % de marge, et arrondir sa hauteur
    // decale la bande utile d'autant.
    const band = (WORLD.roadMaxY - WORLD.roadMinY) * depthToWorldPx();
    const height = band / ((100 - DEPTH_PAD * 2) / 100);

    // Ecrite seulement quand elle change : la poser a chaque image forcerait un
    // recalcul de mise en page soixante fois par seconde.
    if (height > 0 && height !== mapHudHeight) {
        mapHudHeight = height;
        hud.style.height = `${height.toFixed(2)}px`;
    }
}

// Ou tombe un point du monde dans la fenetre, en px depuis son bord gauche. Le
// tour boucle : ce qui PRECEDE la fenetre se lit en negatif, sans quoi un corps
// qui entre par la gauche serait confondu avec un corps qui sort par la droite.
function mapOffset(worldX) {
    const w = WORLD.width;
    let d = worldX - mapView.start;
    if (w > 0) {
        d = ((d % w) + w) % w;
        // Le partage se fait au milieu de ce qui RESTE hors du cadre, et non au
        // demi-tour : la fenetre peut couvrir plus de la moitie d'un tour, et
        // basculer a w/2 renverrait sa propre moitie droite du cote des negatifs.
        if (d > (w + mapView.span) / 2) d -= w;
    }
    return d;
}

// Vrai quand un point tombe dans le cadre. Ce qui n'y est pas ne se dessine
// pas : une marque repliee sur un bord mentirait sur une position.
function inMapView(pct) {
    return pct >= 0 && pct <= 100;
}

// Un corps se dessine a son emprise reelle et non en pastille de taille fixe. Les
// deux axes portant la meme echelle, une largeur et une profondeur s'y comparent
// : un tuyau est visiblement plus large qu'un kart.

function spanXPct(halfX) {
    return (halfX * 2 / mapView.span) * 100;
}

// La profondeur ne dispose que de la bande interieure, celle que `depthPct`
// remplit : les marges du cadre n'en font pas partie.
function spanYPct(halfY) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 0;
    return (halfY * 2 / (hi - lo)) * (100 - DEPTH_PAD * 2);
}

// Pose une marque a sa taille reelle. `round` pour le seul corps qui l'est.
function sizeEntity(el, half) {
    el.style.width = `${spanXPct(half.x)}%`;
    el.style.height = `${spanYPct(half.y)}%`;
    el.style.borderRadius = half.round ? '50%' : '0';
}

// Un segment du monde ramene a la fenetre et coupe a ses bords. `len` est signe —
// negatif pour un regard vers l'arriere. Un segment y est d'un seul tenant, la
// fenetre ne faisant jamais le tour.
function worldSegments(from, len) {
    const span = mapView.span;

    let a = mapOffset(len < 0 ? from + len : from);
    let b = a + Math.abs(len);

    if (b <= 0 || a >= span) return [];
    if (a < 0) a = 0;
    if (b > span) b = span;

    return [[(a / span) * 100, ((b - a) / span) * 100]];
}

function xPct(worldX) {
    return (mapOffset(worldX) / mapView.span) * 100;
}

// Une bande horizontale : un morceau de monde sur une tranche de profondeur.
function bandHtml(cls, from, len, loY, hiY, title) {
    const top = depthPct(loY);
    const bottom = depthPct(hiY);
    const y = Math.min(top, bottom);
    const h = Math.max(Math.abs(bottom - top), 1.5);

    return worldSegments(from, len).map(seg =>
        `<div class="${cls}" style="left:${seg[0].toFixed(3)}%;width:${seg[1].toFixed(3)}%;` +
        `top:${y.toFixed(2)}%;height:${h.toFixed(2)}%;"${title ? ` title="${title}"` : ''}></div>`
    ).join('');
}

// Un trait de profondeur, sur toute la largeur de la carte.
function ruleHtml(cls, y, title) {
    return `<div class="${cls}" style="top:${depthPct(y).toFixed(2)}%;"${title ? ` title="${title}"` : ''}></div>`;
}

// Une OMBRE : un trapeze au sol, entre deux ecarts au kart, avec sa propre
// profondeur a chaque bout. Elle s'elargit en s'eloignant de l'oeil et s'arrete
// net — c'est tout le modele de la vue a la troisieme personne.
//
// Le rectangle qui la porte couvre son enveloppe, `clip-path` y taille le
// trapeze. Coupee au bord du cadre, ses profondeurs se reinterpolent a la coupe.
function shadowHtml(from, to, loA, hiA, loB, hiB) {
    // Un coup d'oeil arriere projette l'ombre dans le sens des x decroissants :
    // on remet le proche a gauche AVEC ses profondeurs, sans quoi le trapeze se
    // dessine a l'envers.
    if (to < from) {
        const x = from; from = to; to = x;
        const l = loA; loA = loB; loB = l;
        const h = hiA; hiA = hiB; hiB = h;
    }

    const span = to - from;

    // Bornee a la piste : au-dela elle ne cache plus rien de reel, et un
    // trapeze qui deborde de dix fois la hauteur ecrase le dessin.
    const clampY = y => Math.max(WORLD.roadMinY - 1, Math.min(WORLD.roadMaxY + 1, y));

    const at = x => {
        const t = (span === 0) ? 0 : (x - from) / span;
        return [clampY(loA + (loB - loA) * t), clampY(hiA + (hiB - hiA) * t)];
    };

    // Coupee aux bords de la fenetre, profondeurs reinterpolees a la coupe : sans
    // ca le morceau visible porterait la largeur du bout reste dehors.
    const view = mapView.span;
    const head = mapOffset(from);

    let x0 = from;
    let x1 = to;
    if (head < 0) x0 = from - head;
    if (head + span > view) x1 = from + (view - head);

    if (x1 <= x0) return '';

    const a = at(x0);
    const b = at(x1);

    const left = ((head + (x0 - from)) / view) * 100;
    const width = ((x1 - x0) / view) * 100;

    // Les quatre coins, en pourcentage de la boite : haut-gauche, haut-droit,
    // bas-droit, bas-gauche.
    const yTopA = depthPct(a[1]);
    const yBotA = depthPct(a[0]);
    const yTopB = depthPct(b[1]);
    const yBotB = depthPct(b[0]);

    const top = Math.min(yTopA, yTopB);
    const bot = Math.max(yBotA, yBotB);
    const h = Math.max(bot - top, 0.5);
    const pc = y => (((y - top) / h) * 100).toFixed(2);

    return `<div class="dv-shadow" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;` +
           `top:${top.toFixed(2)}%;height:${h.toFixed(2)}%;` +
           `clip-path:polygon(0% ${pc(yTopA)}%,100% ${pc(yTopB)}%,` +
           `100% ${pc(yBotB)}%,0% ${pc(yBotA)}%);"></div>`;
}

// COUPE POUR L'INSTANT. Passer a true rend le faisceau, rien d'autre a toucher :
// le dessin ne depend que du releve de vue, deja transmis.
const SHOW_RAY_FAN = false;

// Le FAISCEAU, trace depuis l'oeil — le point de vue en arriere du kart
// (`vision.eye.back`). C'est de la que tout le modele d'occlusion se mesure :
// `shadowHides` compare des PENTES rapportees a l'oeil, et un angle mort est la
// projection d'un corps depuis ce point. Les trapezes le montraient deja, mais
// amputes de leur sommet.
//
// Deux familles de traits : les rayons de BORD donnent l'ouverture du faisceau
// meme quand rien ne masque ; les rayons d'ARETE, deux par corps solide, bornent
// son ombre et montrent que le trapeze EST une projection.
//
// En SVG et non en div : un trait oblique se decrit par deux points.
function rayFanHtml(v, dir, lo, hi) {
    const span = mapView.span;

    // Tous les points se reperent PAR RAPPORT A L'OEIL, jamais chacun pour soi :
    // le tour boucle, et deux `mapOffset` independants peuvent tomber de part et
    // d'autre de la couture.
    const eyeOff = mapOffset(v.x - v.eyeBack * dir);
    const px = dw => (((eyeOff + dw) / span) * 100).toFixed(3);
    const py = y => depthPct(y).toFixed(2);

    // Un point a `look` du kart est a `look + eyeBack` de l'oeil, du cote
    // balaye. C'est la seule conversion du dessin, et elle vaut pour tout.
    const reach = look => (look + v.eyeBack) * dir;

    const x0 = px(0);
    const y0 = py(v.y);
    const ray = (cls, look, y) =>
        `<line class="${cls}" x1="${x0}%" y1="${y0}%" ` +
        `x2="${px(reach(look))}%" y2="${py(y)}%" />`;

    const lines = [ray('dv-ray dv-ray-edge', v.range, lo),
                   ray('dv-ray dv-ray-edge', v.range, hi)];

    // `sh[1]` est le bout de l'ombre, `sh[4]`/`sh[5]` ses deux profondeurs la —
    // donc exactement les deux points ou aboutissent les rayons rasants.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[4]));
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[5]));
    }

    return `<svg class="dv-rays" width="100%" height="100%">${lines.join('')}</svg>`;
}

// Un point pose a un endroit precis du monde. Hors fenetre, il ne se dessine
// pas : replie sur un bord, il mentirait sur une position.
function pinHtml(cls, worldX, y, label) {
    const left = xPct(worldX);
    if (!inMapView(left)) return '';
    return `<div class="${cls}" style="left:${left.toFixed(3)}%;top:${depthPct(y).toFixed(2)}%;"` +
           `${label ? ` title="${label}"` : ''}></div>`;
}

// Le dessin de la vue, refait a chaque releve neuf — un balayage tourne douze
// fois par seconde, l'affichage soixante.
//
// La fenetre, elle, DEFILE : le meme releve ne tombe pas au meme endroit d'une
// image a l'autre. Le cadrage entre donc dans ce qui declenche un redessin, sans
// quoi la couche de vision se fige pendant que la piste glisse dessous.
let visionDrawn = null;
let visionDrawnAt = null;
let visionNote = '';

function renderVisionLayer() {
    const layer = document.getElementById('debug-vision');
    if (!layer) return;

    const v = worldState.vision;

    // Pourquoi il n'y a rien a dessiner, quand il n'y a rien a dessiner. Un
    // `return` muet est ce qui a laisse cette carte vide sans que personne ne
    // s'en apercoive : chaque cause a sa phrase, et elle s'affiche a la place du
    // dessin.
    let note = '';
    if (!WORLD.vision) {
        // Le `hello` ne porte pas les distances de vue : le service tourne sur
        // une version anterieure du protocole. Recharger la page n'y changera
        // rien.
        note = 'service de course a redemarrer (hello sans bloc vision)';
    } else if (focusedKartId === null) {
        note = 'aucun kart suivi — clique un kart dans le classement';
    } else if (!v) {
        note = `vue demandee pour le kart ${focusedKartId}, rien recu`;
    }

    if (note) {
        if (note !== visionNote) {
            visionNote = note;
            visionDrawn = null;
            layer.innerHTML = `<div class="dv-note">${note}</div>`;
        }
        return;
    }

    visionNote = '';
    if (v === visionDrawn && mapView.start === visionDrawnAt) return;
    visionDrawn = v;
    visionDrawnAt = mapView.start;

    const cfg = WORLD.vision;
    const dir = v.scanBack ? -1 : 1;
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    const html = [];

    // 1. LE CHAMP. Jusqu'ou porte CE balayage-la, dans le sens ou il a eu lieu.
    //    La portee vient du serveur : elle n'est pas la meme devant et derriere,
    //    et la choisir ici serait deja une deduction.
    html.push(bandHtml('dv-cone', v.x, v.range * dir, lo, hi,
        `${v.scanBack ? 'arriere' : 'avant'} ${v.range}px`));

    // 1 bis. LES ANGLES MORTS. Ce que les corps solides jettent au sol depuis
    //    la camera de poursuite. Chacun s'elargit en s'eloignant et S'ARRETE :
    //    la ou il s'arrete, le kart revoit la piste. C'est la lecture qui
    //    manquait — un trou noir dans le champ vert, avec un bord.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        html.push(shadowHtml(v.x + sh[0] * dir, v.x + sh[1] * dir,
                             sh[2], sh[3], sh[4], sh[5]));
    }

    // 1 ter. LE FAISCEAU : d'ou partent ces ombres, et pourquoi elles ont cette
    // forme.
    //    Pose apres elles pour que les rayons se lisent PAR-DESSUS le noir. Coupe pour
    //    l'instant, cf. `SHOW_RAY_FAN`.
    if (SHOW_RAY_FAN) html.push(rayFanHtml(v, dir, lo, hi));

    // 2. LA LIGNE DE TIR qu'on partage : la portee du danger latent, sur la
    //    seule bande ou l'alignement compte. Hors de cette bande, un porteur ne
    //    peut rien contre le kart et se decaler ne veut rien dire.
    html.push(bandHtml('dv-press', v.x, cfg.pressureRange * dir,
        v.y - cfg.clear, v.y + cfg.clear, `alignement ±${cfg.clear}`));

    // 3. LA VOIE : plus large que le degagement, et elle doit l'etre — les deux
    //    corps bougent en profondeur pendant le temps avant impact.
    html.push(ruleHtml('dv-lane', v.y - cfg.threatLane, 'voie'));
    html.push(ruleHtml('dv-lane', v.y + cfg.threatLane, 'voie'));

    // 4. CE QUI FERME UN PASSAGE. C'est la lecture la plus utile de la carte :
    //    un couloir libre est un trou entre deux barres. Un mur dur — un tuyau —
    //    ne se franchit pas, le reste se paie.
    for (let i = 0; i < v.spans.length; i++) {
        const s = v.spans[i];
        html.push(bandHtml(s[4] ? 'dv-span dv-hard' : 'dv-span', v.x, s[2],
            s[0], s[1], `${s[4] ? 'mur' : 'corps'} a ${Math.round(s[2])}px`));
    }

    // 5. CE QUE LE MOTEUR A RETENU. Chaque marque est une decision de la vue,
    //    pas une entite de la scene : c'est l'ecart entre les deux qu'on cherche.
    if (v.threat) {
        html.push(ruleHtml('dv-threat', v.threat[2],
            `menace ${v.threat[1]} · ${v.threat[3] < 0 ? 'jamais' : v.threat[3] + 'ms'}`));
    }
    if (v.pressure) {
        html.push(ruleHtml('dv-carrier', v.pressure[0],
            v.pressure[2] ? 'porteur derriere' : 'porteur devant'));
    }
    if (v.pipe) {
        const pipe = worldState.pipes[v.pipe[0]];
        if (pipe) html.push(pinHtml('dv-pin dv-pin-pipe', pipe.worldX, pipe.y, 'tuyau qui barre'));
    }
    if (v.box) html.push(pinHtml('dv-pin dv-pin-box', v.x + v.box[1], v.box[0], 'boite visee'));
    if (v.red) html.push(pinHtml('dv-pin dv-pin-red', v.x - v.red[0], v.red[1],
        `rouge derriere ×${v.red[3]}`));

    // 6. LA CONSIGNE. La profondeur que le kart REJOINT, s'il a un plan. Une vue
    //    sans le geste qu'elle a produit ne se juge pas.
    if (v.plan) html.push(ruleHtml('dv-plan', v.plan[3], `${v.plan[0]}${v.plan[4] ? ' (approx.)' : ''}`));

    // 7. L'OEIL. Il n'est PAS sur le kart : la camera le suit de `eyeBack`
    //    pixels, du cote oppose au regard, et c'est de la que partent toutes
    //    les ombres ci-dessus. La voir a sa place est la moitie de ce qui rend
    //    le dessin comprehensible.
    const eyePct = xPct(v.x - v.eyeBack * dir);
    if (inMapView(eyePct)) {
        html.push(`<div class="dv-eye${v.scanBack ? ' dv-eye-back' : ''}" ` +
                  `style="left:${eyePct.toFixed(3)}%;` +
                  `top:${depthPct(v.y).toFixed(2)}%;"></div>`);
    }
    html.push(bandHtml('dv-eyelink', v.x, -v.eyeBack * dir, v.y, v.y, 'recul de camera'));

    layer.innerHTML = html.join('');
}

function initDebugHUD() {
    let hud = document.getElementById('debug-hud');
    if (!hud) {
        hud = document.createElement('div');
        hud.id = 'debug-hud';
        document.body.appendChild(hud);
    }
    hud.innerHTML = '';
    hud.style.display = 'block';
    // La hauteur se recalcule : `updateMapView` ne la reecrit que lorsqu'elle
    // change, et le cadre vient d'etre vide.
    mapHudHeight = 0;
    visionDrawnAt = null;

    // La couche de vision passe en premier : elle est le fond sur lequel les
    // entites se lisent, jamais l'inverse.
    const vision = document.createElement('div');
    vision.id = 'debug-vision';
    hud.appendChild(vision);
    visionDrawn = null;

    // La ligne d'arrivee defile comme le reste : la fenetre bouge, elle ne
    // reste pas a une fraction fixe du cadre. Sa position se pose donc a chaque
    // image, avec celle des corps.
    const finishLine = document.createElement('div');
    finishLine.className = 'debug-entity debug-finish';
    finishLine.id = 'debug-finish';
    hud.appendChild(finishLine);

    // Chaque corps se dessine a son emprise, et le serveur seul la connait. Un
    // vieux serveur qui ne l'enverrait pas laisse le repli hors ligne prendre le
    // relais : la carte reste juste plutot que de disparaitre.
    const hitboxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;

    // Les tuyaux : ils ne bougent pas dans le MONDE, mais la fenetre si. Leur
    // emprise se pose une fois — elle ne change jamais — et leur position a
    // chaque image, comme celle des karts. C'est le corps le plus structurant de
    // la piste, le seul qu'on ne traverse pas.
    worldState.pipes.forEach((pipe, i) => {
        const dPipe = document.createElement('div');
        dPipe.className = 'debug-entity debug-pipe';
        dPipe.id = `debug-pipe-${i}`;
        dPipe.style.top = `${depthPct(pipe.y)}%`;
        sizeEntity(dPipe, hitboxes.pipe);
        hud.appendChild(dPipe);
    });

    worldState.itemBoxes.forEach((box, i) => {
        const dBox = document.createElement('div');
        dBox.className = 'debug-entity debug-itembox';
        dBox.id = `debug-box-${i}`;
        dBox.style.top = `${depthPct(box.y)}%`;
        sizeEntity(dBox, hitboxes.itemBox);
        hud.appendChild(dBox);
    });

    worldState.karts.forEach(kart => {
        const dKart = document.createElement('div');
        dKart.className = 'debug-entity debug-kart';
        dKart.id = `debug-kart-${kart.id}`;
        dKart.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        // Son emprise a lui, pas celle du kart de reference : c'est tout
        // l'interet de la carte que d'y voir un long et un court n'occuper ni
        // la meme longueur ni la meme profondeur.
        sizeEntity(dKart, kart.body || hitboxes.kart);
        hud.appendChild(dKart);
    });

    // Les objets vont et viennent : leur couche se reecrit a chaque image, elle
    // ne se peuple pas ici.
    const items = document.createElement('div');
    items.id = 'debug-items';
    hud.appendChild(items);

    // Ce que la banniere montre, dans la fenetre. Un seul element : la carte ne
    // fait plus le tour du monde, donc ce rectangle ne peut plus se couper en
    // deux morceaux comme il le fallait du temps du tour complet.
    const camView = document.createElement('div');
    camView.className = 'debug-camera-view';
    camView.id = 'debug-camera-view';
    hud.appendChild(camView);

    const leaderboard = document.createElement('div');
    leaderboard.id = 'debug-leaderboard';
    leaderboard.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 10px 15px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 14px;
        z-index: 9999;
        min-width: 200px;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: bold; margin-bottom: 8px; text-align: center; border-bottom: 1px solid #555; padding-bottom: 5px;';
    title.innerText = '🏁 Classement';
    leaderboard.appendChild(title);

    const list = document.createElement('div');
    list.id = 'debug-leaderboard-list';
    leaderboard.appendChild(list);

    document.body.appendChild(leaderboard);
    // Le cadre vient d'apparaitre : on prend sa largeur maintenant, une fois,
    // plutot qu'a chaque image depuis updateMapView().
    refreshLayoutMetrics();
}

// Les objets, redessines d'un bloc a chaque image : ils naissent et disparaissent
// en pleine course, et une couche reecrite a moins d'etat qu'un pool a tenir a
// jour.
//
// Deux corps se DESSINENT comme « sans emprise » plutot que d'etre passes sous
// silence — un objet inoffensif au milieu de la piste est ce qu'on vient verifier
// : la bleue, qui survole tout et dont le souffle a un rayon croissant, et la
// banane en cloche tant qu'elle MONTE.
//
// L'objet TRAINE n'est pas dans `worldState.items` mais dans `kart.heldItem`, et
// il a pourtant une emprise, testee a `worldX + heldBehindX` : c'est elle qui
// fait du trainage un BOUCLIER, et qui blesse le poursuivant colle. Sans lui la
// carte mentait par omission sur le cas le plus utile a verifier.
function renderItemLayer() {
    const layer = document.getElementById('debug-items');
    if (!layer) return;

    const boxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;
    const half = boxes.item || OFFLINE_WORLD.hitboxes.item;
    const behindX = (boxes.heldBehindX !== undefined)
        ? boxes.heldBehindX : OFFLINE_WORLD.hitboxes.heldBehindX;

    const w = spanXPct(half.x).toFixed(3);
    const h = spanYPct(half.y).toFixed(3);
    const html = [];

    const mark = (cls, worldX, y, title, sized) => {
        const left = xPct(worldX);
        if (!inMapView(left)) return;
        html.push(`<div class="${cls}" style="left:${left.toFixed(3)}%;` +
                  `top:${depthPct(y).toFixed(2)}%;${sized ? `width:${w}%;height:${h}%;` : ''}" ` +
                  `title="${title}"></div>`);
    };

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];

        const blue = item.type === 'blueShell' || item.type === 'blueBlast';
        const inert = blue || item.rising;

        // Sans emprise, il reste un point : on marque OU il est, sans lui
        // preter une boite qu'il n'a pas.
        const cls = 'dv-item' + (inert ? ' dv-item-inert' : '')
            + (item.type === 'banana' ? ' dv-item-banana' : '');

        mark(cls, item.worldX, item.y,
             `${item.type}${inert ? ' — sans emprise' : ''}`, !inert);
    }

    // Les objets traines, pris sur leur porteur. Meme emprise qu'un objet
    // largue — c'est la meme constante qui les teste — mais une autre couleur :
    // celui-ci encaisse, il ne blesse pas.
    for (let k = 0; k < worldState.karts.length; k++) {
        const kart = worldState.karts[k];
        const held = kart.heldItem;
        if (!held || held.holdPosition !== 'behind') continue;

        mark('dv-item dv-item-held', kart.worldX + behindX, kart.yPercent,
             `${held.type} traine — bouclier`, true);
    }

    layer.innerHTML = html.join('');
}

// Pose une marque a son abscisse dans la fenetre, ou l'efface si elle en sort.
// Rend true quand elle est visible, pour que l'appelant s'epargne le reste.
function placeInView(el, worldX) {
    if (!el) return false;

    const left = xPct(worldX);
    if (!inMapView(left)) {
        el.style.display = 'none';
        return false;
    }

    el.style.display = '';
    el.style.left = `${left.toFixed(3)}%`;
    return true;
}

function updateDebugHUD() {
    const hud = document.getElementById('debug-hud');
    if (!hud) return;

    // Meme cache que la boucle. C'est ici que la lecture faisait le plus de
    // degats : elle tombait APRES les ecritures de style de `renderState`, donc
    // le navigateur devait recalculer toute la mise en page pour y repondre —
    // le HUD faussait ainsi la mesure qu'il affiche.
    const screenWidth = viewMetrics.containerWidth || window.innerWidth;

    // Le cadrage d'abord : tout ce qui suit se place dedans.
    updateMapView(hud);

    const camMain = document.getElementById('debug-camera-view');

    // La fenetre de camera ne se dessine que LIBRE. Collee a un kart, elle est
    // centree sur lui par construction et recouvre d'un aplat rouge la zone qu'on
    // vient regarder — le seul moment ou sa position s'apprend est celui ou elle
    // avance toute seule.
    if (camMain) {
        // camera = centre de la vue : le bord gauche est a mi-largeur en arriere.
        const seg = (focusedKartId === null)
            ? worldSegments(renderCameraX - screenWidth / 2, screenWidth)
            : [];

        if (seg.length) {
            camMain.style.display = 'block';
            camMain.style.left = `${seg[0][0].toFixed(3)}%`;
            camMain.style.width = `${seg[0][1].toFixed(3)}%`;
        } else {
            camMain.style.display = 'none';
        }
    }

    // Les corps fixes du monde defilent sous la fenetre : leur abscisse se repose
    // a chaque image, et ce qui sort du cadre disparait.
    //
    // La ligne d'arrivee est une BANDE, pas un trait, posee par son bord GAUCHE :
    // c'est ainsi que le decor la place, et c'est exactement la que le tour se
    // compte. Elle passe par `worldSegments` car elle peut n'etre qu'a moitie
    // dans le cadre.
    const finishEl = document.getElementById('debug-finish');
    if (finishEl) {
        const seg = worldSegments(WORLD.finishLineX, finishBandWidth());
        if (seg.length) {
            finishEl.style.display = '';
            finishEl.style.left = `${seg[0][0].toFixed(3)}%`;
            finishEl.style.width = `${seg[0][1].toFixed(3)}%`;
        } else {
            finishEl.style.display = 'none';
        }
    }
    for (let i = 0; i < worldState.pipes.length; i++) {
        placeInView(document.getElementById(`debug-pipe-${i}`), worldState.pipes[i].worldX);
    }
    for (let i = 0; i < worldState.itemBoxes.length; i++) {
        placeInView(document.getElementById(`debug-box-${i}`), worldState.itemBoxes[i].worldX);
    }

    // Ce que le kart suivi n'a PAS vu au dernier balayage. C'est la moitie
    // manquante de la carte : sans elle, un kart qui ignore une banane et un
    // kart qui ne la voit pas se dessinent pareil.
    const v = worldState.vision;
    const hidden = v ? v.hidden : null;

    worldState.karts.forEach(kart => {
        const el = document.getElementById(`debug-kart-${kart.id}`);
        if (el) {
            if (!placeInView(el, kart.worldX)) return;
            el.style.top = `${depthPct(kart.yPercent)}%`;
            // Translucides comme le reste des marques : a taille reelle les
            // corps se recouvrent, et un aplat opaque effacerait le tuyau
            // contre lequel un kart est justement en train de se cogner.
            el.style.backgroundColor = (kart.state === 'hit')
                ? 'rgba(255, 64, 64, 0.75)'
                : 'rgba(64, 96, 255, 0.75)';
            if (kart.state === 'grid') el.style.backgroundColor = 'rgba(150, 150, 150, 0.7)';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';

            // Meme convention de signe que le moteur : un kart s'identifie en
            // negatif dans les releves de vue.
            const masked = !!hidden && hidden.indexOf(-1 - kart.id) !== -1;
            el.classList.toggle('is-masked', masked);
            el.classList.toggle('is-watched', v ? v.id === kart.id : false);
        }
    });

    renderItemLayer();
    renderVisionLayer();

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        // Meme reference que la physique : rollItem() mesure l'ecart au premier
        // via totalDistance, jamais via worldX. Trier ici sur autre chose
        // afficherait des ecarts incoherents avec le tirage d'items.
        const sortedKarts = [...worldState.karts]
            .sort((a, b) => b.totalDistance - a.totalDistance);

        const leader = sortedKarts[0] || null;

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            // Le nombre de tours n'est pas diffuse : il se deduit de la
            // distance parcourue, qui l'est. Affiche en base 1 : on est dans
            // le tour 1 des le depart, comme sur le panneau de Lakitu.
            const laps = Math.floor(kart.totalDistance / WORLD.width) + 1;
            const gap = (leader && leader.id !== kart.id)
                ? `${Math.round(leader.totalDistance - kart.totalDistance)}px`
                : '\u2014';
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps} \u00B7 ${gap}</span></div>`;
        }).join('');
    }
}
