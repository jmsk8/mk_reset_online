// Plan de course d'un kart : la profondeur qu'il vise, et pourquoi. Il dure
// plusieurs images et sa revision est cadencee.

import { randomRange } from './math.js';
import { steerCap, steerReach } from './steering.js';
import { chooseLane, laneSlop, sideRoom, steerSettle } from './driving.js';
import { isTrailable } from './weapons.js';

// Un plan ne se ferme que sur une echeance ou une menace vue disparue (une
// absence d'observation ne prouve rien).

// Delai avant la prochaine revision, tire au sort pour que les karts ne
// decident pas tous au meme instant.
function reviewDelay(cfg, rng) {
    const vis = cfg.vision;
    return vis.reviewIntervalMs
        * randomRange(rng, vis.reviewJitterMin, vis.reviewJitterMax);
}

function placePlan(cfg, rng, kart, plan, ttc) {
    // Erreur d'appreciation de son propre volant (`crossJudgeError`), qui se
    // repercute sur la portee et le detour.
    const err = cfg.ai.crossJudgeError;
    const cap = steerCap(cfg, kart, plan.intensity)
        * randomRange(rng, 1 - err, 1 + err);

    const lane = chooseLane(cfg, rng, kart, cap, ttc, cfg.ai.steering.dodge);

    // Nulle part ou aller : il ne reste que le frein.
    plan.stuck = lane === null;

    // Mesure depuis le point d'arret (ou le kart finirait volant lache).
    const settle = steerSettle(cfg, kart);

    plan.laneY = (lane === null) ? settle : lane;
    plan.dir = (plan.laneY > settle) ? 1 : (plan.laneY < settle) ? -1 : 0;

    // Deja en place : le plan rend la main au reste du pilotage (meme seuil que
    // le braquage).
    plan.idle = !plan.stuck
        && Math.abs(plan.laneY - settle) <= cfg.ai.steering.dodge.tolerance;

    // Traversee : passer devant l'objet, avec frein.
    const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
    plan.crossing = plan.dir !== 0 && plan.dir !== natural;

    // Plan pose sur un balayage arriere : repris au premier balayage de face.
    plan.coarse = kart.sight.scanBack;
}

// Precaution : quitter la ligne du porteur, du cote qui a la place (le cote
// naturel en priorite), sans passer par `chooseLane`.
function placeSafety(cfg, kart, plan) {
    const clear = cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item;
    const lo = cfg.road.minY + cfg.road.edgeSafetyMargin;
    const hi = cfg.road.maxY - cfg.road.edgeSafetyMargin;

    // Marge au-dela du degagement strict, pour ne pas osciller a la limite.
    const slack = clear + cfg.hitboxes.kartVsKart.y * 0.5;

    const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
    const need = clear - Math.abs(kart.yPercent - plan.threatY);

    const roomNatural = sideRoom(cfg, kart, natural);
    const roomOther = sideRoom(cfg, kart, -natural);
    const dir = (roomNatural >= need || roomNatural >= roomOther)
        ? natural : -natural;

    plan.dir = dir;

    // Profondeur bornee par la face de confort du premier corps vu de ce cote.
    const room = (dir === natural) ? roomNatural : roomOther;
    const want = Math.min(hi, Math.max(lo, plan.threatY + dir * slack));
    const edge = kart.yPercent + dir * room;
    plan.laneY = (dir > 0) ? Math.min(want, edge) : Math.max(want, edge);

    // Une precaution ne freine pas et n'est jamais acculee.
    plan.stuck = false;
    plan.crossing = false;

    // Rien a commander : nulle part ou aller, ou deja arrive.
    plan.idle = Math.abs(plan.laneY - steerSettle(cfg, kart))
        <= cfg.ai.steering.safety.tolerance;
    plan.coarse = kart.sight.scanBack;
}

