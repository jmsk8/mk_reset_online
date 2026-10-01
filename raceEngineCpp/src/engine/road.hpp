// Bord de piste et contact entre karts.
// <- raceEngine/src/engine/road.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// Bord de piste : position bornee, frottement qui ralentit.
void clamp_kart_to_road(const config::Config& cfg, Kart& kart, double deltaTime);

// Contacts entre karts, une fois que tous ont bouge.
void resolve_kart_contacts(const config::Config& cfg, WorldState& state,
                           double now, double deltaTime, std::vector<Event>& events);

} // namespace engine
