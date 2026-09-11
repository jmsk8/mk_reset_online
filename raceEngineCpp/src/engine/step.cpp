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

// ── Les fonctions VIDES ─────────────────────────────────────────────────────
//
// Chacune existe avec sa vraie signature et un corps qui ne fait rien (plan
// §2). Ce n'est pas une lacune : c'est le plan de travail. Les appeler DES
// MAINTENANT garantit qu'elles seront branchees au bon endroit de l'ordre du
// tick le jour ou elles feront quelque chose.

// La DISTRIBUTION d'un objet : quel objet ce kart recoit, selon son rang, la
// courbe de tirage et les decotes. Rend « rien » tant qu'elle est vide — le
// ramassage, lui, fonctionne deja (plan §3).
std::optional<HeldItem> roll_item(const config::Config& cfg, WorldState& state,
                                  Rng& rng, double now, const Kart& kart) {
    (void)cfg; (void)state; (void)rng; (void)now; (void)kart;
    return std::nullopt;
}

// La DECISION de pilotage : quelle profondeur viser, et pourquoi. Le point
// d'accroche de toute la prise de decision — c'est ici que viendront `laneRisk`,
// les plans, l'esquive et `giveWay`.
//
// Tant qu'elle est vide, c'est l'errance qui tient `laneY` (cf. `wander`).
void choose_lane(const config::Config& cfg, WorldState& state, Kart& kart, double now) {
    (void)cfg; (void)state; (void)kart; (void)now;
}

namespace {

// L'errance : une profondeur cible tiree toutes les 2 a 6 s, avec une marge
// gardee sur chaque bord — personne ne vise le rail. C'est le comportement
// d'attente, celui que `choose_lane` remplacera.
//
// Elle refuse une cible qui pointe droit sur un tuyau PROCHE. Ce n'est pas de la
// perception — un vrai evitement regarde ce qu'il a devant, mesure le temps
// disponible et choisit un couloir (c'est le travail de `choose_lane`) — mais
// sans ce minimum, un kart tire une profondeur alignee sur un tuyau, s'y cogne,
// est ecarte, retire la meme, et la course ne se termine JAMAIS : elle reste en
// `finishing` jusqu'au delai maximum, sans que rien ne dise pourquoi.
void wander(const config::Config& cfg, const WorldState& state, Kart& kart,
            Rng& rng, double now) {
    const double lo = cfg.road.minY + cfg.wander.margin;
    const double hi = cfg.road.maxY - cfg.wander.margin;

    // Le degagement a tenir avec un tuyau, en profondeur : sa demi-emprise plus
    // celle du kart, plus une marge.
    const double clearY = cfg.pipe.hitbox.y + kart.body.y + cfg.wander.pipeMargin;

    // Le tuyau le plus PROCHE devant, s'il barre la profondeur visee. Verifie a
    // CHAQUE tick et non au seul tirage : une cible sure au moment ou elle est
    // choisie cesse de l'etre des que le kart avance vers un autre tuyau. Sans
    // ce controle continu, un kart se cognait, etait ecarte, revenait, et la
    // course ne se terminait jamais — elle restait en `finishing` jusqu'au
    // delai maximum sans que rien ne dise pourquoi.
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
        // Ecarte du cote le plus degage, et TIENT : la profondeur visee ne se
        // retire pas tant que le tuyau n'est pas passe.
        const double up = std::min(hi, threat->y + clearY + 1);
        const double down = std::max(lo, threat->y - clearY - 1);
        const double roomUp = hi - up;
        const double roomDown = down - lo;
        kart.laneY = (roomUp >= roomDown) ? up : down;
        kart.nextWanderAt = now + cfg.pipe.clearWanderMs;
        return;
    }

    if (now < kart.nextWanderAt) return;

