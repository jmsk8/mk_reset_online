// Le banc d'equilibrage, et le soak.
// <- raceEngine/tools/simulate.js + server.js --duration
//
// Le moteur est PUR : `step_physics` ne lit ni l'horloge, ni le hasard global —
// tout arrive en parametre. C'est ce qui rend ce banc possible, et il faut que
// ca le reste (architecture.md §6).
//
//   race_engine --simulate --races 200 --seed 42     N courses hors horloge
//   race_engine --soak --duration 600                soak du moteur seul
//
// A graine egale, deux campagnes rendent le meme resultat : c'est la propriete
// qui permet de comparer deux reglages. La parite flottante avec le JS, elle,
// n'est pas un objectif (piege P-5) — on vise l'equivalence de COMPORTEMENT.

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

// Le soak : une course qui tourne le temps demande, sans WebSocket, avec un
// controle d'integrite a chaque pas.
int run_soak(const config::Config& cfg, const std::vector<track::Track>& tracks,
             double durationSeconds);

} // namespace tools
