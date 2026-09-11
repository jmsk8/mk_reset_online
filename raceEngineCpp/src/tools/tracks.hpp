// Relecture des circuits dessines, hors service.
// <- raceEngine/tools/tracks.js
//
// Le moteur refuse de demarrer sur un dessin faux — c'est ce qu'on veut en
// production, mais pas au moment ou l'on dessine. Cette sous-commande fait la
// meme lecture et dit la meme chose, sans rien lancer :
//
//   race_engine --tracks           verifie tous les circuits et les resume
//   race_engine --tracks --order   ce que ca donne sur un grand prix entier
//
// Elle traduit surtout le dessin en CHIFFRES : combien de pixels fait le tour,
// ou tombe la ligne, a quelle profondeur chaque boite se pose. C'est la seule
// facon de verifier qu'un trace fait bien ce qu'on croyait dessiner.

#pragma once

#include "config/config.hpp"

namespace tools {

int run_tracks(const config::Config& cfg, bool showOrder);

} // namespace tools
