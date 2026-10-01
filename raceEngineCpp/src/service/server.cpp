#include "service/server.hpp"

#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "App.h"

#include "engine/step.hpp"
#include "engine/world.hpp"
#include "json.hpp"
#include "protocol.hpp"

namespace service {

namespace {

constexpr int TICK_HZ = 30;
constexpr double DT = 1.0 / TICK_HZ;
constexpr double DT_MS = DT * 1000.0;

// Simulation a 30 Hz, diffusion a 10 Hz : le client interpole. Lie a
// `RENDER_DELAY_MS = 200` cote client.
constexpr int SEND_HZ = 10;
constexpr int TICKS_PER_SEND = TICK_HZ / SEND_HZ;

// Plafond de rattrapage apres une pause de l'hote.
constexpr int MAX_CATCHUP_STEPS = 5;

// Delai avant l'arret de la course quand plus personne ne regarde (un F5 ne
// doit pas la relancer).
constexpr double IDLE_GRACE_MS = 30000;

// Messages clients courts : au-dela, rejete.
constexpr int MAX_PAYLOAD = 512;

// Delai apres lequel un onglet cache ne compte plus comme spectateur (comme
// HIDDEN_GRACE_MS de server.js et HIDDEN_DISCONNECT_MS de net.js).
constexpr double HIDDEN_GRACE_MS = 60000;

// Sujet de diffusion unique : uWS compresse une fois pour tous.
constexpr const char* TOPIC = "race";

double now_ms() {
    using namespace std::chrono;
    return static_cast<double>(
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

// Seul etat touche par le gestionnaire de signal ; la boucle le lit.
volatile std::sig_atomic_t g_sighup = 0;

void on_sighup(int) { g_sighup = 1; }

// Etat par connexion.
struct ClientMeta {
    // Identifiant du navigateur (`hi`), vide tant qu'il n'est pas recu.
    std::string nav;
    bool hidden = false;
    double hiddenSince = 0;
    bool voted = false;
    bool hasWatch = false;
    long long watchId = 0;
};

using Socket = uWS::WebSocket<false, true, ClientMeta>;

struct Race {
    config::Config cfg;
    engine::WorldState state;
    double t0 = 0;
    long long ticks = 0;
    std::string trackName;
};

struct Service {
    config::Config baseCfg;
    std::vector<track::Track> tracks;
    Options opts;

    engine::Rng rng { 0x9E3779B9u };

    std::optional<Race> race;

    // Connexions ouvertes (uWS ne sait pas les enumerer).
    std::set<Socket*> sockets;

    // Le grand prix dure plusieurs courses : il vit ici, pas dans le monde.
    int gpRound = 1;
    std::map<std::string, int> gpPoints;

    // Grille de la manche suivante, vainqueur en pole. Vide = tiree au sort.
    std::vector<std::string> lastFinishOrder;

    long long totalRaces = 0;

    // Poses par le vote ou SIGHUP, traites par la boucle.
    bool restartRequested = false;

    // Debut du delai d'arret faute de spectateurs ; 0 = aucun.
    double idleSince = 0;

    double lastWall = 0;
    double accumulator = 0;
    long long tickCounter = 0;

    uWS::App* app = nullptr;
};

// ── Spectateurs et vote ────────────────────────────────────────────────────
//
// Memes regles que server.js : un spectateur est un navigateur (pas une
// connexion), avec une voix commune a toutes ses connexions.

// Cle d'un navigateur : son identifiant, ou la connexion a defaut (`@` n'entre
// dans aucun identifiant valide).
std::string nav_key(Socket* ws) {
    const ClientMeta* meta = ws->getUserData();
    if (!meta->nav.empty()) return meta->nav;
    char buf[32];
    std::snprintf(buf, sizeof buf, "@%p", static_cast<const void*>(ws));
    return buf;
}

// [voix, spectateurs]. La voix d'un navigateur qui ne regarde plus ne compte pas.
protocol::VoteTally tally(const Service& svc) {
    const double now = now_ms();
    std::set<std::string> watching;
    std::set<std::string> voters;
    for (Socket* ws : svc.sockets) {
        const ClientMeta* meta = ws->getUserData();
        const std::string key = nav_key(ws);
        if (!meta->hidden || now - meta->hiddenSince < HIDDEN_GRACE_MS) watching.insert(key);
        if (meta->voted) voters.insert(key);
    }
    int votes = 0;
    for (const std::string& key : voters) {
        if (watching.count(key)) votes++;
    }
    return { votes, static_cast<int>(watching.size()) };
}

bool unanimous(const protocol::VoteTally& t) {
    return t.watchers > 0 && t.votes >= t.watchers;
}

bool nav_voted(const Service& svc, const std::string& key) {
    for (Socket* ws : svc.sockets) {
        if (ws->getUserData()->voted && nav_key(ws) == key) return true;
    }
    return false;
}

// Pose ou retire la voix d'un navigateur sur toutes ses connexions, et les
// previent. Cibles relevees avant l'envoi.
void set_nav_vote(Service& svc, const std::string& key, bool voted) {
    std::vector<Socket*> targets;
    for (Socket* ws : svc.sockets) {
        if (nav_key(ws) == key) targets.push_back(ws);
    }
    const std::string message = voted ? R"({"t":"vote","v":true})" : R"({"t":"vote","v":false})";
    for (Socket* ws : targets) {
        ws->getUserData()->voted = voted;
        ws->send(message, uWS::OpCode::TEXT);
    }
}

// Les voix ne survivent pas a la course ; les clients effacent la leur au
// `hello` suivant.
void clear_votes(Service& svc) {
    for (Socket* ws : svc.sockets) ws->getUserData()->voted = false;
}

// Visibilite d'une connexion : un onglet en arriere-plan se desabonne. Rend
// vrai s'il revient au premier plan (il lui faut une scene complete).
bool set_hidden(Socket* ws, bool hidden) {
    ClientMeta* meta = ws->getUserData();
    const bool wasHidden = meta->hidden;
    meta->hidden = hidden;
    if (hidden) {
        if (!wasHidden) meta->hiddenSince = now_ms();
        ws->unsubscribe(TOPIC);
    } else {
        ws->subscribe(TOPIC);
    }
    return wasHidden && !hidden;
}

void start_race(Service& svc) {
    if (svc.race.has_value()) return;
    if (svc.tracks.empty()) return;

    const double now = now_ms();

    // Circuit de la manche, choisi avant de batir le monde (il fait partie de
    // la config).
    track::Track circuit = track::for_round(svc.tracks, svc.gpRound);

    Race race;
    race.cfg = track::apply_track(svc.baseCfg, circuit);
    race.trackName = circuit.name;
    race.t0 = now;
    race.state = engine::create_world_state(race.cfg, svc.rng, now, svc.lastFinishOrder);
    race.state.simTime = now;
    race.state.gpRound = svc.gpRound;
    race.state.gpPoints = svc.gpPoints;

    svc.race.emplace(std::move(race));
    svc.idleSince = 0;
    svc.totalRaces++;

    std::printf("[course] manche %d/%d sur %s — %d karts, tour de %.0f px\n",
                svc.gpRound, svc.baseCfg.grandPrix.races,
                svc.race->trackName.c_str(),
                static_cast<int>(svc.race->state.karts.size()),
                svc.race->cfg.world.width);
    std::fflush(stdout);
}

// Manche suivante ou nouveau bloc, sur `raceOver`.
void advance_grand_prix(Service& svc) {
    if (!svc.race.has_value()) return;

    // L'ordre d'arrivee donne la grille suivante, par nom de personnage (les
    // ids changent a chaque course).
    svc.lastFinishOrder.clear();
    for (int id : svc.race->state.finishOrder) {
        if (id >= 0 && id < static_cast<int>(svc.race->state.karts.size())) {
            svc.lastFinishOrder.push_back(
                svc.race->state.karts[static_cast<size_t>(id)].charName);
        }
    }

    svc.gpPoints = svc.race->state.gpPoints;
    clear_votes(svc);

    const bool complete = svc.gpRound >= svc.baseCfg.grandPrix.races;
    if (complete) {
        // Bloc neuf : scores remis a zero et grille tiree au sort.
        svc.gpRound = 1;
        svc.gpPoints.clear();
        svc.lastFinishOrder.clear();
        std::printf("[grand prix] termine — on repart sur un bloc neuf\n");
    } else {
        svc.gpRound++;
    }
    std::fflush(stdout);

    svc.race.reset();
    start_race(svc);
}

void stop_race(Service& svc) {
    if (!svc.race.has_value()) return;
    svc.race.reset();
    std::printf("[course] arret — plus aucun spectateur depuis 30 s\n");
    std::fflush(stdout);
}

} // namespace

int run(const config::Config& cfg, const std::vector<track::Track>& tracks,
        const Options& opts) {
    Service svc;
    svc.baseCfg = cfg;
    svc.tracks = tracks;
    svc.opts = opts;
    svc.lastWall = now_ms();

    if (opts.alwaysOn) start_race(svc);

    std::signal(SIGHUP, on_sighup);

    uWS::App app;
    svc.app = &app;

    // ── /healthz ────────────────────────────────────────────────────────────
    // Requis par nginx (`depends_on: race: service_healthy`).
    app.get("/healthz", [&svc](auto* res, auto* /*req*/) {
        json::Writer w;
        w.begin_object();
        w.key("ok");     w.boolean(true);
        w.key("racing"); w.boolean(svc.race.has_value());
        w.key("track");
        if (svc.race.has_value()) w.string(svc.race->trackName);
        else w.null();
        // Connexions et navigateurs qui regardent.
        w.key("clients"); w.integer(static_cast<long long>(svc.sockets.size()));
        w.key("spectators"); w.integer(tally(svc).watchers);
        w.key("ticks");  w.integer(svc.race.has_value() ? svc.race->ticks : 0);
        w.key("races");  w.integer(svc.totalRaces);
        // Moteur reellement en service (peut differer de `make engine` avant
        // un `make re-race`).
        w.key("engine"); w.string("cpp");
        w.end_object();

        res->writeHeader("Content-Type", "application/json");
        res->end(w.str());
    });

    // ── /ws/race ────────────────────────────────────────────────────────────
    // Champs dans l'ordre de `WebSocketBehavior` (designated initializers).
    app.ws<ClientMeta>(opts.wsPath, {
        // Contexte deflate conserve entre messages, fenetre de 4 Ko pour borner
        // la memoire par connexion.
        .compression = uWS::DEDICATED_COMPRESSOR_4KB,

        // `maxPayload: 512` du JS.
        .maxPayloadLength = MAX_PAYLOAD,

        // uWS envoie les pings et ferme les connexions muettes.
        .idleTimeout = 60,
        .sendPingsAutomatically = true,

        .upgrade = [&svc, &opts](auto* res, auto* req, auto* context) {
            // Controle d'origine avant d'accepter : 403.
            std::string origin { req->getHeader("origin") };
            if (!opts.allowedOrigins.empty() && !origin.empty()) {
                const bool allowed = std::find(opts.allowedOrigins.begin(),
                                               opts.allowedOrigins.end(),
                                               origin) != opts.allowedOrigins.end();
                if (!allowed) {
                    std::printf("[ws] origine refusee : %s\n", origin.c_str());
                    std::fflush(stdout);
                    res->writeStatus("403 Forbidden")->end();
                    return;
                }
            }

            res->template upgrade<ClientMeta>(
                ClientMeta {},
                req->getHeader("sec-websocket-key"),
                req->getHeader("sec-websocket-protocol"),
                req->getHeader("sec-websocket-extensions"),
                context);
        },

        .open = [&svc](auto* ws) {
            svc.sockets.insert(ws);
            svc.idleSince = 0;

            // La course demarre a la premiere connexion.
            start_race(svc);

            ws->subscribe(TOPIC);

            if (svc.race.has_value()) {
                ws->send(protocol::build_hello(svc.race->cfg, svc.race->state,
                                               svc.race->state.simTime, svc.race->t0,
                                               now_ms(), tally(svc), {}),
                         uWS::OpCode::TEXT);
            }
        },

        .message = [&svc](auto* ws, std::string_view payload, uWS::OpCode /*op*/) {
            // Repond a `ping`, note `hi`, `vis` et `watch`, compte `vote`. Le
            // reste est ignore.
            const json::ClientMessage msg = json::parse_client_message(payload);
            ClientMeta* meta = static_cast<ClientMeta*>(ws->getUserData());

            switch (msg.type) {
                case json::ClientMessageType::Ping:
                    ws->send(protocol::build_pong(msg.pingToken, now_ms()),
                             uWS::OpCode::TEXT);
                    break;

                // Premier message : navigateur et visibilite.
                case json::ClientMessageType::Hi: {
                    // Une seule fois par connexion.
                    if (meta->nav.empty() && !msg.nav.empty()) {
                        meta->nav = msg.nav;
                        // Reprend la voix deja posee par ce navigateur.
                        if (nav_voted(svc, meta->nav)) {
                            meta->voted = true;
                            ws->send(R"({"t":"vote","v":true})", uWS::OpCode::TEXT);
                        }
                    }
                    if (set_hidden(ws, msg.hidden) && svc.race.has_value()) {
                        ws->send(protocol::build_hello(svc.race->cfg, svc.race->state,
                                                       svc.race->state.simTime,
                                                       svc.race->t0, now_ms(),
                                                       tally(svc), {}),
                                 uWS::OpCode::TEXT);
                    }
                    // Deux connexions fusionnees : le quorum a baisse.
                    if (unanimous(tally(svc))) svc.restartRequested = true;
                    break;
                }

                // Bascule par navigateur ; redemarrage a l'unanimite.
                case json::ClientMessageType::Vote: {
                    const std::string key = nav_key(ws);
                    set_nav_vote(svc, key, !nav_voted(svc, key));
                    if (unanimous(tally(svc))) svc.restartRequested = true;
                    break;
                }

                case json::ClientMessageType::Watch:
                    meta->hasWatch = msg.hasId;
                    meta->watchId = msg.watchId;
                    break;

                case json::ClientMessageType::Vis:
                    if (set_hidden(ws, msg.hidden) && svc.race.has_value()) {
                        ws->send(protocol::build_hello(svc.race->cfg, svc.race->state,
                                                       svc.race->state.simTime,
                                                       svc.race->t0, now_ms(),
                                                       tally(svc), {}),
                                 uWS::OpCode::TEXT);
                    }
                    break;

                case json::ClientMessageType::Unknown:
                default:
                    break;
            }
        },

        .close = [&svc](auto* ws, int /*code*/, std::string_view /*message*/) {
            svc.sockets.erase(ws);

            // Un spectateur de moins peut completer l'unanimite.
            if (svc.race.has_value() && unanimous(tally(svc))) svc.restartRequested = true;

            // Delai de grace avant l'arret.
            if (svc.sockets.empty() && !svc.opts.alwaysOn) {
                svc.idleSince = now_ms();
            }
        }
    });

    // ── La boucle ───────────────────────────────────────────────────────────
    //
    // Timer a ~33 ms et accumulateur a pas fixe.
    struct us_timer_t* timer = us_create_timer(
        reinterpret_cast<struct us_loop_t*>(uWS::Loop::get()), 0, sizeof(Service*));
    *reinterpret_cast<Service**>(us_timer_ext(timer)) = &svc;

    us_timer_set(timer, [](struct us_timer_t* t) {
        Service& svc = **reinterpret_cast<Service**>(us_timer_ext(t));

        const double wall = now_ms();
        // Ecoule plafonne a 1 s (hote gele).
        double elapsed = wall - svc.lastWall;
        if (elapsed > 1000) elapsed = 1000;
        if (elapsed < 0) elapsed = 0;
        svc.lastWall = wall;

        // Arret differe apres le depart du dernier spectateur.
        if (svc.idleSince > 0 && svc.sockets.empty()
            && wall - svc.idleSince >= IDLE_GRACE_MS) {
            stop_race(svc);
            svc.idleSince = 0;
        }

        // SIGHUP (`make restart-race`) : nouveau grand prix sans couper les
        // connexions.
        if (g_sighup) {
            g_sighup = 0;
            svc.restartRequested = true;
            std::printf("[signal] SIGHUP — grand prix neuf\n");
            std::fflush(stdout);
        }

        // Redemarrage traite ici, hors des handlers de message et de signal.
        if (svc.restartRequested) {
            svc.restartRequested = false;
            clear_votes(svc);
            svc.gpRound = 1;
            svc.gpPoints.clear();
            svc.lastFinishOrder.clear();
            svc.race.reset();
            start_race(svc);
            if (svc.race.has_value()) {
                // Nouveau `t0` : le client distingue nouvelle course et
                // reconnexion.
                svc.app->publish(TOPIC,
                    protocol::build_hello(svc.race->cfg, svc.race->state,
                                          svc.race->state.simTime, svc.race->t0,
                                          now_ms(), tally(svc), {}),
                    uWS::OpCode::TEXT, true);
            }
            return;
        }

        if (!svc.race.has_value()) return;

        svc.accumulator += elapsed / 1000.0;

        int steps = 0;
        bool raceOver = false;

        while (svc.accumulator >= DT && steps < MAX_CATCHUP_STEPS) {
            std::vector<engine::Event> events =
                engine::step_physics(svc.race->cfg, svc.race->state, svc.rng,
                                     svc.race->state.simTime, DT);

            for (const engine::Event& e : events) {
                if (e.type == engine::EventType::RaceOver) raceOver = true;
            }

            // Horloge de simulation : 1000/30 par pas, interpolee par le client.
            svc.race->state.simTime += DT_MS;
            svc.race->ticks++;
            svc.accumulator -= DT;
            steps++;
            svc.tickCounter++;

            if (svc.tickCounter % TICKS_PER_SEND == 0) {
                const protocol::VoteTally vote = tally(svc);
                // Expiration d'un onglet cache : l'unanimite peut etre atteinte.
                if (unanimous(vote)) svc.restartRequested = true;
                const std::string payload =
                    protocol::build_snapshot(svc.race->cfg, svc.race->state,
                                             svc.race->state.simTime, vote, events);
                // Compressee une fois pour le sujet.
                svc.app->publish(TOPIC, payload, uWS::OpCode::TEXT, true);
            }
        }

        // Retard au-dela du plafond abandonne.
        if (svc.accumulator > DT * MAX_CATCHUP_STEPS) {
            svc.accumulator = DT * MAX_CATCHUP_STEPS;
        }

        // Manche close : la suivante est annoncee par un `hello` complet.
        if (raceOver) {
            advance_grand_prix(svc);
            if (svc.race.has_value()) {
                // `hello` complet (nouveau circuit, grille, ids) et nouveau `t0`.
                svc.app->publish(TOPIC,
                    protocol::build_hello(svc.race->cfg, svc.race->state,
                                          svc.race->state.simTime, svc.race->t0,
                                          now_ms(), tally(svc), {}),
                    uWS::OpCode::TEXT, true);
            }
        }
    }, 33, 33);

    bool listening = false;
    app.listen(opts.port, [&](auto* token) {
        if (token) {
            listening = true;
            std::printf("[service] a l'ecoute sur :%d%s (moteur C++)\n",
                        opts.port, opts.wsPath.c_str());
            std::fflush(stdout);
        }
    });

    if (!listening) {
        std::fprintf(stderr, "[service] impossible d'ecouter sur le port %d\n", opts.port);
        return 1;
    }

    app.run();
    return 0;
}

} // namespace service