function updatePlan(cfg, rng, now, kart) {
    const vis = cfg.vision;
    const sight = kart.sight;
    const plan = kart.plan;

    // Une menace toujours en vue et qui converge prolonge le plan.
    if (plan.threatId && sight.threatId === plan.threatId
        && sight.threatTtc !== Infinity) {
        plan.until = now + sight.threatTtc + vis.holdAfterMs;
    }

    // Meme regle pour la precaution : prolongee tant que le danger est percu.
    if (plan.kind === 'safety' && sight.pressure
        && sight.pressureId === plan.threatId) {
        plan.until = now + vis.safety.holdMs;
    }

    // Ceder la tete seulement tant que `updateBlue` le decide.
    if (plan.kind === 'yieldLead' && kart.alert.blueMode !== 'yield') plan.until = 0;

    if (plan.threatId && (now >= plan.until || sight.planGone)) {
        plan.threatId = 0;
        plan.kind = '';
        plan.until = 0;
        plan.idle = false;
    }

    // Une menace plus urgente prend la main ; la nature compte autant que
    // l'identite (un porteur de banane peut prendre une etoile).
    if (sight.threatKind === 'spin'
        && (sight.threatId !== plan.threatId || plan.kind !== 'spin')) {
        plan.kind = 'spin';
        plan.threatId = sight.threatId;
        plan.threatY = sight.threatY;
        plan.intensity = randomRange(rng, cfg.ai.dodgeIntensityMin, cfg.ai.dodgeIntensityMax);
        plan.until = now + sight.threatTtc + vis.holdAfterMs;
        plan.reviewAt = now + reviewDelay(cfg, rng);
        placePlan(cfg, rng, kart, plan, sight.threatTtc);
        return;
    }

    // Ceder la tete devant une bleue : quitter la ligne du suiveur (le frein
    // est gere par `updateBlue`).
    if (!plan.threatId && kart.alert.blueMode === 'yield' && sight.rearKartDist >= 0) {
        plan.kind = 'yieldLead';
        plan.threatId = sight.rearKartId;
        plan.threatY = sight.rearKartY;
        plan.intensity = vis.giveWay.speed;
        plan.until = kart.alert.yieldUntil;
        plan.reviewAt = now + reviewDelay(cfg, rng);
        placeSafety(cfg, kart, plan);
        return;
    }

    // Laisser passer une rouge qui suit (sauf s'il y en a deux) : se faire
    // doubler pour sortir de sa cible.
    if (!plan.threatId && sight.redBehindDist >= 0
        && sight.redBehindDist <= vis.giveWay.range
        && !(kart.heldItem && isTrailable(cfg, kart.heldItem.type))
        && now >= kart.giveWayRetryAt) {
        const give = vis.giveWay;
        kart.giveWayRetryAt = now + give.retryMs;

        const chance = (sight.redBehindCount > 1) ? give.chanceRival : give.chance;
        if (rng() < chance) {
            plan.kind = 'giveWay';
            plan.threatId = sight.redBehindId;
            plan.threatY = sight.redBehindY;
            plan.intensity = give.speed;
            plan.until = now + give.holdMs;
            plan.reviewAt = now + reviewDelay(cfg, rng);
            placeSafety(cfg, kart, plan);
            return;
        }
    }

    // Porteur dans le dos, de memoire (`carrierAt`) : le laisser passer s'il est
    // pres, se ranger, ou le viser (`updateShield`), tire a chaque echeance.
    if (!plan.threatId && now - sight.carrierAt <= vis.pressureMemoryMs
        && now >= kart.safetyRetryBackAt) {
        const spec = vis.carrierBehind;
        kart.safetyRetryBackAt = now + vis.safety.retryMs;

        // Porteur de rouge : deja traite au-dessus.
        const armed = kart.heldItem && isTrailable(cfg, kart.heldItem.type);
        const red = sight.redBehindDist >= 0 && sight.redBehindId === sight.carrierId;
        if (!armed && !red && sight.carrierDist <= spec.passRange
            && rng() < spec.passChance) {
            plan.kind = 'giveWay';
            plan.threatId = sight.carrierId;
            plan.threatY = sight.carrierY;
            plan.intensity = vis.giveWay.speed;
            plan.until = now + vis.giveWay.holdMs;
            plan.reviewAt = now + reviewDelay(cfg, rng);
            placeSafety(cfg, kart, plan);
            return;
        }

        if (rng() < vis.safety.chance) {
            plan.kind = 'safety';
            plan.threatId = sight.carrierId;
            plan.threatY = sight.carrierY;
            plan.intensity = vis.safety.speed;
            plan.until = now + vis.safety.holdMs;
            plan.reviewAt = now + reviewDelay(cfg, rng);
            placeSafety(cfg, kart, plan);
            return;
        }
    }

    // Precaution face au porteur de devant, avec une chance de ne pas etre prise
    // (sa propre echeance).
    if (!plan.threatId && sight.pressure && !sight.pressureBack
        && now >= kart.safetyRetryFrontAt) {
        const safety = vis.safety;
        kart.safetyRetryFrontAt = now + safety.retryMs;

        if (rng() < safety.chance) {
            plan.kind = 'safety';
            plan.threatId = sight.pressureId;
            plan.threatY = sight.pressureY;
            plan.intensity = safety.speed;
            plan.until = now + safety.holdMs;
            plan.reviewAt = now + reviewDelay(cfg, rng);
            placeSafety(cfg, kart, plan);
            return;
        }
    }

    if (!plan.threatId) return;

    // Revision periodique avec la perception fraiche ; un plan pose sur un
    // balayage arriere est repris au premier balayage de face.
    const forced = plan.coarse && !sight.scanBack;

    if (!forced && now < plan.reviewAt) return;
    plan.reviewAt = now + reviewDelay(cfg, rng);
    if (!forced && rng() >= vis.reviewChance) return;

    if (plan.kind === 'safety' || plan.kind === 'giveWay' || plan.kind === 'yieldLead') {
        // La ligne a quitter suit le porteur.
        if (sight.pressure && sight.pressureId === plan.threatId) {
            plan.threatY = sight.pressureY;
        }
        if (sight.redBehindDist >= 0 && sight.redBehindId === plan.threatId) {
            plan.threatY = sight.redBehindY;
        }
        if (sight.rearKartDist >= 0 && sight.rearKartId === plan.threatId) {
            plan.threatY = sight.rearKartY;
        }
        placeSafety(cfg, kart, plan);
        return;
    }

    // Profondeur de la menace remise a jour (etoile et bill manoeuvrent).
    if (sight.threatId === plan.threatId) plan.threatY = sight.threatY;

    // Temps restant, au moins jusqu'a la prochaine revision.
    placePlan(cfg, rng, kart, plan,
        Math.max(plan.until - now - vis.holdAfterMs, vis.reviewIntervalMs));
}

