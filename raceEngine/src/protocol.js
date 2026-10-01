// Protocole serveur -> client du banner. Le snapshot fait foi : un arrivant
// doit pouvoir afficher une scene complete a partir de lui seul, les evenements
// ne servant qu'aux animations.

const PROTOCOL_VERSION = 11;

// Bits d'etat d'un kart.
const FLAG_GRID = 1;      // sur la grille, avant le coup d'envoi
const FLAG_HIT = 2;       // percute -> tete-a-queue
const FLAG_STOPPED = 4;   // immobilise apres impact -> sprite fige
const FLAG_STAR = 8;      // etoile active -> halo
const FLAG_FINISHED = 16; // a franchi la ligne -> tour d'honneur
const FLAG_SHRUNK = 32;   // rapetisse par l'eclair -> sprite reduit
const FLAG_BILL = 64;     // transforme en Bill Ball -> sprite remplace
const FLAG_BUMPED = 128;  // arrete net par un pipe : arret et recul, sprite inchange
const FLAG_FLAT = 256;    // ecrase par un kart reste grand -> sprite aplati
const FLAG_FINAL_LAP = 512; // dans sa zone de dernier tour -> Lakitu montre « final »

// Releve de decision pour le HUD de debug, en un entier (envoye en permanence).
// Les tables d'indices voyagent dans le `hello` (`world.ai`).
const AI_STATES = ['cruising', 'pipe', 'dodging', 'safety', 'giveWay', 'aiming', 'yieldLead'];
const AI_DANGERS = ['', 'carrier', 'ram', 'shot'];
const AI_ALERTS = ['', 'ram', 'red', 'blue'];

function aiTuple(cfg, kart, now) {
    const sight = kart.sight;
    const plan = kart.plan;
    if (!sight) return 0;

    let v = Math.max(0, AI_STATES.indexOf(kart.aiState));

    // Danger arriere, tant que le souvenir tient (meme peremption que le pilotage).
    const fresh = (now - sight.dangerAt) <= cfg.vision.pressureMemoryMs;
    const danger = fresh ? AI_DANGERS.indexOf(sight.dangerKind) : 0;
    v |= (danger > 0 ? danger : 0) << 4;

    if (sight.back) v |= 1 << 6;
    if (now < kart.brakeUntil) v |= 1 << 7;
    if (kart.shieldHold && kart.heldItem) v |= 1 << 8;
    if (sight.redBehindCount > 1) v |= 1 << 9;

    // Menace de devant retenue, s'il y en a une.
    const kind = plan && plan.threatId ? plan.kind : '';
    v |= (kind === 'spin' ? 1 : 0) << 10;
    if (sight.pipeIndex >= 0) v |= 1 << 11;

    // Porteur qu'on suit (souvenir compris).
    if (sight.pressure && !sight.pressureBack) v |= 1 << 12;

    // Alerte entendue la plus pressante (la bleue prime).
    const alert = kart.alert;
    if (alert) {
        let heard = '';
        if (alert.blue || alert.blueMode) heard = 'blue';
        else if (alert.red) heard = 'red';
        else if (alert.ram) heard = 'ram';
        v |= AI_ALERTS.indexOf(heard) << 13;

        // Bleue qui l'a choisi, objet garde pour elle, suivi du regard.
        if (alert.blueOnMe) v |= 1 << 15;
        if (alert.blueMode === 'cover') v |= 1 << 16;
        if (alert.watch) v |= 1 << 17;
    }

    return v;
}

