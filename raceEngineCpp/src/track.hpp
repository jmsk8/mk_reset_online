// Lecture des circuits dessines.
// <- raceEngine/src/track.js
//
// Un circuit est un dessin dans tracks/, relu au demarrage. Le format tient en
// quelques caracteres — `X` bord, `x` ligne, `B` boite, `P`/`p` tuyaux — et le
// reste du fichier est de la prose : c'est un .md qui se lit sur GitHub.
//
// Vu de dessus, la course allant vers la droite, la derniere colonne touchant la
// premiere. Une colonne vaut CELL_PX px de monde ; les rangees se partagent la
// profondeur de la piste, qui reste une constante de physique.
//
// CE FICHIER NE CONNAIT PAS LA PHYSIQUE : il rend des cellules. C'est
// `apply_track` qui les pose sur une config — seul endroit ou une colonne
// devient une distance et une rangee une profondeur.

#pragma once

#include <stdexcept>
#include <string>
#include <vector>

#include "config/config.hpp"

namespace track {

// Un caractere = un motif rouge/blanc de la bordure, l'unite visible la plus
// fine du decor.
inline constexpr double CELL_PX = 80;

// Un dessin faux est une erreur d'AUTEUR, pas un plantage : le message dit quoi
// corriger, une pile d'appels ne dirait rien de plus.
struct TrackError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

struct Cell {
    int col = 0;
    int row = 0;
};

struct PipeCell {
    int col = 0;
    int row = 0;
    // Deux couleurs, un seul obstacle : `P` plante un vert, `p` un rouge, et
    // c'est TOUTE la difference. La couleur ne voyage que jusqu'au decor.
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

    // Ce qui se dessine sans etre faux, mais qui se joue mal. Des
    // avertissements et non des refus : c'est un choix de trace, pas une erreur.
    std::vector<std::string> warnings;
};

// Le dessin en coordonnees de CELLULES, sans notion de pixel ni de profondeur.
// `source` ne sert qu'aux messages d'erreur.
Track parse_track(const std::string& text, const std::string& source);

// Le dessin pose sur une config de physique. Rend une config NEUVE plutot que de
// modifier celle recue : deux courses d'un grand prix ne tournent pas sur le
// meme circuit.
config::Config apply_track(const config::Config& cfg, Track& track);

// Le dossier des circuits, cherche la ou il se trouve selon qu'on tourne dans le
// conteneur (monte en /app/tracks) ou dans le depot.
std::string resolve_tracks_dir(const std::string& base);

// Tous les circuits du dossier, dans l'ordre des NOMS DE FICHIERS : c'est cet
// ordre qui devient celui des manches d'un grand prix, donc il se pilote en
// nommant les fichiers 01-, 02-, ...
//
// Un dessin faux arrete le chargement au lieu d'etre saute : un circuit qui
// disparait en silence de la rotation se remarquerait trois courses plus tard.
std::vector<Track> load_tracks(const std::string& dir, const config::Config& cfg);

// Le circuit d'une manche. Le grand prix compte a partir de 1, et la rotation
// reboucle : quatre manches sur deux circuits alternent, ce qui reste jouable.
const Track& for_round(const std::vector<Track>& tracks, int round);

// Le passage le plus etroit de la piste, une fois les tuyaux poses.
struct Passage {
    double free = 0;
    double x = 0;
};
Passage narrowest_passage(const config::Config& cfg,
                          const std::vector<std::pair<double, double>>& pipes,
                          double width);

} // namespace track
