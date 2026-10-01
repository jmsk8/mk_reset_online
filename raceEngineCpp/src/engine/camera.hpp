// Camera de course : vise la vitesse qui garde le peloton dans le cadre.
// <- raceEngine/src/engine/camera.js

#pragma once

#include "config/config.hpp"
#include "engine/world.hpp"

namespace engine {

void update_camera(const config::Config& cfg, WorldState& state, double deltaTime);

} // namespace engine
