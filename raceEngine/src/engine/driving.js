// Choix d'une profondeur (voie) et braquage pour la rejoindre. Les tableaux de
// candidates sont des tampons reutilises (aucune allocation dans la boucle).

import { steerCap, steerDelay, steerReach } from './steering.js';

// Placement : la note d'une profondeur, en ms (meme monnaie que `vision.cost`) :
//
//     note = ce qu'on risque en y etant  +  ce que coute d'y aller
//
// Seul le tuyau est un mur ; le reste se franchit contre son prix :
//
//     tuyau        infranchissable de pres, puis preference qui s'efface
//     objet        2000 ms de tete-a-queue
//     carrosserie   300 ms de bousculade
//     bord           200 ms de frottement
//
// Entamer une marge de confort coute en proportion, sans rien refuser.

// Poids d'un obstacle selon sa distance : plein dans sa portee ; au-dela, seul
// un mur compte encore, de moins en moins jusqu'a la limite du regard.
function spanWeight(cfg, s) {
    const d = s.dx < 0 ? -s.dx : s.dx;
    return (d <= s.reach) ? 1 : 0;
}

// Marge d'imprecision du kart en plus de sa hitbox : bande morte du braquage
// (`tolerance`) plus derive inversement proportionnelle a son volant
// (`slop / cap`). En croisiere : ~0.8 pour koopa, ~1.6 pour bowser.
function laneSlop(cfg, kart, cap, spec) {
    return spec.tolerance + cfg.vision.place.slop / Math.max(cap, 1);
}

// Cout d'etre a la profondeur `y`, en ms (`Infinity` si impossible), d'apres
// `kart.sight` seulement : ce qui n'a pas ete vu ne coute rien. `slop` gonfle
// chaque corps. `LANE_EPS` : tolerance numerique sur les limites.
const LANE_EPS = 1e-9;

function laneRisk(cfg, kart, y, cap, slop) {
    const road = cfg.road;
    if (y < road.minY || y > road.maxY) return Infinity;

    const sight = kart.sight;
    let risk = 0;

    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        const w = spanWeight(cfg, s);
        if (w <= 0) continue;

        // Murs suivants : une dette (deplacement a faire plus tard) plutot qu'un
        // refus, sauf s'ils sont hors d'atteinte.
        if (s.hard && s.spare > 0) {
            const room = steerReach(cfg, cap, s.spare);
            const need = (y > s.lo - slop && y < s.hi + slop)
                ? Math.min(y - (s.lo - slop), (s.hi + slop) - y)
                : 0;
            if (need > room) return Infinity;
            if (need > 0) {
                risk += cfg.vision.place.detour * cfg.vision.place.debt
                    * steerDelay(cfg, cap, need);
            }
            continue;
        }

        // Ecart a la limite dure (negatif a l'interieur, nul sur la limite, qui
        // ne touche pas), avec tolerance numerique.
        const gap = ((y <= s.lo) ? s.lo - y : (y >= s.hi) ? y - s.hi : -1) - slop;

        if (gap < -LANE_EPS) {
            if (s.hard && w >= 1) return Infinity;
            risk += s.cost * w;
            continue;
        }

        // Confort entame : jusqu'a `place.graze` du prix du contact.
        const clear = (gap > 0) ? gap : 0;
        if (clear < s.margin) {
            risk += s.cost * w * cfg.vision.place.graze * (1 - clear / s.margin);
        }
    }

    // Encombrement : cout cumule des karts deja dans le passage (bande = hitbox
    // entre karts plus marge de confort).
    const crowd = cfg.vision.crowd;
    if (crowd.cost > 0 && sight.crowdCount > 0) {
        const band = cfg.hitboxes.kartVsKart.y + cfg.vision.place.margin.kart;
        let press = 0;
        for (let i = 0; i < sight.crowdCount; i++) {
            const d = Math.abs(y - sight.crowdY[i]);
            if (d < band) press += 1 - d / band;
        }
        if (press > 0) risk += crowd.cost * press;
    }

    // Bord : coute de la vitesse par frottement, sans rien fermer.
    const edge = Math.min(y - road.minY, road.maxY - y);
    const width = road.edgeSafetyMargin;
    if (edge < width) risk += cfg.vision.cost.edge * (1 - edge / width);

    // La boite : seul terme negatif de la note.
    const box = kart.sight;
    if (box.boxDist >= 0) {
        const off = Math.abs(y - box.boxY);
        const grab = cfg.hitboxes.itemBox.y;
        if (off < grab) risk -= cfg.vision.place.boxBonus * (1 - off / grab);
    }

    return risk;
}

// Note d'un candidat : risque a la position reellement atteignable, detour sur
// l'intention.
function laneScore(cfg, kart, y, cap, settle, reach, weight, slop) {
    const target = (y > settle + reach) ? settle + reach
        : (y < settle - reach) ? settle - reach : y;

    const risk = laneRisk(cfg, kart, target, cap, slop);
    if (risk === Infinity) return Infinity;

    const move = (target > settle) ? target - settle : settle - target;
    return risk + weight * steerDelay(cfg, cap, move);
}

// Tampons du choix, partages par tous les karts.
const laneY = [];

const laneCost = [];

let laneN = 0;

function laneAdd(cfg, y) {
    const lo = cfg.road.minY;
    const hi = cfg.road.maxY;
    const v = (y < lo) ? lo : (y > hi) ? hi : y;

    for (let i = 0; i < laneN; i++) {
        if (Math.abs(laneY[i] - v) < 1e-6) return;
    }
    laneY[laneN] = v;
    laneCost[laneN] = 0;
    laneN++;
}

