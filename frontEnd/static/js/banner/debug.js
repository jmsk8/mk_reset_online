// HUD de debug (mode debug uniquement, lecture seule) : carte de piste vue de
// dessus, couche de vision et emprises. Fenetre centree sur le kart observe,
// a l'echelle 1 (un pixel de monde pour un pixel de carte) ; tout ce qui est
// dessine vient du serveur (`visionTuple`).

// Fond de piste en haut, bord proche en bas ; marge en % aux extremites.
const DEPTH_PAD = 7;

function depthPct(y) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 50;
    const t = (y - lo) / (hi - lo);
    const inner = 100 - DEPTH_PAD * 2;
    return Math.max(0, Math.min(100, DEPTH_PAD + (1 - t) * inner));
}

// Fenetre : bord gauche et largeur en px de monde, recalcules a chaque image.
let mapView = { start: 0, span: 1 };

let mapHudHeight = 0;

// Px de monde par unite de profondeur, selon la hauteur reelle de la scene.
function depthToWorldPx() {
    // Hauteur de la bande roulable, mesuree par refreshLayoutMetrics().
    const band = WORLD.roadMaxY - WORLD.roadMinY;
    const h = viewMetrics.roadBandHeight;
    // Repli : valeur PC (bodies.depthPx).
    return (h > 0 && band > 0) ? h / band : 3.6;
}

// Largeur de la bande d'arrivee en px de monde, mesuree sur le decor par
// refreshLayoutMetrics().
function finishBandWidth() {
    // Repli sur la valeur du CSS.
    return cachedFinishBand > 0 ? cachedFinishBand : 60;
}

// Recentre la fenetre et met le cadre a l'echelle 1 (largeur choisie en CSS,
// hauteur = profondeur de piste).
function updateMapView(hud) {
    const vis = WORLD.vision;

    // Largeur en cache (une lecture ici forcerait une mise en page).
    const frame = viewMetrics.hudWidth || WORLD.width;
    const span = Math.max(1, Math.min(frame, WORLD.width));

    // Centre : le kart observe, sinon la camera.
    let centre = renderCameraX;
    if (focusedKartId !== null) {
        const watched = worldState.kartsById[focusedKartId];
        if (watched) centre = watched.worldX;
    }

    // Cadre decale du cote ou le kart regarde (borne au quart de la fenetre).
    const quarter = span / 4;
    let bias = vis ? (vis.rangeFront - vis.rangeBack) / 2 : 0;
    if (bias > quarter) bias = quarter;
    if (bias < -quarter) bias = -quarter;

    mapView.span = span;
    mapView.start = centre - span / 2 + bias;

    // Hauteur de la bande en px de monde, sans arrondi.
    const band = (WORLD.roadMaxY - WORLD.roadMinY) * depthToWorldPx();
    const height = band / ((100 - DEPTH_PAD * 2) / 100);

    // Ecrite seulement si elle change.
    if (height > 0 && height !== mapHudHeight) {
        mapHudHeight = height;
        hud.style.height = `${height.toFixed(2)}px`;
    }
}

// Position d'un point du monde dans la fenetre, en px depuis son bord gauche
// (negative pour ce qui precede la fenetre, le tour bouclant).
function mapOffset(worldX) {
    const w = WORLD.width;
    let d = worldX - mapView.start;
    if (w > 0) {
        d = ((d % w) + w) % w;
        // Partage au milieu de ce qui reste hors du cadre.
        if (d > (w + mapView.span) / 2) d -= w;
    }
    return d;
}

// Vrai si le point tombe dans le cadre.
function inMapView(pct) {
    return pct >= 0 && pct <= 100;
}

// Les corps se dessinent a leur emprise reelle (memes echelles sur les deux axes).
function spanXPct(halfX) {
    return (halfX * 2 / mapView.span) * 100;
}

// Hauteur en % de la bande interieure.
function spanYPct(halfY) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 0;
    return (halfY * 2 / (hi - lo)) * (100 - DEPTH_PAD * 2);
}

// Pose une marque a sa taille reelle (`round` pour le seul corps rond).
function sizeEntity(el, half) {
    el.style.width = `${spanXPct(half.x)}%`;
    el.style.height = `${spanYPct(half.y)}%`;
    el.style.borderRadius = half.round ? '50%' : '0';
}

// Segment du monde ramene a la fenetre et coupe a ses bords (`len` signe).
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

function ruleHtml(cls, y, title) {
    return `<div class="${cls}" style="top:${depthPct(y).toFixed(2)}%;"${title ? ` title="${title}"` : ''}></div>`;
}

