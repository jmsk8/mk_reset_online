#include "engine/road.hpp"

#include "engine/step.hpp"

namespace engine {

void clamp_kart_to_road(const config::Config& cfg, Kart& kart, double deltaTime) {
    const config::RoadCfg& road = cfg.road;
    bool atWall = false;

    if (kart.yPercent >= road.maxY) {
        kart.yPercent = road.maxY;
        // La consigne de volant est annulee DANS le sens du mur seulement : un
        // kart plaque doit pouvoir s'en decoller.
        if (kart.vy > 0) kart.vy = 0;
        atWall = true;
    } else if (kart.yPercent <= road.minY) {
        kart.yPercent = road.minY;
        if (kart.vy < 0) kart.vy = 0;
        atWall = true;
    }

    if (!atWall) return;

    // Meme forme que le volant : un taux en 1/s, borne a 1 pour qu'une frame
    // longue arrive pile sur le plancher plutot que de le depasser.
    const config::WallCfg& wall = cfg.physics.wall;
    const double floor = kart.stats ? kart.stats->topSpeed * wall.speedFactor : 0;
    if (kart.absoluteVelocity > floor) {
        const double k = wall.grip * deltaTime;
        kart.absoluteVelocity += (floor - kart.absoluteVelocity) * (k > 1 ? 1 : k);
    }
}

// VIDE : c'est le plan de travail, pas une lacune (plan §2). La signature est
// la vraie, l'appel est deja au bon endroit du tick — il ne manque que le corps.
//
// Ce qu'elle devra faire : separer deux carrosseries qui se recouvrent, en
// repartissant la poussee selon les masses, et pousser dans `bumpVx`/`bumpVy`
// plutot que dans `vy` — sans quoi le volant effacerait le choc avant que les
// karts se soient decolles.
void resolve_kart_contacts(const config::Config& cfg, WorldState& state,
                           double now, double deltaTime, std::vector<Event>& events) {
    (void)cfg; (void)state; (void)now; (void)deltaTime; (void)events;
}

} // namespace engine
