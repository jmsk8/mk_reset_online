// Un pas de simulation : appelle dans l'ordre ce que les autres modules font.

import { randomRange } from './math.js';
import { crossedDepth, getShortestDistance } from './geometry.js';
import { steerCost } from './steering.js';
import { isRamming, shrunkReachX, shrunkReachY } from './bodies.js';
import { getActiveBoost, getBillSpeed, getMomentumSpeed, getNewMomentumTarget } from './stats.js';
import { updateLeaderboard } from './standings.js';
import { updateCamera } from './camera.js';
import { spendItem } from './items.js';
import { spinOutKart, updateBill, updateBlueBlast, updateBlueShell, updateStorm } from './effects.js';
import { activateItem, destroyOrbitItem, getOrbitItemPosition, giveKartItem, redShellTargetScore, updateOrbitItems } from './weapons.js';
import { advanceProjectile, collideKartWithPipes, redShellAimY } from './pipes.js';
import { clampKartToRoad, resolveKartContacts } from './road.js';
import { updateRace } from './race.js';
import { updateAI } from './ai.js';

function stepPhysics(cfg, state, rng, now, deltaTime) {
    const events = [];

    updateRace(cfg, state, rng, now, deltaTime, events);
    updateStorm(cfg, state, now, events);
    updateCamera(cfg, state, deltaTime);

    if (state.sign && now > state.sign.until) state.sign = null;

    const boxesLen = state.itemBoxes.length;
    for (let i = 0; i < boxesLen; i++) {
        const box = state.itemBoxes[i];
        if (!box.active && now > box.reactivateTime) {
            box.active = true;
        }

        const kartsLen0 = state.karts.length;
        for (let k = 0; k < kartsLen0; k++) {
            const kart = state.karts[k];
            if (kart.state !== 'running' && kart.state !== 'hit') continue;
            if (kart.finished) continue;

            const dist = getShortestDistance(cfg, box.worldX, kart.worldX);
            const dy = Math.abs(box.y - kart.yPercent);
            if (Math.abs(dist) >= cfg.hitboxes.itemBox.x) continue;
            if (dy >= cfg.hitboxes.itemBox.y) continue;

            // Passage date sans condition, qu'il reste un cube ou non.
            kart.boxPassedAt = now;

            if (!box.active) continue;

            box.active = false;
            box.reactivateTime = now + cfg.delays.boxRespawn;
            if (!kart.heldItem) {
                kart.pendingItemGrantTime = now + cfg.delays.itemGrant;
            }
        }
    }

    const kartsLen = state.karts.length;

    for (let i = 0; i < kartsLen; i++) {
        const kart = state.karts[i];

        if (kart.state === 'grid') continue;

        // Drapeau du snapshot (pose hors de la branche 'running').
        kart.bumped = now < kart.bumpEndTime;

        kart.isFlat = now < kart.flatEndTime;

        // Gain d'appui des objets de vitesse, pose une fois par tick pour
        // `steerCap`.
        kart.steerBoost = (now < kart.boostEndTime || now < kart.starEndTime)
            ? cfg.physics.steer.boostGain : 1;

        // Amortissement des deux canaux de choc (aussi en toupie).
        const bumpDecay = cfg.physics.contact.decay * deltaTime;
        const bumpKeep = bumpDecay > 1 ? 0 : 1 - bumpDecay;
        kart.bumpVy *= bumpKeep;
        kart.bumpVx *= bumpKeep;

        if (kart.state === 'running') {
            // Depart rate : moteur noye.
            if (kart.startStallUntil > now) continue;

            // Un kart arrive ne ramasse plus rien.
            if (!kart.finished && kart.pendingItemGrantTime && now > kart.pendingItemGrantTime) {
                giveKartItem(cfg, state, rng, now, kart, events);
                kart.pendingItemGrantTime = 0;
            }

            updateAI(cfg, state, rng, now, kart, deltaTime);
            updateBill(cfg, state, now, kart, events);

            // Sous objet (bill compris), la vitesse vise la pointe de l'objet ;
            // sinon elle suit l'elan du kart.
            const boost = getActiveBoost(cfg, state, kart, now);

            if (boost) {
                // Montee sous objet ; redescente immediate si la pointe baisse.
                const rampRate = cfg.speeds.accelerationRate * kart.stats.acceleration * boost.ramp;
                if (kart.absoluteVelocity < boost.peak) {
                    kart.absoluteVelocity = Math.min(boost.peak,
                        kart.absoluteVelocity + rampRate * deltaTime);
                } else {
                    kart.absoluteVelocity = boost.peak;
                }

                // L'elan est mis de cote (avec son compte a rebours) au premier
                // tick sous objet, pour toute la chaine d'objets.
                if (kart.preBoostMomentum < 0) {
                    kart.preBoostMomentum = kart.momentum;
                    kart.preBoostDriftLeft = Math.max(0, kart.nextMomentumChange - now);
                }
            } else {
                // Fin de suspension : l'elan reprend la ou il en etait.
                if (kart.preBoostMomentum >= 0) {
                    kart.momentum = kart.preBoostMomentum;
                    kart.nextMomentumChange = now + kart.preBoostDriftLeft;
                    kart.preBoostMomentum = -1;
                }

                if (now > kart.nextMomentumChange) {
                    kart.momentumTarget = getNewMomentumTarget(rng, cfg, kart.stats);
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                }
                const mChangeSpeed = cfg.speeds.momentumChangeSpeed;
                if (kart.momentum < kart.momentumTarget) {
                    kart.momentum = Math.min(kart.momentumTarget, kart.momentum + mChangeSpeed * deltaTime);
                } else {
                    kart.momentum = Math.max(kart.momentumTarget, kart.momentum - mChangeSpeed * deltaTime);
                }

                const targetSpeed = getMomentumSpeed(cfg, kart.stats, kart.momentum);
                const accRate = cfg.speeds.accelerationRate * kart.stats.acceleration;
                if (kart.absoluteVelocity < targetSpeed) {
                    kart.absoluteVelocity = Math.min(targetSpeed, kart.absoluteVelocity + accRate * deltaTime);
                } else if (kart.absoluteVelocity > targetSpeed) {
                    kart.absoluteVelocity = Math.max(targetSpeed, kart.absoluteVelocity - accRate * 0.25 * deltaTime);
                }
                if (kart.absoluteVelocity > kart.stats.topSpeed) {
                    kart.absoluteVelocity = kart.stats.topSpeed;
                }
            }

            // Ce qui peut encore rogner la vitesse.
            let effectiveSpeed = kart.absoluteVelocity;

            // Freins et ralenti ne s'appliquent pas sous objet.
            if (!boost) {
                if (kart.finished) {
                    effectiveSpeed = Math.min(effectiveSpeed,
                        kart.stats.topSpeed * cfg.race.finishedSpeedRatio);
                }
                // Severite propre a chaque frein (`edgeBrakeFactor` par defaut).
                if (now < kart.brakeUntil) {
                    effectiveSpeed *= kart.brakeFactor || cfg.ai.edgeBrakeFactor;
                }

                // Cout du braquage (`steerCost`), hors objet ; il ne tombe que
                // pendant les transitions, `steer` annulant la consigne une fois
                // la cible tenue. Compteur d'observation seulement.
                const cornerMult = steerCost(cfg, kart);
                kart.cornerLostPx += effectiveSpeed * (1 - cornerMult) * deltaTime;
                effectiveSpeed *= cornerMult;
            }

            // L'etoile ne change pas la vitesse.
            if (kart.starEndTime > now) {
                kart.isInvincible = true;
            } else if (kart.isInvincible) {
                kart.isInvincible = false;
                events.push({ type: 'starOff', kartId: kart.id });
            }

            // Rapetissement en dernier : un kart reduit est lent quoi qu'il tienne.
            if (kart.shrinkEndTime > now) {
                effectiveSpeed *= cfg.lightning.speedFactor;
                kart.isShrunk = true;
            } else if (kart.isShrunk) {
                kart.isShrunk = false;
                events.push({ type: 'shrinkOff', kartId: kart.id });
            }

            // Aplati : malus cumule au rapetissement (il traine sans s'arreter).
            if (kart.isFlat) {
                effectiveSpeed *= cfg.lightning.flatSpeedFactor;
            }

            // Descente de fin de vol du bill, jamais sous la vitesse du kart.
            const billSpeed = getBillSpeed(cfg, state, kart);
            if (!kart.isBill && kart.billSlowUntil > now) {
                const left = (kart.billSlowUntil - now) / cfg.bill.slowdownMs;
                effectiveSpeed = Math.max(
                    effectiveSpeed,
                    kart.stats.topSpeed + (billSpeed - kart.stats.topSpeed) * left
                );
            }

            // Choc longitudinal ajoute, borne a l'arret.
            const shovedSpeed = effectiveSpeed + kart.bumpVx;
            let moveDist = (shovedSpeed > 0 ? shovedSpeed : 0) * deltaTime;

            // Choc contre un tuyau : arret net puis recul (deduit aussi de
            // `totalDistance`).
            if (now < kart.bumpEndTime) {
                moveDist = 0;
                if (kart.bumpRecoilLeft > 0) {
                    const back = Math.min(
                        kart.bumpRecoilLeft,
                        (cfg.pipe.recoilPx * 1000 / cfg.pipe.recoilMs) * deltaTime
                    );
                    kart.bumpRecoilLeft -= back;
                    moveDist = -back;
                }
            }

            kart.totalDistance += moveDist;

            kart.contactSpeed = deltaTime > 0 ? moveDist / deltaTime : 0;

            const prevWorldX = kart.worldX;
            kart.worldX += moveDist;
            kart.yPercent += (kart.vy + kart.bumpVy) * deltaTime;

            const finishX = cfg.world.finishLineX;
            if (moveDist >= 0) {
                if (prevWorldX < finishX && kart.worldX >= finishX) {
                    kart.lapCount++;
                    kart.hasPassedFinishLine = true;
                }
            } else if (prevWorldX >= finishX && kart.worldX < finishX) {
                // Repousse a travers la ligne : le tour est decompte.
                kart.lapCount--;
            }

            if (!kart.finished && kart.totalDistance >= kart.finishDistance) {
                kart.finished = true;
                kart.finishRank = state.finishOrder.length + 1;
                state.finishOrder.push(kart.id);

                // Objet retire a l'arrivee.
                if (kart.heldItem) {
                    if (kart.heldItem.holdPosition === 'orbit') {
                        for (const orb of kart.heldItem.orbs) {
                            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: orb.id });
                        }
                    } else {
                        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                    }
                    kart.heldItem = null;
                    kart.trailTime = 0;
                }

                events.push({ type: 'kartFinished', kartId: kart.id, rank: kart.finishRank });
            }

            if (kart.worldX >= cfg.world.width) {
                kart.worldX -= cfg.world.width;
            }
            if (kart.worldX < 0) {
                kart.worldX += cfg.world.width;
            }

            clampKartToRoad(cfg, kart, deltaTime);

            // Tuyau juge apres le deplacement ; les contacts entre karts sont
            // resolus plus tard (`resolveKartContacts`).
            collideKartWithPipes(cfg, state, kart, now, events);

            if (kart.heldItem && kart.state === 'running' && kart.heldItem.holdPosition === 'behind') {
                let itemWorldX = kart.worldX + cfg.offsets.world.heldItemBehind;
                if (itemWorldX < 0) itemWorldX += cfg.world.width;
                if (itemWorldX >= cfg.world.width) itemWorldX -= cfg.world.width;

                const itemY = kart.yPercent;

                for (let j = 0; j < kartsLen; j++) {
                    const victim = state.karts[j];
                    if (victim.id === kart.id || victim.state !== 'running') continue;
                    if (victim.hitInvincibleUntil > now) continue;

                    const dx = Math.abs(getShortestDistance(cfg, itemWorldX, victim.worldX));
                    const dy = Math.abs(itemY - victim.yPercent);

                    const hitThresholdY = 8;

                    // `dx` tient compte du rapetissement, `dy` est une tolerance fixe.
                    if (dx < shrunkReachX(cfg, cfg.hitboxes.itemVsKart, victim, now)
                        && dy < hitThresholdY) {
                        if (isRamming(victim)) {
                            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                            kart.heldItem = null;
                            kart.trailTime = 0;
                            break;
                        }
                        const trailedType = kart.heldItem.type;
                        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                        kart.heldItem = null;
                        kart.trailTime = 0;

                        spinOutKart(cfg, now, victim, events, trailedType);
                        break;
                    }
                }
            }

            // Passage au trainage : la hitbox de l'objet s'active.
            if (kart.heldItem && kart.trailTime && now > kart.trailTime
                && kart.heldItem.holdPosition === 'hands') {
                kart.heldItem.holdPosition = 'behind';
                kart.trailTime = 0;
            }

            if (kart.heldItem && now > kart.throwTime) activateItem(cfg, state, rng, now, kart, events);

        } else if (kart.state === 'hit') {
            // Glissade de la toupie a la vitesse laissee par le coup
            // (`hits[source].keep`), arretee par un tuyau (`pipeBlocked`), plus
            // le choc longitudinal borne a l'arret.
            let hitSpeed = 0;
            if (kart.hitKeepSpeed > 0 && now >= kart.bumpEndTime && !kart.pipeBlocked) {
                hitSpeed = kart.hitKeepSpeed;
                kart.stopped = false;
            } else {
                kart.stopped = true;
            }

            const shovedHitSpeed = hitSpeed + kart.bumpVx;
            const hitMove = (shovedHitSpeed > 0 ? shovedHitSpeed : 0) * deltaTime;
            kart.contactSpeed = deltaTime > 0 ? hitMove / deltaTime : 0;
            kart.worldX += hitMove;
            kart.totalDistance += hitMove;

            // Le choc lateral deplace aussi la toupie.
            kart.yPercent += kart.bumpVy * deltaTime;
            // Pas de frottement de bord sur une toupie.
            clampKartToRoad(cfg, kart, deltaTime);

            if (kart.worldX >= cfg.world.width) {
                kart.worldX -= cfg.world.width;
            }
            // Une toupie peut reculer sous l'origine du monde.
            if (kart.worldX < 0) {
                kart.worldX += cfg.world.width;
            }

            collideKartWithPipes(cfg, state, kart, now, events);
            if (now > kart.hitEndTime) {
                kart.state = 'running';
                kart.stopped = false;
                // Reprise a la vitesse laissee par le coup.
                kart.absoluteVelocity = kart.hitKeepSpeed;
                kart.hitKeepSpeed = 0;

                // Vitesse laterale remise a zero apres l'incident.
                kart.vy = 0;
                kart.targetVy = 0;

                kart.momentum = 0.2;
                kart.momentumTarget = randomRange(rng, 0.6, 1.0);
                kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                // Plus d'elan a restituer.
                kart.preBoostMomentum = -1;
                // Sursis selon la source du coup (`hits`).
                kart.hitInvincibleUntil = now + kart.hitInvincibleMs;
            }
        }
    }

    // Contacts entre karts, une fois que tous ont bouge.
    resolveKartContacts(cfg, state, now, deltaTime, events);

    updateOrbitItems(cfg, state, now, deltaTime, events);

    // Les bleues sont hors de cette passe.
    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i];
        if (item.isDead || item.spent) continue;
        if (item.type === 'blueShell' || item.type === 'blueBlast') continue;

        for (let j = i - 1; j >= 0; j--) {
            const other = state.items[j];
            if (other.isDead || other.spent) continue;
            if (other.type === 'blueShell' || other.type === 'blueBlast') continue;
            const dx = Math.abs(getShortestDistance(cfg, item.worldX, other.worldX));
            const dy = Math.abs(item.y - other.y);
            if (dx < cfg.hitboxes.itemVsKart.x && dy < cfg.hitboxes.itemVsKart.y) {
                spendItem(cfg, item, now);
                spendItem(cfg, other, now);
            }
        }
    }

    for (let i = state.items.length - 1; i >= 0; i--) {
        const item = state.items[i];
        if (item.isDead) continue;

        // Profondeur de depart du pas (impacts testes sur le segment).
        item.prevY = item.y;

        if (item.type === 'blueShell') {
            updateBlueShell(cfg, state, now, item, deltaTime, events);
            if (now - item.lastAnimTime > cfg.itemAnim.blueShell.animSpeed) {
                item.currentFrame = (item.currentFrame % 3) + 1;
                item.lastAnimTime = now;
            }
            continue;
        }

        if (item.type === 'blueBlast') {
            updateBlueBlast(cfg, state, now, item, events);
            continue;
        }

        // Vol en cloche : inoffensif a la montee.
        if (item.flightUntil) {
            const total = cfg.speeds.bananaLobDurationMs;
            const progress = Math.min(1, 1 - (item.flightUntil - now) / total);

            item.worldX = item.flightFrom + (item.flightTo - item.flightFrom) * progress;
            if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
            item.hop = Math.sin(Math.PI * Math.pow(progress, cfg.speeds.bananaLobRise)) * cfg.speeds.bananaLobHeight;

            if (item.rising && progress >= Math.pow(0.5, 1 / cfg.speeds.bananaLobRise)) {
                item.rising = false;
            }

            if (progress >= 1) {
                item.flightUntil = 0;
                item.hop = 0;
                item.vx = 0;
                item.rising = false;
                // Duree de vie comptee a l'atterrissage.
                item.createdAt = now;
            }
        }

        // Carapace posee : immobile comme une banane.
        if (item.type !== 'banana' && !item.resting) {
            if (item.type === 'redShell' && item.targetKartId !== null) {
                const target = state.kartsById[item.targetKartId];
                if (target && (target.state === 'running' || target.state === 'hit')) {
                    // Profondeur de la cible, ou detour d'un tuyau.
                    const diffY = redShellAimY(cfg, state, item, target) - item.y;
                    item.vy = diffY * cfg.speeds.redShellTrackingSpeed;
                } else {
                    // Cible de repli dans le sens de deplacement.
                    const dir = item.vx >= 0 ? 1 : -1;
                    let newTarget = null;
                    let bestScore = Infinity;
                    for (let k = 0; k < kartsLen; k++) {
                        const candidate = state.karts[k];
                        if (candidate.id === item.shooterId) continue;
                        if (candidate.state !== 'running') continue;
                        const dist = getShortestDistance(cfg, candidate.worldX, item.worldX) * dir;
                        const score = redShellTargetScore(cfg, dist);
                        if (score < bestScore) {
                            bestScore = score;
                            newTarget = candidate;
                        }
                    }
                    if (newTarget) {
                        item.targetKartId = newTarget.id;
                    } else {
                        item.targetKartId = null;
                        item.vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
                    }
                }
            }

            // Bords et tuyaux, par sous-pas.
            advanceProjectile(cfg, state, item, deltaTime, now);
        }

        if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
        if (item.worldX < 0) item.worldX += cfg.world.width;

        // Carapace posee : frame figee.
        const spin = item.resting ? null : cfg.itemAnim[item.type];
        if (spin && (item.type === 'greenShell' || item.type === 'redShell')
            && now - item.lastAnimTime > spin.animSpeed) {
            item.currentFrame = (item.currentFrame % 3) + 1;
            item.lastAnimTime = now;
        }
        // Objet pose : duree de vie d'une banane.
        if ((item.type === 'banana' || item.resting) && now - item.createdAt > cfg.delays.bananaLife) {
            item.isDead = true;
        }

        if (!item.armed) {
            const shooter = state.kartsById[item.shooterId];
            if (!shooter || Math.abs(getShortestDistance(cfg, item.worldX, shooter.worldX)) > cfg.itemArmDistance) {
                item.armed = true;
            }
        }

        if (item.spent) continue;
        // Pas de hitbox pendant la montee.
        if (item.rising) continue;

        for (let k = 0; k < kartsLen; k++) {
            const kart = state.karts[k];
            // Un piege epargne celui qui l'a pose tant qu'il ne s'en est pas eloigne.
            const trap = item.type === 'banana' || item.resting;
            if (trap && kart.id === item.shooterId && !item.armed) continue;
            if (!trap && item.type === 'redShell' && kart.id === item.shooterId) continue;
            // Une verte epargne son lanceur, sauf renvoyee par un tuyau.
            if (!trap && item.type === 'greenShell' && kart.id === item.shooterId && !item.pipeBounced) continue;
            if (kart.state !== 'running' && kart.state !== 'hit') continue;

            if (isRamming(kart)) {
                const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                if (dk < shrunkReachX(cfg, cfg.hitboxes.itemVsKart, kart, now)
                    && crossedDepth(item, kart.yPercent,
                                    shrunkReachY(cfg, cfg.hitboxes.itemVsKart, kart, now))) {
                    spendItem(cfg, item, now);
                    break;
                }
                continue;
            }

            let hitHeldItem = false;
            if (kart.heldItem && kart.heldItem.holdPosition === 'behind') {
                let hX = kart.worldX + cfg.offsets.world.heldItemBehind;
                if (hX < 0) hX += cfg.world.width;
                if (hX >= cfg.world.width) hX -= cfg.world.width;

                const dh = Math.abs(getShortestDistance(cfg, item.worldX, hX));
                if (dh < cfg.hitboxes.itemVsKart.x
                    && crossedDepth(item, kart.yPercent, cfg.hitboxes.itemVsKart.y)) {
                     events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                     kart.heldItem = null;
                     kart.trailTime = 0;
                     spendItem(cfg, item, now);
                     hitHeldItem = true;
                }
            } else if (kart.heldItem && kart.heldItem.holdPosition === 'orbit') {
                // Le bouclier encaisse : un seul orbe part.
                const held = kart.heldItem;
                for (let b = held.orbs.length - 1; b >= 0; b--) {
                    const pos = getOrbitItemPosition(cfg, kart, held.orbs[b], held.orbitAngle);
                    const dh = Math.abs(getShortestDistance(cfg, item.worldX, pos.worldX));
                    if (dh < cfg.hitboxes.itemVsKart.x
                        && crossedDepth(item, pos.y, cfg.hitboxes.itemVsKart.y)) {
                        destroyOrbitItem(kart, b, events);
                        spendItem(cfg, item, now);
                        hitHeldItem = true;
                        break;
                    }
                }
            }

            if (hitHeldItem) break;

            // Contact objet-kart.
            const body = cfg.hitboxes.itemVsKart;
            const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
            if (dk < shrunkReachX(cfg, body, kart, now)
                && crossedDepth(item, kart.yPercent, shrunkReachY(cfg, body, kart, now))) {
                if (kart.state === 'running' && kart.hitInvincibleUntil <= now) {
                    spinOutKart(cfg, now, kart, events, item.type);
                }
                spendItem(cfg, item, now);
                break;
            }
        }
    }

    let writeIdx = 0;
    for (let i = 0; i < state.items.length; i++) {
        const it = state.items[i];
        if (it.spent && now >= it.deadAt) it.isDead = true;
        if (it.isDead) {
            events.push({ type: 'killItem', itemId: it.id });
        } else {
            state.items[writeIdx++] = it;
        }
    }
    state.items.length = writeIdx;

    updateLeaderboard(state, now, events);

    return events;
}

export {
    stepPhysics,
};
