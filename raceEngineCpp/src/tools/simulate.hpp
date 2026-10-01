// Banc d'equilibrage et soak.
// <- raceEngine/tools/simulate.js + server.js --duration
//
// Possible parce que `step_physics` ne lit ni l'horloge ni le hasard global.
//
//   race_engine --simulate --races 200 --seed 42     N courses hors horloge
//   race_engine --soak --duration 600                soak du moteur seul
//
// A graine egale, deux campagnes donnent le meme resultat. La parite flottante
// avec le JS n'est pas recherchee.

#pragma once

#include <string>
#include <vector>

#include "config/config.hpp"
#include "track.hpp"

namespace tools {

struct SimulateOptions {
    int races = 200;
    unsigned int seed = 0;
    bool hasSeed = false;
    bool csv = false;
    std::string trackFilter;
};

int run_simulate(const config::Config& cfg, const std::vector<track::Track>& tracks,
                 const SimulateOptions& opts);

// Soak : une course sans WebSocket pendant la duree demandee, avec controle
// d'integrite a chaque pas.
int run_soak(const config::Config& cfg, const std::vector<track::Track>& tracks,
             double durationSeconds);

} // namespace tools
