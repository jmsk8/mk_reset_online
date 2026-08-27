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

const PROTOCOL_VERSION = 6;

// Champ de bits de l'etat d'un kart. Compact parce qu'il part dix fois par
// seconde a chaque spectateur (voir §6.7 du document de migration).
const FLAG_GRID = 1;      // sur la grille, avant le coup d'envoi
const FLAG_HIT = 2;       // percute -> tete-a-queue
const FLAG_STOPPED = 4;   // immobilise apres impact -> sprite fige
const FLAG_STAR = 8;      // etoile active -> halo
const FLAG_FINISHED = 16; // a franchi la ligne -> tour d'honneur
const FLAG_SHRUNK = 32;   // rapetisse par l'eclair -> sprite reduit
const FLAG_BILL = 64;     // transforme en Bill Ball -> sprite remplace

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

// [id, type, worldX, y, frame, hop] — `frame` porte l'animation des carapaces,
// `hop` la hauteur d'une banane encore en l'air, en pixels de rendu.
function itemTuple(item) {
    return [
        item.id,
        item.type,
        round(item.worldX, 2),
        round(item.y, 2),
        item.currentFrame,
        item.hop ? round(item.hop, 1) : 0
    ];
}

// [debut, frappe, fin, lanceur], en temps serveur, ou null hors orage. Les trois
// dates suffisent au client a placer la scene ou qu'il en soit : le ciel
// s'assombrit de `debut` a `frappe`, la foudre tombe a `frappe`, le jour revient
// a `fin`. C'est le minimum pour qu'un spectateur arrive en plein orage le voie
// au bon stade au lieu de le rejouer depuis le debut. Le lanceur suit : c'est le
// seul que la foudre epargne, et le client doit l'epargner aussi.
function stormTuple(state) {
    const storm = state.storm;
    if (!storm) return null;
    return [Math.round(storm.startedAt), Math.round(storm.strikeAt), Math.round(storm.until), storm.shooterId];
}

// [manche, points de la course, points du grand prix]. Les deux tableaux sont
// alignes sur l'ordre de `state.karts`, qui est aussi celui des identifiants et
// celui du `hello` : le client lit la case i pour le kart i, sans avoir a
// transporter les noms a chaque envoi. Les points de la course restent a zero
// tant qu'elle n'est pas close.
function grandPrixTuple(state) {
    return [
        state.gpRound,
        state.karts.map(kart => state.racePoints[kart.charName] || 0),
        state.karts.map(kart => state.gpPoints[kart.charName] || 0)
    ];
}

// [groupe, image]. Le drapeau s'anime cote client : seul le groupe part.
function signTuple(state) {
    if (!state.sign) return null;
    return [state.sign.group, state.sign.group === 'finish' ? null : state.sign.frame];
}

// Les deux cameras pourraient se deduire du temps ecoule ; elles voyagent quand
// meme dans chaque snapshot, contre la certitude qu'aucun spectateur ne verra le
// decor decale.
//
// `vote` est le decompte du vote de redemarrage, [poses, spectateurs]. Il ne
// vient pas de l'etat du monde mais du service, seul a connaitre les
// connexions — d'ou ce parametre plutot qu'une lecture dans `state`. Le
// snapshot etant serialise une fois pour tout le monde, il ne peut porter que
// le total : chaque client se souvient seul de son propre vote.
function buildSnapshot(state, simTime, vote) {
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
        st: stormTuple(state),
        fo: state.finishOrder,

        // Le grand prix suit le meme principe que l'ordre d'arrivee : un
        // spectateur qui se connecte pendant le tableau des scores doit le voir
        // rempli, sans avoir assiste aux trois courses precedentes.
        gp: grandPrixTuple(state),

        // Meme regle : un arrivant doit voir le vote en cours, pas un compteur
        // a zero qui sauterait au snapshot suivant.
        vt: vote || [0, 0]
    };
}

// Envoye une fois par connexion. Contient l'identite des karts, la geometrie du
// monde, et un premier snapshot complet : de quoi construire la scene sans rien
// savoir de ce qui s'est passe avant.
//
// Le client ne garde aucune copie des constantes de simulation : elles arrivent
// toutes ici. C'est ce qui evite qu'un reglage de gameplay change d'un cote
// sans l'autre (§6.9).
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
            // Cadence des trois images du Bill Ball, derivee du temps elle aussi.
            billAnimSpeed: cfg.itemAnim.bill.animSpeed,

            laps: cfg.race.laps,
            // Nombre de courses d'un grand prix, pour l'entete « course N / M ».
            gpRaces: cfg.grandPrix.races,
            flagAnimSpeed: 220,
            // Rayon du souffle de la bleue : le client en tire la taille dessinee,
            // pour que l'effet couvre exactement la zone touchee.
            blastRadius: cfg.blueShell.blastRadiusX,
            // Taille d'un kart rapetisse, en fraction de sa taille normale : le
            // client ne decide pas de l'ampleur d'un malus de gameplay.
            shrinkScale: cfg.lightning.scale
        },

        karts: state.karts.map(kart => ({ id: kart.id, char: kart.charName })),
        boxes: state.itemBoxes.map(box => ({ x: round(box.worldX, 2), y: round(box.y, 2) })),

        snapshot: buildSnapshot(state, simTime, vote)
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
    FLAG_SHRUNK,
    FLAG_BILL,
    buildHello,
    buildSnapshot,
    filterEvents
};
