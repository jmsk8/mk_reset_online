#include "engine/road.hpp"

#include "engine/step.hpp"

namespace engine {

void clamp_kart_to_road(const config::Config& cfg, Kart& kart, double deltaTime) {
    const config::RoadCfg& road = cfg.road;
    bool atWall = false;

    if (kart.yPercent >= road.maxY) {
        kart.yPercent = road.maxY;
        // Consigne annulee dans le sens du mur seulement.
        if (kart.vy > 0) kart.vy = 0;
        atWall = true;
    } else if (kart.yPercent <= road.minY) {
        kart.yPercent = road.minY;
        if (kart.vy < 0) kart.vy = 0;
        atWall = true;
    }

    if (!atWall) return;

    // Taux en 1/s, borne a 1.
    const config::WallCfg& wall = cfg.physics.wall;
    const double floor = kart.stats ? kart.stats->topSpeed * wall.speedFactor : 0;
    if (kart.absoluteVelocity > floor) {
        const double k = wall.grip * deltaTime;
        kart.absoluteVelocity += (floor - kart.absoluteVelocity) * (k > 1 ? 1 : k);
    }
}

// Pas encore implemente. A faire : separer deux carrosseries qui se recouvrent
// selon les masses, via `bumpVx`/`bumpVy` (pas `vy`).
void resolve_kart_contacts(const config::Config& cfg, WorldState& state,
                           double now, double deltaTime, std::vector<Event>& events) {
    (void)cfg; (void)state; (void)now; (void)deltaTime; (void)events;
}

} // namespace engine
