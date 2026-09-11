// Le bord de piste, et le contact entre karts.
// <- raceEngine/src/engine/road.js

#pragma once

#include <vector>

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

struct Event;

// La piste est BORNEE en largeur, la ou sa longueur boucle. Racler coute de la
// vitesse : c'est le seul endroit qui le fait payer.
void clamp_kart_to_road(const config::Config& cfg, Kart& kart, double deltaTime);

// LES CONTACTS ENTRE KARTS — VIDE en v0, les karts se traversent (plan §3).
//
// Appelee une fois que TOUT LE MONDE a bouge, et c'est la raison d'etre de sa
// place dans le tick : la traiter dans la boucle par-kart pousserait un kart
// contre un adversaire qui n'a pas encore fait son pas.
void resolve_kart_contacts(const config::Config& cfg, WorldState& state,
                           double now, double deltaTime, std::vector<Event>& events);

} // namespace engine
