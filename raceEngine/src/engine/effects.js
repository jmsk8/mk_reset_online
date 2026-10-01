// Effets subis par un kart : eclair, etoile, bill, ecrasement, souffle de la bleue.

import { getShortestDistance } from './geometry.js';
import { isRamming } from './bodies.js';
import { getDistanceToLeader, getRacingLeader } from './standings.js';
// Import circulaire sans danger (appels en cours de course uniquement).
import { depositHeldItem } from './weapons.js';

// Le kart perd son objet tenu (un evenement par orbe pour le client).
function loseHeldItem(kart, events) {
    const held = kart.heldItem;
    if (!held) return;

    if (held.holdPosition === 'orbit') {
        for (let i = 0; i < held.orbs.length; i++) {
            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.orbs[i].id });
        }
    } else {
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
    }

    kart.heldItem = null;
    kart.trailTime = 0;
}

// Duree du rapetissement : maximale pour le premier, minimale pour le dernier.
// Distance et rang sont melanges par `rankWeight` ; les bornes restent
// shrinkMsMax et shrinkMsMin.
function shrinkDuration(cfg, state, kart) {
    const spec = cfg.lightning;

    const dist = Math.min(getDistanceToLeader(state, kart), spec.shrinkFalloffDistance);
    const distRatio = spec.shrinkFalloffDistance > 0 ? dist / spec.shrinkFalloffDistance : 0;

    // Rapporte au nombre de places (une course a un kart retombe sur la distance).
    const places = state.rankedCount - 1;
    const rankRatio = places > 0 ? (kart.rank - 1) / places : 0;

    const w = spec.shrinkRankWeight;
    const mix = distRatio * (1 - w) + rankRatio * w;

    return spec.shrinkMsMax + (spec.shrinkMsMin - spec.shrinkMsMax) * mix;
}

// La foudre detruit l'objet en main et l'orbite ; un objet traine est lache.
function dropOrLoseHeldItem(cfg, state, now, kart, events) {
    const held = kart.heldItem;
    if (held && held.holdPosition === 'behind') depositHeldItem(cfg, state, now, kart, events);
    else loseHeldItem(kart, events);
}

// La foudre frappe toute la piste : tete-a-queue, rapetissement, vitesse
// divisee et mains vides.
function strikeAll(cfg, state, now, events) {
    const storm = state.storm;

    for (let i = 0; i < state.karts.length; i++) {
        const kart = state.karts[i];
        if (kart.id === storm.shooterId) continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;
        if (kart.finished) continue;
        // Etoile et bill protegent totalement.
        if (isRamming(kart)) continue;

        kart.shrinkEndTime = now + shrinkDuration(cfg, state, kart);
        // Pose immediatement : les karts partent en tete-a-queue juste apres.
        kart.isShrunk = true;

        // Le champignon en cours est annule.
        kart.boostEndTime = 0;

        // Avant le tete-a-queue, qui reprogrammerait un tir.
        dropOrLoseHeldItem(cfg, state, now, kart, events);

        // Un kart deja en toupie n'en prend pas une seconde.
        if (kart.state === 'running') spinOutKart(cfg, now, kart, events, 'lightning');

        events.push({ type: 'lightningHit', kartId: kart.id });
    }
}

// L'orage fait partie de l'etat (visible par un arrivant).
function updateStorm(cfg, state, now, events) {
    const storm = state.storm;
    if (!storm) return;

    if (!storm.struck && now >= storm.strikeAt) {
        storm.struck = true;
        strikeAll(cfg, state, now, events);
    }

    if (now >= storm.until) state.storm = null;
}

