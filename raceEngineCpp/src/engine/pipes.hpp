// Collisions, rebonds et evitement des tuyaux.
// <- raceEngine/src/engine/pipes.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// Choc d'un kart contre un tuyau (masse infinie) : arret net, recul, repart de zero.
void collide_kart_with_pipes(const config::Config& cfg, WorldState& state,
                             Kart& kart, double now, std::vector<Event>& events);

} // namespace engine
