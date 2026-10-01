// Pilote IA : `updateAI` rassemble perception et etat du kart, `command`
// applique l'ordre de priorite des manoeuvres.

import { randomRange } from './math.js';
import { steer, steerSettle } from './driving.js';
import { billAimDepth, getShotDirection, isAiming } from './weapons.js';
import { pipeOutranksPlan, updatePlan } from './plans.js';
import { perceive, updateGlance, updateShield } from './vision.js';
import { hear, updateBlue } from './alerts.js';
import { steerAroundPipes } from './pipes.js';

// Pilotage d'un kart pour un pas de temps, a partir de ce qu'il a percu.
function updateAI(cfg, state, rng, now, kart, deltaTime) {
    if (kart.state !== 'running') return;

    const vis = cfg.vision;

    // Un bill rejoint le milieu de la piste et ne fait que contourner les tuyaux.
    if (kart.isBill) {
        steer(cfg, kart, deltaTime, billAimDepth(cfg, state, kart),
            cfg.bill.centerSpeed, cfg.ai.steering.bill);
        return;
    }

    const sight = kart.sight;

    // Ecoute, attention, puis balayage (amorti par `vision.scanIntervalMs`).
    hear(cfg, state, rng, now, kart);
    updateGlance(cfg, rng, state, now, kart);
    if (now - sight.at >= vis.scanIntervalMs) perceive(cfg, state, rng, now, kart);

    // Gestion de la bleue avant le plan.
    updateBlue(cfg, rng, state, now, kart);
    updatePlan(cfg, rng, now, kart);
    updateShield(cfg, rng, state, now, kart);

    command(cfg, state, rng, now, kart, deltaTime);

    // Lever le pied devant la bleue, quelle que soit la manoeuvre en cours (le
    // frein le plus appuye l'emporte).
    const mode = kart.alert.blueMode;
    if (mode === 'yield' || mode === 'hang') {
        const factor = cfg.vision.alerts.blue.brakeFactor;
        const active = now < kart.brakeUntil && kart.brakeFactor > 0;
        if (!active || kart.brakeFactor > factor) kart.brakeFactor = factor;
        const until = now + 2 * cfg.vision.scanIntervalMs;
        if (kart.brakeUntil < until) kart.brakeUntil = until;
    }
}

