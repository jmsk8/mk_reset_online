// Tuyaux : rebonds, chocs et contournement.

import { getShortestDistance } from './geometry.js';
import { approachMs, steerCapOver, steerDelay, steerReach } from './steering.js';
import { isRamming, kartHalfExtents } from './bodies.js';
import { spendItem } from './items.js';
import { chooseLane, laneScore, laneSlop, steer, steerSettle } from './driving.js';
import { reviewDelay } from './plans.js';

// Un tuyau est un disque au sol (x en px de monde, y en profondeur), traite dans
// un espace normalise ou chaque ecart est divise par son demi-axe.

// Vrai si l'ecart tombe dans l'emprise ronde `box`.
function insidePipe(box, dx, dy) {
    const u = dx / box.x;
    const v = dy / box.y;
    return u * u + v * v < 1;
}

// Compte un rebond de verte (bords et tuyaux) ; true si c'etait celui de trop.
function registerBounce(cfg, item, now) {
    if (item.type !== 'greenShell') return false;

    item.bounces++;
    if (item.bounces > cfg.pipe.maxShellBounces) {
        spendItem(cfg, item, now);
        return true;
    }
    return false;
}

// Rebond d'une carapace sur un tuyau ; true si contact. La normale au point
// touche fixe le point de sortie et l'axe a renverser : un seul axe se renverse
// (celui qui porte le plus l'entree), car les deux axes n'ont pas la meme
// echelle de vitesse.
function bounceItemOffPipe(cfg, pipe, item) {
    const box = cfg.pipe.hitbox;
    const margin = 1 + cfg.pipe.escapeMargin;

    const dx = getShortestDistance(cfg, item.worldX, pipe.worldX);
    const dy = item.y - pipe.y;

    // Normale : la position normalisee ramenee a l'unite.
    let nu = dx / box.x;
    let nv = dy / box.y;
    let norm = Math.sqrt(nu * nu + nv * nv);

    // Pile au centre : normale prise sur la trajectoire.
    if (norm < 1e-6) {
        nu = -item.vx / box.x;
        nv = -item.vy / box.y;
        norm = Math.sqrt(nu * nu + nv * nv);
        if (norm < 1e-6) return false;
    }

    nu /= norm;
    nv /= norm;

    // Part de l'entree portee par chaque axe (positive vers le centre).
    const inX = -(item.vx / box.x) * nu;
    const inY = -(item.vy / box.y) * nv;

    // Elle s'eloigne deja.
    if (inX <= 0 && inY <= 0) return false;

    // Reposee sur l'arc, marge comprise.
    let outX = pipe.worldX + nu * box.x * margin;
    let outY = pipe.y + nv * box.y * margin;

    // Tuyau colle au bord : sortie par le bout plutot que hors de la piste.
    if (outY > cfg.road.maxY || outY < cfg.road.minY) {
        if (inX <= 0) return false;
        const sideX = dx >= 0 ? 1 : -1;
        item.vx = -item.vx;
        outX = pipe.worldX + sideX * box.x * margin;
        outY = item.y;
    } else if (inY > inX) {
        // Flanc : la profondeur se renverse.
        item.vy = -item.vy;
    } else {
        // Bout : l'avance se renverse.
        item.vx = -item.vx;
    }

    item.worldX = outX;
    if (item.worldX < 0) item.worldX += cfg.world.width;
    if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
    item.y = outY;
    return true;
}

