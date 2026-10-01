// Moteur de course du banner SMK, version C++.
// <- raceEngine/src/server.js : arguments, signaux, boucle, enchainement GP.
//
//   race_engine                     service normal (HTTP + WebSocket)
//   race_engine --karts 4           4 karts au lieu de 8 (dev seulement, 1 a 12)
//   race_engine --always-on         simule meme sans spectateur
//
// Une seule course, regardee par tous les navigateurs.

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>
#include <vector>

#include "config/config.hpp"
#include "service/server.hpp"
#include "tools/simulate.hpp"
#include "tools/tracks.hpp"
#include "track.hpp"

namespace {

std::string arg_value(const std::vector<std::string>& args, const std::string& name) {
    for (size_t i = 0; i < args.size(); i++) {
        // `--karts 4` ou `--karts=4`.
        if (args[i] == name && i + 1 < args.size()) return args[i + 1];
        const std::string prefix = name + "=";
        if (args[i].rfind(prefix, 0) == 0) return args[i].substr(prefix.size());
    }
    return {};
}

bool has_flag(const std::vector<std::string>& args, const std::string& name) {
    for (const std::string& a : args) if (a == name) return true;
    return false;
}

std::vector<std::string> split_origins(const char* raw) {
    std::vector<std::string> out;
    if (!raw) return out;

    std::string current;
    for (const char* p = raw; *p; p++) {
        if (*p == ',') {
            if (!current.empty()) out.push_back(current);
            current.clear();
            continue;
        }
        if (*p == ' ' || *p == '\t') continue;
        current += *p;
    }
    if (!current.empty()) out.push_back(current);
    return out;
}

} // namespace

int main(int argc, char** argv) {
    const std::vector<std::string> args(argv + 1, argv + argc);

    config::Config cfg;

    // Nombre de karts, reglage de developpement borne a [1, 12].
    const std::string kartsArg = arg_value(args, "--karts");
    if (!kartsArg.empty()) {
        const int requested = std::atoi(kartsArg.c_str());
        if (!config::set_kart_count(cfg, requested)) {
            std::fprintf(stderr,
                "[config] --karts %s hors bornes : il en faut entre 1 et 12.\n",
                kartsArg.c_str());
            return 1;
        }
    }

    // Nombre de tours, reglage de developpement comme `--karts`.
    const std::string lapsArg = arg_value(args, "--laps");
    if (!lapsArg.empty()) {
        const int requested = std::atoi(lapsArg.c_str());
        if (requested < 1 || requested > 20) {
            std::fprintf(stderr,
                "[config] --laps %s hors bornes : il en faut entre 1 et 20.\n",
                lapsArg.c_str());
            return 1;
        }
        cfg.race.laps = requested;
    }

    // Emprises deduites des sprites, une fois la config complete.
    try {
        config::derive_bodies(cfg);
    } catch (const std::exception& err) {
        std::fprintf(stderr, "[config] %s\n", err.what());
        return 1;
    }

    // Outils : pas de service demarre.
    if (has_flag(args, "--tracks")) {
        return tools::run_tracks(cfg, has_flag(args, "--order"));
    }

    // Circuits charges une fois au demarrage depuis tracks/. Un dessin invalide
    // arrete ici, avant l'ecoute.
    std::vector<track::Track> tracks;
    try {
        const std::string dir = track::resolve_tracks_dir(".");
        tracks = track::load_tracks(dir, cfg);
        std::printf("[circuits] %zu charge(s) depuis %s : ", tracks.size(), dir.c_str());
        for (size_t i = 0; i < tracks.size(); i++) {
            if (i) std::printf(", ");
            std::printf("%s (%d col, %zu pipes)", tracks[i].name.c_str(),
                        tracks[i].columns, tracks[i].pipes.size());
        }
        std::printf("\n");
    } catch (const std::exception& err) {
        std::fprintf(stderr, "[circuits] %s\n", err.what());
        std::fprintf(stderr, "[circuits] `--tracks` verifie les dessins sans rien demarrer.\n");
        return 1;
    }

    // Banc et soak, hors horloge et hors reseau.
    if (has_flag(args, "--simulate")) {
        tools::SimulateOptions sim;
        const std::string races = arg_value(args, "--races");
        if (!races.empty()) sim.races = std::max(1, std::atoi(races.c_str()));
        const std::string seed = arg_value(args, "--seed");
        if (!seed.empty()) {
            sim.seed = static_cast<unsigned int>(std::strtoul(seed.c_str(), nullptr, 10));
            sim.hasSeed = true;
        }
        sim.csv = has_flag(args, "--csv");
        sim.trackFilter = arg_value(args, "--track");
        return tools::run_simulate(cfg, tracks, sim);
    }

    const std::string duration = arg_value(args, "--duration");
    if (has_flag(args, "--soak") || (!duration.empty() && !has_flag(args, "--always-on"))) {
        const double seconds = duration.empty() ? 600 : std::atof(duration.c_str());
        return tools::run_soak(cfg, tracks, seconds);
    }

    service::Options opts;
    if (const char* port = std::getenv("PORT")) {
        const int parsed = std::atoi(port);
        if (parsed > 0) opts.port = parsed;
    }
    if (const char* wsPath = std::getenv("WS_PATH")) {
        if (*wsPath) opts.wsPath = wsPath;
    }
    opts.allowedOrigins = split_origins(std::getenv("ALLOWED_ORIGINS"));
    opts.alwaysOn = has_flag(args, "--always-on")
        || (std::getenv("ALWAYS_ON") && std::string(std::getenv("ALWAYS_ON")) == "1");

    std::printf("[config] %d karts, tour de %.0f px, %d tours\n",
                cfg.kartCount, cfg.world.width, cfg.race.laps);
    std::fflush(stdout);

    try {
        return service::run(cfg, tracks, opts);
    } catch (const std::exception& err) {
        std::fprintf(stderr, "[service] %s\n", err.what());
        return 1;
    }
}
