// Un pas de simulation : l'ordre dans lequel le monde avance.
// <- raceEngine/src/engine/step.js
//
// Cette fonction n'invente rien — elle appelle, dans un ordre qui compte, ce que
// les autres modules savent faire. La lire, c'est lire la course.
//
// Elle ne connait ni uWS, ni les sockets, ni JSON (plan §3 et §4.1bis) : elle
// prend l'etat, le fait avancer, et rend des evenements. C'est ce qui permet de
// la relire et de la modifier sans avoir une ligne de reseau sous les yeux.

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

// Seuls `kartHit`, `leaderboardPosition` et `pipeShaken` sont DIFFUSES au
// client : les autres decrivent des creations ou destructions que la
// reconciliation deduit deja du snapshot — les transmettre donnerait deux
// sources de verite.
enum class EventType {
    LeaderboardPosition,
    PipeShaken,
    KartFinished,
    RaceStart,
    RaceFinishing,
    RaceFinished,
    RaceOver,
    StartBoost
};

struct Event {
    EventType type;
    int kartId = 0;
    int value = 0;

    // `leaderboardPosition` : des INDICES, pas des rangs. -1 = inconnu.
    int newPosition = -1;
    int prevPosition = -1;

    // `pipeShaken` : l'index dans `hello.pipes`, et c'est ce qui le rend
    // indispensable — le tuyau est au meme endroit avant et apres, seul le
    // sursaut a eu lieu, rien dans le snapshot ne le dit.
    int pipeIndex = -1;
};

// Le pas. `now` est l'horloge de SIMULATION en ms (piege P-4), pas l'horloge
// murale : c'est elle qui avance de 1000/30 par appel.
std::vector<Event> step_physics(const config::Config& cfg, WorldState& state,
                                Rng& rng, double now, double deltaTime);

} // namespace engine
