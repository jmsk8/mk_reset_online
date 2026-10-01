// L'ouie : ce qu'un kart sait arriver sans l'avoir vu (quoi, et si c'est pour
// lui, jamais ou). `hear` pose des constats dans `kart.alert` :
//   ram    etoile ou bill dans le dos, a portee : fait tourner la tete
//   red    une rouge le vise : il se couvre (`updateShield`)
//   blue   une bleue arrive et il est en tete, ou elle l'a choisi (`updateBlue`)

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { isContactActive, isRamming } from './bodies.js';
import { getRacingLeader } from './standings.js';

// Etoile ou bill derriere, entendu sans se retourner : declenche un coup d'oeil.
// Releve aussi le temps avant contact du plus pressant (`alert.ramTtc`, infini
// s'il ne gagne pas de terrain).
function ramNoise(cfg, state, kart) {
    const alert = kart.alert;
    alert.ram = false;
    alert.ramTtc = Infinity;
    alert.ramId = -1;
    if (isRamming(kart)) return;

    const karts = state.karts;
    for (let i = 0; i < karts.length; i++) {
        const other = karts[i];
        if (other.id === kart.id) continue;
        if (!isRamming(other) || !isContactActive(other)) continue;

        // Derriere et a portee de regard.
        const dx = getShortestDistance(cfg, other.worldX, kart.worldX);
        if (dx >= 0 || -dx > cfg.vision.range.back) continue;
        alert.ram = true;

        // Temps jusqu'au contact (comme dans `perceive`).
        const rel = other.absoluteVelocity - kart.absoluteVelocity;
        if (rel <= 0) continue;
        const reach = other.isBill ? cfg.bill.hitbox.x : cfg.hitboxes.kartVsKart.x;
        const gap = -dx - reach;
        const ttc = (gap > 0) ? (gap / rel) * 1000 : 0;
        if (ttc < alert.ramTtc) {
            alert.ramTtc = ttc;
            alert.ramId = other.id;
        }
    }
}

// Reflexe, comme pour une menace vue (`judgeThreat`).
function reaction(cfg, rng) {
    const ai = cfg.ai;
    return ai.reactionBaseMs * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);
}

// Une rouge le vise (l'alarme du jeu d'origine). La plus proche est jugee une
// fois (reflexe et inattention) ; `alert.red` n'est vrai qu'apres le reflexe.
function hearRed(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.red;
    alert.red = false;
    if (!spec.enabled) {
        alert.redId = 0;
        return;
    }

    let best = null;
    let bestGap = Infinity;
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== 'redShell' || item.isDead || item.spent) continue;
        if (item.targetKartId !== kart.id) continue;

        // Dans le dos et a portee d'oreille.
        const gap = -getShortestDistance(cfg, item.worldX, kart.worldX);
        if (gap < 0 || gap > cfg.vision.range.back) continue;
        if (gap < bestGap) {
            bestGap = gap;
            best = item;
        }
    }

    if (!best) {
        alert.redId = 0;
        return;
    }

    if (best.id !== alert.redId) {
        alert.redId = best.id;
        alert.redReactAt = now + reaction(cfg, rng);
        alert.redIgnored = rng() < spec.miss;
    }
    alert.red = !alert.redIgnored && now >= alert.redReactAt;
}

// Protection contre le souffle de la bleue : champignon en poussee ou etoile.
function holdsCover(kart) {
    const held = kart.heldItem;
    return !!held && (held.type === 'shroom' || held.type === 'star');
}

function blueAlive(state, id) {
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].id === id) return !items[i].isDead;
    }
    return false;
}

// La bleue : avant son verrou, le premier l'entend venir et peut encore ceder
// la tete ; apres, elle a choisi sa cible. Seuls le premier, puis sa cible,
// l'entendent.
function hearBlue(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.blue;
    alert.blue = false;
    alert.blueOnMe = false;
    alert.blueEta = Infinity;
    alert.bluePhase = '';
    alert.blueLook = false;
    if (!spec.enabled) {
        alert.blueId = 0;
        return;
    }

    const leader = getRacingLeader(state) === kart;
    let blue = null;
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== 'blueShell' || item.isDead) continue;
        if (item.targetKartId === kart.id) {
            blue = item;
            break;
        }
        if (item.targetKartId === null && leader && !blue) blue = item;
    }

    if (!blue) {
        alert.blueId = 0;
        return;
    }

    if (blue.id !== alert.blueId) {
        alert.blueId = blue.id;
        alert.blueReactAt = now + reaction(cfg, rng);
        alert.blueIgnored = rng() < spec.miss;
        alert.blueBias = 1 + randomRange(rng, -spec.etaError, spec.etaError);
        alert.blueYield = rng() < spec.yieldChance;
        alert.blueStartled = false;
        alert.blueFireAt = 0;
    }
    if (alert.blueIgnored || now < alert.blueReactAt) return;

    alert.blue = true;
    alert.blueOnMe = blue.targetKartId === kart.id;

    if (alert.blueOnMe) {
        alert.bluePhase = blue.phase;
        return;
    }

    // Temps estime avant le verrou (ou la fin de sa croisiere).
    const b = cfg.blueShell;
    let gap = getShortestDistance(cfg, kart.worldX, blue.worldX);
    if (gap < 0) gap += cfg.world.width;
    const closing = b.speed - kart.absoluteVelocity;
    let eta = (closing > 0) ? (Math.max(0, gap - b.lockDistance) / closing) * 1000 : Infinity;
    const expire = blue.createdAt + b.maxCruiseMs - now;
    if (expire < eta) eta = (expire > 0) ? expire : 0;
    alert.blueEta = eta * alert.blueBias;

    // Il se retourne pour voir qui le suit, s'il n'a pas de protection.
    alert.blueLook = !holdsCover(kart) && alert.blueMode === '';
    if (alert.blueLook && !alert.blueStartled) {
        alert.blueStartled = true;
        alert.startle = true;
    }
}

