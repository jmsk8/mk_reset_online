// Classement, points, etapes de course.
// <- raceEngine/src/engine/standings.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// Le premier : celui a qui il reste le moins a parcourir.
const Kart* get_leader(const WorldState& state);

// Rangs par distance restante (les karts ne partent pas de la meme ligne).
void update_leaderboard(const config::Config& cfg, WorldState& state, double now,
                        std::vector<Event>& events);

// Points d'une manche, indexes par personnage (les ids changent a chaque course).
void award_race_points(const config::Config& cfg, WorldState& state);

} // namespace engine
