// Moteur de course autoritatif du banner SMK — version C++.
// <- raceEngine/src/server.js : arguments, signaux, boucle, enchainement GP.
//
//   race_engine                     service normal (HTTP + WebSocket)
//   race_engine --karts 4           4 karts au lieu de 8 (dev seulement, 1 a 12)
//   race_engine --always-on         simule meme sans spectateur
//
// Une seule course tourne ici, et c'est elle que tous les navigateurs
// regardent : les clients ne simulent rien, ils affichent. L'architecture
// complete est dans docs/banner/architecture.md.
//
// SEUL fichier autorise a connaitre toutes les couches a la fois (plan §4.1bis) :
// c'est lui qui les assemble, rien d'autre.

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
        // Deux formes acceptees : `--karts 4` et `--karts=4`.
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

    // Le nombre de karts : reglage de DEVELOPPEMENT, borne a [1, 12] (plan §3).
    // docker-compose.yml ne l'expose sur aucune variable d'environnement — le
    // service en conteneur reste a 8.
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

    // Le nombre de tours, meme esprit que `--karts` : un reglage de
    // DEVELOPPEMENT. Une course de 5 tours dure ~154 s, ce qui rend un grand
    // prix entier penible a observer quand on travaille sur l'enchainement des
    // manches. Absent de docker-compose.yml, comme `--karts`.
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

    // Les emprises se deduisent des sprites, une fois la config complete. Sans
    // cet appel, toutes les hitboxes valent zero et les corps se traverseraient
    // sans qu'aucune erreur ne le dise.
    try {
        config::derive_bodies(cfg);
    } catch (const std::exception& err) {
        std::fprintf(stderr, "[config] %s\n", err.what());
        return 1;
    }

    // Les outils tournent et rendent la main : ils ne demarrent aucun service.
    if (has_flag(args, "--tracks")) {
        return tools::run_tracks(cfg, has_flag(args, "--order"));
    }

    // Les circuits sont des dessins, pas du code : ils vivent dans tracks/,
    // monte en lecture seule dans le conteneur. Charges UNE FOIS au demarrage.
    //
    // Un dessin faux arrete ici, avant meme d'ecouter — plutot qu'au depart
    // d'une course, ou le conteneur relancerait le service en boucle a chaque
    // spectateur.
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

    // Le banc et le soak : ils tournent hors horloge et hors reseau.
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
