#include "engine/step.hpp"

#include <algorithm>
#include <cmath>
#include <optional>

#include "engine/camera.hpp"
#include "engine/geometry.hpp"
#include "engine/math.hpp"
#include "engine/pipes.hpp"
#include "engine/race.hpp"
#include "engine/road.hpp"
#include "engine/standings.hpp"
#include "engine/steering.hpp"

namespace engine {

// ── A implementer ───────────────────────────────────────────────────────────
//
// Signatures definitives et corps vides, deja appeles a leur place dans le tick.

// Distribution d'un objet selon le rang ; ne rend rien pour l'instant.
std::optional<HeldItem> roll_item(const config::Config& cfg, WorldState& state,
                                  Rng& rng, double now, const Kart& kart) {
    (void)cfg; (void)state; (void)rng; (void)now; (void)kart;
    return std::nullopt;
}

// Decision de pilotage (profondeur visee). Tant qu'elle est vide, `wander`
// tient `laneY`.
void choose_lane(const config::Config& cfg, WorldState& state, Kart& kart, double now) {
    (void)cfg; (void)state; (void)kart; (void)now;
}

namespace {

// Errance : profondeur cible tiree toutes les 2 a 6 s, avec une marge sur
// chaque bord. Ecarte les cibles alignees sur un tuyau proche, sinon un kart
// peut s'y cogner sans fin et bloquer la fin de course.
void wander(const config::Config& cfg, const WorldState& state, Kart& kart,
            Rng& rng, double now) {
    const double lo = cfg.road.minY + cfg.wander.margin;
    const double hi = cfg.road.maxY - cfg.wander.margin;

    // Degagement en profondeur : demi-emprise du tuyau + celle du kart + marge.
    const double clearY = cfg.pipe.hitbox.y + kart.body.y + cfg.wander.pipeMargin;

    // Tuyau le plus proche devant, s'il barre la profondeur visee (verifie a
    // chaque tick, pas seulement au tirage).
    const Pipe* threat = nullptr;
    double threatAhead = cfg.wander.lookAhead;
    for (const Pipe& pipe : state.pipes) {
        const double ahead = forward_distance(cfg, kart.worldX, pipe.worldX);
        if (ahead > threatAhead) continue;
        if (std::abs(kart.laneY - pipe.y) >= clearY) continue;
        threat = &pipe;
        threatAhead = ahead;
    }

    if (threat) {
        // Ecart du cote le plus degage, tenu jusqu'au passage du tuyau. Borne
        // par la piste et non par la marge d'errance, sinon l'esquive d'un
        // tuyau centre manque de degagement et le kart reste coince.
        const double up = threat->y + clearY + 1;
        const double down = threat->y - clearY - 1;
        const double roomUp = cfg.road.maxY - up;
        const double roomDown = down - cfg.road.minY;
        kart.laneY = clamp((roomUp >= roomDown) ? up : down,
                           cfg.road.minY, cfg.road.maxY);
        kart.nextWanderAt = now + cfg.pipe.clearWanderMs;
        return;
    }

    if (now < kart.nextWanderAt) return;

    // Rien devant : profondeur tiree au hasard.
    double target = rng.range(lo, hi);
    for (int attempt = 0; attempt < 6; attempt++) {
        bool blocked = false;
        for (const Pipe& pipe : state.pipes) {
            const double ahead = forward_distance(cfg, kart.worldX, pipe.worldX);
            if (ahead > cfg.wander.lookAhead) continue;
            if (std::abs(target - pipe.y) < clearY) { blocked = true; break; }
        }
        if (!blocked) break;
        target = rng.range(lo, hi);
    }

    kart.laneY = target;
    kart.nextWanderAt = now + rng.range(cfg.wander.intervalMin, cfg.wander.intervalMax);
}

} // namespace

// Pilote : perception, decision, volant. Sans `sight`, `ai[]` rend 0.
void update_ai(const config::Config& cfg, WorldState& state, Kart& kart,
               Rng& rng, double now, double deltaTime) {
    choose_lane(cfg, state, kart, now);
    wander(cfg, state, kart, rng, now);

    // `steer()` est la seule fonction qui ecrit `vy`.
    const config::SteerCfg& s = cfg.physics.steer;
    steer(cfg, kart, deltaTime, kart.laneY, s.wanderSpeed, s.wanderGain, s.wanderTolerance);
}

// ── Le pas ──────────────────────────────────────────────────────────────────

namespace {

// Ramassage d'une boite : le cube se consomme et se regenere ; le tirage
// (`roll_item`) ne rend encore rien.
void update_item_boxes(const config::Config& cfg, WorldState& state, Rng& rng, double now) {
    for (ItemBox& box : state.itemBoxes) {
        if (!box.active && now > box.reactivateTime) {
            box.active = true;
        }

        for (Kart& kart : state.karts) {
            if (kart.state != KartState::Running && kart.state != KartState::Hit) continue;
            if (kart.finished) continue;

            const double dist = get_shortest_distance(cfg, box.worldX, kart.worldX);
            const double dy = std::abs(box.y - kart.yPercent);
            if (std::abs(dist) >= cfg.hitboxes.itemBox.x) continue;
            if (dy >= cfg.hitboxes.itemBox.y) continue;

            // Passage date meme sans cube.
            kart.boxPassedAt = now;

            if (!box.active) continue;

            box.active = false;
            box.reactivateTime = now + cfg.delays.boxRespawn;

            // Deux emplacements : on ne sert que si l'un est libre.
            const bool full = kart.heldItems[0].has_value() && kart.heldItems[1].has_value();
            if (!full) {
                std::optional<HeldItem> rolled = roll_item(cfg, state, rng, now, kart);
                if (rolled.has_value()) {
                    if (!kart.heldItems[0].has_value()) kart.heldItems[0] = rolled;
                    else kart.heldItems[1] = rolled;
                }
            }
        }
    }
}

// Avance longitudinale : l'elan derive vers une cible retiree toutes les 3 a
// 7 s, et la vitesse rejoint cet elan a l'acceleration du kart.
void advance_kart(const config::Config& cfg, WorldState& state, Kart& kart,
                  Rng& rng, double now, double deltaTime, std::vector<Event>& events) {
    if (kart.state != KartState::Running) return;

    // Depart rate : le kart reste sur place, moteur noye.
    if (kart.startStallUntil > now) {
        kart.contactSpeed = 0;
        return;
    }

    const config::SpeedsCfg& sp = cfg.speeds;
    const double accRate = sp.accelerationRate * kart.stats->acceleration;

    if (now > kart.nextMomentumChange) {
        kart.momentumTarget = rng.range(
            sp.momentumFloorBase + sp.momentumFloorWeightGain * kart.stats->normWeight, 1.0);
        kart.nextMomentumChange = now + rng.range(sp.momentumDriftMin, sp.momentumDriftMax);
    }

    const double mChange = sp.momentumChangeSpeed * deltaTime;
    if (kart.momentum < kart.momentumTarget) {
        kart.momentum = std::min(kart.momentumTarget, kart.momentum + mChange);
    } else {
        kart.momentum = std::max(kart.momentumTarget, kart.momentum - mChange);
    }

    // Sous objet de vitesse, pointe de l'objet ; sinon, celle de l'elan.
    double targetSpeed;
    if (now < kart.boostEndTime) {
        targetSpeed = kart.stats->topSpeed;
    } else {
        targetSpeed = kart.stats->topSpeed
            * (sp.momentumMinRatio + (1.0 - sp.momentumMinRatio) * kart.momentum);
    }

    if (kart.absoluteVelocity < targetSpeed) {
        kart.absoluteVelocity = std::min(targetSpeed, kart.absoluteVelocity + accRate * deltaTime);
    } else if (kart.absoluteVelocity > targetSpeed) {
        // Decelerer plus lentement qu'accelerer : lever le pied n'est pas freiner.
        kart.absoluteVelocity = std::max(targetSpeed,
                                         kart.absoluteVelocity - accRate * 0.25 * deltaTime);
    }
    if (kart.absoluteVelocity > kart.stats->topSpeed) {
        kart.absoluteVelocity = kart.stats->topSpeed;
    }

    double effectiveSpeed = kart.absoluteVelocity;

    // Le tour d'honneur se court au ralenti.
    if (kart.finished) {
        effectiveSpeed = std::min(effectiveSpeed,
                                  kart.stats->topSpeed * cfg.race.finishedSpeedRatio);
    }

    double moveDist = effectiveSpeed * deltaTime;

    // Choc contre un tuyau : arret net puis recul. Le recul diminue aussi
    // `totalDistance` pour garder position et progression coherentes.
    if (now < kart.bumpEndTime) {
        moveDist = 0;
        if (kart.bumpRecoilLeft > 0) {
            const double back = std::min(
                kart.bumpRecoilLeft,
                (cfg.pipe.recoilPx * 1000 / cfg.pipe.recoilMs) * deltaTime);
            kart.bumpRecoilLeft -= back;
            moveDist = -back;
        }
    }

    kart.totalDistance += moveDist;
    // Vitesse reelle du tick (recul compris), lue par le volant.
    kart.contactSpeed = deltaTime > 0 ? moveDist / deltaTime : 0;

    const double prevWorldX = kart.worldX;
    const double rawWorldX = kart.worldX + moveDist;

    // Franchissement juge avant le bouclage de `worldX`.
    const double finishX = cfg.world.finishLineX;
    if (moveDist >= 0) {
        if (prevWorldX < finishX && rawWorldX >= finishX) kart.lapCount++;
    } else if (prevWorldX >= finishX && rawWorldX < finishX) {
        // Ligne repassee en arriere : le tour est decompte.
        kart.lapCount--;
    }

    kart.worldX = wrap_world_x(cfg, rawWorldX);
    kart.yPercent += kart.vy * deltaTime;

    if (!kart.finished && kart.totalDistance >= kart.finishDistance) {
        kart.finished = true;
        kart.finishRank = static_cast<int>(state.finishOrder.size()) + 1;
        state.finishOrder.push_back(kart.id);

        Event ev;
        ev.type = EventType::KartFinished;
        ev.kartId = kart.id;
        ev.value = kart.finishRank;
        events.push_back(ev);
    }

    clamp_kart_to_road(cfg, kart, deltaTime);
}

} // namespace

std::vector<Event> step_physics(const config::Config& cfg, WorldState& state,
                                Rng& rng, double now, double deltaTime) {
    std::vector<Event> events;

    update_race(cfg, state, rng, now, deltaTime, events);
    update_camera(cfg, state, deltaTime);

    update_item_boxes(cfg, state, rng, now);

    for (Kart& kart : state.karts) {
        if (kart.state == KartState::Grid) continue;

        // Drapeau lu tel quel dans le snapshot.
        kart.bumped = now < kart.bumpEndTime;

        // Gain de volant des objets de vitesse, pose une fois par tick.
        kart.steerBoost = (now < kart.boostEndTime) ? cfg.physics.steer.boostGain : 1.0;

        update_ai(cfg, state, kart, rng, now, deltaTime);
        advance_kart(cfg, state, kart, rng, now, deltaTime, events);

        // Tuyau juge sur la position d'arrivee.
        collide_kart_with_pipes(cfg, state, kart, now, events);
    }

    // Tout le monde a bouge : contacts entre karts.
    resolve_kart_contacts(cfg, state, now, deltaTime, events);

    update_leaderboard(cfg, state, now, events);

    return events;
}

} // namespace engine
