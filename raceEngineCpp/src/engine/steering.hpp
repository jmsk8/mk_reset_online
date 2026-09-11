// La loi de braquage : ce qu'un kart PEUT faire du volant.
// <- raceEngine/src/engine/steering.js
//
// `steer()` est la SEULE fonction qui ecrit `vy`. Invariant obtenu au prix fort
// (audit-pilotage-2026-08.md §7.2) : il ne se reperd pas. Tout ce qui veut
// deplacer un kart lateralement passe par une CONSIGNE (`laneY`), jamais par
// une ecriture directe.

#pragma once

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

// Allure du kart, en fraction de SA propre pointe. Rapportee a la sienne et non
// a une vitesse absolue : ce qui compte n'est pas de rouler vite dans l'absolu
// mais d'etre lance pour soi.
double steer_pace(const Kart& kart);

// Ce qu'il reste de volant a l'allure du moment (`drag`), et ce que le volant
// MORD faute d'avancer (`bite`). Deux mecaniques distinctes : sans `bite`, un
// kart IMMOBILE disposerait de son volant maximum et repartirait en crabe apres
// un choc.
double steer_grip(const config::Config& cfg, const Kart& kart);
double steer_bite(const config::Config& cfg, const Kart& kart);

double steer_cap(const config::Config& cfg, const Kart& kart, double base);

// La consigne de volant, puis son integration. C'est ICI et nulle part ailleurs
// que `vy` change.
void steer(const config::Config& cfg, Kart& kart, double deltaTime,
           double laneY, double speed, double gain, double tolerance);

} // namespace engine