// Angle mort : trapeze au sol entre deux ecarts au kart, avec une profondeur a
// chaque bout (clip-path sur le rectangle englobant, reinterpole a la coupe).
function shadowHtml(from, to, loA, hiA, loB, hiB) {
    // Regard vers l'arriere : on remet le proche a gauche avec ses profondeurs.
    if (to < from) {
        const x = from; from = to; to = x;
        const l = loA; loA = loB; loB = l;
        const h = hiA; hiA = hiB; hiB = h;
    }

    const span = to - from;

    // Borne a la piste.
    const clampY = y => Math.max(WORLD.roadMinY - 1, Math.min(WORLD.roadMaxY + 1, y));

    const at = x => {
        const t = (span === 0) ? 0 : (x - from) / span;
        return [clampY(loA + (loB - loA) * t), clampY(hiA + (hiB - hiA) * t)];
    };

    // Coupe aux bords de la fenetre, profondeurs reinterpolees.
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

    // Coins en % : haut-gauche, haut-droit, bas-droit, bas-gauche.
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

// Faisceau desactive pour l'instant.
const SHOW_RAY_FAN = false;

// Faisceau trace depuis l'oeil (`vision.eye.back`) : rayons de bord (ouverture)
// et rayons d'arete (deux par corps solide, bornes de son ombre). En SVG.
function rayFanHtml(v, dir, lo, hi) {
    const span = mapView.span;

    // Points reperes par rapport a l'oeil (le tour boucle).
    const eyeOff = mapOffset(v.x - v.eyeBack * dir);
    const px = dw => (((eyeOff + dw) / span) * 100).toFixed(3);
    const py = y => depthPct(y).toFixed(2);

    // Un point a `look` du kart est a `look + eyeBack` de l'oeil.
    const reach = look => (look + v.eyeBack) * dir;

    const x0 = px(0);
    const y0 = py(v.y);
    const ray = (cls, look, y) =>
        `<line class="${cls}" x1="${x0}%" y1="${y0}%" ` +
        `x2="${px(reach(look))}%" y2="${py(y)}%" />`;

    const lines = [ray('dv-ray dv-ray-edge', v.range, lo),
                   ray('dv-ray dv-ray-edge', v.range, hi)];

    // sh[1] : bout de l'ombre ; sh[4]/sh[5] : ses deux profondeurs.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[4]));
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[5]));
    }

    return `<svg class="dv-rays" width="100%" height="100%">${lines.join('')}</svg>`;
}

// Point du monde ; rien hors fenetre.
function pinHtml(cls, worldX, y, label) {
    const left = xPct(worldX);
    if (!inMapView(left)) return '';
    return `<div class="${cls}" style="left:${left.toFixed(3)}%;top:${depthPct(y).toFixed(2)}%;"` +
           `${label ? ` title="${label}"` : ''}></div>`;
}

// Dessin de la vue, refait a chaque releve neuf ou quand la fenetre defile.
let visionDrawn = null;
let visionDrawnAt = null;
let visionNote = '';

function renderVisionLayer() {
    const layer = document.getElementById('debug-vision');
    if (!layer) return;

    const v = worldState.vision;

    // Raison affichee quand il n'y a rien a dessiner.
    let note = '';
    if (!WORLD.vision) {
        // `hello` sans distances de vue : service sur une ancienne version.
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

    // 1. Le champ : portee du balayage (fournie par le serveur).
    html.push(bandHtml('dv-cone', v.x, v.range * dir, lo, hi,
        `${v.scanBack ? 'arriere' : 'avant'} ${v.range}px`));

    // 1 bis. Les angles morts projetes par les corps solides.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        html.push(shadowHtml(v.x + sh[0] * dir, v.x + sh[1] * dir,
                             sh[2], sh[3], sh[4], sh[5]));
    }

    // 1 ter. Le faisceau, par-dessus les ombres (voir SHOW_RAY_FAN).
    if (SHOW_RAY_FAN) html.push(rayFanHtml(v, dir, lo, hi));

    // 2. La ligne de tir : portee du danger latent sur la bande d'alignement.
    html.push(bandHtml('dv-press', v.x, cfg.pressureRange * dir,
        v.y - cfg.clear, v.y + cfg.clear, `alignement ±${cfg.clear}`));

    // 3. La voie (plus large que le degagement).
    html.push(ruleHtml('dv-lane', v.y - cfg.threatLane, 'voie'));
    html.push(ruleHtml('dv-lane', v.y + cfg.threatLane, 'voie'));

    // 4. Ce qui ferme un passage : murs durs et obstacles franchissables a un cout.
    for (let i = 0; i < v.spans.length; i++) {
        const s = v.spans[i];
        html.push(bandHtml(s[4] ? 'dv-span dv-hard' : 'dv-span', v.x, s[2],
            s[0], s[1], `${s[4] ? 'mur' : 'corps'} a ${Math.round(s[2])}px`));
    }

    // 5. Ce que le moteur a retenu.
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

    // 6. La consigne : profondeur visee par le plan.
    if (v.plan) html.push(ruleHtml('dv-plan', v.plan[3], `${v.plan[0]}${v.plan[4] ? ' (approx.)' : ''}`));

    // 7. L'oeil, a `eyeBack` du kart du cote oppose au regard.
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
    // Hauteur a recalculer (cadre vide).
    mapHudHeight = 0;
    visionDrawnAt = null;

    // Couche de vision en premier (fond).
    const vision = document.createElement('div');
    vision.id = 'debug-vision';
    hud.appendChild(vision);
    visionDrawn = null;

    // Ligne d'arrivee, positionnee a chaque image.
    const finishLine = document.createElement('div');
    finishLine.className = 'debug-entity debug-finish';
    finishLine.id = 'debug-finish';
    hud.appendChild(finishLine);

    // Emprises du serveur, ou repli hors ligne.
    const hitboxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;

    // Tuyaux : emprise posee une fois, position a chaque image.
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
        // Emprise propre a ce kart.
        sizeEntity(dKart, kart.body || hitboxes.kart);
        hud.appendChild(dKart);
    });

    // Objets : couche reecrite a chaque image.
    const items = document.createElement('div');
    items.id = 'debug-items';
    hud.appendChild(items);

    // Zone montree par la banniere.
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
    // Largeur du cadre mesuree une fois.
    refreshLayoutMetrics();
}

