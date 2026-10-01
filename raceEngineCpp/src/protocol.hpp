// Contrat serveur -> client.
// <- raceEngine/src/protocol.js
//
// Le snapshot fait foi : un spectateur qui arrive en cours de course doit
// pouvoir afficher une scene complete sans avoir recu d'evenement.

#pragma once

#include <string>
#include <vector>

#include "config/config.hpp"
#include "engine/step.hpp"
#include "engine/world.hpp"

namespace protocol {

// A changer en meme temps que `raceEngine/src/protocol.js` et
// `frontEnd/.../interpolate.js` : en cas d'ecart, le client abandonne.
inline constexpr int PROTOCOL_VERSION = 11;

// Vote de redemarrage : [voix posees, spectateurs], fourni par le service.
struct VoteTally {
    int votes = 0;
    int watchers = 0;
};

// Snapshot, dix fois par seconde, serialise une fois pour tous : il ne porte
// que le total des votes.
std::string build_snapshot(const config::Config& cfg, const engine::WorldState& state,
                           double simTime, VoteTally vote,
                           const std::vector<engine::Event>& events);

// Une fois par connexion : geometrie et constantes du rendu (le client n'en
// garde aucune copie).
std::string build_hello(const config::Config& cfg, const engine::WorldState& state,
                        double simTime, double t0, double serverTime, VoteTally vote,
                        const std::vector<engine::Event>& events);

// Reponse a un `ping` : horodatage client renvoye tel quel et heure serveur.
std::string build_pong(const std::string& clientToken, double serverTime);

} // namespace protocol
