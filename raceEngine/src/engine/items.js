// Tirage des objets (l'usage est dans weapons.js) : poids et usure.

import { clamp01, curve, ramp } from './math.js';
import { remainingDistance } from './geometry.js';
import { getDistanceToLeader, getKartByRank, getRaceStage, getRacingTail } from './standings.js';

// Un type present dans cfg.disabledItems ne sort jamais d'une boite.
function isItemEnabled(cfg, itemType) {
    const disabled = cfg.disabledItems;
    return !disabled || disabled.indexOf(itemType) === -1;
}

// Description d'orbite d'un type triple, ou null (`child` : objet largue).
function getOrbitSpec(cfg, itemType) {
    const specs = cfg.orbitItems;
    return (specs && specs[itemType]) ? specs[itemType] : null;
}

// Retrait differe : l'objet reste affiche le temps du choc, sans pouvoir heurter.
function spendItem(cfg, item, now) {
    if (item.spent) return;
    item.spent = true;
    item.deadAt = now + cfg.delays.itemLingerMs;
}

// Rang minimal exige (`lastRanks` compte depuis la fin de grille).
function minRankFor(profile, kartCount) {
    let min = profile.minRank || 1;
    if (profile.lastRanks) min = Math.max(min, kartCount - profile.lastRanks + 1);
    return min;
}

// Decote : chaque exemplaire distribue divise le poids du suivant, resorbee au
// fil des tours.
function decaySpecFor(cfg, itemType) {
    if (itemType === 'blueShell') return cfg.blueShell;
    const profile = cfg.itemDistribution.items[itemType];
    return (profile && profile.decay) ? profile : null;
}

function itemDecayOf(state, itemType) {
    const value = state.itemDecay[itemType];
    return (value === undefined) ? 1 : value;
}

function applyItemDecay(cfg, state, itemType) {
    const spec = decaySpecFor(cfg, itemType);
    if (!spec) return;
    state.itemDecay[itemType] = itemDecayOf(state, itemType) * spec.decay;
}

function regenItemDecay(cfg, state) {
    for (const itemType in state.itemDecay) {
        const spec = decaySpecFor(cfg, itemType);
        if (!spec || !spec.regenPerLap) continue;
        state.itemDecay[itemType] = Math.min(1, state.itemDecay[itemType] + spec.regenPerLap);
    }
}

// Reflux de fin de course pour les objets rares (`lateFade`), applique par-dessus
// la pression.
function lateFadeFactor(spec, stage) {
    const fade = spec && spec.lateFade;
    if (!fade) return 1;
    return 1 - fade.depth * ramp(stage, fade.from, fade.to);
}

// Un seul exemplaire en circulation ; un orage en cours compte pour l'eclair.
function isSingletonFree(state, itemType) {
    if (itemType === 'lightning' && state.storm) return false;
    for (let i = 0; i < state.karts.length; i++) {
        const held = state.karts[i].heldItem;
        if (held && held.type === itemType) return false;
    }
    return true;
}

// Poids d'un objet pour ce kart (0 : desactive, verrouille ou courbe eteinte).
function itemWeight(cfg, state, kart, itemType, profile, axes) {
    if (!isItemEnabled(cfg, itemType)) return 0;
    if (profile.minStage && axes.s < profile.minStage) return 0;
    if (profile.minDist && axes.d < profile.minDist) return 0;
    if (kart.rank < minRankFor(profile, state.karts.length)) return 0;
    if (profile.unique && !isSingletonFree(state, itemType)) return 0;

    let weight = profile.base;

    if (profile.power) {
        weight *= ramp(axes.pressure, profile.power.open, profile.power.full);
    } else {
        weight *= curve(profile.rank, axes.p);
        weight *= curve(profile.dist, axes.d);
        weight *= curve(profile.stage, axes.s);
        weight *= curve(profile.gap, axes.g);
    }

    if (profile.packBonus) weight *= 1 + profile.packBonus * (1 - axes.i);
    weight *= lateFadeFactor(profile, axes.s);
    if (kart.lastItem === itemType) weight *= cfg.itemDistribution.repeatPenalty;
    weight *= itemDecayOf(state, itemType);

    return weight > 0 ? weight : 0;
}

// Mesures dont depend la distribution.
function computeItemAxes(cfg, state, kart) {
    const spec = cfg.itemDistribution;
    const count = state.karts.length;

    const p = count > 1 ? clamp01((kart.rank - 1) / (count - 1)) : 0;
    const d = clamp01(getDistanceToLeader(state, kart) / spec.distanceRef);
    const s = getRaceStage(state);

    const ahead = getKartByRank(state, kart.rank - 1);
    const gapAhead = ahead ? remainingDistance(kart) - remainingDistance(ahead) : 0;
    const g = clamp01(gapAhead / spec.gapRef);

    const tail = getRacingTail(state);
    const spread = tail ? getDistanceToLeader(state, tail) : 0;
    const i = spec.spreadShare * clamp01(spread / spec.spreadRef)
        + (1 - spec.spreadShare) * g;

    const pressure = (spec.rankShare * p + (1 - spec.rankShare) * d)
        * (spec.stageBoost.base + spec.stageBoost.gain * s)
        * (spec.packBoost.base + spec.packBoost.gain * i);

    return { p: p, d: d, s: s, g: g, i: i, pressure: pressure };
}

// Tirage de la bleue, avant les poids, declenche par l'echappee du premier.
function rollBlueShell(cfg, state, rng, now, kart) {
    const spec = cfg.blueShell;
    if (!isItemEnabled(cfg, 'blueShell')) return false;
    if (now - state.blueShellLastAt < spec.cooldownMs) return false;

    const rankWeight = spec.rankWeights[kart.rank] || 0;
    if (rankWeight <= 0) return false;

    const leader = state.cachedLeader;
    if (!leader || leader.id === kart.id) return false;

    const second = getKartByRank(state, 2);
    const lead = second ? remainingDistance(second) - remainingDistance(leader) : 0;
    const escape = clamp01(lead / spec.leadRef);

    const stage = getRaceStage(state);
    const chance = spec.baseChance
        * ramp(stage, spec.stageWindow.from, spec.stageWindow.to)
        * lateFadeFactor(spec, stage)
        * (spec.leadFloor + spec.leadGain * escape)
        * rankWeight
        * itemDecayOf(state, 'blueShell');

    return chance > 0 && rng() < chance;
}

function rollItem(cfg, state, rng, now, kart) {
    if (rollBlueShell(cfg, state, rng, now, kart)) {
        applyItemDecay(cfg, state, 'blueShell');
        state.blueShellLastAt = now;
        return 'blueShell';
    }

    const profiles = cfg.itemDistribution.items;
    const axes = computeItemAxes(cfg, state, kart);

    // Seuls les poids non nuls entrent dans le tirage.
    const pool = [];
    let total = 0;
    for (const itemType in profiles) {
        const weight = itemWeight(cfg, state, kart, itemType, profiles[itemType], axes);
        if (weight <= 0) continue;
        pool.push({ type: itemType, weight: weight });
        total += weight;
    }

    // Tout verrouille : pas d'objet.
    if (total <= 0) return null;

    let roll = rng() * total;
    let chosen = pool[pool.length - 1].type;
    for (let i = 0; i < pool.length; i++) {
        roll -= pool[i].weight;
        if (roll <= 0) { chosen = pool[i].type; break; }
    }

    applyItemDecay(cfg, state, chosen);
    return chosen;
}

export {
    computeItemAxes,
    getOrbitSpec,
    isItemEnabled,
    regenItemDecay,
    rollItem,
    spendItem,
};
