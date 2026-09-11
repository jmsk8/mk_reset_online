// Collisions, rebonds et evitement des tuyaux.
// <- raceEngine/src/engine/pipes.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// Le kart contre le tuyau.
//
// Masse infinie : rien ne se transmet au tuyau, tout est pour le kart. Arrete
// net, recule un peu, repart de zero — c'est son ACCELERATION qui decide de ce
// que le choc lui aura coute, ce qui fait payer les lourds sans qu'aucune
// penalite ne soit ecrite pour eux.
void collide_kart_with_pipes(const config::Config& cfg, WorldState& state,
                             Kart& kart, double now, std::vector<Event>& events);

} // namespace engine
