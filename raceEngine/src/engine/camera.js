// La camera de course. Elle ne suit personne en particulier : elle vise
// une vitesse, celle qui garde le peloton dans le cadre.

import { forwardDistance, remainingDistance } from './geometry.js';
import { getLeader } from './standings.js';

// Recalculee a chaque pas : la camera vise l'instant ou le leader franchira
// la ligne. Un leader percute en chemin change la donne, elle suit.
function aimCameraSpeed(cfg, state) {
    const race = cfg.race;
    const leader = getLeader(state);
    if (!leader) return cfg.speeds.roadPPS;

    const distance = forwardDistance(cfg, state.cameraX, state.cameraTarget);
    const speed = Math.max(leader.absoluteVelocity, 1);
    const timeLeft = Math.max(0.4, remainingDistance(leader) / speed);

    return Math.min(
        cfg.speeds.roadPPS * race.cameraMaxCatchupRatio,
        Math.max(cfg.speeds.roadPPS * race.cameraMinSpeedRatio, distance / timeLeft)
    );
}

function updateCamera(cfg, state, deltaTime) {
    const width = cfg.world.width;

    if (state.phase === 'countdown') return;

    if (state.phase === 'racing') {
        state.cameraX += cfg.speeds.roadPPS * deltaTime;
    } else if (state.cameraTarget !== null && state.cameraTarget !== undefined) {
        state.cameraSpeed = aimCameraSpeed(cfg, state);

        // Approche de la position de parking, puis arret net.
        const remaining = forwardDistance(cfg, state.cameraX, state.cameraTarget);
        const advance = state.cameraSpeed * deltaTime;
        if (advance >= remaining) {
            state.cameraX = state.cameraTarget;
            state.cameraTarget = null;
        } else {
            state.cameraX += advance;
        }
    } else {
        return;
    }

    if (state.cameraX >= width) state.cameraX -= width;

    // Fond en parallaxe : moitié vitesse.
    state.bgCameraX = (state.bgCameraX || 0) + (state.phase === 'racing'
        ? cfg.speeds.roadPPS * deltaTime * 0.5
        : state.cameraSpeed * deltaTime * 0.5);
    if (state.bgCameraX >= width) state.bgCameraX -= width;
}

export {
    updateCamera,
};
