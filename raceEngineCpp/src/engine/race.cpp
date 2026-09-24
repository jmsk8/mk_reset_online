#include "engine/race.hpp"

#include <algorithm>
#include <limits>
#include <cmath>

#include "engine/geometry.hpp"
#include "engine/standings.hpp"
#include "engine/step.hpp"

namespace engine {

namespace {

void set_sign(WorldState& state, const char* group, int frame,
              double now, double duration) {
    state.signGroup = group;
    state.signFrame = frame;
    state.signUntil = now + duration;
}

// Le coup d'envoi. Chaque kart tire SON depart : turbo pour la grande majorite,
// depart normal, ou cale d'une seconde.
void launch_karts(const config::Config& cfg, WorldState& state, Rng& rng,
                  double now, std::vector<Event>& events) {
    const config::RaceCfg& race = cfg.race;

    for (Kart& kart : state.karts) {
        kart.state = KartState::Running;

        const double roll = rng.next();
        Event ev;
        ev.type = EventType::StartBoost;
        ev.kartId = kart.id;

        if (roll < race.startTurboChance) {
            kart.boostEndTime = now + race.turboBoostMs;
            kart.absoluteVelocity = kart.stats->topSpeed;
            kart.momentum = 1;
            ev.value = 0; // turbo
        } else if (roll < race.startTurboChance + race.startNormalChance) {
            kart.absoluteVelocity = kart.stats->topSpeed * rng.range(0.85, 0.95);
            ev.value = 1; // normal
        } else {
            // Depart rate : le kart reste sur place, moteur noye.
            kart.startStallUntil = now + race.failStallMs;
            kart.absoluteVelocity = 0;
            kart.momentum = 0;
            ev.value = 2; // fail
        }
        events.push_back(ev);
    }
}

} // namespace

double countdown_duration(const config::RaceCfg& race) {
    return race.countdownHoldMs + 2 * race.lightIntervalMs;
}

void update_race(const config::Config& cfg, WorldState& state, Rng& rng,
                 double now, double deltaTime, std::vector<Event>& events) {
    (void)deltaTime;
    const config::RaceCfg& race = cfg.race;
    const Kart* leader = get_leader(state);
    if (!leader) return;

    // Tour du premier. `lapCount` compte les FRANCHISSEMENTS ; le premier
    // cloture le trajet depuis la grille et non un tour, d'ou le plancher a 1.
    //
    // Suivi HORS de la machine a phases, et c'est essentiel : la camera passe en
    // approche deux tours avant la fin, si bien que tenir ce compteur dans la
    // seule phase 'racing' le figeait pour les deux derniers tours de chaque
    // course.
    if (state.phase == Phase::Racing || state.phase == Phase::Finishing) {
        const int lap = std::min(race.laps, std::max(1, leader->lapCount));
        if (lap != state.leaderLap) state.leaderLap = lap;

        // Le panneau du dernier tour. Il sort quand le PREMIER approche la ligne
        // qui ouvre ce tour -- a `flagDistance`, comme le drapeau -- et reste en
        // main jusqu'a ce que le DERNIER l'ait passee d'autant. Le dernier est
        // relu a chaque pas (un depassement en queue change qui ferme la
        // marche) ; si le premier prend un tour au dernier, le drapeau le
        // remplace avant. Borne en distance et non en duree, hors de la machine
        // a phases : voir race.js, qui porte le raisonnement complet.
        const double width = cfg.world.width;
        const double leaderToLine = leader->finishDistance - leader->totalDistance - width;
        if (!state.finalSignShown && race.laps > 1 && leaderToLine <= race.flagDistance) {
            state.finalSignShown = true;
            set_sign(state, "laps", 0, now, race.maxRaceMs);
        } else if (state.signGroup == "laps") {
            double lastRemaining = -std::numeric_limits<double>::infinity();
            for (const Kart& kart : state.karts) {
                if (kart.finished) continue;
                lastRemaining = std::max(lastRemaining, kart.finishDistance - kart.totalDistance);
            }
            if (lastRemaining - width < -race.flagDistance) {
                state.signGroup.clear();
                state.signFrame = 0;
            }
        }

        // Et pour CHAQUE kart, s'il est dans sa propre zone de dernier tour : le
        // client montre le panneau du kart qu'il suit quand drapeau et dernier
        // tour se chevauchent (voir race.js).
        for (Kart& kart : state.karts) {
            const double toLine = kart.finishDistance - kart.totalDistance - width;
            kart.finalLapSign = state.finalSignShown && !kart.finished &&
                toLine <= race.flagDistance && toLine >= -race.flagDistance;
        }
    }

    // Le panneau s'efface tout seul.
    if (!state.signGroup.empty() && now > state.signUntil) {
        state.signGroup.clear();
        state.signFrame = 0;
    }

    if (state.phase == Phase::Countdown) {
        const double remaining = state.startAt - now;

        // Un feu par intervalle : la premiere image est tenue le temps de
        // l'attente, la quatrieme — le feu vert — n'apparait qu'au GO.
        const double elapsed = state.countdownMs - remaining;
        const int step = (elapsed < race.countdownHoldMs)
            ? 1
            : std::min(3, 2 + static_cast<int>(
                  std::floor((elapsed - race.countdownHoldMs) / race.lightIntervalMs)));

        if (state.signGroup != "start" || state.signFrame != step) {
            set_sign(state, "start", step, now, remaining + race.goSignMs);
        }

        if (now >= state.startAt) {
            state.phase = Phase::Racing;
            set_sign(state, "start", 4, now, race.goSignMs);
            launch_karts(cfg, state, rng, now, events);
            events.push_back({ EventType::RaceStart });
        }
        return;
    }

    if (state.phase == Phase::Racing) {
        const double remaining = leader->finishDistance - leader->totalDistance;

        if (remaining <= race.cameraApproachDistance) {
            state.phase = Phase::Finishing;
            state.hasCameraTarget = true;
            state.cameraTarget = park_position(cfg, race.parkFinishOffset);
            // Pas de drapeau ici : la camera se gare deux tours avant la fin et
            // la ligne reste a l'ecran tout ce temps. C'est la phase
            // 'finishing' qui sort Lakitu a l'approche REELLE.
            events.push_back({ EventType::RaceFinishing });
        }
        return;
    }

    if (state.phase == Phase::Finishing) {
        const double remaining = leader->finishDistance - leader->totalDistance;

        // Une fois sorti, le drapeau reste en main : il accompagne CHAQUE
        // passage, pas seulement le premier.
        if (!state.flagShown && remaining <= race.flagDistance) {
            state.flagShown = true;
            set_sign(state, "finish", 0, now, race.maxRaceMs);
        }

        // Deux facons de clore : le quota d'arrivees est atteint, ou le delai
        // large est depasse — un kart bloque ne doit pas figer le service. Dans
        // les deux cas les retardataires sont classes dans l'ordre ou ils
        // roulent.
        //
        // Quota borne sur le plateau reel, comme en JS : avec moins de karts
        // que prevu, le quota fixe ne serait jamais atteint.
        const int quota = std::min(race.stopAtFinisher,
                                   std::max(1, static_cast<int>(state.karts.size()) - 1));
        const bool quotaReached =
            static_cast<int>(state.finishOrder.size()) >= quota;
        const bool timedOut = now > state.startAt + race.maxRaceMs;

        if ((quotaReached || timedOut) && state.resultsAt == 0) {
            std::vector<Kart*> stragglers;
            for (Kart& kart : state.karts) {
                if (!kart.finished) stragglers.push_back(&kart);
            }
            std::sort(stragglers.begin(), stragglers.end(),
                      [](const Kart* a, const Kart* b) { return a->rank < b->rank; });

            for (Kart* kart : stragglers) {
                kart->finished = true;
                kart->finishRank = static_cast<int>(state.finishOrder.size()) + 1;
                state.finishOrder.push_back(kart->id);
            }

            award_race_points(cfg, state);

            // La derniere manche du bloc porte le classement general : on laisse
            // le temps de le lire.
            const bool isFinalRace = state.gpRound >= cfg.grandPrix.races;
            state.resultsAt = now + (isFinalRace ? race.finalResultsDelayMs
                                                 : race.resultsDelayMs);
            state.phase = Phase::Results;
            events.push_back({ EventType::RaceFinished });
        }
        return;
    }

    if (state.phase == Phase::Results && state.resultsAt > 0 && now >= state.resultsAt) {
        // Le SERVICE en tire une course neuve : c'est lui qui detient
        // `create_world_state` et les connexions a prevenir.
        Event ev;
        ev.type = EventType::RaceOver;
        ev.value = (state.gpRound >= cfg.grandPrix.races) ? 1 : 0;
        events.push_back(ev);

        // Repousse : sans ca l'evenement partirait a chaque tick jusqu'a ce que
        // le service ait fini de rebatir le monde.
        state.resultsAt = now + race.resultsDelayMs;
    }
}

} // namespace engine
