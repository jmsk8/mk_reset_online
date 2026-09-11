// Classement, points, etapes de course.
// <- raceEngine/src/engine/standings.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// Le premier, au sens du classement : celui a qui il reste le moins a parcourir.
const Kart* get_leader(const WorldState& state);

// Les rangs, par distance RESTANTE — jamais `totalDistance` : les karts partent
// de lignes differentes, comparer leurs compteurs bruts placerait la pole en
// dernier au premier virage.
void update_leaderboard(const config::Config& cfg, WorldState& state, double now,
                        std::vector<Event>& events);

// Les points d'une manche, indexes par NOM DE PERSONNAGE et non par id : les ids
// sont reconstruits a chaque course, les personnages non.
void award_race_points(const config::Config& cfg, WorldState& state);

} // namespace engine
