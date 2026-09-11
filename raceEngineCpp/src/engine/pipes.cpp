#include "engine/pipes.hpp"

#include <cmath>

#include "engine/geometry.hpp"
#include "engine/math.hpp"
#include "engine/step.hpp"

namespace engine {

namespace {

// Le tuyau est le SEUL corps rond du moteur : ses deux valeurs sont les
// demi-axes d'un disque, pas les cotes d'une boite.
bool inside_pipe(const config::Extent& box, double dx, double dy) {
    const double u = dx / box.x;
    const double v = dy / box.y;
    return u * u + v * v < 1;
}

// Vers quel cote le kart est ecarte. A egalite parfaite, vers le bord le plus
// LOIN : sans quoi un kart pile au centre du tuyau serait pousse vers le rail.
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

    // La carrosserie de CE kart, pas celle du kart de reference : elle vient de
    // son sprite, et un kart long se cogne plus tot qu'un court.
    //
    // La carrosserie est une boite, le tuyau est rond : leur somme est un
    // rectangle aux coins ARRONDIS, et c'est ce que teste le rabotage plus bas.
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

        // Hors de la croix plate : c'est l'ARC du tuyau qui tranche.
        const double cornerX = std::abs(dx) - flatX;
        const double cornerY = std::abs(dy) - flatY;
        if (cornerX > 0 && cornerY > 0 && !inside_pipe(box, cornerX, cornerY)) continue;

        // Le sursis : sans lui, un kart arrete CONTRE le tuyau rejouerait le
        // choc a chaque tick, rallongeant `bumpEndTime` par a-coups et faisant
        // clignoter le sprite.
        if (now < kart.pipeImmuneUntil) continue;
        kart.pipeImmuneUntil = now + cfg.pipe.immuneMs;

        kart.bumpEndTime = now + cfg.pipe.bumpMs;
        kart.bumpRecoilLeft = cfg.pipe.recoilPx;
        kart.absoluteVelocity = 0;
        kart.momentum = 0;
        // Un tuyau efface l'elan, y compris celui qu'un objet en cours tenait de
        // cote : sans ca, la fin de l'objet le rendrait en silence et le choc
        // n'aurait rien coute a celui qui l'a pris lance.
        kart.preBoostMomentum = -1;

        // Ecarte vers le cote le plus degage, sans quoi un kart pousse par le
        // peloton resterait plaque contre le tuyau. La consigne passe par
        // `laneY` — `vy` n'appartient qu'a `steer()`.
        //
        // Elle ne fait que DONNER LE CAP : c'est l'evitement de `wander` qui la
        // tiendra tant que le tuyau est devant. Poser ici une echeance
        // concurrente ferait deux ecrivains pour une meme consigne.
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