// Reaction a la bleue : se proteger d'abord (etoile des qu'elle l'a choisi,
// champignon quand elle s'arrete au-dessus de lui, apres `hesitateMs`). Sinon,
// s'il est suivi de pres, ceder la tete avant le verrou puis rester en retrait.
function updateBlue(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.blue;

    // ── Se proteger ──────────────────────────────────────────────
    // Une rouge qui le vise passe avant.
    const held = kart.heldItem;
    if (alert.blue && holdsCover(kart) && !alert.red) {
        if (alert.blueMode !== 'cover') {
            alert.blueMode = 'cover';
            alert.savedThrowTime = kart.throwTime;
        }
        if (alert.blueOnMe && !alert.blueFireAt) {
            if (held.type === 'star') {
                alert.blueFireAt = now + reaction(cfg, rng);
            } else if (alert.bluePhase === 'hover') {
                alert.blueFireAt = now + reaction(cfg, rng) + rng() * spec.hesitateMs;
            }
        }

        // Objet garde jusque-la.
        kart.throwTime = alert.blueFireAt || (now + cfg.vision.pressureMemoryMs);
        return;
    }
    if (alert.blueMode === 'cover') {
        // Plus rien a couvrir : le plan d'origine reprend.
        alert.blueMode = '';
        if (held && alert.savedThrowTime > kart.throwTime) kart.throwTime = alert.savedThrowTime;
    }

    // ── Ceder la tete ────────────────────────────────────────────────────
    const give = Math.max(1, kart.absoluteVelocity * (1 - spec.brakeFactor));

    if (alert.blueMode === 'yield') {
        // Choisi malgre tout, ou plus rien a eviter.
        if (alert.blueOnMe || !blueAlive(state, alert.yieldBlueId) || now > alert.yieldUntil) {
            alert.blueMode = '';
        } else if (getRacingLeader(state) !== kart) {
            // Double : rester hors du souffle qui tombera sur l'autre.
            alert.blueMode = 'hang';
            alert.hangUntil = now + (spec.clearPx / give) * 1000;
        }
        return;
    }
    if (alert.blueMode === 'hang') {
        if (!blueAlive(state, alert.yieldBlueId) || now > alert.hangUntil) alert.blueMode = '';
        return;
    }

    // Une tentative par bleue.
    if (!alert.blue || alert.blueOnMe || !alert.blueYield || holdsCover(kart)) return;
    if (alert.yieldTriedId === alert.blueId) return;

    // Un suiveur vu, assez proche, qui ne freine pas.
    const sight = kart.sight;
    if (sight.rearKartDist < 0 || sight.rearKartDist > spec.yieldRange) return;
    if (sight.rearKartRel < -spec.closeTol) return;

    // Freiner juste assez tot pour se faire doubler, avec une marge ; trop tard,
    // ne rien tenter (le suiveur se retrouverait sous le souffle).
    const need = ((sight.rearKartDist + spec.passPx) / give) * 1000;
    if (alert.blueEta > need + spec.slackMs) return;
    if (alert.blueEta < need - spec.slackMs) return;

    alert.blueMode = 'yield';
    alert.yieldBlueId = alert.blueId;
    alert.yieldTriedId = alert.blueId;
    alert.yieldUntil = now + spec.maxYieldMs;
}

// Ce que le kart entend a ce pas (avant l'attention).
function hear(cfg, state, rng, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts;
    const plan = kart.plan;

    hearRed(cfg, rng, state, now, kart);
    hearBlue(cfg, rng, state, now, kart);
    ramNoise(cfg, state, kart);

    // Sursaut puis suivi du regard : regarder quand le danger arrive, et ne pas
    // lacher tant que l'esquive n'est pas decidee.
    const decided = plan.kind === 'spin' && plan.threatId === -1 - alert.ramId;
    alert.watch = spec.ram.enabled && alert.ramTtc <= spec.ram.leadMs && !decided;

    if (alert.ram) {
        if (now - alert.ramAt > spec.ram.quietMs) alert.ramStartled = false;
        alert.ramAt = now;
    }
    if (alert.watch && !alert.ramStartled) {
        alert.startle = true;
        alert.ramStartled = true;
    }
}

export {
    hear,
    updateBlue,
};
