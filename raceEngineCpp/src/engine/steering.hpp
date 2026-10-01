// Loi de braquage. `steer()` est la seule fonction qui ecrit `vy` : un
// deplacement lateral passe toujours par une consigne (`laneY`).

#pragma once

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

// Allure du kart en fraction de sa propre pointe.
double steer_pace(const Kart& kart);

// Volant restant a l'allure du moment (`drag`), et mordant faute d'avancer
// (`bite`).
double steer_grip(const config::Config& cfg, const Kart& kart);
double steer_bite(const config::Config& cfg, const Kart& kart);

double steer_cap(const config::Config& cfg, const Kart& kart, double base);

// Consigne de volant puis integration.
void steer(const config::Config& cfg, Kart& kart, double deltaTime,
           double laneY, double speed, double gain, double tolerance);

} // namespace engine
