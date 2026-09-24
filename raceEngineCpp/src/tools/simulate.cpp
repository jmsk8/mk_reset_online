#include "tools/simulate.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <map>
#include <string>
#include <vector>

#include "engine/rng.hpp"
#include "engine/step.hpp"
#include "engine/world.hpp"

namespace tools {

namespace {

constexpr double DT = 1.0 / 30.0;
constexpr double DT_MS = DT * 1000.0;

// Au-dela, la course est declaree bloquee : sans ce garde-fou, un bug de
// physique ferait tourner le banc jusqu'a la fin des temps.
constexpr long long MAX_TICKS = 30 * 60 * 10;

struct Tally {
    int races = 0;
    int wins = 0;
    long long points = 0;
    long long rankSum = 0;
    double lapMsSum = 0;
    int lapMsCount = 0;
};

bool is_broken(double v) {
    return !std::isfinite(v);
}

// Un NaN n'apparait jamais seul : il se propage a tout ce qu'il touche, et une
// course qui en contient un est perdue. On le signale des la premiere
// occurrence, avec de quoi remonter a sa source.
bool check_integrity(const engine::WorldState& state, std::string& why) {
    for (const engine::Kart& kart : state.karts) {
        if (is_broken(kart.worldX) || is_broken(kart.yPercent)
            || is_broken(kart.totalDistance) || is_broken(kart.absoluteVelocity)
            || is_broken(kart.vy)) {
            why = "kart " + std::to_string(kart.id) + " (" + kart.charName + ")";
            return false;
        }
    }
    return true;
}

// Une course entiere, hors horloge : on avance a pas fixes jusqu'a ce que la
// machine a phases la declare close.
bool simulate_one(const config::Config& cfg, engine::Rng& rng,
                  const std::vector<std::string>& startOrder,
                  engine::WorldState& out, std::string& why) {
    double now = 0;
    engine::WorldState state = engine::create_world_state(cfg, rng, now, startOrder);

    for (long long tick = 0; tick < MAX_TICKS; tick++) {
        engine::step_physics(cfg, state, rng, now, DT);
        now += DT_MS;
        state.simTime = now;

        if (!check_integrity(state, why)) return false;

        // La course est close quand la machine a phases a distribue les points
        // et pose sa date de resultats.
        if (state.phase == engine::Phase::Results && state.resultsAt > 0) {
            out = std::move(state);
            return true;
        }
    }

    why = "course bloquee (" + std::to_string(MAX_TICKS) + " pas sans arrivee)";
    return false;
}

} // namespace

int run_simulate(const config::Config& cfg, const std::vector<track::Track>& tracks,
                 const SimulateOptions& opts) {
    if (tracks.empty()) {
        std::printf("✗ aucun circuit a simuler\n");
        return 1;
    }

    // Les circuits retenus. `--track` n'en garde qu'un, pour juger un trace en
    // particulier sans que les autres diluent la mesure.
    std::vector<const track::Track*> selected;
    for (const track::Track& t : tracks) {
        if (opts.trackFilter.empty()
            || t.name.find(opts.trackFilter) != std::string::npos
            || t.source.find(opts.trackFilter) != std::string::npos) {
            selected.push_back(&t);
        }
    }
    if (selected.empty()) {
        std::printf("✗ aucun circuit ne correspond a « %s »\n", opts.trackFilter.c_str());
        return 1;
    }

    engine::Rng rng(opts.hasSeed ? opts.seed : 0x9E3779B9u);

    std::map<std::string, Tally> byChar;
    std::vector<std::string> startOrder;
    int completed = 0;

    for (int i = 0; i < opts.races; i++) {
        track::Track circuit = *selected[static_cast<size_t>(i) % selected.size()];
        const config::Config raceCfg = track::apply_track(cfg, circuit);

        // Un grand prix neuf repart d'un tirage, comme dans le service
        // (`advance_grand_prix`). Sans ca, depuis que chaque course aligne
        // `kartCount` karts parmi davantage de personnages, les memes karts
        // couraient toute la campagne et les autres jamais.
        if (i % cfg.grandPrix.races == 0) startOrder.clear();

        engine::WorldState finished;
        std::string why;
        if (!simulate_one(raceCfg, rng, startOrder, finished, why)) {
            std::printf("✗ course %d : %s\n", i + 1, why.c_str());
            return 1;
        }
        completed++;

        // L'ordre d'arrivee devient la grille de la manche suivante, comme en
        // course reelle : le banc mesure le jeu tel qu'il se joue.
        startOrder.clear();
        for (int id : finished.finishOrder) {
            startOrder.push_back(finished.karts[static_cast<size_t>(id)].charName);
        }

        for (size_t rank = 0; rank < finished.finishOrder.size(); rank++) {
            const engine::Kart& kart =
                finished.karts[static_cast<size_t>(finished.finishOrder[rank])];
            Tally& t = byChar[kart.charName];
            t.races++;
            t.rankSum += static_cast<long long>(rank) + 1;
            if (rank == 0) t.wins++;
            const auto pts = finished.racePoints.find(kart.charName);
            if (pts != finished.racePoints.end()) t.points += pts->second;
        }
    }

    // Le classement du banc : par points, comme un grand prix.
    std::vector<std::pair<std::string, Tally>> rows(byChar.begin(), byChar.end());
    std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
        if (a.second.points != b.second.points) return a.second.points > b.second.points;
        return a.first < b.first;
    });

    if (opts.csv) {
        std::printf("personnage,courses,victoires,points,rang_moyen\n");
        for (const auto& row : rows) {
            std::printf("%s,%d,%d,%lld,%.2f\n", row.first.c_str(),
                        row.second.races, row.second.wins, row.second.points,
                        row.second.races ? static_cast<double>(row.second.rankSum)
                                           / row.second.races : 0.0);
        }
        return 0;
    }

    std::printf("%d course(s) sur %zu circuit(s), graine %u\n\n",
                completed, selected.size(),
                opts.hasSeed ? opts.seed : 0x9E3779B9u);
    std::printf("%-10s %8s %10s %8s %10s\n",
                "personnage", "courses", "victoires", "points", "rang moy.");

    for (const auto& row : rows) {
        const Tally& t = row.second;
        std::printf("%-10s %8d %9d%% %8lld %10.2f\n",
                    row.first.c_str(), t.races,
                    t.races ? (t.wins * 100 / t.races) : 0,
                    t.points,
                    t.races ? static_cast<double>(t.rankSum) / t.races : 0.0);
    }

    // CE QUE CE BANC NE MESURE PAS ENCORE.
    //
    // En v0 les karts ne se touchent pas (`resolve_kart_contacts` est vide) et
    // ne recoivent aucun objet (`roll_item` rend « rien »). Il ne reste donc que
    // la pointe pour departager, et l'ecart entre le plus rapide et le plus lent
    // du plateau vaut 5 % — moins que ce que la grille donne d'avance. Le
    // classement REPRODUIT donc l'ordre de depart, et les colonnes ci-dessus
    // disent surtout qui est parti devant.
    //
    // Ce n'est pas un defaut d'equilibrage : c'est ce qu'une course sans
    // interaction PEUT produire. Les chiffres deviendront lisibles quand
    // `items.cpp` et `road.cpp::resolve_kart_contacts` seront ecrits — d'ici la,
    // ce banc verifie que la simulation TIENT (aucun NaN, toutes les courses
    // arrivent au bout), pas que le plateau est juste.
    std::printf("\n✓ campagne terminee, aucun NaN.\n");
    std::printf("  Note : sans objets ni contacts entre karts (v0), le classement\n"
                "  suit l'ordre de grille — l'ecart de pointe du plateau (5 %%) ne\n"
                "  suffit pas a doubler. Le banc verifie ici la TENUE du moteur.\n");
    return 0;
}

