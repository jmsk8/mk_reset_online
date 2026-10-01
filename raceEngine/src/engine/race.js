// Deroulement d'une course : grille, depart, tours, arrivee.

import { parkPosition, remainingDistance } from './geometry.js';
import { getInitialKartSpeed } from './stats.js';
import { awardRacePoints, getLeader } from './standings.js';
import { regenItemDecay } from './items.js';

// Depart de chaque kart : turbo, normal ou cale d'une seconde.
function launchKarts(cfg, state, rng, now, events) {
    const race = cfg.race;

    for (const kart of state.karts) {
        kart.state = 'running';

        const roll = rng();
        if (roll < race.startTurboChance) {
            kart.boostEndTime = now + race.turboBoostMs;
            kart.absoluteVelocity = kart.stats.topSpeed;
            kart.momentum = 1;
            events.push({ type: 'startBoost', kartId: kart.id, kind: 'turbo' });
        } else if (roll < race.startTurboChance + race.startNormalChance) {
            kart.absoluteVelocity = getInitialKartSpeed(rng, kart.stats);
            events.push({ type: 'startBoost', kartId: kart.id, kind: 'normal' });
        } else {
            kart.startStallUntil = now + race.failStallMs;
            kart.absoluteVelocity = 0;
            kart.momentum = 0;
            events.push({ type: 'startBoost', kartId: kart.id, kind: 'fail' });
        }
    }
}

// Distance restante du dernier kart encore en course.
function lastRemaining(state) {
    let most = -Infinity;
    for (const kart of state.karts) {
        if (kart.finished) continue;
        const left = remainingDistance(kart);
        if (left > most) most = left;
    }
    return most;
}

function setSign(state, group, frame, now, duration) {
    state.sign = { group: group, frame: frame, until: now + duration };
}

function countdownDuration(race) {
    return race.countdownHoldMs + 2 * race.lightIntervalMs;
}

function updateRace(cfg, state, rng, now, deltaTime, events) {
    const race = cfg.race;
    const leader = getLeader(state);

    // Tour du premier (plancher a 1 : le premier franchissement clot le trajet
    // depuis la grille). Suivi en 'racing' et en 'finishing'.
    if (state.phase === 'racing' || state.phase === 'finishing') {
        const lap = Math.min(race.laps, Math.max(1, leader.lapCount));
        if (lap !== state.leaderLap) {
            state.leaderLap = lap;
            regenItemDecay(cfg, state);
        }

        // Panneau du dernier tour : sort quand le premier approche la ligne
        // (`flagDistance`) et reste jusqu'a ce que le dernier l'ait passee
        // d'autant. Le drapeau le remplace si le premier prend un tour au dernier.
        const width = cfg.world.width;
        if (!state.finalSignShown && race.laps > 1 &&
            remainingDistance(leader) - width <= race.flagDistance) {
            state.finalSignShown = true;
            setSign(state, 'laps', 'final', now, race.maxRaceMs);
        } else if (state.sign && state.sign.group === 'laps' &&
                   lastRemaining(state) - width < -race.flagDistance) {
            state.sign = null;
        }

        // Zone de dernier tour propre a chaque kart (le client montre celle du
        // kart qu'il suit).
        for (const kart of state.karts) {
            const toLine = remainingDistance(kart) - width;
            kart.finalLapSign = state.finalSignShown && !kart.finished &&
                toLine <= race.flagDistance && toLine >= -race.flagDistance;
        }
    }

    if (state.phase === 'countdown') {
        // Un feu par seconde jusqu'au depart.
        const remaining = state.startAt - now;

        // Premiere image tenue pendant l'attente ; le feu vert n'apparait qu'au GO.
        const elapsed = state.countdownMs - remaining;
        const step = elapsed < race.countdownHoldMs
            ? 1
            : Math.min(3, 2 + Math.floor((elapsed - race.countdownHoldMs) / race.lightIntervalMs));
        if (!state.sign || state.sign.group !== 'start' || state.sign.frame !== step) {
            setSign(state, 'start', step, now, remaining + race.goSignMs);
        }

        if (now >= state.startAt) {
            state.phase = 'racing';
            // Feu vert au coup d'envoi.
            setSign(state, 'start', 4, now, race.goSignMs);
            launchKarts(cfg, state, rng, now, events);
            events.push({ type: 'raceStart' });
        }
        return;
    }

    if (state.phase === 'racing') {
        if (remainingDistance(leader) <= race.cameraApproachDistance) {
            state.phase = 'finishing';
            state.cameraTarget = parkPosition(cfg, race.parkFinishOffset);

            // Le drapeau sort plus tard, a l'approche reelle de la ligne.
            events.push({ type: 'raceFinishing' });
        }
        return;
    }

    if (state.phase === 'finishing') {
        // Drapeau a l'approche reelle de la ligne, garde ensuite.
        if (!state.flagShown && leader && remainingDistance(leader) <= race.flagDistance) {
            state.flagShown = true;
            setSign(state, 'finish', 1, now, race.maxRaceMs);
        }

        // Fin de course : quota d'arrivees atteint (borne par le nombre de
        // karts) ou delai maximal depasse ; les retardataires sont classes dans
        // l'ordre ou ils roulent.
        const quota = Math.min(race.stopAtFinisher, Math.max(1, state.karts.length - 1));
        const quotaReached = state.finishOrder.length >= quota;
        const timedOut = now > state.startAt + race.maxRaceMs;

        if ((quotaReached || timedOut) && !state.resultsAt) {
            const stragglers = state.karts.filter(kart => !kart.finished)
                .sort((a, b) => a.rank - b.rank);
            for (const kart of stragglers) {
                kart.finished = true;
                kart.finishRank = state.finishOrder.length + 1;
                state.finishOrder.push(kart.id);
            }

            awardRacePoints(cfg, state);

            // Plus de temps pour lire le classement general a la fin du bloc.
            const isFinalRace = state.gpRound >= cfg.grandPrix.races;
            state.resultsAt = now + (isFinalRace ? race.finalResultsDelayMs : race.resultsDelayMs);
            state.phase = 'results';
            events.push({ type: 'raceFinished' });
        }
        return;
    }

    if (state.phase === 'results' && now >= state.resultsAt) {
        // Le service lance la course suivante ; `gpComplete` indique un bloc neuf.
        events.push({
            type: 'raceOver',
            order: state.finishOrder.slice(),
            gpRound: state.gpRound,
            gpComplete: state.gpRound >= cfg.grandPrix.races,
            gpPoints: Object.assign({}, state.gpPoints)
        });
        state.resultsAt = now + race.resultsDelayMs;
    }
}

export {
    countdownDuration,
    updateRace,
};
