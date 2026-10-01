// Service : uWS, /healthz, /ws/race, clients et diffusion.
// <- raceEngine/src/server.js
//
// Toute la configuration WebSocket est ici (compression, idleTimeout, upgrade,
// origines).

#pragma once

#include <string>
#include <vector>

#include "config/config.hpp"
#include "track.hpp"

namespace service {

struct Options {
    int port = 3000;
    std::string wsPath = "/ws/race";

    // Origines autorisees. Vide = toutes (local uniquement).
    std::vector<std::string> allowedOrigins;

    // Simule meme sans spectateur (soak, banc).
    bool alwaysOn = false;
};

// Ouvre le service et rend la main a l'arret de la boucle. `tracks` : rotation
// des manches.
int run(const config::Config& cfg, const std::vector<track::Track>& tracks,
        const Options& opts);

} // namespace service
