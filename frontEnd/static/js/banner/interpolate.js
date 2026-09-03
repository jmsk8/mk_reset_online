// L'horloge partagee et l'interpolation entre deux instantanes.
//
// Le serveur parle dix fois par seconde, l'ecran se rafraichit soixante. Ce
// fichier fabrique les cinquante images qui manquent, et recale l'horloge locale
// sur celle du serveur sans jamais la faire sauter.

// Reception : horloge, tampon, interpolation. Le client ne simule rien — il
// recoit des snapshots dates en temps serveur, les empile, et affiche en
// permanence un instant legerement retarde, assez pour avoir toujours deux
// snapshots a interpoler. C'est ce retard, et lui seul, qui rend le mouvement
// fluide a 10 Hz.

// Retard de rendu : deux intervalles de diffusion (100 ms a 10 Hz). C'est la
// tolerance a la gigue du reseau. En dessous d'un intervalle il n'y a rien a
// interpoler ; juste au-dessus, le moindre snapshot en retard fait tomber le
// rendu sur son dernier etat connu — la scene se fige puis saute, ce qui ne se
// distingue pas d'une chute de framerate. A reajuster si SEND_HZ change.
const RENDER_DELAY_MS = 200;

const BUFFER_KEEP_MS = 3000;

// Vitesse de rattrapage de l'horloge, en millisecondes par frame. A 60 images
// par seconde, 1 ms par frame absorbe 60 ms d'ecart en une seconde : assez
// rapide pour suivre une derive reelle, assez lent pour ne pas se voir.
const CLOCK_SLEW_MS_PER_FRAME = 1;

// Au-dela, ce n'est plus une derive mais un decrochage — retour d'un onglet
// endormi, changement de reseau. On se recale d'un coup, quitte a sauter.
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

// Assez rapproche pour que la latence affichee decrive le lien du moment : a
// 30 s, le chiffre restait fige une demi-minute et ne disait plus rien d'une
// coupure passagere. Le cout est nul a cote du flux de snapshots — un objet de
// deux champs — et l'horloge y gagne : ses huit mesures couvrent desormais une
// fenetre courte, donc recente.
const PING_INTERVAL_MS = 5000;

// Duree de vie d'une mesure d'horloge. Sans peremption, la meilleure mesure
// jamais faite gagne pour toujours — y compris apres que l'horloge locale a
// change sous nos pieds.
const CLOCK_SAMPLE_TTL_MS = 120000;
// Doit valoir exactement PROTOCOL_VERSION dans raceEngine/src/protocol.js. Le
// serveur l'annonce dans son `hello` et le client refuse tout ce qui ne
// correspond pas : mieux vaut le decor seul qu'une scene interpretee de
// travers. Les deux se modifient donc ensemble, jamais l'un sans l'autre.
const PROTOCOL_VERSION = 11;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Une coupure d'une seconde ne merite pas d'annoncer une panne au visiteur ;
// deux echecs de suite, si.
const OFFLINE_AFTER_ATTEMPTS = 2;

// Interpolation sur un monde qui boucle : entre x=3830 et x=20, le chemin court
// fait 30 unites vers la droite, pas 3810 vers la gauche. Interpoler
// naivement ferait traverser toute la carte a l'envers a chaque tour.
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

// Ecrit un tuple de kart dans le miroir local. Les champs continus sont
// interpoles, les champs discrets (etat, rang, objet tenu) sont pris sur le
// snapshot de depart : les faire apparaitre en avance donnerait un halo ou un
// tete-a-queue avant le fait.
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
    kart.rank = ta[5];

    // Un serveur qui ne date pas le malus (`hitEnd` absent) ne doit pas priver
    // le kart de sa toupie : on la cale alors sur l'instant ou l'etat 'hit' est
    // apparu. Approximatif pour un arrivant, juste pour tous les autres.
    if (kart.state === 'hit') {
        kart.hitEndTime = ta[11] || kart.hitEndTime || (getGameTime() + WORLD.hitDuration);
    } else {
        kart.hitEndTime = 0;
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
        // Les phases sont figees a la creation de l'orbite et reparties
        // regulierement : le serveur n'a pas a les transmettre.
        held.orbs = ta[10].map((id, i) => ({ id: id, phase: (i * 2 * Math.PI) / WORLD.orbit.count }));
    }

    kart.heldItem = held;
}

// Applique un etat au miroir local. `b` absent = pas d'interpolation, on colle
// au snapshot `a` — c'est le cas du premier `hello` et des rattrapages.
// Structures reutilisees d'une frame a l'autre. `applyState` tourne soixante
// fois par seconde : tout ce qu'elle allouerait deviendrait du dechet a
// ramasser, et le ramassage se voit sur mobile — de petites pauses regulieres,
// exactement ce qu'on prend pour une chute de framerate.
const nextKartTuples = new Map();
const nextItemTuples = new Map();
const itemMirrors = new Map();

// Vrai quand la structure de la scene a pu changer, c'est-a-dire uniquement a
// l'arrivee d'un nouveau snapshot. Entre deux, rien ne peut apparaitre ni
// disparaitre : reconcilier a chaque frame reviendrait a refaire six fois le
// meme travail pour rien.
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

    // Le releve de decision de l'IA. Il ne s'interpole pas — c'est une suite
    // d'etats, pas une position — et il ne sert qu'au HUD de debug : un client
    // qui l'ignore affiche exactement la meme course.
    if (a.ai) {
        for (let i = 0; i < a.k.length; i++) {
            const kart = worldState.kartsById[a.k[i][0]];
            if (kart) kart.ai = a.ai[i] || 0;
        }
    }

    // La VUE du kart suivi ne s'interpole pas : c'est un BALAYAGE, pris a un
    // instant et valable jusqu'au suivant — interpoler inventerait une vue que le
    // kart n'a jamais eue. Elle est lue sur le snapshot AFFICHE et non sur le
    // dernier recu : la carte doit dire ce que le kart voyait a l'image qu'on
    // regarde.
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
        // Pas d'interpolation : c'est un etat, pas une position. Entre deux
        // instantanes il vaut celui de gauche, comme tout ce qui bascule.
        item.rising = !!tuple[6];

        worldState.items.push(item);
    }

    // Les identifiants d'objets ne sont jamais reutilises : sans ce menage, la
    // table grossirait indefiniment sur une course qui dure. Une seule fois par
    // snapshot suffit.
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
