#include "engine/pipes.hpp"

#include <cmath>

#include "engine/geometry.hpp"
#include "engine/math.hpp"
#include "engine/step.hpp"

namespace engine {

namespace {

// Le tuyau est un disque : `box` donne ses demi-axes.
bool inside_pipe(const config::Extent& box, double dx, double dy) {
    const double u = dx / box.x;
    const double v = dy / box.y;
    return u * u + v * v < 1;
}

// Cote vers lequel le kart est ecarte ; a egalite, vers le bord le plus loin.
double pipe_slide_dir(const config::Config& cfg, const Kart& kart, const Pipe& pipe) {
    if (std::abs(kart.yPercent - pipe.y) < 0.5) {
        return ((cfg.road.maxY - kart.yPercent) >= (kart.yPercent - cfg.road.minY))
            ? 1.0 : -1.0;
    }
    return kart.yPercent >= pipe.y ? 1.0 : -1.0;
}

} // namespace

void collide_kart_with_pipes(const config::Config& cfg, WorldState& state,
                             Kart& kart, double now, std::vector<Event>& events) {
    if (state.pipes.empty()) return;

    const config::Extent& box = cfg.pipe.hitbox;

    // Carrosserie propre au kart ; boite + disque = rectangle aux coins arrondis.
    const double flatX = kart.body.x;
    const double flatY = kart.body.y;
    const double reachX = box.x + flatX;
    const double reachY = box.y + flatY;

    for (size_t p = 0; p < state.pipes.size(); p++) {
        const Pipe& pipe = state.pipes[p];

        const double dx = get_shortest_distance(cfg, kart.worldX, pipe.worldX);
        if (std::abs(dx) >= reachX) continue;
        const double dy = kart.yPercent - pipe.y;
        if (std::abs(dy) >= reachY) continue;

        // Hors de la croix plate : l'arc du tuyau tranche.
        const double cornerX = std::abs(dx) - flatX;
        const double cornerY = std::abs(dy) - flatY;
        if (cornerX > 0 && cornerY > 0 && !inside_pipe(box, cornerX, cornerY)) continue;

        // Sursis apres un choc.
        if (now < kart.pipeImmuneUntil) continue;
        kart.pipeImmuneUntil = now + cfg.pipe.immuneMs;

        kart.bumpEndTime = now + cfg.pipe.bumpMs;
        kart.bumpRecoilLeft = cfg.pipe.recoilPx;
        kart.absoluteVelocity = 0;
        kart.momentum = 0;
        // Le choc efface aussi l'elan mis de cote.
        kart.preBoostMomentum = -1;

        // Ecart vers le cote le plus degage, par la consigne `laneY` (tenue
        // ensuite par l'evitement de `wander`).
        const double dir = pipe_slide_dir(cfg, kart, pipe);
        kart.laneY = clamp(kart.yPercent + dir * cfg.pipe.slideAway,
                           cfg.road.minY + cfg.wander.margin,
                           cfg.road.maxY - cfg.wander.margin);

        Event ev;
        ev.type = EventType::PipeShaken;
        ev.kartId = kart.id;
        ev.pipeIndex = static_cast<int>(p);
        events.push_back(ev);
        return;
    }
}

} // namespace engine
