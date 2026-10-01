// Lecture des circuits dessines.
// <- raceEngine/src/track.js
//
// Un circuit est un fichier .md de tracks/ contenant un dessin : `X` bord,
// `x` ligne, `B` boite, carre de `P`/`p` pour un tuyau. Vu de dessus, course
// vers la droite, la derniere colonne rejoignant la premiere.
//
// Ce fichier rend des cellules ; `apply_track` les convertit en distances et
// profondeurs.

#pragma once

#include <stdexcept>
#include <string>
#include <vector>

#include "config/config.hpp"

namespace track {

// Un caractere = un motif rouge/blanc de la bordure.
inline constexpr double CELL_PX = 80;

// Dessin invalide : message explicite pour l'auteur du circuit.
struct TrackError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct Cell {
    int col = 0;
    int row = 0;
};

// Tuyau dessine en carre de 2x2 : `col`/`row` = coin haut-gauche.
struct PipeCell {
    int col = 0;
    int row = 0;
    // `PP/PP` vert, `pp/pp` rouge ; la couleur ne sert qu'au decor.
    bool red = false;
};

struct Track {
    std::string name;
    std::string source;
    int columns = 0;
    int rows = 0;
    int finishColumn = -1;
    std::vector<Cell> boxes;
    std::vector<PipeCell> pipes;

    // Traces valides mais peu jouables.
    std::vector<std::string> warnings;
};

// Dessin en coordonnees de cellules ; `source` sert aux messages d'erreur.
Track parse_track(const std::string& text, const std::string& source);

// Pose le dessin sur une copie de la config.
config::Config apply_track(const config::Config& cfg, Track& track);

// Dossier des circuits (/app/tracks dans le conteneur, ou dans le depot).
std::string resolve_tracks_dir(const std::string& base);

// Circuits du dossier, tries par nom de fichier (ordre des manches). Un dessin
// invalide arrete le chargement.
std::vector<Track> load_tracks(const std::string& dir, const config::Config& cfg);

// Circuit d'une manche (a partir de 1), en rotation.
const Track& for_round(const std::vector<Track>& tracks, int round);

// Passage le plus etroit de la piste, tuyaux poses.
struct Passage {
    double free = 0;
    double x = 0;
};
Passage narrowest_passage(const config::Config& cfg,
                          const std::vector<std::pair<double, double>>& pipes,
                          double width);

} // namespace track