int run_soak(const config::Config& cfg, const std::vector<track::Track>& tracks,
             double durationSeconds) {
    if (tracks.empty()) {
        std::printf("✗ aucun circuit a simuler\n");
        return 1;
    }

    engine::Rng rng(0x9E3779B9u);
    track::Track circuit = tracks[0];
    const config::Config raceCfg = track::apply_track(cfg, circuit);

    double now = 0;
    engine::WorldState state = engine::create_world_state(raceCfg, rng, now);

    const long long totalTicks = static_cast<long long>(durationSeconds * 30);
    long long races = 0;

    for (long long tick = 0; tick < totalTicks; tick++) {
        std::vector<engine::Event> events =
            engine::step_physics(raceCfg, state, rng, now, DT);
        now += DT_MS;
        state.simTime = now;

        std::string why;
        if (!check_integrity(state, why)) {
            std::printf("✗ integrite perdue au pas %lld : %s\n", tick, why.c_str());
            return 1;
        }

        for (const engine::Event& e : events) {
            if (e.type == engine::EventType::RaceOver) {
                // Le soak enchaine, comme le service : c'est la duree qui
                // decide, pas le nombre de courses.
                races++;
                std::vector<std::string> order;
                for (int id : state.finishOrder) {
                    order.push_back(state.karts[static_cast<size_t>(id)].charName);
                }
                state = engine::create_world_state(raceCfg, rng, now, order);
            }
        }
    }

    std::printf("✓ soak de %.0f s : %lld pas, %lld course(s), pas de NaN.\n",
                durationSeconds, totalTicks, races);
    return 0;
}

} // namespace tools
