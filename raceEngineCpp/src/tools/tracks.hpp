// Verification des circuits dessines, sans lancer le service.
// <- raceEngine/tools/tracks.js
//
//   race_engine --tracks           verifie tous les circuits et les resume
//   race_engine --tracks --order   deroulement sur un grand prix entier
//
// Affiche les chiffres du trace : longueur du tour, position de la ligne,
// profondeur des boites.

#pragma once

#include "config/config.hpp"

namespace tools {

int run_tracks(const config::Config& cfg, bool showOrder);

} // namespace tools
