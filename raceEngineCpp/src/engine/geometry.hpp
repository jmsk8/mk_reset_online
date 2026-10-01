// Distances et positions sur un circuit qui boucle : toute distance passe par
// ces fonctions, jamais par une soustraction directe.

#pragma once

#include "config/config.hpp"

namespace engine {

double get_shortest_distance(const config::Config& cfg, double fromX, double toX);

// Distance vers l'avant de `from` a `to` (la camera ne recule jamais).
double forward_distance(const config::Config& cfg, double from, double to);

// Position de la camera face a la ligne (centre de la vue).
double park_position(const config::Config& cfg, double offset);

// Ramene une abscisse dans [0, width), dans les deux sens.
double wrap_world_x(const config::Config& cfg, double x);

} // namespace engine
