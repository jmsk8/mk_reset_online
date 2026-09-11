#include "tools/tracks.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "track.hpp"

namespace tools {

namespace {

// Les nombres du JS s'ecrivent sans decimale inutile (`7680`, pas `7680.0`) :
// la sortie doit se comparer telle quelle a celle de l'outil node.
std::string num(double v) {
    if (v == std::floor(v) && std::abs(v) < 1e15) {
        return std::to_string(static_cast<long long>(v));
    }
    char buf[32];
    std::snprintf(buf, sizeof(buf), "%g", v);
    return buf;
}

std::string fixed(double v, int decimals) {
    char buf[64];
    std::snprintf(buf, sizeof(buf), "%.*f", decimals, v);
    return buf;
}

} // namespace

int run_tracks(const config::Config& cfg, bool showOrder) {
    std::string dir;
    std::vector<track::Track> tracks;

    try {
        dir = track::resolve_tracks_dir(".");
        tracks = track::load_tracks(dir, cfg);
    } catch (const std::exception& err) {
        std::printf("✗ %s\n", err.what());
        return 1;
    }

    std::printf("%zu circuit(s) dans %s\n\n", tracks.size(), dir.c_str());

    int warned = 0;

    for (track::Track& circuit : tracks) {
        config::Config applied;
        try {
            applied = track::apply_track(cfg, circuit);
        } catch (const std::exception& err) {
            std::printf("✗ %s\n", err.what());
            return 1;
        }

        const double width = applied.world.width;

        // Duree d'un tour a la vitesse de defilement : c'est la mesure qui
        // parle, bien plus qu'un nombre de pixels.
        const double lapSeconds = width / applied.speeds.roadPPS;

        std::printf("── %s  [%s]\n", circuit.name.c_str(), circuit.source.c_str());
        std::printf("   tour     %d colonnes = %s px  (~%s s le tour, ~%s s la course)\n",
                    circuit.columns, num(width).c_str(),
                    fixed(lapSeconds, 1).c_str(),
                    fixed(lapSeconds * applied.race.laps, 0).c_str());
        std::printf("   ligne    colonne %d = %s px\n",
                    circuit.finishColumn, num(applied.world.finishLineX).c_str());
        std::printf("   piste    %d rangees sur %s..%s de profondeur\n",
                    circuit.rows, num(applied.road.minY).c_str(), num(applied.road.maxY).c_str());
        std::printf("   camera   approche a %s px de l'arrivee\n",
                    num(applied.race.cameraApproachDistance).c_str());

        // Les boites sont regroupees par colonne : c'est ainsi qu'un pilote les
        // rencontre — un rideau a franchir, pas des boites eparpillees.
        std::map<double, std::vector<double>> columns;
        for (const config::Placed& box : applied.world.itemBoxes) {
            columns[box.x].push_back(box.y);
        }

        std::printf("   boites   %zu en %zu rideau(x)\n",
                    applied.world.itemBoxes.size(), columns.size());
        for (const auto& entry : columns) {
            double after = entry.first - applied.world.finishLineX;
            if (after < 0) after += width;

            std::string depths;
            for (size_t i = 0; i < entry.second.size(); i++) {
                if (i) depths += ", ";
                depths += fixed(entry.second[i], 1);
            }
            std::printf("            x=%s (%lld %% du tour apres la ligne)  profondeurs %s\n",
                        num(entry.first).c_str(),
                        static_cast<long long>(std::llround((after / width) * 100)),
                        depths.c_str());
        }

        // Les tuyaux, et surtout ce qu'ils laissent passer. Un trace se juge
        // la : un passage juste au-dessus du minimum se franchit, mais tout un
        // peloton n'y tient pas de front.
        if (!applied.world.pipes.empty()) {
            std::string list;
            std::vector<std::pair<double, double>> flat;
            for (size_t i = 0; i < applied.world.pipes.size(); i++) {
                const config::Placed& p = applied.world.pipes[i];
                if (i) list += "  |  ";
                list += "x=" + num(p.x) + " y=" + fixed(p.y, 1) + " "
                     + (p.red ? "red" : "green");
                flat.emplace_back(p.x, p.y);
            }
            std::printf("   pipes    %zu : %s\n", applied.world.pipes.size(), list.c_str());

            const track::Passage passage = track::narrowest_passage(applied, flat, width);
            std::printf("   passage  %s de libre au plus etroit (vers x=%lld), "
                        "minimum exige %s\n",
                        fixed(passage.free, 1).c_str(),
                        static_cast<long long>(std::llround(passage.x)),
                        num(applied.pipe.minPassageY).c_str());
        }

        for (const std::string& warning : circuit.warnings) {
            std::printf("   ⚠ %s\n", warning.c_str());
            warned++;
        }
        std::printf("\n");
    }

    if (showOrder) {
        std::printf("Grand prix de %d manches :\n", cfg.grandPrix.races);
        for (int round = 1; round <= cfg.grandPrix.races; round++) {
            std::printf("   manche %d — %s\n", round,
                        track::for_round(tracks, round).name.c_str());
        }
        std::printf("\n");
    }

    if (warned) {
        std::printf("✓ %zu circuit(s) lisible(s), %d avertissement(s).\n",
                    tracks.size(), warned);
    } else {
        std::printf("✓ %zu circuit(s) lisible(s), rien a signaler.\n", tracks.size());
    }
    return 0;
}

} // namespace tools
