// Un pas de simulation : appelle dans l'ordre ce que les autres modules font,
// sans reseau ni JSON.

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

// Seuls `kartHit`, `leaderboardPosition` et `pipeShaken` sont diffuses ; le
// reste se deduit du snapshot.
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

    // `leaderboardPosition` : indices, -1 = inconnu.
    int newPosition = -1;
    int prevPosition = -1;

    // `pipeShaken` : index dans `hello.pipes`.
    int pipeIndex = -1;
};

// Le pas ; `now` est l'horloge de simulation en ms.
std::vector<Event> step_physics(const config::Config& cfg, WorldState& state,
                                Rng& rng, double now, double deltaTime);

} // namespace engine
