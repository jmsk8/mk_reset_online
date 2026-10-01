// Usage des objets (le tirage est dans items.js) : prise, visee, lancer,
// trainage, decision de tir et choix de la cible.

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { isRamming, shrunkReachX, shrunkReachY } from './bodies.js';
import { getBillSpeed } from './stats.js';
import { getDistanceToLeader, getRaceStage } from './standings.js';
import { getOrbitSpec, rollItem } from './items.js';
import { spinOutKart } from './effects.js';

// Tout objet simple arrive en main, sans hitbox.
function getHoldPosition(cfg, itemType) {
    if (getOrbitSpec(cfg, itemType)) return 'orbit';
    return 'hands';
}

function isTrailable(cfg, itemType) {
    return (cfg.trailableItems || []).indexOf(itemType) !== -1;
}

// Type menaçant d'un objet tenu (pour un triple, le type de l'objet largue).
function heldThreatType(held) {
    if (!held) return '';
    return held.childType || held.type;
}

// Une banane lachee derriere soi ne se vise pas.
function isAiming(cfg, kart) {
    const held = kart.heldItem;
    if (!held || held.holdPosition === 'orbit') return false;
    if (held.type === 'greenShell' || held.type === 'redShell') return true;
    return held.type === 'banana' && kart.lobbing;
}

// Vrai si le kart tient de quoi atteindre celui qu'il precede (pas une banane,
// sauf lancee en cloche).
function isArmedForward(cfg, kart) {
    const type = heldThreatType(kart.heldItem);
    if (!type) return false;
    if (type === 'greenShell' || type === 'redShell') return true;
    return type === 'banana' && kart.lobbing;
}

// Agressivite de 0 a 1 : produit du rang et de l'ecart au premier (racine),
// pondere par l'etape de course (1 a l'arrivee).
function getAggression(cfg, state, kart) {
    const spec = cfg.ai.aggression;

    // Rapportee au nombre de places a prendre (`rankedCount`).
    const places = state.rankedCount;
    const rankTerm = (places > 1) ? Math.min(kart.rank - 1, places - 1) / (places - 1) : 0;

    const dist = getDistanceToLeader(state, kart);
    const distTerm = (spec.distanceRef > 0)
        ? Math.min(Math.max(dist, 0), spec.distanceRef) / spec.distanceRef
        : 0;

    // Etape de course lue sur le premier (`getRaceStage`).
    const raceTerm = spec.startRatio + (1 - spec.startRatio) * getRaceStage(state);

    return Math.sqrt(rankTerm * distTerm) * raceTerm;
}

// Facteur d'attente : 1 pour qui mene, hurryRatio pour qui n'a rien a perdre.
function hurryFactor(cfg, aggression) {
    return 1 - aggression * (1 - cfg.ai.aggression.hurryRatio);
}

// Decide de la vie de l'objet (traine ou garde en main) et du sens du tir.
function planItemUse(cfg, rng, state, now, kart, itemType) {
    const ai = cfg.ai;

    kart.shotDirection = 1;
    kart.lobbing = false;

    if (itemType === 'greenShell' || itemType === 'redShell') {
        kart.shotDirection = rollShellDirection(cfg, rng, state, kart, itemType);
    } else if (itemType === 'banana') {
        kart.lobbing = rng() < rankChance(ai.bananaLobChance, state, kart);
        kart.shotDirection = kart.lobbing ? 1 : -1;
    }

    // Le premier defend : rien ne part devant lui (place retenue, voir
    // `getShotDirection`).
    kart.shotAsLeader = (kart.rank === 1);
    if (kart.shotAsLeader) {
        kart.lobbing = false;
        kart.shotDirection = -1;
    }

    kart.aimError = randomRange(rng, -ai.aimErrorMax, ai.aimErrorMax);

    const aggression = getAggression(cfg, state, kart);
    const hurry = hurryFactor(cfg, aggression);
    const trailChance = rankChance(ai.trailChance, state, kart)
        * (1 - aggression * (1 - ai.aggression.trailRatio));

    if (isTrailable(cfg, itemType) && rng() < trailChance) {
        const holdFactor = rankChance(ai.trailHoldFactor, state, kart);
        kart.trailTime = now + randomRange(rng, ai.trailDelayMin, ai.trailDelayMax) * hurry;
        kart.throwTime = kart.trailTime
            + randomRange(rng, ai.trailHoldMin, ai.trailHoldMax) * hurry * holdFactor;
        return;
    }

    kart.trailTime = 0;
    kart.throwTime = now + randomRange(rng, ai.holdItemMin, ai.holdItemMax) * hurry;
}

