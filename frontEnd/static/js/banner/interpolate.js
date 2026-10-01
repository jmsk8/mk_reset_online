// Horloge partagee et interpolation entre snapshots. Le client ne simule rien :
// il affiche un instant legerement retarde pour toujours avoir deux snapshots
// a interpoler (10 Hz cote serveur, 60 images/s a l'ecran).

// Retard de rendu : deux intervalles de diffusion (tolerance a la gigue).
// A reajuster si SEND_HZ change.
const RENDER_DELAY_MS = 200;

const BUFFER_KEEP_MS = 3000;

// Rattrapage progressif de l'horloge, en ms par frame.
const CLOCK_SLEW_MS_PER_FRAME = 1;

// Au-dela de cet ecart, l'horloge se recale d'un coup.
const CLOCK_JUMP_THRESHOLD_MS = 1000;

function stepClock() {
    const drift = targetClockOffset - serverClockOffset;
    if (drift === 0) return;

    if (Math.abs(drift) > CLOCK_JUMP_THRESHOLD_MS) {
        serverClockOffset = targetClockOffset;
        return;
    }

    serverClockOffset += Math.max(-CLOCK_SLEW_MS_PER_FRAME,
                                  Math.min(CLOCK_SLEW_MS_PER_FRAME, drift));
}

// Intervalle des pings (latence affichee et mesures d'horloge).
const PING_INTERVAL_MS = 5000;

// Duree de vie d'une mesure d'horloge.
const CLOCK_SAMPLE_TTL_MS = 120000;
// Doit valoir PROTOCOL_VERSION dans raceEngine/src/protocol.js (le client
// refuse toute autre version).
const PROTOCOL_VERSION = 11;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Echecs consecutifs avant d'afficher la panne.
const OFFLINE_AFTER_ATTEMPTS = 2;

// Interpolation sur un monde qui boucle : on prend le chemin le plus court.
function lerpWrapped(from, to, t, width) {
    let delta = to - from;
    if (delta > width / 2) delta -= width;
    else if (delta < -width / 2) delta += width;

    let value = from + delta * t;
    if (value < 0) value += width;
    if (value >= width) value -= width;
    return value;
}

function lerp(from, to, t) {
    return from + (to - from) * t;
}

// Ecrit un tuple de kart dans le miroir local : champs continus interpoles,
// champs discrets pris sur le snapshot de depart.
function writeKart(kart, ta, tb, t) {
    if (tb) {
        kart.worldX = lerpWrapped(ta[1], tb[1], t, WORLD.width);
        kart.yPercent = lerp(ta[2], tb[2], t);
        kart.totalDistance = lerp(ta[3], tb[3], t);
    } else {
        kart.worldX = ta[1];
        kart.yPercent = ta[2];
        kart.totalDistance = ta[3];
    }

    const flags = ta[4];
    kart.state = (flags & 1) ? 'grid' : ((flags & 2) ? 'hit' : 'running');
    kart.stopped = !!(flags & 4);
    kart.isInvincible = !!(flags & 8);
    kart.finished = !!(flags & 16);
    kart.isShrunk = !!(flags & 32);
    kart.isBill = !!(flags & 64);
    kart.bumped = !!(flags & 128);
    kart.isFlat = !!(flags & 256);
    kart.finalLap = !!(flags & 512);
    kart.rank = ta[5];

    // Sans `hitEnd`, la toupie est calee sur l'apparition de l'etat 'hit' ;
    // `hitDur` (ta[13]) est la duree de ce coup, sinon celle du `hello`.
    if (kart.state === 'hit') {
        kart.hitDuration = ta[13] || kart.hitDuration || WORLD.hitDuration;
        kart.hitEndTime = ta[11] || kart.hitEndTime || (getGameTime() + kart.hitDuration);
    } else {
        kart.hitEndTime = 0;
        kart.hitDuration = 0;
    }

    kart.bumpEndTime = kart.bumped ? (ta[12] || kart.bumpEndTime || 0) : 0;

    if (ta[6] === null) {
        kart.heldItem = null;
        return;
    }

    const held = (kart.heldItem && kart.heldItem.id === ta[6]) ? kart.heldItem : {};
    held.id = ta[6];
    held.type = ta[7];
    held.holdPosition = ta[8];

    if (ta[8] === 'orbit') {
        held.childType = ta[7];
        held.orbitAngle = ta[9];
        // Phases reparties regulierement, non transmises.
        held.orbs = ta[10].map((id, i) => ({ id: id, phase: (i * 2 * Math.PI) / WORLD.orbit.count }));
    }

    kart.heldItem = held;
}

