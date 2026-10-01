// Bord de piste et contact entre karts.

import { clamp } from './math.js';
import { getShortestDistance } from './geometry.js';
import { contactInertia, isContactActive, isRamming, isShrunkAt, kartHalfExtents } from './bodies.js';
import { crushKart, spinOutKart } from './effects.js';
import { collideKartWithPipes } from './pipes.js';

// Bord de piste : mur glissant pour les karts (position ramenee au bord, seule
// la composante sortante est annulee). Y rester ralentit vers
// `topSpeed * speedFactor`.
function clampKartToRoad(cfg, kart, deltaTime) {
    const road = cfg.road;
    let atWall = false;

    if (kart.yPercent >= road.maxY) {
        kart.yPercent = road.maxY;
        if (kart.vy > 0) kart.vy = 0;
        if (kart.bumpVy > 0) kart.bumpVy = 0;
        atWall = true;
    } else if (kart.yPercent <= road.minY) {
        kart.yPercent = road.minY;
        if (kart.vy < 0) kart.vy = 0;
        if (kart.bumpVy < 0) kart.bumpVy = 0;
        atWall = true;
    }

    if (!atWall) return;

    // Taux en 1/s, borne a 1.
    const wall = cfg.physics.wall;
    const floor = kart.stats.topSpeed * wall.speedFactor;
    if (kart.absoluteVelocity > floor) {
        const k = wall.grip * deltaTime;
        kart.absoluteVelocity += (floor - kart.absoluteVelocity) * (k > 1 ? 1 : k);
    }
}

// Profondeur restante avant le bord (un kart plaque cede sa part de separation).
function roomToward(cfg, kart, n) {
    return n > 0 ? cfg.road.maxY - kart.yPercent : kart.yPercent - cfg.road.minY;
}

// Deplace un kart le long de la piste (position, progression et tours).
function shiftKartAlongTrack(cfg, kart, dist) {
    if (!dist) return;
    const prevWorldX = kart.worldX;
    kart.totalDistance += dist;
    kart.worldX += dist;
    if (kart.worldX >= cfg.world.width) kart.worldX -= cfg.world.width;
    if (kart.worldX < 0) kart.worldX += cfg.world.width;

    const finishX = cfg.world.finishLineX;
    if (dist >= 0) {
        if (prevWorldX < finishX && kart.worldX >= finishX) {
            kart.lapCount++;
            kart.hasPassedFinishLine = true;
        }
    } else if (prevWorldX >= finishX && kart.worldX < finishX) {
        kart.lapCount--;
    }
}

// Un intouchable fait toupiller ce qu'il percute (sans relancer un tete-a-queue
// en cours ni ignorer le sursis). Cout : bill, sinon etoile.
function spinOnContact(cfg, now, kart, rammer, events) {
    if (kart.state !== 'running') return;
    if (kart.hitInvincibleUntil > now) return;
    spinOutKart(cfg, now, kart, events, rammer.isBill ? 'bill' : 'star');
}

