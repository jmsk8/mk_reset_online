// Le service : uWS, /healthz, /ws/race, les clients, la diffusion.
// <- raceEngine/src/server.js
//
// TOUTE la configuration WebSocket est confinee ici (plan §3) : compression,
// idleTimeout, upgrade, origines. Le fichier qu'on ouvre pour toucher au
// GAMEPLAY (`engine/step.cpp`) n'a jamais besoin d'y entrer.

#pragma once

#include <string>
#include <vector>

#include "config/config.hpp"
#include "track.hpp"

namespace service {

struct Options {
    int port = 3000;
    std::string wsPath = "/ws/race";

    // Origines autorisees a ouvrir le flux. Vide = tout le monde, ce qui
    // convient en local mais jamais en production : sans ce controle, n'importe
    // quel site peut ouvrir une connexion permanente sur ce service.
    std::vector<std::string> allowedOrigins;

    // Simule meme sans spectateur. Sert au soak et au banc.
    bool alwaysOn = false;
};

// Ouvre le service et rend la main quand la boucle s'arrete. `tracks` porte la
// rotation des manches, dans l'ordre des noms de fichiers.
int run(const config::Config& cfg, const std::vector<track::Track>& tracks,
        const Options& opts);

} // namespace service