// Vol du bill : compte les karts doubles et rend la main a la fin.
function updateBill(cfg, state, now, kart, events) {
    if (!kart.isBill) return;
    const spec = cfg.bill;

    // Parcours a l'envers (retrait pendant la lecture).
    for (let i = kart.billAhead.length - 1; i >= 0; i--) {
        const other = state.kartsById[kart.billAhead[i]];
        if (!other || kart.totalDistance > other.totalDistance) {
            kart.billAhead.splice(i, 1);
            // Plancher compte depuis le depart du vol.
            kart.billEndTime = Math.max(
                kart.billStartedAt + spec.minDurationMs,
                kart.billEndTime - spec.overtakeCostMs
            );
        }
    }

    if (now >= kart.billEndTime) {
        kart.isBill = false;
        kart.billAhead.length = 0;
        // Fin du vol : il finit sur son elan.
        kart.billSlowUntil = now + spec.slowdownMs;
        events.push({ type: 'billOff', kartId: kart.id });
    }
}

// Ecrasement : le kart rapetisse est aplati, sans impulsion ni tete-a-queue,
// pendant `lightning.flatMs` ecrete a la fin du rapetissement, avec un plancher
// `crushHoldMs`. L'evenement ne part qu'au premier contact.
function crushKart(cfg, now, kart, events) {
    const spec = cfg.lightning;
    const wasFlat = now < kart.flatEndTime;

    const planned = Math.min(now + spec.flatMs, kart.shrinkEndTime);
    const floor = now + spec.crushHoldMs;

    kart.flatEndTime = (planned > floor) ? planned : floor;

    // Pas de retour a la taille normale pendant qu'il est plat.
    if (kart.shrinkEndTime < kart.flatEndTime) {
        kart.shrinkEndTime = kart.flatEndTime;
    }

    if (!wasFlat) events.push({ type: 'kartCrushed', kartId: kart.id });
}

// Cout d'un coup selon sa source (`hits[source]`) : duree et vitesse gardee.
function hitSpec(cfg, source) {
    const spec = cfg.hits[source];
    if (!spec) throw new Error(`hits : aucune entree pour la source « ${source} »`);
    // Champ manquant : erreur explicite plutot que NaN.
    for (const field of ['spinMs', 'keep', 'invincibleMs']) {
        if (typeof spec[field] !== 'number' || !(spec[field] >= 0)) {
            throw new Error(`hits.${source}.${field} vaut ${spec[field]}`);
        }
    }
    return spec;
}

// Tete-a-queue, sans condition (l'appelant decide qui l'encaisse) ; passage
// oblige de tous les coups.
function spinOutKart(cfg, now, kart, events, source) {
    const spec = hitSpec(cfg, source);
    const speed = Math.min(Math.max(kart.absoluteVelocity, 0), kart.stats.topSpeed);

    kart.state = 'hit';
    kart.hitDuration = spec.spinMs;
    kart.hitEndTime = now + spec.spinMs;
    kart.hitKeepSpeed = speed * spec.keep;
    kart.hitInvincibleMs = spec.invincibleMs;
    events.push({ type: 'kartHit', kartId: kart.id, source: source });
    if (kart.heldItem) kart.throwTime = kart.hitEndTime + cfg.delays.throwDelayAfterHit;
}

// Etoile et champignon sont les deux seules sorties.
function blastKart(cfg, state, now, kart, events) {
    if (kart.state !== 'running') return;
    if (isRamming(kart)) return;
    if (kart.boostEndTime > now) return;

    spinOutKart(cfg, now, kart, events, 'blueShell');
}

// Un kart n'est touche qu'une fois, quand le front l'atteint.
function updateBlueBlast(cfg, state, now, item, events) {
    const spec = cfg.blueShell;
    const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.blastMs);
    // Le front touche la carrosserie, pas seulement le centre.
    const body = cfg.hitboxes.itemVsKart;
    const reachX = spec.blastRadiusX * progress + body.x;
    const reachY = spec.blastRadiusY * progress + body.y;

    for (let k = 0; k < state.karts.length; k++) {
        const kart = state.karts[k];
        const dx = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
        const dy = Math.abs(kart.yPercent - item.y);
        if (dx > reachX || dy > reachY) continue;

        blastKart(cfg, state, now, kart, events);
    }

    if (progress >= 1) item.isDead = true;
}

