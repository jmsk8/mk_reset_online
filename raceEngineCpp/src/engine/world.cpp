// <- raceEngine/src/engine/world.js + stats.js
//
// Stats des personnages et grille de depart.

#include "engine/world.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <string>

#include "engine/math.hpp"

namespace engine {

StatsTable derive_character_stats(const config::Config& cfg) {
    const config::KartStatsCfg& spec = cfg.kartStats;
    const double span = (spec.maxPoints - spec.minPoints) != 0
        ? static_cast<double>(spec.maxPoints - spec.minPoints)
        : 1.0;

    StatsTable table;
    table.reserve(spec.characters.size());

    for (const config::CharacterSpec& raw : spec.characters) {
        // Axe hors bornes ou budget faux : erreur de configuration.
        const int axes[3] = { raw.weight, raw.power, raw.handling };
        for (int v : axes) {
            if (v < spec.minPoints || v > spec.maxPoints) {
                throw std::runtime_error("kartStats : " + raw.name + " a un axe a "
                    + std::to_string(v) + ", hors de ["
                    + std::to_string(spec.minPoints) + ", "
                    + std::to_string(spec.maxPoints) + "]");
            }
        }
        const int total = raw.weight + raw.power + raw.handling;
        if (total != spec.budget) {
            throw std::runtime_error("kartStats : " + raw.name + " totalise "
                + std::to_string(total) + " points au lieu des "
                + std::to_string(spec.budget) + " du budget");
        }

        CharacterStats s;
        s.name = raw.name;
        s.rawWeight = raw.weight;
        s.rawPower = raw.power;
        s.rawHandling = raw.handling;

        s.normWeight   = (raw.weight - spec.minPoints) / span;
        s.normPower    = (raw.power - spec.minPoints) / span;
        s.normHandling = (raw.handling - spec.minPoints) / span;

        s.mass  = lerp(spec.mass.min, spec.mass.max, s.normWeight);
        s.force = lerp(spec.force.min, spec.force.max, s.normPower);
        // Axe handling courbe : voir `gripCurve` en config.
        s.grip  = lerp(spec.grip.min, spec.grip.max,
                       std::pow(s.normHandling, spec.gripCurve));

        // Pointe additive : chaque axe apporte ses px/s.
        s.topSpeed = spec.speedBase
            + spec.speedPerWeight * s.normWeight
            + spec.speedPerPower * s.normPower;

        s.acceleration = clamp(s.force / std::pow(s.mass, spec.massDragAccel),
                               spec.accelClamp.min, spec.accelClamp.max);
        s.agility = clamp(s.grip / std::pow(s.mass, spec.massDragAgility),
                          spec.agilityClamp.min, spec.agilityClamp.max);

        // Cout en vitesse du braquage, base sur le grip.
        s.cornering = std::pow(s.grip, spec.cornerGripGain)
            * std::pow(s.force, spec.cornerPowerGain)
            / std::pow(s.mass, spec.cornerMassDrag);

        table.push_back(std::move(s));
    }

    return table;
}

WorldState create_world_state(const config::Config& cfg, Rng& rng, double now,
                              const std::vector<std::string>& startOrder) {
    WorldState state;
    state.simTime = now;
    state.statsTable = derive_character_stats(cfg);

    if (state.statsTable.empty()) {
        throw std::runtime_error("createWorldState : aucun personnage en config");
    }

    // Ordre de la grille : roster de la config sans les personnages desactives,
    // reordonne selon `startOrder` (manche precedente) ou melange (debut de
    // grand prix). Les `kartCount` premiers courent.
    std::vector<int> roster;
    roster.reserve(state.statsTable.size());
    for (size_t i = 0; i < state.statsTable.size(); i++) {
        if (cfg.kartStats.characters[i].enabled) roster.push_back(static_cast<int>(i));
    }
    if (roster.empty()) {
        throw std::runtime_error("createWorldState : aucun personnage actif (enabled)");
    }

    if (!startOrder.empty()) {
        std::vector<int> ordered;
        ordered.reserve(roster.size());
        for (const std::string& name : startOrder) {
            for (int idx : roster) {
                if (state.statsTable[static_cast<size_t>(idx)].name == name
                    && std::find(ordered.begin(), ordered.end(), idx) == ordered.end()) {
                    ordered.push_back(idx);
                    break;
                }
            }
        }
        // Les personnages absents de `startOrder` gardent l'ordre du roster.
        for (int idx : roster) {
            if (std::find(ordered.begin(), ordered.end(), idx) == ordered.end()) {
                ordered.push_back(idx);
            }
        }
        roster = std::move(ordered);
    } else {
        // Fisher-Yates avec le RNG du moteur : course rejouable a graine egale.
        for (size_t i = roster.size(); i > 1; i--) {
            const size_t j = static_cast<size_t>(rng.next() * static_cast<double>(i));
            std::swap(roster[i - 1], roster[j < i ? j : i - 1]);
        }
    }

    const config::GridCfg& grid = cfg.race.grid;
    const int lanes = static_cast<int>(grid.lanes.size());
    if (lanes <= 0) {
        throw std::runtime_error("createWorldState : la grille n'a aucune colonne");
    }

    const double roadHeight = cfg.road.maxY - cfg.road.minY;
    const int rosterSize = static_cast<int>(roster.size());

    // Moins de personnages que de places : la course se fait avec eux. Seul
    // `--karts` (developpement) recycle au-dela du roster.
    const int kartCount = cfg.kartCountForced
        ? cfg.kartCount
        : std::min(cfg.kartCount, rosterSize);

    state.karts.reserve(static_cast<size_t>(kartCount));

    for (int index = 0; index < kartCount; index++) {
        // La grille se deduit du nombre de karts (deux colonnes, pas entre rangs).
        const int row = index / lanes;
        const int col = index % lanes;

        const double gapToLine = grid.backOffset
            + row * grid.rowGap
            + col * grid.colStagger;

        double worldX = cfg.world.finishLineX - gapToLine;
        if (worldX < 0) worldX += cfg.world.width;

        // Diagonale repartie sur le nombre de rangs reels : au-dela de 8 karts,
        // le dernier ne doit pas partir sur le bord. A 8 karts, grille du JS.
        const int rows = (kartCount + lanes - 1) / lanes;
        const double slope = rows > 1
            ? grid.laneSlope * 3.0 / static_cast<double>(rows - 1)
            : 0.0;

        const double depth = grid.lanes[col] + row * slope;
        const double verticalPos = clamp(cfg.road.minY + roadHeight * depth,
                                         cfg.road.minY, cfg.road.maxY);

        // Au-dela du roster, les personnages sont reutilises (stats partagees).
        const int rosterIndex = roster[static_cast<size_t>(index % rosterSize)];

        Kart kart;
        kart.id = index;
        kart.charName = state.statsTable[rosterIndex].name;
        kart.stats = &state.statsTable[rosterIndex];
        if (rosterIndex < static_cast<int>(cfg.bodiesByCharacter.size())) {
            kart.body = cfg.bodiesByCharacter[rosterIndex];
        }

        kart.worldX = worldX;
        kart.yPercent = verticalPos;
        kart.totalDistance = 0;

        // Les karts ne partent pas tous du meme rang : distance propre a chacun.
        kart.finishDistance = cfg.race.laps * cfg.world.width + gapToLine;

        kart.state = KartState::Grid;
        kart.rank = index + 1;

        // Profondeur visee initiale : celle de la grille.
        kart.laneY = verticalPos;
        kart.nextWanderAt = now + rng.range(cfg.wander.intervalMin, cfg.wander.intervalMax);

        // Elan initial, tire comme en JS.
        kart.momentumTarget = rng.range(
            cfg.speeds.momentumFloorBase
                + cfg.speeds.momentumFloorWeightGain * kart.stats->normWeight,
            1.0);
        kart.nextMomentumChange = now + rng.range(cfg.speeds.momentumDriftMin,
                                                  cfg.speeds.momentumDriftMax);

        state.karts.push_back(std::move(kart));
    }

    state.countdownMs = cfg.race.countdownHoldMs + 2 * cfg.race.lightIntervalMs;
    state.startAt = now + state.countdownMs;
    state.phase = Phase::Countdown;

    // ── Decor du circuit ────────────────────────────────────────────────────
    // Deja converti en px de monde par `apply_track` ; sans circuit, ni boite
    // ni tuyau.
    for (const config::Placed& box : cfg.world.itemBoxes) {
        ItemBox b;
        b.worldX = box.x;
        b.y = box.y;
        b.active = true;
        state.itemBoxes.push_back(b);
    }

    for (const config::Placed& pipe : cfg.world.pipes) {
        Pipe p;
        p.worldX = pipe.x;
        p.y = pipe.y;
        p.kind = pipe.red ? 1 : 0;
        state.pipes.push_back(p);
    }

    // Camera garee face a la ligne pour le depart.
    const double park = cfg.world.finishLineX + cfg.race.parkStartOffset;
    state.cameraX = park < 0 ? park + cfg.world.width : park;
    state.bgCameraX = state.cameraX;

    return state;
}

} // namespace engine