// Ordre de priorite : la premiere manoeuvre applicable prend le volant.
function command(cfg, state, rng, now, kart, deltaTime) {
    const ai = cfg.ai;
    const vis = cfg.vision;
    const sight = kart.sight;

    // L'esquive passe en premier, sauf si elle mene dans un tuyau
    // (`pipeOutranksPlan`). Ceder suspend le plan sans le fermer.
    const plan = kart.plan;
    if (plan.threatId && plan.kind === 'spin' && !plan.idle
        && !pipeOutranksPlan(cfg, kart)) {
        kart.aiState = 'dodging';

        // Frein seulement pour une esquive acculee ou une traversee.
        if (plan.stuck || plan.crossing) {
            kart.brakeUntil = now + ai.edgeBrakeMs;
            kart.brakeFactor = ai.edgeBrakeFactor;
        }

        steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.dodge);
        return;
    }

    // Les tuyaux passent avant la visee, le depassement et la maraude.
    if (steerAroundPipes(cfg, state, rng, now, kart, deltaTime)) return;

    // Precaution, apres le tuyau et avant les manoeuvres de confort. `giveWay`
    // s'applique meme sans rien a braquer (son geste principal est de lever le pied).
    if (plan.threatId
        && (plan.kind === 'giveWay' || plan.kind === 'yieldLead'
            || (plan.kind === 'safety' && !plan.idle))) {
        kart.aiState = plan.kind;

        // Ceder le passage : leger frein pour laisser doubler.
        if (plan.kind === 'giveWay') {
            kart.brakeUntil = now + vis.giveWay.brakeMs;
            kart.brakeFactor = vis.giveWay.brakeFactor;
        }

        steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.safety);
        return;
    }

    // Visee dans le sens de tir choisi. Vers l'arriere, elle exige d'avoir
    // regarde (releve) ; sans releve valable, le tir part a l'aveugle a l'heure dite.
    const aimDir = isAiming(cfg, kart) ? getShotDirection(state, kart) : 0;
    const aiming = aimDir !== 0 && now > kart.throwTime - ai.aimLeadMs;

    // Releve pendant le coup d'oeil arriere : profondeur et date de la cible.
    if (aiming && aimDir < 0 && sight.back && sight.scanBack && sight.seenKartDist >= 0) {
        kart.aimTargetY = sight.seenKartY;
        kart.aimTargetAt = now;
    }

    // On ne vise qu'en regardant devant.
    if (aiming && !sight.back) {
        let targetY = null;

        if (aimDir > 0) {
            // La cible n'est visee que si le balayage l'a vue devant.
            if (!sight.scanBack && sight.seenKartDist >= 0) targetY = sight.seenKartY;
        } else if (now - kart.aimTargetAt <= vis.aimMemoryMs) {
            targetY = kart.aimTargetY;
        }

        // Sans releve valable : tir a l'aveugle, depuis sa ligne.
        if (targetY !== null) {
            const margin = cfg.road.edgeSafetyMargin;
            const desired = Math.min(cfg.road.maxY - margin,
                                     Math.max(cfg.road.minY + margin, targetY + kart.aimError));
            const diff = desired - kart.yPercent;

            // Approche proportionnelle de la cible.
            const aim = ai.steering.aim;
            if (Math.abs(diff) > aim.tolerance) {
                kart.aiState = 'aiming';
                steer(cfg, kart, deltaTime, desired, aim.speed, aim);
                return;
            }
        }
    }

    // Depassement du kart le plus proche qui bouche la voie (vu par le balayage).
    if (sight.aheadKartDist >= 0) {
        let dir = (kart.yPercent > sight.aheadKartY) ? 1 : -1;
        if (kart.yPercent > cfg.road.maxY - cfg.road.overtakeMargin) dir = -1;
        if (kart.yPercent < cfg.road.minY + cfg.road.overtakeMargin) dir = 1;

        // Sortir de sa voie, avec une marge d'une demi-carrosserie.
        const pass = ai.steering.overtake;
        const clear = ai.overtakeMinDistance + cfg.hitboxes.kartVsKart.y * 0.5;
        steer(cfg, kart, deltaTime, sight.aheadKartY + dir * clear, pass.speed, pass);
        return;
    }

    // Collecte : la boite visible et libre la plus proche de sa trajectoire.
    if (!kart.heldItem && sight.boxDist >= 0) {
        // Deja dans l'axe : il tient sa ligne.
        const grab = ai.steering.box;
        steer(cfg, kart, deltaTime, sight.boxY, grab.speed, grab);
        return;
    }

    if (now > kart.nextWanderTime) {
        kart.nextWanderTime = now + randomRange(rng, ai.wanderIntervalMin, ai.wanderIntervalMax);
        kart.wanderEndTime = now + randomRange(rng, ai.wanderDurationMin, ai.wanderDurationMax);
        let dir = (rng() > 0.5) ? 1 : -1;

        if (kart.yPercent > cfg.road.maxY - cfg.road.wanderMargin) dir = -1;
        if (kart.yPercent < cfg.road.minY + cfg.road.wanderMargin) dir = 1;

        // Ecart identique pour tous (seul le temps change), dans les limites de
        // la piste.
        kart.wanderY = Math.min(cfg.road.maxY - cfg.road.wanderMargin,
            Math.max(cfg.road.minY + cfg.road.wanderMargin,
                     kart.yPercent + dir * ai.wanderOffset));
    }

    if (now < kart.wanderEndTime) {
        const drift = ai.steering.wander;
        steer(cfg, kart, deltaTime, kart.wanderY, drift.speed, drift);
        return;
    }

    // Croisiere : le volant revient a zero (viser le point d'arret). Aucun
    // retour a une ligne d'origine : la profondeur ne coute rien hors du mur.
    const cruise = ai.steering.cruise;
    kart.aiState = 'cruising';
    steer(cfg, kart, deltaTime, steerSettle(cfg, kart), 0, cruise);
}

export {
    updateAI,
};
