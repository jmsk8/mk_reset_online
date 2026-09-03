// Les caracteristiques d'un pilote, et les vitesses qui en decoulent.
// Le budget de points se lit une fois par configuration et se garde en cache :
// c'est une derivation pure, elle ne depend pas de la course en cours.

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
        // L'axe handling est courbe, pas droit : cf. `gripCurve` en config.
        const grip  = lerp(spec.grip.min, spec.grip.max,
                           Math.pow(norm.handling, spec.gripCurve));

        table[name] = {
            raw: raw,
            norm: norm,
            mass: mass,
            // Pointe additive : chaque axe apporte ses px/s, et les apporte
            // seul. La forme multiplicative d'avant faisait dependre le
            // rendement du poids de la puissance du kart, si bien qu'un
            // point lache sur la puissance devaluait les deux autres axes en
            // meme temps — il n'y avait plus de triangle, juste un axe fort.
            topSpeed: spec.speedBase
                + spec.speedPerWeight * norm.weight
                + spec.speedPerPower * norm.power,
            acceleration: clamp(force / Math.pow(mass, spec.massDragAccel),
                                spec.accelClamp.min, spec.accelClamp.max),
            agility: clamp(grip / Math.pow(mass, spec.massDragAgility),
                           spec.agilityClamp.min, spec.agilityClamp.max),

            // Ce qui tient un kart quand il tourne, donc ce que braquer lui coute
            // en vitesse (`steerCost`). Meme forme que ses deux voisines — les
            // trois axes bruts, le poids au denominateur — mais avec ses PROPRES
            // exposants : elle ne se deduit d'aucune autre stat.
            //
            // Batie sur `agility`, elle laissait `massDragAgility` gouverner deux
            // choses a la fois : la vitesse a laquelle un lourd tourne, ET ce que
            // tourner lui coute. Aux valeurs livrees elle rend exactement ce que
            // rendait `agility * force` — le decouplage ne change rien tant qu'on
            // ne s'en sert pas.
            cornering: Math.pow(grip, spec.cornerGripGain)
                * Math.pow(force, spec.cornerPowerGain)
                / Math.pow(mass, spec.cornerMassDrag)
        };
    }

    derivedStatsCache.set(cfg, table);
    return table;
}

// Agilite moyenne du plateau. Sert d'etalon partout ou il faut juger une
// situation et non un personnage — elle suit automatiquement le plateau,
// sans constante a retoucher quand les stats bougent.
const referenceAgilityCache = new WeakMap();

function referenceAgility(cfg) {
    const cached = referenceAgilityCache.get(cfg);
    if (cached !== undefined) return cached;

    const table = deriveCharacterStats(cfg);
    const names = Object.keys(table);
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

// Meilleure pointe qu'un objet autre que le bill permet d'atteindre, tous
// personnages confondus.
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

// Vitesse de croisiere du bill : le multiplicateur du porteur, releve au
// plancher commun quand celui-ci est plus haut.
function getBillSpeed(cfg, state, kart) {
    return Math.max(kart.stats.topSpeed * cfg.speeds.boosts.bill.multiplier,
                    state.billFloorSpeed);
}

// La pointe qu'un kart sous objet vise, et la vivacite avec laquelle il y monte.
// Un seul modele pour les trois objets (`speeds.boosts`).
//
// Rend null quand aucun n'est actif — c'est ce null qui fait basculer la vitesse
// entre le regime « elan » et le regime « objet ». Quand deux se cumulent, la
// pointe la plus haute gagne ; le bill prime sur tout, rien ne le module.
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