// Vue du kart suivi pour la carte de debug, envoyee sur demande
// (`{t:'watch', id}`). Karts en negatif (`-1 - id`), objets a partir de 1.
function visionTuple(kart) {
    const sight = kart.sight;
    if (!sight) return null;

    const spans = [];
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        // [profondeur basse, haute, ecart signe, portee, dur, tuyau]
        spans.push([
            round(s.lo, 2), round(s.hi, 2), round(s.dx, 1),
            Math.round(s.reach), s.hard ? 1 : 0, s.pipeIndex
        ]);
    }

    const hidden = [];
    for (let i = 0; i < sight.hiddenCount; i++) hidden.push(sight.hiddenIds[i]);

    // Ombres resolues en profondeurs : trapezes [debut, fin] en ecart au kart,
    // avec les deux profondeurs a chaque bout.
    const shadows = [];
    for (let i = 0; i < sight.shadowCount; i++) {
        const from = sight.shadowFrom[i];
        const to = sight.shadowTo[i];
        shadows.push([
            round(from - sight.eyeBack, 1),
            round(to - sight.eyeBack, 1),
            round(sight.eyeY + sight.shadowLo[i] * from, 2),
            round(sight.eyeY + sight.shadowHi[i] * from, 2),
            round(sight.eyeY + sight.shadowLo[i] * to, 2),
            round(sight.eyeY + sight.shadowHi[i] * to, 2)
        ]);
    }

    return {
        // Kart observe et sens du regard au moment du balayage.
        id: kart.id,
        back: sight.back ? 1 : 0,
        scanBack: sight.scanBack ? 1 : 0,
        range: Math.round(sight.scanRange),
        at: Math.round(sight.at),

        // Origine du regard, non interpolee.
        x: round(kart.worldX, 2),
        y: round(kart.yPercent, 2),

        spans: spans,
        hidden: hidden,
        shadows: shadows,

        // Recul de la camera.
        eyeBack: Math.round(sight.eyeBack),

        // Ce que la marche a retenu.
        threat: sight.threatId
            ? [sight.threatId, sight.threatKind, round(sight.threatY, 2),
               (sight.threatTtc === Infinity ? -1 : Math.round(sight.threatTtc))]
            : null,
        pipe: (sight.pipeIndex >= 0) ? [sight.pipeIndex, Math.round(sight.pipeDist)] : null,
        pipeAhead: (sight.pipeAheadIndex >= 0)
            ? [sight.pipeAheadIndex, Math.round(sight.pipeAheadDist)] : null,
        pressure: sight.pressure
            ? [round(sight.pressureY, 2), sight.pressureId, sight.pressureBack ? 1 : 0]
            : null,
        red: (sight.redBehindDist >= 0)
            ? [Math.round(sight.redBehindDist), round(sight.redBehindY, 2),
               sight.redBehindId, sight.redBehindCount]
            : null,
        box: (sight.boxDist >= 0) ? [round(sight.boxY, 2), Math.round(sight.boxDist)] : null,

        // Plan qui commande.
        plan: kart.plan && kart.plan.threatId
            ? [kart.plan.kind, kart.plan.threatId, round(kart.plan.threatY, 2),
               round(kart.plan.laneY, 2), kart.plan.coarse ? 1 : 0]
            : null
    };
}

function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

function kartFlags(kart) {
    let flags = 0;
    if (kart.state === 'grid') flags |= FLAG_GRID;
    if (kart.state === 'hit') flags |= FLAG_HIT;
    if (kart.stopped) flags |= FLAG_STOPPED;
    if (kart.isInvincible) flags |= FLAG_STAR;
    if (kart.finished) flags |= FLAG_FINISHED;
    if (kart.isShrunk) flags |= FLAG_SHRUNK;
    if (kart.isBill) flags |= FLAG_BILL;
    if (kart.bumped) flags |= FLAG_BUMPED;
    if (kart.isFlat) flags |= FLAG_FLAT;
    // Hors course seulement (marqueur non recalcule apres l'arrivee).
    if (kart.finalLapSign && !kart.finished) flags |= FLAG_FINAL_LAP;
    return flags;
}

// [id, worldX, yPercent, totalDistance, flags, rank, heldId, heldType, heldHold,
// orbitAngle, orbIds, hitEnd, bumpEnd, hitDur]
// `heldType` : type de l'objet tenu (pour une orbite, celui de l'objet largue).
// `hitEnd`, `bumpEnd` : fins de malus en temps serveur ; `hitDur` : duree de ce
// tete-a-queue.
function kartTuple(kart) {
    const held = kart.heldItem;
    const orbit = held && held.holdPosition === 'orbit';

    return [
        kart.id,
        round(kart.worldX, 2),
        round(kart.yPercent, 2),
        round(kart.totalDistance, 1),
        kartFlags(kart),
        kart.rank,
        held ? held.id : null,
        held ? (orbit ? held.childType : held.type) : null,
        held ? held.holdPosition : null,
        orbit ? round(held.orbitAngle, 3) : null,
        orbit ? held.orbs.map(o => o.id) : null,
        kart.state === 'hit' ? Math.round(kart.hitEndTime) : null,
        kart.bumped ? Math.round(kart.bumpEndTime) : null,
        kart.state === 'hit' ? kart.hitDuration : null
    ];
}