// Le souffle est une entite de l'etat (visible par un arrivant).
function spawnBlueBlast(cfg, state, now, source, events) {
    const spec = cfg.blueShell;

    // Cible touchee a l'impact ; le front n'emporte que les voisins.
    const target = source.targetKartId === null ? null : state.kartsById[source.targetKartId];
    if (target) blastKart(cfg, state, now, target, events);

    state.items.push({
        id: state.nextItemId++,
        type: 'blueBlast',
        worldX: source.worldX,
        y: source.y,
        vx: 0,
        vy: 0,
        shooterId: source.shooterId,
        targetKartId: null,
        createdAt: now,
        currentFrame: 1,
        lastAnimTime: 0,
        isDead: false,
        flightUntil: 0,
        flightFrom: 0,
        flightTo: 0,
        hop: 0,
        armed: true,
        spent: false,
        deadAt: 0,
        phase: 'blast',
        phaseUntil: now + spec.blastMs
    });
}

// La bleue part tout droit et se verrouille a l'approche du premier.
function updateBlueShell(cfg, state, now, item, deltaTime, events) {
    const spec = cfg.blueShell;
    const target = item.targetKartId === null ? null : state.kartsById[item.targetKartId];

    if (item.phase === 'cruise') {
        item.worldX += spec.speed * deltaTime;
        item.hop = spec.cruiseHop;

        if (!target) {
            const leader = getRacingLeader(state);
            const expired = now - item.createdAt > spec.maxCruiseMs;

            if (!leader) {
                if (expired) {
                    spawnBlueBlast(cfg, state, now, item, events);
                    item.isDead = true;
                    return;
                }
            } else {
                const gap = getShortestDistance(cfg, leader.worldX, item.worldX);
                if ((gap > 0 && gap < spec.lockDistance) || expired) {
                    item.targetKartId = leader.id;
                }
            }
        } else {
            const gap = getShortestDistance(cfg, target.worldX, item.worldX);
            if (gap < spec.catchDistance && gap > -spec.catchDistance) {
                item.phase = 'orbit';
                item.phaseUntil = now + spec.orbitMs;
            }
        }

        if (item.worldX < 0) item.worldX += cfg.world.width;
        if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
        return;
    }

    // Cible disparue : elle explose sur sa derniere position connue.
    if (!target || (target.state !== 'running' && target.state !== 'hit')) {
        spawnBlueBlast(cfg, state, now, item, events);
        item.isDead = true;
        return;
    }

    if (item.phase === 'orbit') {
        const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.orbitMs);
        const angle = progress * spec.orbitTurns * 2 * Math.PI;

        item.worldX = target.worldX + Math.cos(angle) * spec.orbitRadiusX;
        item.y = target.yPercent + Math.sin(angle) * spec.orbitRadiusY;
        item.hop = spec.orbitHop;

        if (progress >= 1) {
            item.phase = 'hover';
            item.phaseUntil = now + spec.hoverMs;
        }
    } else if (item.phase === 'hover') {
        item.worldX = target.worldX + spec.hoverLead;
        item.y = target.yPercent;
        item.hop = spec.orbitHop;

        if (now >= item.phaseUntil) {
            item.phase = 'crash';
            item.phaseUntil = now + spec.crashMs;
        }
    } else if (item.phase === 'crash') {
        const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.crashMs);
        // Elle avance encore pendant sa chute.
        item.worldX = target.worldX + spec.hoverLead + (spec.crashLead - spec.hoverLead) * progress;
        item.y = target.yPercent;
        // Chute acceleree.
        item.hop = spec.orbitHop * (1 - progress * progress);

        if (progress >= 1) {
            spawnBlueBlast(cfg, state, now, item, events);
            item.isDead = true;
            return;
        }
    }

    if (item.worldX < 0) item.worldX += cfg.world.width;
    if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
}

export {
    crushKart,
    spinOutKart,
    updateBill,
    updateBlueBlast,
    updateBlueShell,
    updateStorm,
};