// Orbite elliptique autour du kart, en coordonnees monde.
function getOrbitItemPosition(cfg, kart, orb, orbitAngle) {
    const orbit = cfg.orbit;
    const angle = orbitAngle + orb.phase;

    let worldX = kart.worldX + Math.cos(angle) * orbit.radiusX;
    if (worldX < 0) worldX += cfg.world.width;
    if (worldX >= cfg.world.width) worldX -= cfg.world.width;

    return { worldX: worldX, y: kart.yPercent + Math.sin(angle) * orbit.radiusY };
}

// Retire un orbe sans toucher aux phases des autres. Aucun evenement : l'element
// DOM est supprime ou reutilise selon le cas.
function removeOrbitItem(kart, index) {
    const held = kart.heldItem;
    const orb = held.orbs[index];
    held.orbs.splice(index, 1);
    if (held.orbs.length === 0) kart.heldItem = null;
    return orb;
}

function destroyOrbitItem(kart, index, events) {
    const kartId = kart.id;
    const orb = removeOrbitItem(kart, index);
    events.push({ type: 'removeHeldItem', kartId: kartId, itemId: orb.id });
    return orb;
}

function giveKartItem(cfg, state, rng, now, kart, events) {
    if (kart.heldItem) return;

    const itemType = rollItem(cfg, state, rng, now, kart);
    if (!itemType) return;

    kart.lastItem = itemType;

    // Le drapeau de couverture ne survit pas a l'objet qui l'a justifie (remis
    // ici car planItemUse n'est pas appelee pour les orbites).
    kart.shieldHold = false;

    const holdPosition = getHoldPosition(cfg, itemType);
    const spec = getOrbitSpec(cfg, itemType);

    if (spec) {
        const orbit = cfg.orbit;
        const orbs = [];
        for (let i = 0; i < orbit.count; i++) {
            // Phase figee : la rotation des survivants ne change pas.
            orbs.push({ id: state.nextItemId++, phase: (i * 2 * Math.PI) / orbit.count });
        }

        // id de groupe sans element DOM (l'orbite a son propre rendu).
        kart.heldItem = {
            id: state.nextItemId++,
            type: itemType,
            childType: spec.child,
            holdPosition: holdPosition,
            orbitAngle: 0,
            orbs: orbs
        };

        for (let i = 0; i < orbs.length; i++) {
            events.push({
                type: 'spawnHeldItem',
                kartId: kart.id,
                itemId: orbs[i].id,
                itemType: spec.child,
                holdPosition: holdPosition
            });
        }

        kart.throwTime = now + randomRange(rng, cfg.ai.holdItemMin, cfg.ai.holdItemMax)
            * hurryFactor(cfg, getAggression(cfg, state, kart));
        return;
    }

    const itemId = state.nextItemId++;
    // Decalage visuel derive cote client.
    kart.heldItem = {
        id: itemId,
        type: itemType,
        holdPosition: holdPosition
    };

    planItemUse(cfg, rng, state, now, kart, itemType);

    events.push({ type: 'spawnHeldItem', kartId: kart.id, itemId: itemId, itemType: itemType, holdPosition: holdPosition });
}

function rankChance(table, state, kart) {
    if (kart.rank === 1) return table.leader;
    if (kart.rank >= state.karts.length) return table.last;
    return table.pack;
}

// Note d'un candidat pour la rouge, en distance equivalente (la plus basse
// gagne) : au-dela de `redShellComfortTarget` l'ecart brut, en dessous une
// penalite croissante. Infinity si inatteignable (y compris derriere).
function redShellTargetScore(cfg, dist) {
    const floor = cfg.speeds.redShellMinTarget;
    if (dist < floor) return Infinity;

    const comfort = cfg.speeds.redShellComfortTarget;
    if (dist >= comfort) return dist;

    // Penalite au carre : negligeable au bord du confort.
    const shortfall = (comfort - dist) / (comfort - floor);
    return dist + cfg.speeds.redShellClosePenalty * shortfall * shortfall;
}