// [id, type, worldX, y, frame, hop] : `frame` pour l'animation des carapaces,
// `hop` pour la hauteur d'une banane en l'air (px de rendu).
function itemTuple(item) {
    return [
        item.id,
        item.type,
        round(item.worldX, 2),
        round(item.y, 2),
        item.currentFrame,
        item.hop ? round(item.hop, 1) : 0,
        // Montee d'une banane en cloche (pas de hitbox).
        item.rising ? 1 : 0
    ];
}

// [debut, frappe, fin, lanceur] en temps serveur, ou null hors orage.
function stormTuple(state) {
    const storm = state.storm;
    if (!storm) return null;
    return [Math.round(storm.startedAt), Math.round(storm.strikeAt), Math.round(storm.until), storm.shooterId];
}

// [manche, points de la course, points du grand prix], alignes sur l'ordre de
// `state.karts` (celui du `hello`).
function grandPrixTuple(state) {
    return [
        state.gpRound,
        state.karts.map(kart => state.racePoints[kart.charName] || 0),
        state.karts.map(kart => state.gpPoints[kart.charName] || 0)
    ];
}

// [groupe, image] ; le drapeau s'anime cote client.
function signTuple(state) {
    if (!state.sign) return null;
    return [state.sign.group, state.sign.group === 'finish' ? null : state.sign.frame];
}

// Snapshot complet. Les cameras y figurent pour garantir un decor synchronise.
// `vote` : [voix, spectateurs], fourni par le service.
function buildSnapshot(cfg, state, simTime, vote) {
    return {
        t: 's',
        // Arrondi a la milliseconde.
        ts: Math.round(simTime),
        cx: round(state.cameraX, 2),
        bx: round(state.bgCameraX, 2),
        k: state.karts.map(kartTuple),

        // Releve de decision (informatif).
        ai: state.karts.map(kart => aiTuple(cfg, kart, simTime)),

        i: state.items.map(itemTuple),
        b: state.itemBoxes.map(box => (box.active ? 1 : 0)),

        // Phase et ordre d'arrivee, pour un arrivant pendant le classement.
        ph: state.phase,
        lp: state.leaderLap,
        sg: signTuple(state),
        st: stormTuple(state),
        fo: state.finishOrder,

        // Grand prix, pour un arrivant pendant le tableau des scores.
        gp: grandPrixTuple(state),

        // Vote en cours.
        vt: vote || [0, 0]
    };
}