// Profondeurs candidates : sa propre ligne, les deux bords, et pour chaque
// obstacle vu ses bords au ras de la hitbox et au confort.
function laneCandidates(cfg, kart, settle, slop) {
    laneN = 0;
    laneAdd(cfg, settle);
    laneAdd(cfg, cfg.road.minY);
    laneAdd(cfg, cfg.road.maxY);

    const sight = kart.sight;

    // La boite visee est aussi candidate.
    if (sight.boxDist >= 0) laneAdd(cfg, sight.boxY);

    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        if (spanWeight(cfg, s) <= 0) continue;

        laneAdd(cfg, s.lo - slop);
        laneAdd(cfg, s.hi + slop);
        laneAdd(cfg, s.lo - slop - s.margin);
        laneAdd(cfg, s.hi + slop + s.margin);
    }
}

// Profondeur retenue, ou `null` s'il n'existe aucun endroit tenable (le kart
// freine). Le meilleur choix est pris avec une chance `place.chance`, sinon le
// suivant, et ainsi de suite (1 = kart parfait).
function chooseLane(cfg, rng, kart, cap, ttc, spec) {
    const place = cfg.vision.place;
    const settle = steerSettle(cfg, kart);
    const reach = steerReach(cfg, cap, ttc);

    // Trois passes pour ne jamais se figer : avec imprecision et dans le temps
    // disponible, puis sans imprecision, puis sans limite de temps.
    let chosen = null;

    for (let pass = 0; pass < 3; pass++) {
        const slop = (pass === 0) ? laneSlop(cfg, kart, cap, spec) : 0;
        const horizon = (pass < 2) ? reach : Infinity;

        laneCandidates(cfg, kart, settle, slop);
        for (let i = 0; i < laneN; i++) {
            laneCost[i] = laneScore(cfg, kart, laneY[i], cap, settle, horizon,
                                    place.detour, slop);
        }

        chosen = pickLane(cfg, rng);
        if (chosen !== null) break;
    }

    return chosen;
}

// Tirage dans le classement ; les egalites sont departagees uniformement
// (Vitter), sinon le cote `lo` gagnerait toujours.
function pickLane(cfg, rng) {
    const place = cfg.vision.place;
    let chosen = null;
    for (let round = 0; round < laneN; round++) {
        let pick = -1;
        let ties = 0;
        for (let i = 0; i < laneN; i++) {
            if (laneCost[i] === Infinity) continue;
            if (pick < 0 || laneCost[i] < laneCost[pick] - LANE_EPS) {
                pick = i;
                ties = 1;
            } else if (laneCost[i] <= laneCost[pick] + LANE_EPS) {
                ties++;
                if (rng() * ties < 1) pick = i;
            }
        }
        if (pick < 0) break;

        chosen = laneY[pick];
        if (rng() < place.chance) break;

        // Rate : on passe a l'option suivante.
        laneCost[pick] = Infinity;
    }

    return chosen;
}

// Place libre d'un cote du kart, bornee par le bord et par ce qu'il voit.
function sideRoom(cfg, kart, dir) {
    const margin = cfg.road.edgeSafetyMargin;
    let limit = (dir > 0) ? (cfg.road.maxY - margin) : (cfg.road.minY + margin);

    const sight = kart.sight;
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        if (s.dx > s.reach || s.dx < -s.reach) continue;

        // Face de confort tournee vers le kart, seulement si l'obstacle est de
        // ce cote.
        const face = (dir > 0) ? (s.lo - s.margin) : (s.hi + s.margin);
        if (dir > 0 ? (face > kart.yPercent && face < limit)
                    : (face < kart.yPercent && face > limit)) {
            limit = face;
        }
    }

    return Math.max(0, dir * (limit - kart.yPercent));
}

// Point ou le kart s'arreterait volant lache (reference de `steer`).
function steerSettle(cfg, kart) {
    return kart.yPercent + kart.vy / cfg.physics.steer.response;
}

// Seule fonction de braquage : rejoindre la profondeur `laneY` et la tenir.
//   `laneY`  profondeur a rejoindre (identique pour tous les personnages)
//   `speed`  urgence, avant mise a l'echelle du kart
//   `spec`   `{ gain, tolerance, guard }` (voir `ai.steering`)
// La cible est comparee au point d'arret (inertie du volant) pour eviter le
// depassement. `guard` refuse d'aller dans un obstacle vu.
function steer(cfg, kart, deltaTime, laneY, speed, spec) {
    const response = cfg.physics.steer.response;
    const diff = laneY - steerSettle(cfg, kart);

    if (Math.abs(diff) <= spec.tolerance) {
        // Cible tenue.
        kart.targetVy = 0;
    } else {
        const cap = steerCap(cfg, kart, speed);
        const seek = steerCap(cfg, kart, diff * spec.gain);
        kart.targetVy = Math.max(-cap, Math.min(cap, seek));
    }

    if (spec.guard && kart.targetVy) {
        // Le garde-fou exige un balayage de face (sur un balayage arriere, la
        // piste devant n'a pas ete consultee).
        const dir = kart.targetVy > 0 ? 1 : -1;
        const settle = Math.max(0, dir * kart.vy) / response;
        if (kart.sight.scanBack || sideRoom(cfg, kart, dir) <= settle) kart.targetVy = 0;
    }

    // Reponse du volant, facteur borne a 1.
    const k = response * deltaTime;
    kart.vy += (kart.targetVy - kart.vy) * (k > 1 ? 1 : k);
}

export {
    chooseLane,
    laneScore,
    laneSlop,
    laneY,
    sideRoom,
    steer,
    steerSettle,
};