// Couche des objets, reecrite a chaque image. Les objets sans emprise (bleue,
// banane qui monte) sont dessines en point ; les objets traines (dans
// kart.heldItem) a leur emprise worldX + heldBehindX.
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

        // Sans emprise : un simple point.
        const cls = 'dv-item' + (inert ? ' dv-item-inert' : '')
            + (item.type === 'banana' ? ' dv-item-banana' : '');

        mark(cls, item.worldX, item.y,
             `${item.type}${inert ? ' — sans emprise' : ''}`, !inert);
    }

    // Objets traines : meme emprise, autre couleur.
    for (let k = 0; k < worldState.karts.length; k++) {
        const kart = worldState.karts[k];
        const held = kart.heldItem;
        if (!held || held.holdPosition !== 'behind') continue;

        mark('dv-item dv-item-held', kart.worldX + behindX, kart.yPercent,
             `${held.type} traine — bouclier`, true);
    }

    layer.innerHTML = html.join('');
}

// Place une marque dans la fenetre ou l'efface ; renvoie true si elle est visible.
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

    // Largeur en cache (pas de lecture apres les ecritures de renderState).
    const screenWidth = viewMetrics.containerWidth || window.innerWidth;

    updateMapView(hud);

    const camMain = document.getElementById('debug-camera-view');

    // Fenetre de camera dessinee seulement en camera libre.
    if (camMain) {
        // cameraX est le centre de la vue.
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

    // Corps fixes repositionnes a chaque image. La ligne d'arrivee est une
    // bande posee par son bord gauche, eventuellement coupee par le cadre.
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

    // Ce que le kart suivi n'a pas vu au dernier balayage.
    const v = worldState.vision;
    const hidden = v ? v.hidden : null;

    worldState.karts.forEach(kart => {
        const el = document.getElementById(`debug-kart-${kart.id}`);
        if (el) {
            if (!placeInView(el, kart.worldX)) return;
            el.style.top = `${depthPct(kart.yPercent)}%`;
            // Translucides : a taille reelle, les corps se recouvrent.
            el.style.backgroundColor = (kart.state === 'hit')
                ? 'rgba(255, 64, 64, 0.75)'
                : 'rgba(64, 96, 255, 0.75)';
            if (kart.state === 'grid') el.style.backgroundColor = 'rgba(150, 150, 150, 0.7)';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';

            // Un kart s'identifie en negatif dans les releves (comme le moteur).
            const masked = !!hidden && hidden.indexOf(-1 - kart.id) !== -1;
            el.classList.toggle('is-masked', masked);
            el.classList.toggle('is-watched', v ? v.id === kart.id : false);
        }
    });

    renderItemLayer();
    renderVisionLayer();

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        // Tri sur totalDistance, comme rollItem() cote serveur.
        const sortedKarts = [...worldState.karts]
            .sort((a, b) => b.totalDistance - a.totalDistance);

        const leader = sortedKarts[0] || null;

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            // Tour deduit de la distance, en base 1.
            const laps = Math.floor(kart.totalDistance / WORLD.width) + 1;
            const gap = (leader && leader.id !== kart.id)
                ? `${Math.round(leader.totalDistance - kart.totalDistance)}px`
                : '\u2014';
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps} \u00B7 ${gap}</span></div>`;
        }).join('');
    }
}
