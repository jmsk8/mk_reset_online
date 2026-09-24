// La fabrique d'un monde, et la forme de ce qui vit dedans.
// <- raceEngine/src/engine/world.js
//
// Convention du plan §4.1ter : STRUCT pour tout ce qui est etat de simulation,
// champs publics, zero methode. Le comportement vit dans des fonctions libres
// qui prennent l'etat en parametre — `step_physics(cfg, state, ...)`, jamais
// `state.step()`. C'est ce que fait deja le JS, et c'est ce qui permet de lire
// une passe de simulation sans reconstruire un graphe d'objets.

#pragma once

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "config/config.hpp"
#include "engine/rng.hpp"

namespace engine {

// Les trois axes derives d'un personnage. Deduits UNE FOIS par personnage et
// partages par tous les karts qui le jouent (cf. `Kart::stats`, un pointeur) —
// exactement le `WeakMap<cfg, table>` du JS.
struct CharacterStats {
    std::string name;

    // Les points bruts, gardes pour le releve d'equilibrage.
    int rawWeight = 0;
    int rawPower = 0;
    int rawHandling = 0;

    // Normalises sur [0, 1] a partir des bornes du budget.
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
    Grid,      // sur la grille, avant le coup d'envoi
    Running,
    Hit        // tete-a-queue
};

// Le releve de decision. `Cruising` est le seul etat de la v0 : sans perception,
// l'IA ne juge rien (plan §2).
enum class AiState {
    Cruising = 0
};

// Un objet tenu. En v0 rien ne le remplit : `roll_item` rend toujours vide.
struct HeldItem {
    int id = 0;
    int type = 0;
};

struct Kart {
    int id = 0;
    std::string charName;

    // Pointe dans la StatsTable du monde, jamais copie ni possede ici : deux
    // karts du meme personnage partagent la meme entree (plan §3, recyclage du
    // roster au-dela de 8 karts).
    const CharacterStats* stats = nullptr;

    // Le gabarit dessine, deduit du sprite. Part dans `hello.karts[].body`.
    config::KartBody body;

    // ── Position dans le monde ──────────────────────────────────────────────
    // `worldX` boucle sur `cfg.world.width` ; `yPercent` est BORNE entre
    // `road.minY` et `road.maxY`. L'espace est un ruban : cyclique en longueur,
    // ferme en largeur.
    double worldX = 0;
    double yPercent = 0;
    double totalDistance = 0;
    double finishDistance = 0;

    // ── Regime moteur ───────────────────────────────────────────────────────
    double absoluteVelocity = 0;
    double momentum = 0;
    double momentumTarget = 0;
    double nextMomentumChange = 0;

    // Elan mis de cote pendant un objet de vitesse. -1 = rien en attente.
    double preBoostMomentum = -1;
    double preBoostDriftLeft = 0;

    // Vitesse le long de la piste sur le tick ecoule, en px/s. Relevee a la fin
    // du deplacement et lue par le volant, qui a besoin d'une allure REELLE —
    // recul de tuyau compris — et non de la consigne moteur.
    double contactSpeed = 0;

    // ── Lateral ─────────────────────────────────────────────────────────────
    // `vy` n'est ecrit QUE par `steer()` — invariant obtenu au prix fort, cf.
    // audit-pilotage-2026-08.md §7.2. Il ne se reperd pas.
    double vy = 0;
    double targetVy = 0;

    // La profondeur visee. En v0 c'est l'errance qui la tire ; `choose_lane`
    // prendra la main sans rien changer d'autre.
    double laneY = 0;
    double nextWanderAt = 0;

    // Ce que les objets de vitesse rendent au volant. Pose une fois par tick.
    double steerBoost = 1;

    // ── Depart et malus ─────────────────────────────────────────────────────
    double startStallUntil = 0;
    double boostEndTime = 0;

    // Le choc de tuyau : arret net (`bumpEndTime`), contrecoup
    // (`bumpRecoilLeft`), puis immunite le temps de se decoller.
    double bumpEndTime = 0;
    double bumpRecoilLeft = 0;
    double pipeImmuneUntil = 0;
    bool bumped = false;

