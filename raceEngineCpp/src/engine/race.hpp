// Le deroulement d'une course : la grille, le depart, les tours, l'arrivee.
// <- raceEngine/src/engine/race.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

double countdown_duration(const config::RaceCfg& race);

// La machine a phases : countdown -> racing -> finishing -> results.
void update_race(const config::Config& cfg, WorldState& state, Rng& rng,
                 double now, double deltaTime, std::vector<Event>& events);

} // namespace engine
