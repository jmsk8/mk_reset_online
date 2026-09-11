#include "service/server.hpp"

#include <algorithm>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <map>
#include <memory>
#include <optional>
#include <string>

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

// La simulation tourne a 30 Hz, la diffusion a 10 : le client interpole entre
// deux snapshots, il n'a pas besoin de tous les pas. Diffuser plus vite double
// la bande passante par spectateur sans rien changer a ce qu'il voit.
//
// Ce rapport n'est pas libre : `RENDER_DELAY_MS = 200` cote client est cale sur
// SEND_HZ = 10 (piege P-3). Le changer degrade visiblement la fluidite sans rien
// afficher d'anormal.
constexpr int SEND_HZ = 10;
constexpr int TICKS_PER_SEND = TICK_HZ / SEND_HZ;

// Plafond de rattrapage : sans lui, une pause de l'hote declenche une spirale ou
// chaque tick rejoue le retard accumule, ce qui sature le CPU — d'autant plus
// avec la limite a 0.25 cpu de ce service (migration-wss-2026-08.md §6.14).
constexpr int MAX_CATCHUP_STEPS = 5;

// Delai de grace avant l'arret de la course quand plus personne ne regarde. Un
// simple F5 ne doit pas repartir de zero.
constexpr double IDLE_GRACE_MS = 30000;

// Le client n'envoie que `ping`, `vis`, `vote` et `watch`, quelques dizaines
// d'octets : ce qui depasse est une tentative.
constexpr int MAX_PAYLOAD = 512;

// Le sujet de diffusion. Un seul, et c'est tout l'interet : uWS compresse la
// charge UNE FOIS pour le sujet, la ou une boucle d'envoi la recompresserait
// par connexion.
constexpr const char* TOPIC = "race";