    // ── Etat de course ──────────────────────────────────────────────────────
    KartState state = KartState::Grid;
    int rank = 1;
    int lapCount = 0;
    // Dans sa zone de dernier tour (race.cpp) : part en FLAG_FINAL_LAP.
    bool finalLapSign = false;
    bool finished = false;
    int finishRank = 0;
    AiState aiState = AiState::Cruising;

    // ── Objets ──────────────────────────────────────────────────────────────
    // DEUX emplacements, la ou le JS n'en a qu'un (plan §3). Le premier seul
    // part dans le snapshot : le second est un etat purement moteur, invisible
    // du rendu, pour ne pas toucher au protocole 11 ni au front.
    std::optional<HeldItem> heldItems[2];

    // Date a laquelle un objet ramasse sera remis. Le JS s'en sert pour le delai
    // entre la boite et l'objet en main.
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

    // Les stats vivent ICI, et `Kart::stats` y pointe. Un WorldState se DEPLACE
    // (le vector garde ses elements en place) mais ne doit jamais se COPIER :
    // les pointeurs des karts designeraient encore la table de l'original.
    // D'ou les deux lignes ci-dessous — la copie est interdite a la compilation
    // plutot que de produire un monde faux en silence.
    StatsTable statsTable;
    std::vector<Kart> karts;
    std::vector<ItemBox> itemBoxes;
    std::vector<Pipe> pipes;

    // L'ordre d'arrivee, par id de kart. Part tel quel dans `fo`.
    std::vector<int> finishOrder;

    // Les cameras. `cameraX` suit la course, `bgCameraX` le decor en parallaxe
    // (moitie vitesse). Les deux bouclent sur `width`.
    double cameraX = 0;
    double bgCameraX = 0;
    double cameraSpeed = 0;

    // Horloge de SIMULATION, en ms. Elle part de l'horloge murale a la creation
    // et avance de 1000/30 par pas simule, pas par temps reel (piege P-4).
    double simTime = 0;

    // Le tour du leader, pour l'entete « tour N / M ».
    int leaderLap = 1;

    // Le classement lateral ne se recalcule pas a chaque tick : deux fois par
    // seconde suffit, et `previousRanking` sert a dire QUI a double QUI.
    double lastLeaderboardUpdate = 0;
    std::vector<int> previousRanking;

    // ── La machine a phases ─────────────────────────────────────────────────
    double startAt = 0;        // date du feu vert
    double countdownMs = 0;
    double resultsAt = 0;      // 0 = la course n'est pas close
    bool finalSignShown = false;
    bool flagShown = false;

    // Le panneau de Lakitu : [groupe, image]. `group` vide = pas de panneau.
    std::string signGroup;
    int signFrame = 0;
    double signUntil = 0;

    // La camera d'approche : ou elle se gare, et a quelle vitesse elle y va.
    bool hasCameraTarget = false;
    double cameraTarget = 0;

    // ── Le grand prix ───────────────────────────────────────────────────────
    // Il court sur plusieurs courses : les points sont indexes par NOM DE
    // PERSONNAGE et non par id — les ids sont reconstruits a chaque manche, les
    // personnages non.
    int gpRound = 1;
    std::map<std::string, int> racePoints;
    std::map<std::string, int> gpPoints;

    WorldState() = default;
    WorldState(WorldState&&) = default;
    WorldState& operator=(WorldState&&) = default;
    WorldState(const WorldState&) = delete;
    WorldState& operator=(const WorldState&) = delete;
};

// Les stats de chaque personnage, deduites une fois de la config. Leve si un
// budget ne tombe pas juste : c'est une erreur d'auteur, pas un reglage.
StatsTable derive_character_stats(const config::Config& cfg);

// La fabrique. Pose la grille, les karts, les boites et les tuyaux.
//
// `startOrder` donne l'ordre de la grille par NOM DE PERSONNAGE : vide, elle est
// tiree au sort — c'est ce qui ouvre chaque grand prix. Sinon c'est l'ordre
// d'arrivee de la manche precedente, vainqueur en pole.
WorldState create_world_state(const config::Config& cfg, Rng& rng, double now,
                              const std::vector<std::string>& startOrder = {});

} // namespace engine
