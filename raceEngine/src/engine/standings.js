// Le classement : qui mene, qui suit, et ce que ca rapporte.

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

// Le mieux place parmi ceux qui courent encore : viser le tour d'honneur
// d'un kart deja arrive n'aurait aucun sens.
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

// Le dernier encore en course. Pendant de getRacingLeader : ensemble ils
// donnent l'etalement du peloton.
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

// Avancement du premier, 0 au depart a 1 a l'arrivee : mesure d'etape
// commune a tous les karts.
function getRaceStage(state) {
    const leader = state.cachedLeader;
    if (!leader || !leader.finishDistance) return 0;
    return clamp01(leader.totalDistance / leader.finishDistance);
}

// Classement reel, recalcule a chaque pas. Il porte `rank` et
// `cachedLeader`, dont dependent la distribution d'objets, l'agressivite et
// toutes les regles de place de l'IA — un rang vieux d'une demi-seconde
// ferait planifier un objet avec la place precedente, et le premier tirer
// vers l'avant juste apres avoir pris la tete. Trier huit karts ne coute
// rien ; c'est l'animation de depassement, plus bas, qui doit etre cadencee.
function updateRanks(state) {
    const karts = state.karts;
    const kartsLen = karts.length;

    const activeKarts = [];
    for (let i = 0; i < kartsLen; i++) {
        const k = karts[i];
        if (k.state === 'running' || k.state === 'hit') activeKarts.push(k);
    }
    if (activeKarts.length === 0) return null;

    // Position reelle = distance RESTANTE jusqu'a la ligne et non distance
    // parcourue : la grille etant en quinconce, les huit karts n'ont pas la meme
    // distance a couvrir. Un kart arrive garde ensuite sa place quoi qu'il fasse
    // — il roule au ralenti, et un poursuivant pourrait le depasser en distance
    // sans lui reprendre sa position.
    activeKarts.sort((a, b) => {
        if (a.finished || b.finished) {
            if (a.finished && b.finished) return a.finishRank - b.finishRank;
            return a.finished ? -1 : 1;
        }
        return remainingDistance(a) - remainingDistance(b);
    });

    state.cachedLeader = activeKarts[0];
    // Combien de places il y a a prendre, et non combien de karts existent :
    // c'est l'echelle sur laquelle un rang se lit. Un plateau ampute — des
    // karts encore en grille, une course a six — doit rendre les memes
    // extremes qu'un plateau complet, sinon le rang ne veut plus dire la
    // meme chose d'une course a l'autre.
    state.rankedCount = activeKarts.length;
    for (let i = 0; i < activeKarts.length; i++) activeKarts[i].rank = i + 1;

    return activeKarts;
}

// Les evenements de depassement, eux, restent cadences : chacun declenche
// une animation de glissement cote client, qui ne peut pas rejouer trente
// fois par seconde. `previousRanking` n'avance qu'avec eux, pour que le
// client voie bien le trajet complet d'une place a l'autre.
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

// Points du grand prix, attribues une fois la course close. `racePoints`
// ne vaut que pour la course qui vient de finir, `gpPoints` cumule depuis le
// debut du bloc. Les deux sont indexes par personnage et non par kart : les
// identifiants sont refaits a chaque course, les personnages non.
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