// Structures reutilisees d'une frame a l'autre (pas d'allocation dans applyState).
const nextKartTuples = new Map();
const nextItemTuples = new Map();
const itemMirrors = new Map();

// Dernier snapshot applique : la structure de la scene ne change qu'a
// l'arrivee d'un nouveau.
let lastAppliedSnapshot = null;
let domDirty = true;

function applyState(a, b, t) {
    worldState.cameraX = b ? lerpWrapped(a.cx, b.cx, t, WORLD.width) : a.cx;
    worldState.bgCameraX = b ? lerpWrapped(a.bx, b.bx, t, WORLD.width) : a.bx;

    const fresh = a !== lastAppliedSnapshot;
    if (fresh) {
        lastAppliedSnapshot = a;
        domDirty = true;
    }

    nextKartTuples.clear();
    if (b) for (const tuple of b.k) nextKartTuples.set(tuple[0], tuple);

    for (const tuple of a.k) {
        const kart = worldState.kartsById[tuple[0]];
        if (kart) writeKart(kart, tuple, b ? nextKartTuples.get(tuple[0]) : null, t);
    }

    // Releve de decision de l'IA (HUD de debug), non interpole.
    if (a.ai) {
        for (let i = 0; i < a.k.length; i++) {
            const kart = worldState.kartsById[a.k[i][0]];
            if (kart) kart.ai = a.ai[i] || 0;
        }
    }

    // Vue du kart suivi, non interpolee, lue sur le snapshot affiche.
    if (fresh) worldState.vision = a.vw || null;

    nextItemTuples.clear();
    if (b) for (const tuple of b.i) nextItemTuples.set(tuple[0], tuple);

    worldState.items.length = 0;
    for (const tuple of a.i) {
        let item = itemMirrors.get(tuple[0]);
        if (!item) {
            item = { id: tuple[0], type: tuple[1], worldX: 0, y: 0, currentFrame: 1, hop: 0, rising: false };
            itemMirrors.set(tuple[0], item);
        }

        const to = b ? nextItemTuples.get(tuple[0]) : null;
        item.type = tuple[1];
        item.worldX = to ? lerpWrapped(tuple[2], to[2], t, WORLD.width) : tuple[2];
        item.y = to ? lerp(tuple[3], to[3], t) : tuple[3];
        item.currentFrame = tuple[4];
        item.hop = to ? lerp(tuple[5] || 0, to[5] || 0, t) : (tuple[5] || 0);
        // Etat discret : valeur du snapshot de gauche.
        item.rising = !!tuple[6];

        worldState.items.push(item);
    }

    // Purge des objets disparus (ids jamais reutilises).
    if (fresh && itemMirrors.size > worldState.items.length) {
        for (const id of itemMirrors.keys()) {
            if (!nextItemTuples.has(id) && !worldState.items.some(item => item.id === id)) {
                itemMirrors.delete(id);
            }
        }
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) {
        worldState.itemBoxes[i].active = a.b[i] === 1;
    }

    worldState.phase = a.ph;
    worldState.leaderLap = a.lp;
    worldState.sign = a.sg;
    worldState.storm = a.st || null;
    worldState.finishOrder = a.fo;
    worldState.gp = a.gp || null;
    worldState.vote = a.vt || [0, 0];
}