// Envoye a chaque connexion : identite des karts, geometrie et constantes du
// monde, et un premier snapshot complet.
function buildHello(cfg, state, simTime, t0, vote) {
    return {
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        serverTime: Date.now(),
        t0: t0,

        world: {
            width: cfg.world.width,
            finishLineX: cfg.world.finishLineX,
            sunX: cfg.world.sunX,
            roadMinY: cfg.road.minY,
            roadMaxY: cfg.road.maxY,
            roadPPS: cfg.speeds.roadPPS,
            // Duree de repli du tete-a-queue (la plus longue de la table).
            hitDuration: Math.max(...Object.values(cfg.hits).map(h => h.spinMs)),
            // Geometrie des objets en orbite.
            orbit: {
                count: cfg.orbit.count,
                radiusX: cfg.orbit.radiusX,
                radiusY: cfg.orbit.radiusY
            },
            // Cadence d'animation des carapaces en orbite.
            shellAnimSpeed: cfg.itemAnim.greenShell.animSpeed,
            // Cadence des trois images du Bill Ball.
            billAnimSpeed: cfg.itemAnim.bill.animSpeed,

            laps: cfg.race.laps,
            // Nombre de courses d'un grand prix.
            gpRaces: cfg.grandPrix.races,
            flagAnimSpeed: 220,
            // Rayon du souffle de la bleue.
            blastRadius: cfg.blueShell.blastRadiusX,
            // Taille d'un kart rapetisse, en fraction de sa taille normale.
            shrinkScale: cfg.lightning.scale,

            // Cles du releve de decision, dans l'ordre des indices.
            ai: { states: AI_STATES, dangers: AI_DANGERS, alerts: AI_ALERTS },

            // Demi-emprises des corps pour la carte de debug (`cfg.hitboxes`
            // contient des ecarts entre centres).
            hitboxes: {
                // Kart de reference (chaque kart envoie la sienne dans `body`).
                kart: {
                    x: cfg.hitboxes.kartVsKart.x / 2,
                    y: cfg.hitboxes.kartVsKart.y / 2
                },
                // Demi-axes du disque du tuyau.
                pipe: {
                    x: cfg.pipe.hitbox.x,
                    y: cfg.pipe.hitbox.y,
                    round: true
                },
                // Objet au sol ou en vol (`bodies.item`) ; la bleue n'y figure pas.
                item: {
                    x: cfg.bodies.item.x,
                    y: cfg.bodies.item.y
                },
                // Position de l'objet traine, en ecart signe au centre du porteur.
                heldBehindX: cfg.offsets.world.heldItemBehind,

                // Zone de ramassage, pour le centre d'un kart.
                itemBox: {
                    x: cfg.hitboxes.itemBox.x,
                    y: cfg.hitboxes.itemBox.y
                }
            },

            // Distances de la vue, pour la carte de debug.
            vision: {
                rangeFront: cfg.vision.range.front,
                rangeBack: cfg.vision.range.back,
                pressureRange: cfg.vision.pressureRange,
                // Voie : bande ou un objet est sur la route.
                threatLane: cfg.vision.threatLane,
                // Degagement : bande d'alignement du danger latent.
                clear: cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item
            },

            // Taille dessinee du tuyau en px de monde (determine son emprise).
            pipeDraw: {
                w: round(cfg.pipe.draw.w, 2),
                h: round(cfg.pipe.draw.h, 2)
            }
        },

        // Identite et gabarit de chaque kart : `body` (demi-emprise) et `scale`
        // (rapport au kart de reference).
        karts: state.karts.map(kart => {
            const body = cfg.bodies.kart[kart.charName] || cfg.bodies.ref;
            return {
                id: kart.id,
                char: kart.charName,
                body: {
                    x: round(body.x, 2),
                    y: round(body.y, 3),
                    scale: round(body.scale, 4)
                }
            };
        }),
        boxes: state.itemBoxes.map(box => ({ x: round(box.worldX, 2), y: round(box.y, 2) })),

        // Tuyaux fixes, dans l'ordre de `state.pipes` (index de `pipeShaken`).
        pipes: state.pipes.map(pipe => ({
            x: round(pipe.worldX, 2),
            y: round(pipe.y, 2),
            kind: pipe.kind || 'green'
        })),

        snapshot: buildSnapshot(cfg, state, simTime, vote)
    };
}

// Seuls ces evenements sont transmis ; le reste est deduit du snapshot.
// `pipeShaken` ne se deduit d'aucun snapshot.
const BROADCAST_EVENTS = new Set(['kartHit', 'leaderboardPosition', 'pipeShaken']);

function filterEvents(events) {
    return events.filter(ev => {
        if (!BROADCAST_EVENTS.has(ev.type)) return false;

        // Seuls les vrais changements de place (ou l'entree au classement).
        if (ev.type === 'leaderboardPosition' && ev.newPosition === ev.prevPosition) return false;

        return true;
    });
}

export {
    PROTOCOL_VERSION,
    FLAG_GRID,
    FLAG_HIT,
    FLAG_STOPPED,
    FLAG_STAR,
    FLAG_FINISHED,
    FLAG_SHRUNK,
    FLAG_BILL,
    FLAG_BUMPED,
    FLAG_FLAT,
    buildHello,
    buildSnapshot,
    visionTuple,
    filterEvents
};