// Vrai si l'esquive en cours mene dans un tuyau dans le temps restant : le
// tuyau reprend alors le volant (question geometrique, pas de couts).
function pipeOutranksPlan(cfg, kart) {
    const sight = kart.sight;
    if (sight.pipeIndex < 0) return false;

    // Limite dure du tuyau (hitbox nue).
    let lo = 0;
    let hi = 0;
    let found = false;
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        if (s.pipeIndex !== sight.pipeIndex) continue;
        lo = s.lo;
        hi = s.hi;
        found = true;
        break;
    }
    if (!found) return false;

    const pipeTtc = (sight.pipeDist / Math.max(kart.absoluteVelocity, 1)) * 1000;

    // Position atteinte par l'esquive, depuis le point d'arret.
    const plan = kart.plan;
    const settle = steerSettle(cfg, kart);
    const cap = steerCap(cfg, kart, plan.intensity);
    const reach = steerReach(cfg, cap, pipeTtc);

    const want = plan.laneY - settle;
    const at = settle
        + ((want > reach) ? reach : (want < -reach) ? -reach : want);

    // Avec la meme imprecision que le placement.
    const slop = laneSlop(cfg, kart, cap, cfg.ai.steering.dodge);

    return at > lo - slop && at < hi + slop;
}

export {
    pipeOutranksPlan,
    reviewDelay,
    updatePlan,
};
