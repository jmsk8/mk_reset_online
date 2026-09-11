#include "engine/camera.hpp"

namespace engine {

void update_camera(const config::Config& cfg, WorldState& state, double deltaTime) {
    const double width = cfg.world.width;

    if (state.phase == Phase::Countdown) return;

    if (state.phase == Phase::Racing) {
        state.cameraX += cfg.speeds.roadPPS * deltaTime;
    } else {
        return;
    }

    if (state.cameraX >= width) state.cameraX -= width;

    // Fond en parallaxe : MOITIE vitesse. C'est le seul lien entre le decor et
    // la piste — la texture de fond se repete d'elle-meme cote client, sa
    // longueur n'a aucun rapport avec celle du tour.
    state.bgCameraX += cfg.speeds.roadPPS * deltaTime * 0.5;
    if (state.bgCameraX >= width) state.bgCameraX -= width;
}

} // namespace engine