// Avance d'un projectile sur un pas, en sous-pas bornes en profondeur et le
// long de la piste.
function advanceProjectile(cfg, state, item, deltaTime, now) {
    const spec = cfg.pipe;

    let steps = Math.max(
        Math.ceil(Math.abs(item.vy * deltaTime) / spec.maxSubStepY),
        Math.ceil(Math.abs(item.vx * deltaTime) / spec.maxSubStepX));
    if (!(steps >= 1)) steps = 1;
    if (steps > spec.maxSubSteps) steps = spec.maxSubSteps;

    const dt = deltaTime / steps;
    const pipes = state.pipes;

    // Ni la banane (immobile) ni la bleue (en vol) ne rencontrent un tuyau.
    const meetsPipes = pipes.length > 0
        && (item.type === 'greenShell' || item.type === 'redShell');

    for (let s = 0; s < steps; s++) {
        item.worldX += item.vx * dt;
        item.y += item.vy * dt;

        if (item.y > cfg.road.maxY) {
            item.y = cfg.road.maxY;
            if (item.type !== 'redShell') {
                item.vy = -item.vy;
                if (registerBounce(cfg, item, now)) return;
            }
        } else if (item.y < cfg.road.minY) {
            item.y = cfg.road.minY;
            if (item.type !== 'redShell') {
                item.vy = -item.vy;
                if (registerBounce(cfg, item, now)) return;
            }
        }

        if (!meetsPipes) continue;

        for (let p = 0; p < pipes.length; p++) {
            const pipe = pipes[p];
            const pdx = getShortestDistance(cfg, item.worldX, pipe.worldX);
            if (Math.abs(pdx) >= spec.hitbox.x) continue;
            if (!insidePipe(spec.hitbox, pdx, item.y - pipe.y)) continue;

            // La rouge se brise (en chasse, elle le contourne avant, voir
            // `redShellAimY`).
            if (item.type === 'redShell') {
                spendItem(cfg, item, now);
                return;
            }

            if (bounceItemOffPipe(cfg, pipe, item)) {
                // Renvoyee par un tuyau, elle peut toucher son lanceur.
                item.pipeBounced = true;
                if (registerBounce(cfg, item, now)) return;
                break;
            }
        }
    }
}

// Profondeur visee par une rouge en chasse : celle de sa cible, sauf si un tuyau
// est sur le trajet predit (loi `redShellTrackingSpeed`). Elle le contourne du
// cote ou elle allait, ou de l'autre si ce cote est ferme ; sinon elle garde sa
// cible et se brisera.
function redShellAimY(cfg, state, item, target) {
    const targetY = target.yPercent;
    const pipes = state.pipes;
    if (!pipes.length) return targetY;

    const spec = cfg.pipe;
    const box = spec.hitbox;
    const clear = box.y * (1 + spec.redShell.margin);
    const dir = item.vx >= 0 ? 1 : -1;
    const speed = Math.abs(item.vx);
    if (!(speed > 0)) return targetY;

    // La cible avant le tuyau : rien a contourner.
    const targetAhead = getShortestDistance(cfg, target.worldX, item.worldX) * dir;
    const rate = cfg.speeds.redShellTrackingSpeed;

    let block = null;
    let blockAhead = Infinity;
    let blockY = 0;
    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const ahead = getShortestDistance(cfg, pipe.worldX, item.worldX) * dir;

        // Deja depasse, ou trop loin.
        if (ahead <= -box.x || ahead > spec.redShell.look) continue;
        if (targetAhead > 0 && targetAhead < ahead - box.x) continue;

        const t = (ahead > 0 ? ahead : 0) / speed;
        const y = targetY + (item.y - targetY) * Math.exp(-rate * t);
        if (Math.abs(y - pipe.y) >= clear) continue;

        if (ahead < blockAhead) {
            block = pipe;
            blockAhead = ahead;
            blockY = y;
        }
    }
    if (!block) return targetY;

    // Cote ou elle va deja ; pile dans l'axe, celui de sa cible.
    let side = (blockY > block.y) ? 1 : (blockY < block.y) ? -1 : 0;
    if (side === 0) side = (targetY >= block.y) ? 1 : -1;

    for (let tries = 0; tries < 2; tries++, side = -side) {
        const y = block.y + side * clear;
        if (y < cfg.road.minY || y > cfg.road.maxY) continue;

        // Un second tuyau a la meme hauteur ferme ce passage.
        let shut = false;
        for (let p = 0; p < pipes.length; p++) {
            const other = pipes[p];
            if (other === block) continue;
            if (Math.abs(getShortestDistance(cfg, other.worldX, block.worldX)) >= 2 * box.x) continue;
            if (Math.abs(other.y - y) < clear) { shut = true; break; }
        }
        if (!shut) return y;
    }
    return targetY;
}