    // Rien devant : une profondeur libre, tiree au hasard.
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

// Le PILOTE, qui arbitre tout le reste : perception, decision, volant. Sans
// `sight`, `ai[]` rend 0 pour tout le monde — exactement comme le JS
// aujourd'hui.
void update_ai(const config::Config& cfg, WorldState& state, Kart& kart,
               Rng& rng, double now, double deltaTime) {
    choose_lane(cfg, state, kart, now);
    wander(cfg, state, kart, rng, now);

    // `steer()` est la SEULE fonction qui ecrit `vy`.
    const config::SteerCfg& s = cfg.physics.steer;
    steer(cfg, kart, deltaTime, kart.laneY, s.wanderSpeed, s.wanderGain, s.wanderTolerance);
}

// ── Le pas ──────────────────────────────────────────────────────────────────

namespace {

// Le ramassage d'une boite. Il FONCTIONNE des la v0 : le cube se consomme et se
// regenere, et le tirage est appele pour de vrai — c'est `roll_item` qui ne rend
// rien encore.
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

            // Le passage se date en premier et SANS CONDITION : la zone se
            // traverse qu'il y reste un cube ou non. C'est l'endroit qui rend
            // prudent, pas le butin.
            kart.boxPassedAt = now;

            if (!box.active) continue;

            box.active = false;
            box.reactivateTime = now + cfg.delays.boxRespawn;

            // DEUX emplacements (plan §3) : on ne sert que si l'un est libre.
            // Seul le premier part dans le snapshot ; le second reste un etat
            // moteur, invisible du rendu.
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

// L'avance longitudinale : le regime d'ELAN. Deux etapes — l'elan derive
// lentement vers une cible retiree toutes les 3 a 7 s, et la vitesse rejoint ce
// que cet elan vaut, a l'acceleration du kart.
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

    // Sous objet de vitesse, la pointe visee est celle de l'objet ; hors objet,
    // celle que l'elan vaut.
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
        // On rend la vitesse moins vite qu'on ne la prend : lever le pied n'est
        // pas freiner.
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

    // Choc contre un tuyau : arret net, puis contrecoup. Le recul entame
    // `totalDistance` autant que l'avance — position et progression restent
    // COUSUES, sans quoi un kart franchirait la ligne en etant encore en amont
    // a l'ecran.
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
    // L'allure REELLE du tick, celle que le volant lira : recul compris.
    kart.contactSpeed = deltaTime > 0 ? moveDist / deltaTime : 0;

    const double prevWorldX = kart.worldX;
    const double rawWorldX = kart.worldX + moveDist;

    // Le franchissement se juge AVANT le bouclage : une fois `worldX` ramene
    // dans [0, width), la comparaison ne dit plus rien.
    const double finishX = cfg.world.finishLineX;
    if (moveDist >= 0) {
        if (prevWorldX < finishX && rawWorldX >= finishX) kart.lapCount++;
    } else if (prevWorldX >= finishX && rawWorldX < finishX) {
        // Repousse a travers la ligne : le compteur se defait. Sans ce miroir,
        // le tour serait compte une seconde fois a la prochaine traversee.
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

        // Double la date en booleen : le protocole n'a pas d'horloge, le
        // drapeau se lit tel quel dans le snapshot.
        kart.bumped = now < kart.bumpEndTime;

        // Ce que les objets de vitesse rendent au volant. Pose ICI une fois par
        // tick : c'est ce qui permet a `steer_cap` de ne lire qu'un kart, sans
        // horloge.
        kart.steerBoost = (now < kart.boostEndTime) ? cfg.physics.steer.boostGain : 1.0;

        update_ai(cfg, state, kart, rng, now, deltaTime);
        advance_kart(cfg, state, kart, rng, now, deltaTime, events);

        // Apres le deplacement et le recadrage : le tuyau se juge sur la
        // position ou le kart vient d'ARRIVER.
        collide_kart_with_pipes(cfg, state, kart, now, events);
    }

    // Tout le monde a bouge : les carrosseries peuvent enfin se parler.
    resolve_kart_contacts(cfg, state, now, deltaTime, events);

    update_leaderboard(cfg, state, now, events);

    return events;
}

} // namespace engine
