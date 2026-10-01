#include "protocol.hpp"

#include "engine/math.hpp"
#include "json.hpp"

namespace protocol {

namespace {

const char* phase_name(engine::Phase phase) {
    switch (phase) {
        case engine::Phase::Countdown: return "countdown";
        case engine::Phase::Racing:    return "racing";
        case engine::Phase::Finishing: return "finishing";
        case engine::Phase::Results:   return "results";
    }
    return "countdown";
}

// Cles du releve de decision, dans l'ordre des indices de `aiTuple`.
const char* const AI_STATES[] = { "cruising", "pipe", "dodging", "safety", "giveWay", "aiming" };
const char* const AI_DANGERS[] = { "", "carrier", "ram", "shot" };

// [id, worldX, yPercent, totalDistance, flags, rank, heldId, heldType,
//  heldHold, orbitAngle, orbIds, hitEnd, bumpEnd]
//
// Toujours treize cases (6 a 12 nulles pour l'instant) : un tuple plus court
// decalerait la lecture cote client.
void write_kart_tuple(json::Writer& w, const engine::Kart& kart) {
    w.begin_array();
    w.integer(kart.id);
    w.number(engine::round_to(kart.worldX, 2));
    w.number(engine::round_to(kart.yPercent, 2));
    w.number(engine::round_to(kart.totalDistance, 1));

    // Champ de bits.
    int flags = 0;
    if (kart.state == engine::KartState::Grid) flags |= 1;      // FLAG_GRID
    if (kart.finished) flags |= 16;                              // FLAG_FINISHED
    if (kart.bumped) flags |= 128;                               // FLAG_BUMPED
    if (kart.finalLapSign && !kart.finished) flags |= 512;       // FLAG_FINAL_LAP
    w.integer(flags);

    w.integer(kart.rank);

    // Seul le premier emplacement d'objet est transmis.
    if (kart.heldItems[0].has_value()) {
        w.integer(kart.heldItems[0]->id);
        w.integer(kart.heldItems[0]->type);
    } else {
        w.null();  // heldId
        w.null();  // heldType
    }
    w.null();  // heldHold
    w.null();  // orbitAngle
    w.null();  // orbIds
    w.null(); // hitEnd

    // `bumpEnd` : fin du malus en temps serveur, pour qu'un arrivant reprenne
    // l'animation au bon moment.
    if (kart.bumped) w.number(engine::js_round(kart.bumpEndTime));
    else w.null();

    w.end_array();
}

void write_snapshot_body(json::Writer& w, const config::Config& cfg,
                         const engine::WorldState& state, double simTime,
                         VoteTally vote, const std::vector<engine::Event>& events) {
    w.key("t");  w.string("s");

    // Arrondi a la milliseconde.
    w.key("ts"); w.number(engine::js_round(simTime));

    w.key("cx"); w.number(engine::round_to(state.cameraX, 2));
    w.key("bx"); w.number(engine::round_to(state.bgCameraX, 2));

    w.key("k");
    w.begin_array();
    for (const engine::Kart& kart : state.karts) write_kart_tuple(w, kart);
    w.end_array();

    // Releve de decision : 0 par kart sans `sight`, comme en JS.
    w.key("ai");
    w.begin_array();
    for (size_t i = 0; i < state.karts.size(); i++) w.integer(0);
    w.end_array();

    // Aucun objet en vol pour l'instant.
    w.key("i"); w.begin_array(); w.end_array();

    // Boites alignees sur `hello.boxes[]` : la case i est la boite i.
    w.key("b");
    w.begin_array();
    for (const engine::ItemBox& box : state.itemBoxes) w.integer(box.active ? 1 : 0);
    w.end_array();

    w.key("ph"); w.string(phase_name(state.phase));
    w.key("lp"); w.integer(state.leaderLap);

    // [groupe, image] ; le drapeau s'anime cote client, seul le groupe part.
    w.key("sg");
    if (state.signGroup.empty()) {
        w.null();
    } else {
        w.begin_array();
        w.string(state.signGroup);
        if (state.signGroup == "start") w.integer(state.signFrame);
        else if (state.signGroup == "laps") w.string("final");
        else w.null();
        w.end_array();
    }

    // Orage non simule.
    w.key("st"); w.null();

    // Ordre d'arrivee dans chaque snapshot, pour les arrivants.
    w.key("fo");
    w.begin_array();
    for (int id : state.finishOrder) w.integer(id);
    w.end_array();

    // [manche, points de la course, cumul] ; tableaux alignes sur l'ordre de
    // `state.karts` (celui du `hello`).
    w.key("gp");
    w.begin_array();
    w.integer(state.gpRound);
    w.begin_array();
    for (const engine::Kart& kart : state.karts) {
        const auto it = state.racePoints.find(kart.charName);
        w.integer(it == state.racePoints.end() ? 0 : it->second);
    }
    w.end_array();
    w.begin_array();
    for (const engine::Kart& kart : state.karts) {
        const auto it = state.gpPoints.find(kart.charName);
        w.integer(it == state.gpPoints.end() ? 0 : it->second);
    }
    w.end_array();
    w.end_array();

    w.key("vt");
    w.begin_array();
    w.integer(vote.votes);
    w.integer(vote.watchers);
    w.end_array();

    // Seuls les evenements qui declenchent une animation sont transmis ; le
    // reste se deduit du snapshot.
    if (!events.empty()) {
        bool wroteAny = false;
        json::Writer ev;
        ev.begin_array();
        for (const engine::Event& e : events) {
            if (e.type == engine::EventType::LeaderboardPosition) {
                ev.begin_object();
                ev.key("type");         ev.string("leaderboardPosition");
                ev.key("kartId");       ev.integer(e.kartId);
                // Indices, pas rangs.
                ev.key("newPosition");  ev.integer(e.newPosition);
                ev.key("prevPosition"); ev.integer(e.prevPosition);
                ev.end_object();
                wroteAny = true;
            } else if (e.type == engine::EventType::PipeShaken) {
                // Seul evenement qui ne se deduit d'aucun snapshot.
                ev.begin_object();
                ev.key("type");      ev.string("pipeShaken");
                ev.key("pipeIndex"); ev.integer(e.pipeIndex);
                ev.key("kartId");    ev.integer(e.kartId);
                ev.end_object();
                wroteAny = true;
            }
        }
        ev.end_array();
        if (wroteAny) {
            w.key("ev");
            w.raw(ev.str());
        }
    }
}

} // namespace

std::string build_snapshot(const config::Config& cfg, const engine::WorldState& state,
                           double simTime, VoteTally vote,
                           const std::vector<engine::Event>& events) {
    json::Writer w;
    w.begin_object();
    write_snapshot_body(w, cfg, state, simTime, vote, events);
    w.end_object();
    return w.str();
}

std::string build_hello(const config::Config& cfg, const engine::WorldState& state,
                        double simTime, double t0, double serverTime, VoteTally vote,
                        const std::vector<engine::Event>& events) {
    json::Writer w;
    w.begin_object();

    w.key("t");          w.string("hello");
    w.key("protocol");   w.integer(PROTOCOL_VERSION);
    w.key("serverTime"); w.number(engine::js_round(serverTime));
    w.key("t0");         w.number(engine::js_round(t0));

    w.key("world");
    w.begin_object();
    w.key("width");       w.number(cfg.world.width);
    w.key("finishLineX"); w.number(cfg.world.finishLineX);
    w.key("sunX");        w.number(cfg.world.sunX);
    w.key("roadMinY");    w.number(cfg.road.minY);
    w.key("roadMaxY");    w.number(cfg.road.maxY);
    w.key("roadPPS");     w.number(cfg.speeds.roadPPS);
    // Duree du tete-a-queue (le client en deduit la frame).
    w.key("hitDuration"); w.number(cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration);

    w.key("orbit");
    w.begin_object();
    w.key("count");   w.integer(cfg.orbit.count);
    w.key("radiusX"); w.number(cfg.orbit.radiusX);
    w.key("radiusY"); w.number(cfg.orbit.radiusY);
    w.end_object();

    w.key("shellAnimSpeed"); w.number(cfg.itemAnim.greenShellAnimSpeed);
    w.key("billAnimSpeed");  w.number(cfg.itemAnim.billAnimSpeed);
    w.key("laps");           w.integer(cfg.race.laps);
    w.key("gpRaces");        w.integer(cfg.grandPrix.races);
    w.key("flagAnimSpeed");  w.integer(220);

    // Systemes non simules : valeurs de config, pour le HUD de debug.
    w.key("blastRadius"); w.number(cfg.blueShell.blastRadiusX);
    w.key("shrinkScale"); w.number(cfg.lightning.scale);

    w.key("ai");
    w.begin_object();
    w.key("states");
    w.begin_array();
    for (const char* s : AI_STATES) w.string(s);
    w.end_array();
    w.key("dangers");
    w.begin_array();
    for (const char* d : AI_DANGERS) w.string(d);
    w.end_array();
    w.end_object();

    // Demi-emprises reelles des corps (carte de debug). Les valeurs de
    // `hitboxes` sont des ecarts entre centres, donc deja des sommes.
    w.key("hitboxes");
    w.begin_object();
    w.key("kart");
    w.begin_object();
    w.key("x"); w.number(engine::round_to(cfg.hitboxes.kartVsKart.x / 2, 2));
    w.key("y"); w.number(engine::round_to(cfg.hitboxes.kartVsKart.y / 2, 3));
    w.end_object();
    // Emprise propre du tuyau : demi-axes d'un disque.
    w.key("pipe");
    w.begin_object();
    w.key("x");     w.number(engine::round_to(cfg.pipe.hitbox.x, 2));
    w.key("y");     w.number(engine::round_to(cfg.pipe.hitbox.y, 3));
    w.key("round"); w.boolean(true);
    w.end_object();
    w.key("item");
    w.begin_object();
    w.key("x"); w.number(cfg.bodies.item.x);
    w.key("y"); w.number(cfg.bodies.item.y);
    w.end_object();
    w.key("heldBehindX"); w.number(cfg.offsets.heldItemBehind);
    // Boite a objets : zone ou doit passer le centre d'un kart.
    w.key("itemBox");
    w.begin_object();
    w.key("x"); w.number(cfg.hitboxes.itemBox.x);
    w.key("y"); w.number(cfg.hitboxes.itemBox.y);
    w.end_object();
    w.end_object();

    w.key("vision");
    w.begin_object();
    w.key("rangeFront");    w.number(cfg.vision.rangeFront);
    w.key("rangeBack");     w.number(cfg.vision.rangeBack);
    w.key("pressureRange"); w.number(cfg.vision.pressureRange);
    w.key("threatLane");    w.number(cfg.vision.threatLane);
    w.key("clear");         w.number(engine::round_to(cfg.vision.clear, 3));
    w.end_object();

    // Taille dessinee du tuyau en px de monde ; elle determine l'emprise.
    w.key("pipeDraw");
    w.begin_object();
    w.key("w"); w.number(engine::round_to(cfg.pipe.drawW, 2));
    w.key("h"); w.number(engine::round_to(cfg.pipe.drawH, 2));
    w.end_object();

    w.end_object(); // world

    // Identite et gabarit de chaque kart, tires de son sprite.
    w.key("karts");
    w.begin_array();
    for (const engine::Kart& kart : state.karts) {
        w.begin_object();
        w.key("id");   w.integer(kart.id);
        w.key("char"); w.string(kart.charName);
        w.key("body");
        w.begin_object();
        w.key("x");     w.number(engine::round_to(kart.body.x, 2));
        w.key("y");     w.number(engine::round_to(kart.body.y, 3));
        w.key("scale"); w.number(engine::round_to(kart.body.scale, 4));
        w.end_object();
        w.end_object();
    }
    w.end_array();

    w.key("boxes");
    w.begin_array();
    for (const engine::ItemBox& box : state.itemBoxes) {
        w.begin_object();
        w.key("x"); w.number(engine::round_to(box.worldX, 2));
        w.key("y"); w.number(engine::round_to(box.y, 2));
        w.end_object();
    }
    w.end_array();

    // Tuyaux fixes : envoyes dans le `hello`. Leur ordre est celui de l'index
    // d'un `pipeShaken`.
    w.key("pipes");
    w.begin_array();
    for (const engine::Pipe& pipe : state.pipes) {
        w.begin_object();
        w.key("x");    w.number(engine::round_to(pipe.worldX, 2));
        w.key("y");    w.number(engine::round_to(pipe.y, 2));
        w.key("kind"); w.string(pipe.kind == 1 ? "red" : "green");
        w.end_object();
    }
    w.end_array();

    w.key("snapshot");
    w.begin_object();
    write_snapshot_body(w, cfg, state, simTime, vote, events);
    w.end_object();

    w.end_object();
    return w.str();
}

std::string build_pong(const std::string& clientToken, double serverTime) {
    json::Writer w;
    w.begin_object();
    w.key("t"); w.string("pong");

    // Renvoye tel quel (non converti en nombre), et seulement s'il est
    // numerique : sinon `null`.
    bool numeric = !clientToken.empty();
    for (size_t i = 0; i < clientToken.size() && numeric; i++) {
        const char c = clientToken[i];
        const bool sign = (c == '-' || c == '+') && i == 0;
        if (!sign && !(c >= '0' && c <= '9') && c != '.' && c != 'e' && c != 'E') {
            numeric = false;
        }
    }
    w.key("c");
    if (numeric) w.raw(clientToken);
    else w.null();

    w.key("s"); w.number(engine::js_round(serverTime));
    w.end_object();
    return w.str();
}

} // namespace protocol