// Cote vers lequel un kart plaque contre un tuyau s'ecarte : celui ou il
// deborde, sinon le plus degage.
function pipeSlideDir(cfg, kart, pipe) {
    if (Math.abs(kart.yPercent - pipe.y) < 0.5) {
        return (cfg.road.maxY - kart.yPercent) >= (kart.yPercent - cfg.road.minY) ? 1 : -1;
    }
    return kart.yPercent >= pipe.y ? 1 : -1;
}

// Choc d'un kart contre un tuyau (masse infinie) : arret net, recul, repart de
// zero. Etoile et bill le traversent. Sursis par tuyau.
function collideKartWithPipes(cfg, state, kart, now, events) {
    kart.pipeBlocked = false;

    const pipes = state.pipes;
    if (!pipes.length) return;

    const box = cfg.pipe.hitbox;

    // Carrosserie propre au kart ; boite + disque = rectangle aux coins arrondis.
    const flat = kartHalfExtents(cfg, kart, now);
    const reachX = box.x + flat.x;
    const reachY = box.y + flat.y;

    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const dx = getShortestDistance(cfg, kart.worldX, pipe.worldX);
        if (Math.abs(dx) >= reachX) continue;
        const dy = kart.yPercent - pipe.y;
        if (Math.abs(dy) >= reachY) continue;

        // Hors de la croix plate : l'arc du tuyau tranche.
        const cornerX = Math.abs(dx) - flat.x;
        const cornerY = Math.abs(dy) - flat.y;
        if (cornerX > 0 && cornerY > 0 && !insidePipe(box, cornerX, cornerY)) continue;

        // Toupie : arretee et glissante, sans nouveau choc ni sursis.
        if (kart.state === 'hit') {
            kart.pipeBlocked = true;
            kart.bumpVy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;
            return;
        }

        if (p === kart.lastPipeIndex && now < kart.pipeImmuneUntil) continue;

        kart.lastPipeIndex = p;
        kart.pipeImmuneUntil = now + cfg.pipe.immuneMs;

        if (isRamming(kart)) {
            events.push({ type: 'pipeShaken', pipeIndex: p, kartId: kart.id });
            return;
        }

        kart.bumpEndTime = now + cfg.pipe.bumpMs;
        kart.bumpRecoilLeft = cfg.pipe.recoilPx;
        kart.absoluteVelocity = 0;
        kart.momentum = 0;
        // Le choc efface aussi l'elan mis de cote.
        kart.preBoostMomentum = -1;

        // Ecart vers le cote le plus degage, dans `bumpVy` (subi, pas pilote).
        kart.bumpVy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;

        // Le plan en cours ne vaut plus : nouveau couloir au redemarrage.
        kart.aiState = 'cruising';
        kart.plan.threatId = 0;
        kart.pipeTargetIndex = -1;

        events.push({ type: 'kartBumped', kartId: kart.id, pipeIndex: p });
        return;
    }
}

