// Le contrat serveur -> client.
// <- raceEngine/src/protocol.js, dont docs/banner/protocole.md donne la carte.
//
// LA REGLE QUI GOUVERNE TOUT CE FICHIER : LE SNAPSHOT FAIT FOI. Un spectateur
// qui se connecte a la 187e seconde n'a vu passer aucun evenement et doit
// pourtant afficher une scene complete et juste.
//
// Un champ manquant ne produit pas une erreur cote client : il produit un rendu
// FAUX et SILENCIEUX (plan §5). C'est la partie qui ne souffre aucune
// approximation.

#pragma once

#include <string>
#include <vector>

#include "config/config.hpp"
#include "engine/step.hpp"
#include "engine/world.hpp"

namespace protocol {

// Monter cette version impose de la monter des DEUX COTES a la fois
// (`raceEngine/src/protocol.js` et `frontEnd/.../interpolate.js`). Un decalage
// et le client appelle `giveUp()` : decor seul, pastille rouge, et plus aucune
// tentative de reconnexion (piege P-1).
inline constexpr int PROTOCOL_VERSION = 11;

// Le vote de redemarrage : [voix posees, spectateurs]. Vient du service, seul a
// connaitre les connexions — l'etat du monde ne les voit pas.
struct VoteTally {
    int votes = 0;
    int watchers = 0;
};

// Le snapshot, dix fois par seconde. Serialise UNE FOIS pour tout le monde :
// c'est pourquoi il ne peut porter que le total des votes, jamais celui d'un
// spectateur en particulier.
std::string build_snapshot(const config::Config& cfg, const engine::WorldState& state,
                           double simTime, VoteTally vote,
                           const std::vector<engine::Event>& events);

// Une fois par connexion. Porte toute la geometrie et les constantes dont le
// rendu a besoin : le client n'en garde AUCUNE copie, c'est ce qui evite qu'un
// reglage de gameplay change d'un cote sans l'autre.
std::string build_hello(const config::Config& cfg, const engine::WorldState& state,
                        double simTime, double t0, double serverTime, VoteTally vote,
                        const std::vector<engine::Event>& events);

// Reponse a un `ping` : l'horodatage client renvoye TEL QUEL, et l'heure
// serveur. C'est ce qui cale l'horloge partagee — aucune date locale n'entre
// dans un calcul commun, celles des visiteurs sont fausses.
std::string build_pong(const std::string& clientToken, double serverTime);

} // namespace protocol
