#include "engine/standings.hpp"

#include <algorithm>

#include "engine/step.hpp"

namespace engine {

const Kart* get_leader(const WorldState& state) {
    const Kart* leader = nullptr;
    double best = 0;
    for (const Kart& kart : state.karts) {
        const double remaining = kart.finishDistance - kart.totalDistance;
        if (!leader || remaining < best) {
            leader = &kart;
            best = remaining;
        }
    }
    return leader;
}

void update_leaderboard(const config::Config& cfg, WorldState& state, double now,
                        std::vector<Event>& events) {
    if (state.karts.empty()) return;

    // Le tri se fait sur la distance RESTANTE. `id` departage : sans lui, deux
    // karts a egalite parfaite echangeraient leurs rangs d'un tick a l'autre et
    // le classement clignoterait.
    std::vector<const Kart*> ordered;
    ordered.reserve(state.karts.size());
    for (const Kart& k : state.karts) ordered.push_back(&k);

    std::sort(ordered.begin(), ordered.end(), [](const Kart* a, const Kart* b) {
        // Un kart arrive garde son rang d'arrivee : il roule au ralenti et se
        // ferait sinon doubler au classement par ceux qui courent encore.
        if (a->finished != b->finished) return a->finished;
        if (a->finished && b->finished) return a->finishRank < b->finishRank;

        const double ra = a->finishDistance - a->totalDistance;
        const double rb = b->finishDistance - b->totalDistance;
        if (ra != rb) return ra < rb;
        return a->id < b->id;
    });

    for (size_t i = 0; i < ordered.size(); i++) {
        state.karts[static_cast<size_t>(ordered[i]->id)].rank = static_cast<int>(i) + 1;
    }

    // Le releve ne part que deux fois par seconde : le classement lateral
    // n'est pas une animation, et l'envoyer a chaque tick noierait `ev[]`.
    if (now - state.lastLeaderboardUpdate < 500) return;
    state.lastLeaderboardUpdate = now;

    std::vector<int> ranking;
    ranking.reserve(ordered.size());

    for (size_t i = 0; i < ordered.size(); i++) {
        const int id = ordered[i]->id;
        ranking.push_back(id);

        const auto prev = std::find(state.previousRanking.begin(),
                                    state.previousRanking.end(), id);
        const int prevPos = (prev == state.previousRanking.end())
            ? -1
            : static_cast<int>(prev - state.previousRanking.begin());

        Event ev;
        ev.type = EventType::LeaderboardPosition;
        ev.kartId = id;
        ev.newPosition = static_cast<int>(i);
        ev.prevPosition = prevPos;
        events.push_back(ev);
    }

    state.previousRanking = std::move(ranking);
}

void award_race_points(const config::Config& cfg, WorldState& state) {
    const std::vector<int>& table = cfg.race.points;

    for (size_t i = 0; i < state.finishOrder.size(); i++) {
        const int id = state.finishOrder[i];
        if (id < 0 || id >= static_cast<int>(state.karts.size())) continue;

        const std::string& name = state.karts[static_cast<size_t>(id)].charName;
        const int points = (i < table.size()) ? table[i] : 0;

        // `racePoints` ne vaut que pour la manche qui vient de finir,
        // `gpPoints` cumule depuis le debut du bloc.
        state.racePoints[name] = points;
        state.gpPoints[name] += points;
    }
}

} // namespace engine
