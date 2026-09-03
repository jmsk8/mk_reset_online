// Le TIRAGE d'un objet : qui a droit a quoi, et a quelle frequence.
// L'usage de l'objet une fois tire est dans `weapons.js` — ici on ne fait que
// peser les chances et entretenir l'usure qui evite les rafales.

import { clamp01, curve, ramp } from './math.js';
import { remainingDistance } from './geometry.js';
import { getDistanceToLeader, getKartByRank, getRaceStage, getRacingTail } from './standings.js';

// Interrupteur global : un type present dans cfg.disabledItems ne sort
// jamais d'une boite, son poids etant force a 0 dans tous les paliers.
function isItemEnabled(cfg, itemType) {
    const disabled = cfg.disabledItems;
    return !disabled || disabled.indexOf(itemType) === -1;
}

// Renvoie la description d'orbite d'un type triple, ou null si l'objet n'en
// est pas un. `child` est l'objet reellement largue a chaque activation.
function getOrbitSpec(cfg, itemType) {
    const specs = cfg.orbitItems;
    return (specs && specs[itemType]) ? specs[itemType] : null;
}

// Retire avec un sursis : l'objet reste affiche le temps qu'on voie le choc,
// sans plus rien pouvoir heurter.
function spendItem(cfg, item, now) {
    if (item.spent) return;
    item.spent = true;
    item.deadAt = now + cfg.delays.itemLingerMs;
}

// Rang minimal exige ; `lastRanks` se compte depuis la fin de grille et
// l'emporte s'il est plus restrictif.
function minRankFor(profile, kartCount) {
    let min = profile.minRank || 1;
    if (profile.lastRanks) min = Math.max(min, kartCount - profile.lastRanks + 1);
    return min;
}

// Decote : chaque exemplaire distribue divise le poids du suivant, pour
// tout le monde, resorbee tour apres tour. La bleue suit la meme regle via
// son propre bloc de config.
function decaySpecFor(cfg, itemType) {
    if (itemType === 'blueShell') return cfg.blueShell;
    const profile = cfg.itemDistribution.items[itemType];
    return (profile && profile.decay) ? profile : null;
}

// 1 tant qu'aucun exemplaire n'a ete distribue.
function itemDecayOf(state, itemType) {
    const value = state.itemDecay[itemType];
    return (value === undefined) ? 1 : value;
}

function applyItemDecay(cfg, state, itemType) {
    const spec = decaySpecFor(cfg, itemType);
    if (!spec) return;
    state.itemDecay[itemType] = itemDecayOf(state, itemType) * spec.decay;
}

// A chaque tour entame par le premier.
function regenItemDecay(cfg, state) {
    for (const itemType in state.itemDecay) {
        const spec = decaySpecFor(cfg, itemType);
        if (!spec || !spec.regenPerLap) continue;
        state.itemDecay[itemType] = Math.min(1, state.itemDecay[itemType] + spec.regenPerLap);
    }
}

// Reflux de fin de course. Les objets rares se concentrent naturellement sur le
// dernier tour — c'est la que les ecarts sont les plus grands — et une bleue
// quasi certaine au dernier tour tue le suspense.
//
// Ce terme ne corrige pas la pression : il s'applique par-dessus, et seulement
// sur la fin. Un objet sans `lateFade` n'est pas concerne.
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

// Poids d'un objet pour ce kart, dans cette situation. Zero se lit « pas
// lui, pas ici, pas maintenant » : desactive, verrouille, ou courbe eteinte.
function itemWeight(cfg, state, kart, itemType, profile, axes) {
    if (!isItemEnabled(cfg, itemType)) return 0;
    if (profile.minStage && axes.s < profile.minStage) return 0;
    if (profile.minDist && axes.d < profile.minDist) return 0;
    if (kart.rank < minRankFor(profile, state.karts.length)) return 0;
    if (profile.unique && !isSingletonFree(state, itemType)) return 0;

    let weight = profile.base;

    if (profile.power) {
        // Les objets puissants ne lisent que la pression.
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

// Les mesures dont depend toute la distribution, calculees a la demande.
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

// Tirage a part, joue avant les poids : declenche par l'echappee du
// premier, pas par le retard du tireur.
function rollBlueShell(cfg, state, rng, now, kart) {
    const spec = cfg.blueShell;
    if (!isItemEnabled(cfg, 'blueShell')) return false;
    if (now - state.blueShellLastAt < spec.cooldownMs) return false;

    // Un rang absent de la table n'en recoit jamais.
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

    // Seuls les poids non nuls entrent dans le tirage : un objet verrouille
    // ne peut donc pas etre choisi par un rng() rendant exactement 0.
    const pool = [];
    let total = 0;
    for (const itemType in profiles) {
        const weight = itemWeight(cfg, state, kart, itemType, profiles[itemType], axes);
        if (weight <= 0) continue;
        pool.push({ type: itemType, weight: weight });
        total += weight;
    }

    // Tout peut etre verrouille au meme instant : dans ce cas le kart repart
    // sans objet plutot que d'en recevoir un que la config interdit.
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