// Resolution d'une paire ; `withImpulse` seulement a la premiere passe.
function resolveKartPair(cfg, now, deltaTime, a, b, withImpulse, events) {
    const c = cfg.physics.contact;

    let boxX, boxY;
    if (a.isBill || b.isBill) {
        // Le bill balaie plus large qu'une carrosserie.
        boxX = cfg.bill.hitbox.x;
        boxY = cfg.bill.hitbox.y;
    } else {
        const halfA = kartHalfExtents(cfg, a, now);
        const halfB = kartHalfExtents(cfg, b, now);
        boxX = halfA.x + halfB.x;
        boxY = halfA.y + halfB.y;
    }

    // dx > 0 : `a` devant `b` ; dy > 0 : `a` plus profond.
    const dx = getShortestDistance(cfg, a.worldX, b.worldX);
    const penX = boxX - Math.abs(dx);
    if (penX <= 0) return;
    const dy = a.yPercent - b.yPercent;
    const penY = boxY - Math.abs(dy);
    if (penY <= 0) return;

    // Un intouchable (etoile ou bill) ne subit pas le choc ; deux etoiles se
    // traversent, mais un bill reste en contact (partage tres inegal,
    // `billMassFactor`).
    const ramA = isRamming(a);
    const ramB = isRamming(b);

    // Un seul intouchable : sa victime toupille.
    if (ramA !== ramB) spinOnContact(cfg, now, ramA ? b : a, ramA ? a : b, events);

    const ramContact = ramA && ramB && (a.isBill || b.isBill);
    if ((ramA || ramB) && !ramContact) return;

    // Ecrasement : un kart rapetisse passe sous un kart normal, sans aucun
    // echange (une etoile le blesse au lieu de l'ecraser).
    const crushA = isShrunkAt(a, now) && !isShrunkAt(b, now) && !isRamming(b);
    const crushB = isShrunkAt(b, now) && !isShrunkAt(a, now) && !isRamming(a);
    if (crushA || crushB) {
        crushKart(cfg, now, crushA ? a : b, events);
        return;
    }

    // Bousculade attenuee entre intouchables.
    const scale = ramContact ? cfg.bill.pushFactor : 1;

    const iA = contactInertia(cfg, a);
    const iB = contactInertia(cfg, b);
    const total = iA + iB;
    // Part du choc de chacun, fixee par l'inertie d'en face (ejection, refus de
    // braquage et separation).
    const shareA = iB / total;
    const shareB = iA / total;

    // Fraction du chevauchement resorbee sur ce pas, bornee a 1.
    const k = c.separationRate * deltaTime;
    const sep = k > 1 ? 1 : k;

    // Normale du choc en espace normalise (chaque axe divise par sa boite).
    let ux = dx / boxX;
    let uy = dy / boxY;
    let len = Math.sqrt(ux * ux + uy * uy);
    if (len < 1e-6) {
        // Superposition parfaite : departage par identifiant.
        ux = 0;
        uy = a.id < b.id ? 1 : -1;
        len = 1;
    }
    // Unitaire, de `b` vers `a`.
    const nx = ux / len;
    const ny = uy / len;

    if (withImpulse) {
        // Vitesse de rapprochement par axe.
        const sgnX = nx >= 0 ? 1 : -1;
        const sgnY = ny >= 0 ? 1 : -1;
        const closeX = (b.contactSpeed - a.contactSpeed) * sgnX;
        const closeY = ((b.vy + b.bumpVy) - (a.vy + a.bumpVy)) * sgnY;

        // Rapprochement le long de la normale, en boites par seconde.
        const approach = (closeX / boxX) * Math.abs(nx)
                       + (closeY / boxY) * Math.abs(ny);

        // Impulsion seulement s'ils se rapprochent encore.
        if (approach > 0) {
            let force = c.ejectBase + approach * c.restitution;
            if (force > c.maxEject) force = c.maxEject;
            force *= scale;

            // Coup reparti sur les deux axes par la normale.
            const jx = force * nx * c.ejectX;
            const jy = force * ny * c.ejectY;
            a.bumpVx = clamp(a.bumpVx + jx * shareA, -c.maxBumpX, c.maxBumpX);
            a.bumpVy = clamp(a.bumpVy + jy * shareA, -c.maxBumpY, c.maxBumpY);
            b.bumpVx = clamp(b.bumpVx - jx * shareB, -c.maxBumpX, c.maxBumpX);
            b.bumpVy = clamp(b.bumpVy - jy * shareB, -c.maxBumpY, c.maxBumpY);
        }

        // Refus de braquage a chaque tick du contact, en proportion de la masse
        // d'en face, dose par `ny`.
        const denyReach = Math.abs(ny) * scale;
        const intoA = -a.vy * sgnY;
        if (intoA > 0) a.vy += intoA * c.steerDeny * shareA * denyReach * sgnY;
        const intoB = b.vy * sgnY;
        if (intoB > 0) b.vy -= intoB * c.steerDeny * shareB * denyReach * sgnY;
    }

    // Separation : empeche les carrosseries de rester imbriquees.
    const corrX = Math.max(penX - c.slopX, 0) * sep * Math.abs(nx);
    const corrY = Math.max(penY - c.slopY, 0) * sep * Math.abs(ny);

    // Contre le bord, un kart sans place rend sa part a l'autre.
    const dirY = ny >= 0 ? 1 : -1;
    let corrAy = corrY * shareA;
    let corrBy = corrY * shareB;
    const roomA = Math.max(0, roomToward(cfg, a, dirY));
    const roomB = Math.max(0, roomToward(cfg, b, -dirY));
    if (corrAy > roomA) { corrBy += corrAy - roomA; corrAy = roomA; }
    if (corrBy > roomB) { corrAy = Math.min(corrAy + (corrBy - roomB), roomA); corrBy = roomB; }
    a.yPercent += corrAy * dirY;
    b.yPercent -= corrBy * dirY;

    const dirX = nx >= 0 ? 1 : -1;
    shiftKartAlongTrack(cfg, a, corrX * shareA * dirX);
    shiftKartAlongTrack(cfg, b, -corrX * shareB * dirX);
}

// Passe complete : plusieurs relaxations sur toutes les paires, puis remise au
// bord et contre les tuyaux.
function resolveKartContacts(cfg, state, now, deltaTime, events) {
    const c = cfg.physics.contact;
    const kartsLen = state.karts.length;

    for (let pass = 0; pass < c.iterations; pass++) {
        const withImpulse = pass === 0;
        for (let i = 0; i < kartsLen; i++) {
            const a = state.karts[i];
            if (!isContactActive(a)) continue;
            for (let j = i + 1; j < kartsLen; j++) {
                const b = state.karts[j];
                if (!isContactActive(b)) continue;
                resolveKartPair(cfg, now, deltaTime, a, b, withImpulse, events);
            }
        }
    }

    for (let i = 0; i < kartsLen; i++) {
        const kart = state.karts[i];
        if (!isContactActive(kart)) continue;

        // Frottement du bord apres la passe de contacts.
        clampKartToRoad(cfg, kart, deltaTime);

        // Le sursis par tuyau rend ce second passage sans danger.
        collideKartWithPipes(cfg, state, kart, now, events);
    }
}

export {
    clampKartToRoad,
    resolveKartContacts,
};
