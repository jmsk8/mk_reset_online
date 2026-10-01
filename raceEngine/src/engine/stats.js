// Caracteristiques d'un pilote et vitesses qui en decoulent (budget de points
// mis en cache par configuration).

import { clamp, lerp, ramp, randomRange } from './math.js';

const derivedStatsCache = new WeakMap();

function deriveCharacterStats(cfg) {
    const cached = derivedStatsCache.get(cfg);
    if (cached) return cached;

    const spec = cfg.kartStats;
    const span = (spec.maxPoints - spec.minPoints) || 1;
    const axes = ['weight', 'power', 'handling'];
    const table = {};

    for (const name of Object.keys(spec.characters)) {
        const raw = spec.characters[name];

        for (const axis of axes) {
            const v = raw[axis];
            if (typeof v !== 'number' || v < spec.minPoints || v > spec.maxPoints) {
                throw new Error(`kartStats : ${name}.${axis} vaut ${v}, hors de `
                    + `[${spec.minPoints}, ${spec.maxPoints}]`);
            }
        }
        const total = raw.weight + raw.power + raw.handling;
        if (total !== spec.budget) {
            throw new Error(`kartStats : ${name} totalise ${total} points `
                + `au lieu des ${spec.budget} du budget`);
        }

        const norm = {
            weight:   (raw.weight - spec.minPoints) / span,
            power:    (raw.power - spec.minPoints) / span,
            handling: (raw.handling - spec.minPoints) / span
        };

        const mass  = lerp(spec.mass.min, spec.mass.max, norm.weight);
        const force = lerp(spec.force.min, spec.force.max, norm.power);
        // Axe handling courbe (voir `gripCurve`).
        const grip  = lerp(spec.grip.min, spec.grip.max,
                           Math.pow(norm.handling, spec.gripCurve));

        table[name] = {
            raw: raw,
            norm: norm,
            mass: mass,
            // Pointe additive : chaque axe apporte ses propres px/s.
            topSpeed: spec.speedBase
                + spec.speedPerWeight * norm.weight
                + spec.speedPerPower * norm.power,
            acceleration: clamp(force / Math.pow(mass, spec.massDragAccel),
                                spec.accelClamp.min, spec.accelClamp.max),
            agility: clamp(grip / Math.pow(mass, spec.massDragAgility),
                           spec.agilityClamp.min, spec.agilityClamp.max),

            // Tenue en virage, qui fixe le cout du braquage (`steerCost`), avec
            // ses propres exposants.
            cornering: Math.pow(grip, spec.cornerGripGain)
                * Math.pow(force, spec.cornerPowerGain)
                / Math.pow(mass, spec.cornerMassDrag)
        };
    }

    derivedStatsCache.set(cfg, table);
    return table;
}

// Agilite moyenne du plateau de reference (`bodies.referenceKarts`), etalon
// pour juger une situation independamment du personnage.
const referenceAgilityCache = new WeakMap();

function referenceAgility(cfg) {
    const cached = referenceAgilityCache.get(cfg);
    if (cached !== undefined) return cached;

    const table = deriveCharacterStats(cfg);
    const names = ((cfg.bodies && cfg.bodies.referenceKarts) || Object.keys(table))
        .filter(name => table[name]);
    let sum = 0;
    for (let i = 0; i < names.length; i++) sum += table[names[i]].agility;
    const mean = sum / names.length;

    referenceAgilityCache.set(cfg, mean);
    return mean;
}

function getNewMomentumTarget(rng, cfg, stats) {
    const floor = cfg.speeds.momentumFloor;
    const minMomentum = floor.base + floor.weightGain * stats.norm.weight;
    return randomRange(rng, minMomentum, 1.0);
}

function getMomentumSpeed(cfg, stats, momentum) {
    const minRatio = cfg.speeds.momentumMinRatio;
    return stats.topSpeed * (minRatio + (1.0 - minRatio) * momentum);
}

function getInitialKartSpeed(rng, stats) {
    const variation = randomRange(rng, 0.85, 0.95);
    return stats.topSpeed * variation;
}

// Meilleure pointe atteignable avec un objet autre que le bill.
function fastestBoostedSpeed(cfg) {
    const table = deriveCharacterStats(cfg);
    const names = Object.keys(table);
    let best = 0;
    for (let i = 0; i < names.length; i++) {
        const top = table[names[i]].topSpeed;
        const boosts = cfg.speeds.boosts;
        const shroom = top * boosts.shroom.multiplier;
        const star = top * boosts.star.multiplier;
        if (shroom > best) best = shroom;
        if (star > best) best = star;
    }
    return best;
}

// Vitesse de croisiere du bill : multiplicateur du porteur, au moins le plancher commun.
function getBillSpeed(cfg, state, kart) {
    return Math.max(kart.stats.topSpeed * cfg.speeds.boosts.bill.multiplier,
                    state.billFloorSpeed);
}

// Pointe visee sous objet et vivacite de la montee (`speeds.boosts`). null si
// aucun objet n'est actif ; en cas de cumul la plus haute gagne, le bill prime.
function getActiveBoost(cfg, state, kart, now) {
    const boosts = cfg.speeds.boosts;

    if (kart.isBill) {
        return { peak: getBillSpeed(cfg, state, kart), ramp: boosts.bill.ramp };
    }

    let best = null;
    if (kart.starEndTime > now) {
        best = { peak: kart.stats.topSpeed * boosts.star.multiplier, ramp: boosts.star.ramp };
    }
    if (kart.boostEndTime > now) {
        const peak = kart.stats.topSpeed * boosts.shroom.multiplier;
        if (!best || peak > best.peak) best = { peak: peak, ramp: boosts.shroom.ramp };
    }
    return best;
}

export {
    deriveCharacterStats,
    fastestBoostedSpeed,
    getActiveBoost,
    getBillSpeed,
    getInitialKartSpeed,
    getMomentumSpeed,
    getNewMomentumTarget,
    referenceAgility,
};
