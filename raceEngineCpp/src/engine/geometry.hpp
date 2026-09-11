// Distances et positions sur un circuit qui BOUCLE.
// <- raceEngine/src/engine/geometry.js
//
// Rien ici ne connait ni kart ni objet : ce sont des mesures sur l'axe de la
// piste, et elles valent pour n'importe quel corps pose dessus.
//
// Piege P-6 du plan : toute distance passe par ces fonctions, JAMAIS par une
// soustraction directe. Deux positions proches de part et d'autre de l'origine
// du monde donneraient sinon un ecart de presque un tour.

#pragma once

#include "config/config.hpp"

namespace engine {

double get_shortest_distance(const config::Config& cfg, double fromX, double toX);

// Distance a parcourir VERS L'AVANT pour aller de `from` a `to`. La camera ne
// recule jamais : le decor defilerait a l'envers.
double forward_distance(const config::Config& cfg, double from, double to);

// Position de la camera face a la ligne. La camera designe le CENTRE de la vue,
// donc un ecart negatif place la ligne a droite du centre.
double park_position(const config::Config& cfg, double offset);

// Ramene une abscisse dans [0, width). Le monde boucle : c'est le seul endroit
// qui a le droit de le faire, et il le fait dans les deux sens — un kart
// repousse par un tuyau peut reculer a travers l'origine.
double wrap_world_x(const config::Config& cfg, double x);

} // namespace engine