// Meilleur candidat devant, ou null si tous sont sous le plancher d'armement.
function findRedShellTarget(cfg, state, kart) {
    let best = null;
    let bestScore = Infinity;

    for (let i = 0; i < state.karts.length; i++) {
        const other = state.karts[i];
        if (other.id === kart.id) continue;
        if (other.state !== 'running' && other.state !== 'hit') continue;

        const dist = getShortestDistance(cfg, other.worldX, kart.worldX);
        const score = redShellTargetScore(cfg, dist);
        if (score < bestScore) {
            bestScore = score;
            best = other;
        }
    }

    return best;
}

// Sens de tir effectif : le premier ne tire jamais devant lui, et un kart double
// depuis le plan ne tire plus derriere.
function getShotDirection(state, kart) {
    if (kart.rank === 1) return -1;
    if (kart.shotAsLeader) return 1;
    return kart.shotDirection;
}

function rollShellDirection(cfg, rng, state, kart, itemType) {
    const chances = cfg.ai.shellBackwardChance[itemType];
    if (!chances) return 1;

    return rng() < rankChance(chances, state, kart) ? -1 : 1;
}

// Met un objet en jeu depuis un kart (activation et largage d'orbite).
function spawnLaunchedItem(cfg, state, rng, now, kart, itemType, itemId, startX, startY, events, direction) {
    const dir = direction === -1 ? -1 : 1;
    let vx = 0;
    let vy = 0;
    let targetKartId = null;

    if (itemType === 'greenShell') {
        vx = cfg.speeds.projectileSpeed * dir;
        vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
    } else if (itemType === 'redShell') {
        vx = cfg.speeds.redShellSpeed * dir;
        // Tete chercheuse vers l'avant seulement.
        const target = dir > 0 ? findRedShellTarget(cfg, state, kart) : null;
        if (target) {
            targetKartId = target.id;
        } else {
            vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
        }
    }

    pushGroundItem(cfg, state, now, kart, itemType, itemId, startX, startY, vx, vy, targetKartId);
    events.push({ type: 'launchItem', kartId: kart.id, itemId: itemId });
}

// Objet en piste, avec les memes champs qu'il soit lance ou pose.
function pushGroundItem(cfg, state, now, kart, itemType, itemId, startX, startY, vx, vy, targetKartId) {
    let worldX = startX;
    if (worldX < 0) worldX += cfg.world.width;
    if (worldX >= cfg.world.width) worldX -= cfg.world.width;

    const item = {
        id: itemId,
        type: itemType,
        worldX: worldX,
        y: startY,
        vx: vx,
        vy: vy,
        shooterId: kart.id,
        targetKartId: targetKartId,
        createdAt: now,
        currentFrame: 1,
        lastAnimTime: 0,
        isDead: false,

        // Profondeur au pas precedent (impacts testes sur le segment).
        prevY: startY,
        // Rebonds encaisses ; au-dela de `pipe.maxShellBounces`, destruction.
        bounces: 0,
        // Une verte renvoyee par un tuyau peut toucher son lanceur.
        pipeBounced: false,

        // Vol en cloche : `hop` en px de rendu ; pas de hitbox pendant la montee.
        flightUntil: 0,
        flightFrom: 0,
        flightTo: 0,
        hop: 0,
        rising: false,

        // Ne touche son lanceur qu'une fois eloigne.
        armed: false,
        spent: false,
        deadAt: 0,

        // Objet pose (depositHeldItem) : immobile.
        resting: false
    };
    state.items.push(item);
    return item;
}

// Depose l'objet traine a sa place (meme emprise, meme id pour le client).
// Une carapace deposee devient un piege immobile.
function depositHeldItem(cfg, state, now, kart, events) {
    const held = kart.heldItem;
    const item = pushGroundItem(cfg, state, now, kart, held.type, held.id,
                                kart.worldX + cfg.offsets.world.heldItemBehind,
                                kart.yPercent, 0, 0, null);
    item.resting = true;

    // Ni `launchItem` (pas un tir) ni `removeHeldItem` (pas disparu).
    events.push({ type: 'dropItem', kartId: kart.id, itemId: held.id });
    kart.heldItem = null;
    kart.trailTime = 0;
}

