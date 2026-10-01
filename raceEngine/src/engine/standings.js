// Classement et points.

import { clamp01 } from './math.js';
import { remainingDistance } from './geometry.js';

function getKartByRank(state, rank) {
    return state.karts.find(k => k.rank === rank && (k.state === 'running' || k.state === 'hit')) || null;
}

function getLeader(state) {
    let leader = null;
    for (const kart of state.karts) {
        if (!leader || kart.totalDistance > leader.totalDistance) leader = kart;
    }
    return leader;
}

// Le mieux place parmi les karts encore en course.
function getRacingLeader(state) {
    let best = null;
    for (let i = 0; i < state.karts.length; i++) {
        const kart = state.karts[i];
        if (kart.finished) continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;
        if (!best || kart.rank < best.rank) best = kart;
    }
    return best;
}

// Le dernier encore en course.
function getRacingTail(state) {
    let worst = null;
    for (let i = 0; i < state.karts.length; i++) {
        const kart = state.karts[i];
        if (kart.finished) continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;
        if (!worst || kart.rank > worst.rank) worst = kart;
    }
    return worst;
}

function getDistanceToLeader(state, kart) {
    const leader = state.cachedLeader;
    if (!leader || leader.id === kart.id) return 0;
    return remainingDistance(kart) - remainingDistance(leader);
}

// Avancement du premier, de 0 au depart a 1 a l'arrivee.
function getRaceStage(state) {
    const leader = state.cachedLeader;
    if (!leader || !leader.finishDistance) return 0;
    return clamp01(leader.totalDistance / leader.finishDistance);
}

// Classement reel, recalcule a chaque pas (rank et cachedLeader alimentent la
// distribution d'objets et l'IA). Seule l'animation de depassement est cadencee.
function updateRanks(state) {
    const karts = state.karts;
    const kartsLen = karts.length;

    const activeKarts = [];
    for (let i = 0; i < kartsLen; i++) {
        const k = karts[i];
        if (k.state === 'running' || k.state === 'hit') activeKarts.push(k);
    }
    if (activeKarts.length === 0) return null;

    // Tri sur la distance restante (grille en quinconce) ; un kart arrive garde
    // sa place.
    activeKarts.sort((a, b) => {
        if (a.finished || b.finished) {
            if (a.finished && b.finished) return a.finishRank - b.finishRank;
            return a.finished ? -1 : 1;
        }
        return remainingDistance(a) - remainingDistance(b);
    });

    state.cachedLeader = activeKarts[0];
    // Nombre de places a prendre, echelle de lecture d'un rang.
    state.rankedCount = activeKarts.length;
    for (let i = 0; i < activeKarts.length; i++) activeKarts[i].rank = i + 1;

    return activeKarts;
}

// Evenements de depassement cadences (animation cote client) ;
// `previousRanking` n'avance qu'avec eux.
function updateLeaderboard(state, now, events) {
    const activeKarts = updateRanks(state);
    if (!activeKarts) return;

    if (now - state.lastLeaderboardUpdate < 500) return;
    state.lastLeaderboardUpdate = now;

    const newRanking = [];
    const prevRanking = state.previousRanking;

    for (let i = 0; i < activeKarts.length; i++) {
        const kart = activeKarts[i];
        newRanking.push(kart.id);

        events.push({
            type: 'leaderboardPosition',
            kartId: kart.id,
            newPosition: i,
            prevPosition: prevRanking.indexOf(kart.id)
        });
    }

    state.previousRanking = newRanking;
}

// Points du grand prix, une fois la course close. `racePoints` pour la course,
// `gpPoints` cumules ; indexes par personnage (les ids changent a chaque course).
function awardRacePoints(cfg, state) {
    const table = cfg.grandPrix.points;

    for (let i = 0; i < state.finishOrder.length; i++) {
        const kart = state.kartsById[state.finishOrder[i]];
        const points = (i < table.length) ? table[i] : 0;
        state.racePoints[kart.charName] = points;
        state.gpPoints[kart.charName] = (state.gpPoints[kart.charName] || 0) + points;
    }
}

export {
    awardRacePoints,
    getDistanceToLeader,
    getKartByRank,
    getLeader,
    getRaceStage,
    getRacingLeader,
    getRacingTail,
    updateLeaderboard,
};
