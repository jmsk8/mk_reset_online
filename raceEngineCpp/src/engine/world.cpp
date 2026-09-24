// <- raceEngine/src/engine/world.js + stats.js
//
// La fabrique d'un monde. Deux choses : deduire les stats de chaque personnage,
// puis poser la grille de depart.

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
        // Un axe hors bornes ou un budget qui ne tombe pas juste est une erreur
        // d'AUTEUR : le message dit quoi corriger, la pile d'appels ne dirait
        // rien de plus.
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
        // L'axe handling est courbe, pas droit : cf. `gripCurve` en config.
        s.grip  = lerp(spec.grip.min, spec.grip.max,
                       std::pow(s.normHandling, spec.gripCurve));

        // Pointe ADDITIVE : chaque axe apporte ses px/s, et les apporte seul.
        s.topSpeed = spec.speedBase
            + spec.speedPerWeight * s.normWeight
            + spec.speedPerPower * s.normPower;

        s.acceleration = clamp(s.force / std::pow(s.mass, spec.massDragAccel),
                               spec.accelClamp.min, spec.accelClamp.max);
        s.agility = clamp(s.grip / std::pow(s.mass, spec.massDragAgility),
                          spec.agilityClamp.min, spec.agilityClamp.max);

        // Ce que braquer coute en vitesse. Batie sur `agility`, elle laissait
        // `massDragAgility` gouverner deux choses a la fois : la vitesse a
        // laquelle un lourd tourne, ET ce que tourner lui coute.
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

    // L'ordre de la grille. Le roster de base suit l'ordre de la config, sans
    // les personnages retires du tirage (`enabled`, miroir de `roster.enabled`
    // du JS) ; on le reordonne selon `startOrder` quand une manche precedente
    // l'a decide, sinon on le melange — c'est ce qui ouvre un grand prix. Les
    // `kartCount` premiers courent : melange, c'est le tirage ; reordonne, ce
    // sont les karts de la manche precedente.
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
        // Ce que `startOrder` n'a pas nomme reste dans l'ordre du roster : une
        // manche qui aurait perdu un nom ne doit pas perdre un kart.
        for (int idx : roster) {
            if (std::find(ordered.begin(), ordered.end(), idx) == ordered.end()) {
                ordered.push_back(idx);
            }
        }
        roster = std::move(ordered);
    } else {
        // Fisher-Yates avec le RNG du moteur, jamais le hasard global : c'est ce
        // qui rend une course rejouable a graine egale.
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

    // Moins de personnages actives que de places : la course se fait avec eux,
    // comme en JS. Seul `--karts` (developpement) recycle au-dela du roster.
    const int kartCount = cfg.kartCountForced
        ? cfg.kartCount
        : std::min(cfg.kartCount, rosterSize);

    state.karts.reserve(static_cast<size_t>(kartCount));

    for (int index = 0; index < kartCount; index++) {
        // La grille se DEDUIT du nombre de karts, elle ne le fixe pas : la
        // config decrit une loi de grille (deux colonnes, un pas entre rangs),
        // pas un nombre de places. C'est ce qui permet `--karts=N` entre 1 et 12
        // sans toucher a config/ (plan §3).
        const int row = index / lanes;
        const int col = index % lanes;

        const double gapToLine = grid.backOffset
            + row * grid.rowGap
            + col * grid.colStagger;

        double worldX = cfg.world.finishLineX - gapToLine;
        if (worldX < 0) worldX += cfg.world.width;

        // La diagonale de grille s'accentue avec le rang. Au-dela de 4 rangs —
        // donc au-dela de 8 karts, ce que `--karts` autorise en developpement —
        // elle finirait par poser le dernier kart SUR le bord, dans la bande de
        // frottement : il paierait le bord des le depart. Le pas est donc
        // reparti sur le nombre de rangs REELS plutot que fixe.
        //
        // A 8 karts (4 rangs), le diviseur vaut 4 et la grille est identique a
        // celle du JS, au flottant pres.
        const int rows = (kartCount + lanes - 1) / lanes;
        const double slope = rows > 1
            ? grid.laneSlope * 3.0 / static_cast<double>(rows - 1)
            : 0.0;

        const double depth = grid.lanes[col] + row * slope;
        const double verticalPos = clamp(cfg.road.minY + roadHeight * depth,
                                         cfg.road.minY, cfg.road.maxY);

        // Au-dela du roster, les personnages se RECYCLENT : deux karts peuvent
        // jouer le meme, et partagent alors la meme entree de stats — rien a
        // dupliquer, `stats` est un pointeur (plan §3).
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

        // La distance a couvrir, et la raison pour laquelle le classement se
        // fait en distance RESTANTE : deux karts partis de rangs differents
        // n'ont pas la meme a parcourir.
        kart.finishDistance = cfg.race.laps * cfg.world.width + gapToLine;

        kart.state = KartState::Grid;
        kart.rank = index + 1;

        // La profondeur visee part de celle de la grille : sans ca, tout le
        // monde plongerait vers le centre au feu vert.
        kart.laneY = verticalPos;
        kart.nextWanderAt = now + rng.range(cfg.wander.intervalMin, cfg.wander.intervalMax);

        // L'elan initial, tire comme en JS.
        kart.momentumTarget = rng.range(
            cfg.speeds.momentumFloorBase
                + cfg.speeds.momentumFloorWeightGain * kart.stats->normWeight,
            1.0);
        kart.nextMomentumChange = now + rng.range(cfg.speeds.momentumDriftMin,
                                                  cfg.speeds.momentumDriftMax);

        state.karts.push_back(std::move(kart));
    }

    // Le decompte : c'est lui qui ouvre la course, pas le premier tick.
    state.countdownMs = cfg.race.countdownHoldMs + 2 * cfg.race.lightIntervalMs;
    state.startAt = now + state.countdownMs;
    state.phase = Phase::Countdown;

    // ── Le decor, tel que le CIRCUIT le pose ────────────────────────────────
    //
    // `apply_track` a deja traduit les cellules du dessin en px de monde et en
    // profondeur : ici on ne fait que recopier. Un monde sans circuit charge
    // n'a ni boite ni tuyau — et `create_world_state` ne s'en plaint pas, c'est
    // au service de refuser de demarrer sur un dossier tracks/ vide.
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

    // La camera se gare face a la ligne pour le depart, pas a l'origine du
    // monde : sinon la premiere image montre une piste vide.
    const double park = cfg.world.finishLineX + cfg.race.parkStartOffset;
    state.cameraX = park < 0 ? park + cfg.world.width : park;
    state.bgCameraX = state.cameraX;

    return state;
}

} // namespace engine
