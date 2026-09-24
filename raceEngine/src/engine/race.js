// Le deroulement d'une course : la grille, le depart, les tours, l'arrivee.

import { parkPosition, remainingDistance } from './geometry.js';
import { getInitialKartSpeed } from './stats.js';
import { awardRacePoints, getLeader } from './standings.js';
import { regenItemDecay } from './items.js';

// Le coup d'envoi. Chaque kart tire son depart : turbo pour la grande
// majorite, depart normal, ou cale d'une seconde.
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

// Ce qu'il reste a parcourir au kart le plus en retard encore en course.
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

    // Tour du premier. `lapCount` compte les franchissements ; le premier
    // cloture le trajet depuis la grille et non un tour, d'ou le plancher a 1.
    //
    // Suivi hors de la machine a phases, et c'est essentiel : la camera passe
    // en approche deux tours avant la fin, si bien que tenir ce compteur dans
    // la seule phase 'racing' le figeait a 3 pour les deux derniers tours de
    // chaque course. Avec lui les decotes d'objets, qui ne se resorbaient
    // alors plus jamais — une bleue lancee au troisieme tour restait a demi
    // probabilite jusqu'a l'arrivee.
    if (state.phase === 'racing' || state.phase === 'finishing') {
        const lap = Math.min(race.laps, Math.max(1, leader.lapCount));
        if (lap !== state.leaderLap) {
            state.leaderLap = lap;
            regenItemDecay(cfg, state);
        }

        // Le panneau du dernier tour. Il sort quand le PREMIER approche la
        // ligne qui ouvre ce tour -- a `flagDistance`, comme le drapeau -- et
        // reste en main jusqu'a ce que le DERNIER l'ait passee d'autant : chaque
        // kart passe devant lui en entamant son dernier tour. Borne en distance
        // et non en duree : un kart retarde a l'approche aurait vu un delai fixe
        // expirer avant son passage.
        //
        // Le dernier est relu a chaque pas, pas fige a la sortie du panneau :
        // un depassement en queue de peloton change qui ferme la marche. Et si
        // le premier prend un tour au dernier, il arrive au drapeau avant que
        // celui-ci n'entame son dernier tour : le drapeau remplace le panneau
        // (setSign), qui ne revient plus.
        //
        // Hors de la machine a phases pour la meme raison que le compteur
        // ci-dessus : a cet instant la course est deja en 'finishing' (la camera
        // s'approche deux tours avant la fin). Tenu dans la seule phase
        // 'racing', il ne sortait jamais.
        const width = cfg.world.width;
        if (!state.finalSignShown && race.laps > 1 &&
            remainingDistance(leader) - width <= race.flagDistance) {
            state.finalSignShown = true;
            setSign(state, 'laps', 'final', now, race.maxRaceMs);
        } else if (state.sign && state.sign.group === 'laps' &&
                   lastRemaining(state) - width < -race.flagDistance) {
            state.sign = null;
        }

        // Et pour CHAQUE kart, s'il est dans sa propre zone de dernier tour.
        // Le panneau du service est unique, mais la camera est propre a chaque
        // spectateur : quand le premier prend un tour au dernier, le drapeau
        // (pour lui) et le dernier tour (pour le dernier) se chevauchent, et
        // c'est au client de montrer celui du kart qu'il suit.
        for (const kart of state.karts) {
            const toLine = remainingDistance(kart) - width;
            kart.finalLapSign = state.finalSignShown && !kart.finished &&
                toLine <= race.flagDistance && toLine >= -race.flagDistance;
        }
    }

    if (state.phase === 'countdown') {
        // Un feu par seconde jusqu'au depart : les quatre images de
        // lakitu/start sont montrees dans l'ordre.
        const remaining = state.startAt - now;

        // Premiere image tenue le temps de l'attente, puis un feu par
        // intervalle. La quatrieme, le feu vert, n'apparait qu'au GO.
        const elapsed = state.countdownMs - remaining;
        const step = elapsed < race.countdownHoldMs
            ? 1
            : Math.min(3, 2 + Math.floor((elapsed - race.countdownHoldMs) / race.lightIntervalMs));
        if (!state.sign || state.sign.group !== 'start' || state.sign.frame !== step) {
            setSign(state, 'start', step, now, remaining + race.goSignMs);
        }

        if (now >= state.startAt) {
            state.phase = 'racing';
            // La quatrieme image est le feu vert : elle n'apparait qu'au
            // coup d'envoi, pas pendant le decompte.
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

            // Pas de drapeau ici : la camera se gare deux tours avant la
            // fin et la ligne reste a l'ecran tout ce temps, sortir Lakitu
            // des maintenant le laisserait plante la une demi-course. C'est
            // la phase 'finishing' qui le sort a l'approche reelle.
            events.push({ type: 'raceFinishing' });
        }
        return;
    }

    if (state.phase === 'finishing') {
        // Le drapeau ne sort qu'a l'approche reelle de la ligne, pas des le
        // repositionnement de la camera. Une fois sorti il reste en main :
        // il accompagne chaque passage, pas seulement le premier.
        if (!state.flagShown && leader && remainingDistance(leader) <= race.flagDistance) {
            state.flagShown = true;
            setSign(state, 'finish', 1, now, race.maxRaceMs);
        }

        // Deux facons de clore la course : le quota d'arrivees est atteint,
        // ou le delai large est depasse — un kart bloque ne doit pas figer
        // le service. Dans les deux cas les retardataires sont classes dans
        // l'ordre ou ils roulent.
        // Borne sur le plateau reel : avec moins de karts que prevu (des
        // personnages retires du tirage, `roster`), le quota fixe ne serait
        // jamais atteint et chaque course irait jusqu'a `maxRaceMs`. A 8 karts,
        // rien ne change.
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

            // La derniere course du bloc porte le classement general : on
            // laisse le temps de le lire.
            const isFinalRace = state.gpRound >= cfg.grandPrix.races;
            state.resultsAt = now + (isFinalRace ? race.finalResultsDelayMs : race.resultsDelayMs);
            state.phase = 'results';
            events.push({ type: 'raceFinished' });
        }
        return;
    }

    if (state.phase === 'results' && now >= state.resultsAt) {
        // Le service en tire une course neuve : c'est lui qui detient
        // createWorldState et les connexions a prevenir. `gpComplete` lui
        // dit s'il repart sur un bloc neuf — scores remis a zero et grille
        // tiree au sort — ou sur la course suivante du bloc en cours.
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