double now_ms() {
    using namespace std::chrono;
    return static_cast<double>(
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

// Un signal ne peut toucher qu'a ca : le reste du service est lu par la boucle,
// et un handler qui rebatirait le monde le ferait sous les pieds de uWS.
volatile std::sig_atomic_t g_sighup = 0;

void on_sighup(int) { g_sighup = 1; }

// Ce que le service garde par connexion.
struct ClientMeta {
    bool hidden = false;
    bool voted = false;
    bool hasWatch = false;
    long long watchId = 0;
};

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
    int clientCount = 0;
    int votedCount = 0;

    // Le grand prix court sur plusieurs courses : il vit ICI et non dans l'etat
    // du monde, refait a chaque depart.
    int gpRound = 1;
    std::map<std::string, int> gpPoints;

    // Grille de la manche suivante, vainqueur en pole. Vide = tiree au sort,
    // c'est ce qui ouvre chaque grand prix.
    std::vector<std::string> lastFinishOrder;

    long long totalRaces = 0;

    // Poses par le vote unanime ou par SIGHUP, consommes par la boucle : on ne
    // rebatit pas le monde depuis un gestionnaire de signal ni depuis un
    // handler de message.
    bool restartRequested = false;

    // Date a laquelle la course s'arretera faute de spectateurs. 0 = pas de
    // compte a rebours en cours.
    double idleSince = 0;

    double lastWall = 0;
    double accumulator = 0;
    long long tickCounter = 0;

    uWS::App* app = nullptr;
};

protocol::VoteTally tally(const Service& svc) {
    return { svc.votedCount, svc.clientCount };
}

void start_race(Service& svc) {
    if (svc.race.has_value()) return;
    if (svc.tracks.empty()) return;

    const double now = now_ms();

    // Une manche, un circuit : le grand prix parcourt le dossier dans l'ordre
    // des noms de fichiers. Le choix se fait ICI et pas plus bas parce que le
    // circuit est dans la CONFIG — la longueur du tour, la ligne et les boites
    // en font partie — et que la config doit etre complete avant que le monde
    // ne soit bati.
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

// La manche suivante, ou un bloc neuf. Appele sur `raceOver`, et c'est le
// SERVICE qui le fait : lui seul detient `create_world_state` et les connexions
// a prevenir.
void advance_grand_prix(Service& svc) {
    if (!svc.race.has_value()) return;

    // L'ordre d'arrivee devient la grille de la manche suivante, par NOM de
    // personnage : les ids sont reconstruits a chaque course, les personnages
    // non.
    svc.lastFinishOrder.clear();
    for (int id : svc.race->state.finishOrder) {
        if (id >= 0 && id < static_cast<int>(svc.race->state.karts.size())) {
            svc.lastFinishOrder.push_back(
                svc.race->state.karts[static_cast<size_t>(id)].charName);
        }
    }

    svc.gpPoints = svc.race->state.gpPoints;

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
    // Sans healthcheck vert, nginx ne demarre pas du tout
    // (`depends_on: race: service_healthy`). C'est aussi ce qui decide du choix
    // de l'image de runtime : il faut un `wget` dedans.
    app.get("/healthz", [&svc](auto* res, auto* /*req*/) {
        json::Writer w;
        w.begin_object();
        w.key("ok");     w.boolean(true);
        w.key("racing"); w.boolean(svc.race.has_value());
        w.key("track");
        if (svc.race.has_value()) w.string(svc.race->trackName);
        else w.null();
        w.key("clients"); w.integer(svc.clientCount);
        w.key("ticks");  w.integer(svc.race.has_value() ? svc.race->ticks : 0);
        w.key("races");  w.integer(svc.totalRaces);
        // `make engine` dit ce qui est CHOISI, /healthz dit ce qui TOURNE : les
        // deux peuvent diverger tant qu'un `make re-race` n'a pas eu lieu
        // (piege P-7).
        w.key("engine"); w.string("cpp");
        w.end_object();

        res->writeHeader("Content-Type", "application/json");
        res->end(w.str());
    });

    // ── /ws/race ────────────────────────────────────────────────────────────
    // L'ordre des champs suit celui de `WebSocketBehavior` : un designated
    // initializer en C++ doit respecter l'ordre de declaration, sans quoi le
    // compilateur refuse.
    app.ws<ClientMeta>(opts.wsPath, {
        // Deux snapshots consecutifs se ressemblent enormement : c'est le cas
        // ideal pour deflate, a condition de garder le contexte d'un message a
        // l'autre. La fenetre est reduite a 4 Ko — elle couvre l'historique
        // utile a des messages de quelques centaines d'octets tout en bornant la
        // memoire par connexion, qui compte avec la limite a 128 Mo.
        .compression = uWS::DEDICATED_COMPRESSOR_4KB,

        // `maxPayload: 512` du JS.
        .maxPayloadLength = MAX_PAYLOAD,

        // Le heartbeat manuel du JS (ping toutes les 30 s puis `terminate()`)
        // devient un reglage : uWS ping tout seul et ferme ce qui ne repond
        // plus. Le navigateur repond au niveau PROTOCOLE, sans code client.
        .idleTimeout = 60,
        .sendPingsAutomatically = true,

        .upgrade = [&svc, &opts](auto* res, auto* req, auto* context) {
            // Le controle d'origine a lieu ICI, avant meme d'accepter la
            // connexion : un 403 brut, comme le JS.
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
            svc.clientCount++;
            svc.idleSince = 0;

            // La course demarre a la PREMIERE connexion : personne devant
            // l'ecran, aucun CPU consomme.
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
            // Le service repond a `ping`, note `vis` et `watch`, compte `vote`.
            // Tout le reste est ignore EN SILENCE : c'est un flux de lecture, il
            // n'existe aucune raison legitime de lui envoyer autre chose.
            const json::ClientMessage msg = json::parse_client_message(payload);
            ClientMeta* meta = static_cast<ClientMeta*>(ws->getUserData());

            switch (msg.type) {
                case json::ClientMessageType::Ping:
                    ws->send(protocol::build_pong(msg.pingToken, now_ms()),
                             uWS::OpCode::TEXT);
                    break;

                case json::ClientMessageType::Vote:
                    meta->voted = !meta->voted;
                    svc.votedCount += meta->voted ? 1 : -1;
                    if (svc.votedCount < 0) svc.votedCount = 0;
                    // Unanimite : tout le monde doit vouloir repartir. Un seul
                    // spectateur suffit donc a relancer quand il est seul, ce
                    // qui est le cas le plus frequent.
                    if (svc.clientCount > 0 && svc.votedCount >= svc.clientCount) {
                        svc.restartRequested = true;
                    }
                    break;

                case json::ClientMessageType::Watch:
                    meta->hasWatch = msg.hasId;
                    meta->watchId = msg.watchId;
                    break;

                case json::ClientMessageType::Vis: {
                    const bool wasHidden = meta->hidden;
                    meta->hidden = msg.hidden;
                    if (meta->hidden) {
                        // Un onglet en arriere-plan se DESABONNE : c'est ce qui
                        // rend le banner gratuit dans un onglet oublie. La course
                        // continue sans lui.
                        ws->unsubscribe(TOPIC);
                    } else {
                        ws->subscribe(TOPIC);
                        // Au retour, le client a rate tout ce qui s'est passe :
                        // il lui faut une scene complete, exactement comme a un
                        // arrivant.
                        if (wasHidden && svc.race.has_value()) {
                            ws->send(protocol::build_hello(svc.race->cfg, svc.race->state,
                                                           svc.race->state.simTime,
                                                           svc.race->t0, now_ms(),
                                                           tally(svc), {}),
                                     uWS::OpCode::TEXT);
                        }
                    }
                    break;
                }

                case json::ClientMessageType::Unknown:
                default:
                    break;
            }
        },

        .close = [&svc](auto* ws, int /*code*/, std::string_view /*message*/) {
            ClientMeta* meta = static_cast<ClientMeta*>(ws->getUserData());
            if (meta->voted && svc.votedCount > 0) svc.votedCount--;

            svc.clientCount--;
            if (svc.clientCount < 0) svc.clientCount = 0;

            // Delai de grace : un F5 ne doit pas emporter la course.
            if (svc.clientCount == 0 && !svc.opts.alwaysOn) {
                svc.idleSince = now_ms();
            }
        }
    });

    // ── La boucle ───────────────────────────────────────────────────────────
    //
    // Un timer a ~33 ms, l'ACCUMULATEUR a pas fixe faisant le vrai travail : le
    // timer peut deriver, le pas de simulation non.
    struct us_timer_t* timer = us_create_timer(
        reinterpret_cast<struct us_loop_t*>(uWS::Loop::get()), 0, sizeof(Service*));
    *reinterpret_cast<Service**>(us_timer_ext(timer)) = &svc;

    us_timer_set(timer, [](struct us_timer_t* t) {
        Service& svc = **reinterpret_cast<Service**>(us_timer_ext(t));

        const double wall = now_ms();
        // Ecoule reel PLAFONNE a 1 s : au-dela, l'hote a gele, et rejouer ce
        // retard ne rendrait pas le temps perdu.
        double elapsed = wall - svc.lastWall;
        if (elapsed > 1000) elapsed = 1000;
        if (elapsed < 0) elapsed = 0;
        svc.lastWall = wall;

        // L'arret differe : 30 s apres le depart du dernier spectateur.
        if (svc.idleSince > 0 && svc.clientCount == 0
            && wall - svc.idleSince >= IDLE_GRACE_MS) {
            stop_race(svc);
            svc.idleSince = 0;
        }

        // SIGHUP (`make restart-race`) : un grand prix neuf, sans couper les
        // connexions.
        if (g_sighup) {
            g_sighup = 0;
            svc.restartRequested = true;
            std::printf("[signal] SIGHUP — grand prix neuf\n");
            std::fflush(stdout);
        }

        // Le vote unanime et SIGHUP passent par ici : rebatir le monde depuis un
        // handler de message ou de signal invaliderait l'etat que la boucle est
        // en train de lire.
        if (svc.restartRequested) {
            svc.restartRequested = false;
            svc.votedCount = 0;
            svc.gpRound = 1;
            svc.gpPoints.clear();
            svc.lastFinishOrder.clear();
            svc.race.reset();
            start_race(svc);
            if (svc.race.has_value()) {
                // Une course neuve, c'est un `t0` neuf : le client s'en sert
                // pour distinguer « nouvelle course » de « reconnexion » et
                // faire tomber le rideau (piege P-2).
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

            // L'horloge de SIMULATION avance de 1000/30 par pas simule, pas par
            // temps reel : c'est elle que le client interpole (piege P-4).
            svc.race->state.simTime += DT_MS;
            svc.race->ticks++;
            svc.accumulator -= DT;
            steps++;
            svc.tickCounter++;

            if (svc.tickCounter % TICKS_PER_SEND == 0) {
                const std::string payload =
                    protocol::build_snapshot(svc.race->cfg, svc.race->state,
                                             svc.race->state.simTime, tally(svc), events);
                // Compressee UNE FOIS pour le sujet, quel que soit le nombre de
                // spectateurs.
                svc.app->publish(TOPIC, payload, uWS::OpCode::TEXT, true);
            }
        }

        // Le retard au-dela du plafond est JETE : mieux vaut une course qui
        // saute que l'hote a genoux.
        if (svc.accumulator > DT * MAX_CATCHUP_STEPS) {
            svc.accumulator = DT * MAX_CATCHUP_STEPS;
        }

        // La manche est close : le service en tire la suivante, et previent tout
        // le monde avec un `hello` complet — le monde a change d'identite, pas
        // seulement d'etat.
        if (raceOver) {
            advance_grand_prix(svc);
            if (svc.race.has_value()) {
                // Un `hello` COMPLET et non un snapshot : le monde a change
                // d'identite, pas seulement d'etat — nouveau circuit possible,
                // nouvelle grille, nouveaux ids. Et un `t0` neuf, qui est le
                // seul discriminant « course neuve / reprise » cote client
                // (piege P-2) : c'est lui qui fait tomber le rideau.
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
