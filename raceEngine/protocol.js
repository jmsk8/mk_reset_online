'use strict';

// Protocole serveur → client du banner.
//
// Regle qui gouverne tout ce fichier : **le snapshot fait foi**. Un spectateur
// qui se connecte a la 187e seconde n'a vu passer aucun evenement, et doit
// pourtant afficher une scene complete et juste. Donc tout ce qui est visible a
// l'ecran doit se trouver dans le snapshot — jamais seulement dans un
// evenement. Les evenements ne servent qu'a jouer des animations.
//
// Corollaire pratique : avant d'ajouter un element visuel cote client, se
// demander « un arrivant peut-il le deduire du seul snapshot ? ». Si non, c'est
// ici qu'il manque un champ.

const PROTOCOL_VERSION = 2;

// Champ de bits de l'etat d'un kart. Compact parce qu'il part dix fois par
// seconde a chaque spectateur (voir §6.7 du document de migration).
const FLAG_GRID = 1;      // sur la grille, avant le coup d'envoi
const FLAG_HIT = 2;       // percute -> tete-a-queue
const FLAG_STOPPED = 4;   // immobilise apres impact -> sprite fige
const FLAG_STAR = 8;      // etoile active -> halo
const FLAG_FINISHED = 16; // a franchi la ligne -> tour d'honneur

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
    return flags;
}

// [id, worldX, yPercent, totalDistance, flags, rank, heldId, heldType,
//  heldHold, orbitAngle, orbIds, hitEnd]
//
// `heldType` est indispensable : sans lui le client ne peut pas choisir le
// sprite de l'objet tenu, et un arrivant verrait une banane a la place d'une
// carapace. Pour un objet en orbite c'est le type de l'objet enfant qui est
// transmis — c'est le seul dont le rendu a besoin.
//
// `hitEnd` est la fin du malus, en temps serveur. Le tete-a-queue est une
// animation derivee du temps : sans cette date, un arrivant saurait qu'un kart
// est percute mais pas depuis quand, et le ferait tourner a contretemps.
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
        kart.state === 'hit' ? Math.round(kart.hitEndTime) : null
    ];
}

// [id, type, worldX, y, frame] — `frame` porte l'animation des carapaces, que
// la simulation fait avancer : le client ne fait que l'afficher.
function itemTuple(item) {
    return [
        item.id,
        item.type,
        round(item.worldX, 2),
        round(item.y, 2),
        item.currentFrame
    ];
}

// Les deux cameras sont parfaitement deterministes et pourraient se deduire du
// temps ecoule ; elles voyagent quand meme dans chaque snapshot. Deux nombres
// contre la certitude qu'aucun spectateur ne verra jamais le decor decale, ce
// n'est pas cher paye — et c'est ce que demande une identite stricte du rendu.
// [groupe, image]. Le drapeau s'anime cote client : seul le groupe part.
function signTuple(state) {
    if (!state.sign) return null;
    return [state.sign.group, state.sign.group === 'finish' ? null : state.sign.frame];
}

function buildSnapshot(state, simTime) {
    return {
        t: 's',
        // Arrondi a la milliseconde : l'horloge de simulation avance par pas de
        // 33,333 ms et traine donc des decimales qui ne servent a rien — le
        // client interpole sur des intervalles de 66 ms.
        ts: Math.round(simTime),
        cx: round(state.cameraX, 2),
        bx: round(state.bgCameraX, 2),
        k: state.karts.map(kartTuple),
        i: state.items.map(itemTuple),
        b: state.itemBoxes.map(box => (box.active ? 1 : 0)),

        // L'ordre d'arrivee est dans le snapshot : un spectateur qui se
        // connecte pendant le classement doit le voir en entier.
        ph: state.phase,
        lp: state.leaderLap,
        sg: signTuple(state),
        fo: state.finishOrder
    };
}

// Envoye une fois par connexion. Contient l'identite des karts, la geometrie du
// monde, et un premier snapshot complet : de quoi construire la scene sans rien
// savoir de ce qui s'est passe avant.
//
// Le client ne garde aucune copie des constantes de simulation : elles arrivent
// toutes ici. C'est ce qui evite qu'un reglage de gameplay change d'un cote
// sans l'autre (§6.9).
function buildHello(cfg, state, simTime, t0) {
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
            // Duree du tete-a-queue : le client en derive la frame a afficher.
            hitDuration: cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration,
            // Geometrie des objets en orbite, pour les placer autour du kart.
            orbit: {
                count: cfg.orbit.count,
                radiusX: cfg.orbit.radiusX,
                radiusY: cfg.orbit.radiusY
            },
            // Cadence d'animation des carapaces en orbite, derivee du temps.
            shellAnimSpeed: cfg.itemAnim.greenShell.animSpeed,

            laps: cfg.race.laps,
            flagAnimSpeed: 220
        },

        karts: state.karts.map(kart => ({ id: kart.id, char: kart.charName })),
        boxes: state.itemBoxes.map(box => ({ x: round(box.worldX, 2), y: round(box.y, 2) })),

        snapshot: buildSnapshot(state, simTime)
    };
}

// Seuls ces evenements declenchent quelque chose cote client : le sursaut de la
// photo a l'impact, et le glissement au classement. Tous les autres decrivent
// des creations ou des destructions, que la reconciliation deduit deja du
// snapshot — les transmettre ne ferait que donner deux sources de verite.
const BROADCAST_EVENTS = new Set(['kartHit', 'leaderboardPosition']);

function filterEvents(events) {
    return events.filter(ev => {
        if (!BROADCAST_EVENTS.has(ev.type)) return false;

        // Le classement est recalcule toutes les 500 ms et emet une position
        // pour chacun des huit karts, meme quand rien n'a bouge : seize
        // evenements par seconde dont l'immense majorite ne declenche aucune
        // animation. Seul un changement de place merite d'etre transmis —
        // l'arrivee au classement (prevPosition === -1) en est un.
        if (ev.type === 'leaderboardPosition' && ev.newPosition === ev.prevPosition) return false;

        return true;
    });
}

module.exports = {
    PROTOCOL_VERSION,
    FLAG_GRID,
    FLAG_HIT,
    FLAG_STOPPED,
    FLAG_STAR,
    FLAG_FINISHED,
    buildHello,
    buildSnapshot,
    filterEvents
};