// Couloir pour passer un tuyau : `chooseLane` avec le temps restant (calcule ici
// depuis une distance) et le profil de contournement.
function choosePipeLane(cfg, kart, rng, dist, current) {
    const place = cfg.vision.place;
    const lane = cfg.ai.steering.pipe;

    // Distance jusqu'au contact, pas jusqu'au centre.
    const clear = dist - cfg.hitboxes.kartVsPipe.x;
    const near = clear > 0 ? clear : 0;

    // Trajet reel pour jauger le volant et l'allure ; fenetre avec plancher pour
    // classer les couloirs.
    const trip = approachMs(cfg, kart, near);
    const ttc = Math.max(trip, cfg.vision.reviewIntervalMs);
    const cap = steerCapOver(cfg, kart, lane.speed, near, trip);
    const chosen = chooseLane(cfg, rng, kart, cap, ttc, lane);

    // Aucun endroit tenable : on garde le couloir deja choisi, sinon `null`
    // (pas d'engagement, nouvelle question au tick suivant).
    if (chosen === null) return current;
    if (current === null) return chosen;

    // Changer de couloir exige un gain net, d'autant plus que le tuyau approche
    // (reference : temps pour traverser toute la profondeur).
    const settle = steerSettle(cfg, kart);
    const reach = steerReach(cfg, cap, ttc);
    const slop = laneSlop(cfg, kart, cap, lane);

    const cross = steerDelay(cfg, cap, cfg.road.maxY - cfg.road.minY);
    const grip = (cross > 0) ? 1 - Math.min(1, ttc / cross) : 1;
    if (grip <= 0) return chosen;

    const held = laneScore(cfg, kart, current, cap, settle, reach, place.detour, slop);
    const next = laneScore(cfg, kart, chosen, cap, settle, reach, place.detour, slop);

    return (next < held - place.commit * grip) ? chosen : current;
}

// Contournement d'un tuyau ; true s'il commande la trajectoire. Le tuyau vise
// reste jusqu'a etre derriere, sans frein.
function steerAroundPipes(cfg, state, rng, now, kart, deltaTime) {
    const pipes = state.pipes;
    if (!pipes.length) return false;

    const reach = cfg.hitboxes.kartVsPipe;
    const sight = kart.sight;

    // Le tuyau vise reste tant qu'il n'est pas franchi.
    let dist = 0;
    if (kart.pipeTargetIndex >= 0) {
        const held = pipes[kart.pipeTargetIndex];
        dist = held ? getShortestDistance(cfg, held.worldX, kart.worldX) : 0;
        if (!held || dist < -reach.x || dist > cfg.vision.range.front) {
            kart.pipeTargetIndex = -1;
        }
    }

    if (kart.pipeTargetIndex < 0) {
        // Le plus proche devant, aligne ou non.
        if (sight.pipeAheadIndex < 0) return false;

        // Deja dans la zone de contact (souvent apres un choc) : pas
        // d'engagement, la question est reposee au tick suivant.
        if (sight.pipeAheadDist <= reach.x) return false;

        // Aucun couloir tenable : pas d'engagement non plus (la vue peut
        // encore montrer le mur qu'on vient de passer).
        const laneY = choosePipeLane(cfg, kart, rng, sight.pipeAheadDist, null);
        if (laneY === null) return false;

        kart.pipeTargetIndex = sight.pipeAheadIndex;
        dist = sight.pipeAheadDist;
        kart.pipeLaneY = laneY;
        kart.pipeReviewAt = now + reviewDelay(cfg, rng);

    } else if (now >= kart.pipeReviewAt) {
        // Revision du couloir a cadence irreguliere.
        kart.pipeReviewAt = now + reviewDelay(cfg, rng);
        if (rng() < cfg.vision.reviewChance) {
            kart.pipeLaneY = choosePipeLane(cfg, kart, rng,
                dist > 0 ? dist : 0, kart.pipeLaneY);
        }
    }

    const lane = cfg.ai.steering.pipe;
    const settle = steerSettle(cfg, kart);
    const need = Math.abs(kart.pipeLaneY - settle);

    // Deja sur le meilleur couloir : rend la main au reste du pilotage.
    if (need <= lane.tolerance) return false;

    kart.aiState = 'pipe';

    steer(cfg, kart, deltaTime, kart.pipeLaneY, lane.speed, lane);
    return true;
}

export {
    advanceProjectile,
    collideKartWithPipes,
    redShellAimY,
    steerAroundPipes,
};
