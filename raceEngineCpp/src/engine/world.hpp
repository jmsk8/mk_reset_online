// Creation d'un monde et structures de l'etat. Etat en structs a champs
// publics ; le comportement est dans des fonctions libres.

#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "config/config.hpp"
#include "engine/rng.hpp"

namespace engine {

// Axes derives d'un personnage, partages par les karts qui le jouent.
struct CharacterStats {
    std::string name;

    // Points bruts (releve d'equilibrage).
    int rawWeight = 0;
    int rawPower = 0;
    int rawHandling = 0;

    // Normalises sur [0, 1].
    double normWeight = 0;
    double normPower = 0;
    double normHandling = 0;

    double mass = 0;
    double force = 0;
    double grip = 0;

    double topSpeed = 0;
    double acceleration = 0;
    double agility = 0;
    double cornering = 0;
};

using StatsTable = std::vector<CharacterStats>;

enum class KartState {
    Grid, // sur la grille, avant le coup d'envoi
    Running,
    Hit // tete-a-queue
};

// Releve de decision ; seul `Cruising` existe pour l'instant.
enum class AiState {
    Cruising = 0
};

// Objet tenu (`roll_item` ne rend encore rien).
struct HeldItem {
    int id = 0;
    int type = 0;
};

struct Kart {
    int id = 0;
    std::string charName;

    // Pointe dans la StatsTable du monde (partagee par personnage).
    const CharacterStats* stats = nullptr;

    // Gabarit deduit du sprite (`hello.karts[].body`).
    config::KartBody body;

    // ── Position dans le monde ──────────────────────────────────────────
    // `worldX` boucle sur `cfg.world.width` ; `yPercent` est borne entre
    // `road.minY` et `road.maxY`.
    double worldX = 0;
    double yPercent = 0;
    double totalDistance = 0;
    double finishDistance = 0;

    // ── Regime moteur ───────────────────────────────────────────────────────
    double absoluteVelocity = 0;
    double momentum = 0;
    double momentumTarget = 0;
    double nextMomentumChange = 0;

    // Elan mis de cote pendant un objet de vitesse (-1 : rien).
    double preBoostMomentum = -1;
    double preBoostDriftLeft = 0;

    // Vitesse reelle le long de la piste sur le tick, en px/s.
    double contactSpeed = 0;

    // ── Lateral ───────────────────────────────────────────────
    // `vy` n'est ecrit que par `steer()`.
    double vy = 0;
    double targetVy = 0;

    // Profondeur visee.
    double laneY = 0;
    double nextWanderAt = 0;

    // Gain de volant sous objet de vitesse (pose a chaque tick).
    double steerBoost = 1;

    // ── Depart et malus ────────────────────────────────────────────
    double startStallUntil = 0;
    double boostEndTime = 0;

    // Choc de tuyau : arret net, recul, puis sursis.
    double bumpEndTime = 0;
    double bumpRecoilLeft = 0;
    double pipeImmuneUntil = 0;
    bool bumped = false;

    // ── Etat de course ────────────────────────────────────────────
    KartState state = KartState::Grid;
    int rank = 1;
    int lapCount = 0;
    // Zone de dernier tour (race.cpp).
    bool finalLapSign = false;
    bool finished = false;
    int finishRank = 0;
    AiState aiState = AiState::Cruising;

    // ── Objets ───────────────────────────────────────────────
    // Deux emplacements ; seul le premier part dans le snapshot.
    std::optional<HeldItem> heldItems[2];

    // Date de remise d'un objet ramasse.
    double pendingItemGrantTime = 0;
    double boxPassedAt = 0;
};

struct ItemBox {
    double worldX = 0;
    double y = 0;
    bool active = true;
    double reactivateTime = 0;
};

struct Pipe {
    double worldX = 0;
    double y = 0;
    int kind = 0;
};

enum class Phase {
    Countdown,
    Racing,
    Finishing,
    Results
};

struct WorldState {
    Phase phase = Phase::Countdown;

    // Stats du monde, pointees par `Kart::stats` : un WorldState se deplace
    // mais ne se copie pas (copie interdite ci-dessous).
    StatsTable statsTable;
    std::vector<Kart> karts;
    std::vector<ItemBox> itemBoxes;
    std::vector<Pipe> pipes;

    // Ordre d'arrivee par id de kart (`fo`).
    std::vector<int> finishOrder;

    // Cameras : course, et decor en parallaxe (mi-vitesse).
    double cameraX = 0;
    double bgCameraX = 0;
    double cameraSpeed = 0;

    // Horloge de simulation en ms (1000/30 par pas).
    double simTime = 0;

    // Tour du leader.
    int leaderLap = 1;

    // Classement lateral recalcule deux fois par seconde.
    double lastLeaderboardUpdate = 0;
    std::vector<int> previousRanking;

    // ── Machine a phases ───────────────────────────────────────────
    double startAt = 0; // date du feu vert
    double countdownMs = 0;
    double resultsAt = 0; // 0 = course pas close
    bool finalSignShown = false;
    bool flagShown = false;

    // Panneau de Lakitu ; `group` vide = pas de panneau.
    std::string signGroup;
    int signFrame = 0;
    double signUntil = 0;

    // Camera d'approche : cible et vitesse.
    bool hasCameraTarget = false;
    double cameraTarget = 0;

    // ── Grand prix ─────────────────────────────────────────────
    // Points indexes par personnage (les ids changent a chaque manche).
    int gpRound = 1;
    std::map<std::string, int> racePoints;
    std::map<std::string, int> gpPoints;

    WorldState() = default;
    WorldState(WorldState&&) = default;
    WorldState& operator=(WorldState&&) = default;
    WorldState(const WorldState&) = delete;
    WorldState& operator=(const WorldState&) = delete;
};

// Stats de chaque personnage ; leve si un budget ne tombe pas juste.
StatsTable derive_character_stats(const config::Config& cfg);

// Cree le monde : grille, karts, boites et tuyaux. `startOrder` (noms de
// personnages) : vide, la grille est tiree au sort.
WorldState create_world_state(const config::Config& cfg, Rng& rng, double now,
                              const std::vector<std::string>& startOrder = {});

} // namespace engine
