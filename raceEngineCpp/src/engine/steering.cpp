#include "engine/steering.hpp"

#include <algorithm>
#include <cmath>

namespace engine {

namespace {

double grip_at(const config::Config& cfg, double pace) {
    const config::SteerCfg& s = cfg.physics.steer;
    if (s.paceDrag == 0) return 1;
    return 1 - s.paceDrag * std::pow(pace, s.paceCurve);
}

double bite_at(const config::Config& cfg, double pace) {
    const double bite = cfg.physics.steer.paceBite;
    if (!(bite > 0)) return 1;
    return (pace >= bite) ? 1 : pace / bite;
}

// Ou le kart se posera s'il lache le volant maintenant. Viser depuis cette
// position et non depuis la position brute evite le depassement systematique.
double steer_settle(const config::Config& cfg, const Kart& kart) {
    return kart.yPercent + kart.vy / cfg.physics.steer.response;
}

} // namespace

double steer_pace(const Kart& kart) {
    const double top = kart.stats ? kart.stats->topSpeed : 0;
    if (!(top > 0)) return 1;
    // `contactSpeed` est le deplacement REELLEMENT effectue au tick precedent :
    // boosts, frottement et chocs y sont deja.
    const double pace = kart.contactSpeed / top;
    return pace < 0 ? 0 : (pace > 1 ? 1 : pace);
}

double steer_grip(const config::Config& cfg, const Kart& kart) {
    return grip_at(cfg, steer_pace(kart));
}

double steer_bite(const config::Config& cfg, const Kart& kart) {
    return bite_at(cfg, steer_pace(kart));
}

double steer_cap(const config::Config& cfg, const Kart& kart, double base) {
    if (!kart.stats) return base;
    return base * kart.stats->agility * steer_grip(cfg, kart)
         * steer_bite(cfg, kart) * kart.steerBoost;
}

void steer(const config::Config& cfg, Kart& kart, double deltaTime,
           double laneY, double speed, double gain, double tolerance) {
    const double response = cfg.physics.steer.response;
    const double diff = laneY - steer_settle(cfg, kart);

    if (std::abs(diff) <= tolerance) {
        // Cible tenue : il ne corrige plus, sinon il tremble autour.
        kart.targetVy = 0;
    } else {
        const double cap = steer_cap(cfg, kart, speed);
        const double seek = steer_cap(cfg, kart, diff * gain);
        kart.targetVy = std::max(-cap, std::min(cap, seek));
    }

    // La reponse du volant. Le facteur est BORNE a 1 : sur une frame longue —
    // onglet en arriere-plan, machine qui peine — le lissage non borne
    // depassait la consigne et faisait osciller le kart.
    const double k = response * deltaTime;
    kart.vy += (kart.targetVy - kart.vy) * (k > 1 ? 1 : k);
}

} // namespace engine