function activateItem(cfg, state, rng, now, kart, events) {
    const held = kart.heldItem;
    if (!held) return;

    // Un seul orbe largue par activation.
    if (held.holdPosition === 'orbit') {
        const orb = held.orbs[0];
        const child = held.childType;
        const pos = getOrbitItemPosition(cfg, kart, orb, held.orbitAngle);
        removeOrbitItem(kart, 0);

        let startX, startY;
        let dir = 1;
        if (child === 'banana') {
            // Piege lache depuis la position d'orbite, ramene dans la piste.
            startX = pos.worldX;
            startY = Math.min(Math.max(pos.y, cfg.road.minY), cfg.road.maxY);
        } else {
            // Carapace tiree vers l'avant, comme depuis la main.
            dir = getShotDirection(state, kart);
            startX = kart.worldX + (dir > 0 ? cfg.offsets.world.shellSpawn
                                            : cfg.offsets.world.heldItemBehind);
            startY = kart.yPercent;
        }

        // Meme id : l'element DOM est reutilise.
        spawnLaunchedItem(cfg, state, rng, now, kart, child, orb.id, startX, startY, events, dir);

        if (kart.heldItem) {
            kart.throwTime = now + randomRange(rng, cfg.orbit.dropIntervalMin, cfg.orbit.dropIntervalMax)
                * hurryFactor(cfg, getAggression(cfg, state, kart));
        }
        return;
    }

    // L'eclair declenche un orage (frappe a `strikeAt`).
    if (held.type === 'lightning') {
        const spec = cfg.lightning;

        state.storm = {
            shooterId: kart.id,
            startedAt: now,
            strikeAt: now + spec.strikeAt,
            until: now + spec.totalMs,
            struck: false
        };

        events.push({ type: 'lightningCast', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    // Le bill : le kart devient le projectile (etat avec date de fin).
    if (held.type === 'bill') {
        const spec = cfg.bill;

        kart.isBill = true;
        kart.billStartedAt = now;
        kart.billEndTime = now + spec.durationMs;
        kart.billSlowUntil = 0;
        // Fin du rapetissement.
        kart.shrinkEndTime = 0;
        // Karts devant au declenchement : chacun rattrape raccourcit le vol.
        kart.billAhead = [];
        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id !== kart.id && other.totalDistance > kart.totalDistance) {
                kart.billAhead.push(other.id);
            }
        }

        // Fin du rapetissement.
        kart.shrinkEndTime = 0;
        kart.absoluteVelocity = getBillSpeed(cfg, state, kart);

        events.push({ type: 'billOn', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    if (held.type === 'shroom') {
        // La vitesse monte depuis l'allure actuelle.
        kart.boostEndTime = now + cfg.speeds.boosts.shroom.durationMs;
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    if (held.type === 'star') {
        kart.starEndTime = now + cfg.speeds.boosts.star.durationMs;
        kart.isInvincible = true;
        // L'etoile annule le rapetissement.
        kart.shrinkEndTime = 0;
        events.push({ type: 'starOn', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    // La bleue part droit devant, au-dessus de la piste, vers le premier.
    if (held.type === 'blueShell') {
        const spec = cfg.blueShell;

        state.items.push({
            id: held.id,
            type: 'blueShell',
            worldX: kart.worldX,
            y: (cfg.road.minY + cfg.road.maxY) / 2,
            vx: spec.speed,
            vy: 0,
            shooterId: kart.id,
            targetKartId: null,
            createdAt: now,
            currentFrame: 1,
            lastAnimTime: 0,
            isDead: false,
            flightUntil: 0,
            flightFrom: 0,
            flightTo: 0,
            hop: spec.cruiseHop,
            armed: true,
            phase: 'cruise',
            phaseUntil: 0
        });

        events.push({ type: 'launchItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    let direction = 1;
    let startX = kart.worldX + cfg.offsets.world.heldItemBehind;

    let lobbed = false;

    if (held.type === 'greenShell' || held.type === 'redShell') {
        direction = getShotDirection(state, kart);
        startX = kart.worldX + (direction > 0 ? cfg.offsets.world.shellSpawn
                                              : cfg.offsets.world.heldItemBehind);
    } else if (held.type === 'banana' && kart.lobbing && kart.rank !== 1) {
        lobbed = true;
        startX = kart.worldX + cfg.offsets.world.shellSpawn;
    }

    spawnLaunchedItem(cfg, state, rng, now, kart, held.type, held.id, startX, kart.yPercent, events, direction);

    if (lobbed) {
        const item = state.items[state.items.length - 1];
        item.flightFrom = item.worldX;
        item.flightTo = item.worldX + cfg.speeds.bananaLobDistance;
        item.flightUntil = now + cfg.speeds.bananaLobDurationMs;
        // Pas de hitbox pendant la montee.
        item.rising = true;
        // Pour l'IA seulement (le deplacement vient du vol).
        item.vx = cfg.speeds.bananaLobDistance / (cfg.speeds.bananaLobDurationMs / 1000);
    }
    kart.heldItem = null;
    kart.trailTime = 0;
}

// Orbites de tous les karts, y compris en 'hit' (collisions suspendues tant
// que le porteur ne roule pas).
function updateOrbitItems(cfg, state, now, deltaTime, events) {
    const TWO_PI = Math.PI * 2;
    const kartsLen = state.karts.length;

    for (let i = 0; i < kartsLen; i++) {
        const kart = state.karts[i];
        const held = kart.heldItem;
        if (!held || held.holdPosition !== 'orbit') continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;

        held.orbitAngle += cfg.orbit.orbitSpeed * deltaTime;
        if (held.orbitAngle >= TWO_PI) held.orbitAngle -= TWO_PI;

        if (kart.state !== 'running') continue;

        // Tous les orbes sont testes, y compris derriere le sprite ; parcours a
        // rebours a cause du splice.
        for (let b = held.orbs.length - 1; b >= 0; b--) {
            const orb = held.orbs[b];
            const pos = getOrbitItemPosition(cfg, kart, orb, held.orbitAngle);
            let consumed = false;

            for (let j = 0; j < kartsLen; j++) {
                const victim = state.karts[j];
                if (victim.id === kart.id || victim.state !== 'running') continue;
                if (victim.hitInvincibleUntil > now) continue;

                const dx = Math.abs(getShortestDistance(cfg, pos.worldX, victim.worldX));
                const dy = Math.abs(pos.y - victim.yPercent);
                const orbit = cfg.hitboxes.orbitItemVsKart;
                if (dx >= shrunkReachX(cfg, orbit, victim, now)
                    || dy >= shrunkReachY(cfg, orbit, victim, now)) continue;

                // Etoile ou bill : pas de tete-a-queue, mais l'orbe est consomme.
                if (!isRamming(victim)) spinOutKart(cfg, now, victim, events, held.childType);
                consumed = true;
                break;
            }

            if (consumed) {
                destroyOrbitItem(kart, b, events);
                if (!kart.heldItem) break;
            }
        }
    }
}

// Profondeur visee par un bill : milieu de la piste, ou le degagement le plus
// proche si un tuyau bouche sa voie.
function billAimDepth(cfg, state, kart) {
    const mid = (cfg.road.minY + cfg.road.maxY) / 2;
    const pipes = state.pipes;
    if (!pipes.length) return mid;

    const clear = cfg.hitboxes.kartVsPipe.y + cfg.bill.pipeClearance;

    let blocking = null;
    let bestDist = Infinity;

    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const dist = getShortestDistance(cfg, pipe.worldX, kart.worldX);
        if (dist <= 0 || dist > cfg.pipe.seeDistance) continue;
        if (Math.abs(pipe.y - mid) >= clear) continue;
        if (dist < bestDist) {
            bestDist = dist;
            blocking = pipe;
        }
    }

    if (!blocking) return mid;

    const above = blocking.y + clear;
    const below = blocking.y - clear;
    const canAbove = above <= cfg.road.maxY;
    const canBelow = below >= cfg.road.minY;

    if (canAbove && canBelow) {
        return Math.abs(above - kart.yPercent) <= Math.abs(below - kart.yPercent) ? above : below;
    }
    if (canAbove) return above;
    if (canBelow) return below;

    // Aucun cote ne tient (exclu au chargement) : il traverse.
    return mid;
}

export {
    activateItem,
    billAimDepth,
    destroyOrbitItem,
    getAggression,
    getHoldPosition,
    getOrbitItemPosition,
    getShotDirection,
    giveKartItem,
    heldThreatType,
    isAiming,
    isArmedForward,
    isTrailable,
    rankChance,
    redShellTargetScore,
    depositHeldItem,
    removeOrbitItem,
    spawnLaunchedItem,
    updateOrbitItems,
};
