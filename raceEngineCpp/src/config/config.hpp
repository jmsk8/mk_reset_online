// Reglages, en une seule struct de donnees.
// <- raceEngine/src/config/*.js
//
// Uniquement des litteraux ; les valeurs calculees sont posees par
// `derive_bodies`. Ce fichier n'inclut rien de `engine/`, `protocol/` ni
// `service/`.

#pragma once

#include <string>
#include <vector>

namespace config {

// Demi-emprise d'un corps, ou ecart entre deux centres selon l'usage :
// `hitboxes.*` sont des sommes de deux corps, `bodies.*` des demi-emprises.
struct Extent {
    double x = 0;
    double y = 0;
};

// Boite ou tuyau pose par le circuit : px de monde et profondeur, plus cellules.
struct Placed {
    double x = 0;
    double y = 0;
    // Tuyaux : couleur (decor seulement).
    bool red = false;
};

struct WorldCfg {
    // Longueur du tour, ligne d'arrivee et decor : poses par `apply_track`.
    // Valeurs par defaut pour un monde sans circuit.
    double width = 7680;
    double finishLineX = 1440;

    // Soleil dans le fond en parallaxe, hors du dessin.
    double sunX = 1920;

    std::vector<Placed> itemBoxes;
    std::vector<Placed> pipes;
};

struct RoadCfg {
    // Largeur de piste fixe, independante du circuit.
    double minY = 0;
    double maxY = 35;
};

struct SpeedsCfg {
    double roadPPS = 250;

    // Elan : vitesse visee = `topSpeed * (momentumMinRatio + (1 -
    // momentumMinRatio) * momentum)`, `momentum` retire toutes les
    // `momentumDrift*` ms dans uniform(momentumFloor, 1).
    double momentumMinRatio = 0.78;
    double momentumFloorBase = 0.70;
    double momentumFloorWeightGain = 0;
    double momentumChangeSpeed = 0.25;
    double momentumDriftMin = 3000;
    double momentumDriftMax = 7000;
    double accelerationRate = 150;
};

// Loi du volant. `steer()` est la seule fonction qui ecrit `vy`.
struct SteerCfg {
    double response = 5;

    // `drag` : perte de volant a haute vitesse ; `bite` : manque de volant a
    // basse vitesse (un kart immobile ne braque pas).
    double paceDrag = 0.35;
    double paceCurve = 1.0;
    double paceBite = 0.5;

    // Gain de volant sous objet de vitesse.
    double boostGain = 1.0;

    // Profil d'errance, actif tant que `choose_lane` est vide.
    double wanderSpeed = 4;
    double wanderGain = 6;
    double wanderTolerance = 0.6;
};

struct WallCfg {
    // Vitesse vers laquelle le mur tire, en fraction de la pointe du kart.
    double speedFactor = 0.55;
    double grip = 3;
};

struct PhysicsCfg {
    SteerCfg steer;
    WallCfg wall;
};

// Errance : profondeur cible tiree regulierement, en attendant `choose_lane`.
struct WanderCfg {
    double intervalMin = 2000;
    double intervalMax = 6000;
    // Marge gardee avec chaque bord.
    double margin = 8;

    // Distance de regard et degagement pour ne pas viser un tuyau.
    double lookAhead = 1600;
    double pipeMargin = 2;
};

struct GridCfg {
    double backOffset = 120;
    double rowGap = 170;
    double colStagger = 90;
    std::vector<double> lanes = { 0.09, 0.71 };
    double laneSlope = 0.055;
};

struct RaceCfg {
    int laps = 5;
    GridCfg grid;

    // Marge ajoutee a deux tours pour la camera d'approche (distance calculee
    // par `apply_track`).
    double cameraApproachMargin = 40;
    double cameraApproachDistance = 0;

    // Au-dela, les karts encore en piste sont classes d'office.
    double maxRaceMs = 180000;
    double resultsDelayMs = 10000;
    double finalResultsDelayMs = 20000;

    // Vitesse du tour d'honneur.
    double finishedSpeedRatio = 0.6;

    // Depart : turbo, normal, sinon moteur noye.
    double startTurboChance = 0.8;
    double startNormalChance = 0.1;
    double turboBoostMs = 1200;
    double failStallMs = 1000;

    // Decompte : duree totale = countdownHoldMs + 2 * lightIntervalMs.
    double countdownHoldMs = 3000;
    double lightIntervalMs = 1500;
    double goSignMs = 5000;

    // Distance a la ligne a laquelle le drapeau sort.
    double flagDistance = 1400;

    // Course close des que ce nombre de karts est arrive.
    int stopAtFinisher = 7;

    double parkStartOffset = 0;
    double parkFinishOffset = -150;

    // Points d'une manche, dans l'ordre d'arrivee.
    std::vector<int> points = { 10, 8, 6, 5, 4, 3, 2, 1 };
};

struct GrandPrixCfg {
    int races = 4;
};

struct OrbitCfg {
    int count = 3;
    double radiusX = 62;
    double radiusY = 3.2;
};

struct ItemAnimCfg {
    double greenShellAnimSpeed = 100;
    double billAnimSpeed = 70;
};

struct DelaysCfg {
    double hitDecelDuration = 1500;
    double hitPauseDuration = 500;

    // Cube rallume apres une seconde ; objet remis apres trois.
    double boxRespawn = 1000;
    double itemGrant = 3000;
};

struct VisionCfg {
    double rangeFront = 1400;
    double rangeBack = 1000;
    double pressureRange = 700;
    double threatLane = 12;
    // Degagement : `itemVsKart.y + vision.place.margin.item`, pose par
    // `derive_bodies`.
    double clear = 0;
    double marginItem = 2;
};

// Ecarts entre centres. Seul `itemBox` se regle a la main ; les autres sont
// poses par `derive_bodies` (zero ici).
struct HitboxesCfg {
    Extent kartVsKart;
    Extent itemVsKart;
    Extent kartVsPipe;
    Extent itemBox { 10, 8 };
};

struct PipeCfg {
    // Demi-axes d'un disque, poses par `derive_bodies`.
    Extent hitbox;
    double drawW = 0;
    double drawH = 0;

    // Passage libre minimal en profondeur, verifie au chargement du circuit.
    double minPassageY = 4;  // aligne sur raceEngine/src/config/pipes.js

    // Choc : arret net, puis recul. `immuneMs` evite de rejouer le choc a
    // chaque tick.
    double bumpMs = 600;
    double recoilPx = 90;
    double recoilMs = 250;
    double immuneMs = 700;

    // Ecart en profondeur applique apres un choc.
    double slideAway = 18;

    // Duree de la consigne d'ecartement avant que l'errance reprenne ; doit
    // couvrir le degagement du tuyau.
    double clearWanderMs = 2500;
};

// Loi des corps : `derive_bodies` en tire les emprises depuis la taille des
// sprites.
struct BodiesCfg {
    double kartDraw = 100;
    double fill = 0.75;
    double flatten = 10.0 / 3.0;
    double depthPx = 3.6;
    double orbitSlack = 3;

    // Longueur dessinee du tuyau, reduite (67.2 au lieu de 84) pour laisser de
    // la piste.
    double pipeDraw = 67.2;
    double pipeFill = 0.65;
    double spritePipeW = 95;
    double spritePipeH = 124;

    // Objet au sol ou en vol : demi-emprise directe.
    Extent item { 17, 5 };

    // Karts de reference (moyenne), figes : ajouter ou retirer un personnage ne
    // redimensionne pas les autres.
    std::vector<std::string> referenceKarts = {
        "bowser", "dk", "mario", "luigi", "yoshi", "peach", "toad", "koopa"
    };

    // Poses par `derive_bodies`.
    Extent ref;
    double refSpriteW = 0;
    double refSpritePx = 0;
};

struct OffsetsCfg {
    double heldItemBehind = -54;
};

struct BlueShellCfg {
    double blastRadiusX = 180;
};

struct LightningCfg {
    double scale = 0.5;
};

// Personnage : trois axes bruts et mesures du sprite. Budget verifie au
// chargement.
struct CharacterSpec {
    std::string name;
    int weight = 0;
    int power = 0;
    int handling = 0;
    // Mesures du sprite (scripts/sprite-metrics.py) : largeur, hauteur, pixels
    // opaques.
    double spriteW = 0;
    double spriteH = 0;
    double spritePx = 0;
    // Dans le tirage (`roster.enabled` du JS).
    bool enabled = true;
};

struct Range {
    double min = 0;
    double max = 0;
};

struct KartStatsCfg {
    int minPoints = 0;
    int maxPoints = 10;
    int budget = 15;

    // Axes derives et leurs plages.
    Range mass  { 0.72, 1.25 };
    Range force { 0.85, 1.40 };
    Range grip  { 0.45, 1.32 };

    // Axe handling courbe : un point rend plus en haut de plage qu'en bas.
    double gripCurve = 2.5;

    // Pointe additive : chaque axe apporte ses px/s.
    double speedBase = 490;
    double speedPerWeight = 35;
    double speedPerPower = 10;

    double massDragAccel = 1.75;
    Range accelClamp { 0.75, 1.85 };

    double massDragAgility = 1.70;
    Range agilityClamp { 0.25, 1.70 };

    // Tenue en virage, avec ses propres exposants.
    double cornerGripGain = 1.0;
    double cornerPowerGain = 1.0;
    double cornerMassDrag = 5.0;

    // Ordre du roster (celui du JS, raceEngine/src/config/bodies.js). Derniere
    // colonne : present dans le tirage.
    std::vector<CharacterSpec> characters = {
        { "bowser", 9, 5, 1, 111, 124, 10451, true },
        { "dk",     8, 5, 2, 119, 124, 10497, true },
        { "mario",  5, 5, 5, 112, 119,  8718, true },
        { "birdo",  5, 4, 6, 112, 144, 10229, true },
        { "luigi",  4, 6, 5, 111, 123,  8511, true },
        { "yoshi",  4, 5, 6, 119, 122,  9655, true },
        { "peach",  3, 6, 6, 112, 124,  8425, true },
        { "daisy",  3, 5, 7, 112, 128,  8222, true },
        { "toad",   2, 5, 8, 110, 120,  8278, true },
        { "koopa",  2, 4, 9, 110, 114,  7395, true }
    };
};

// Emprise d'un kart, deduite de son sprite (`hello.karts[].body`).
struct KartBody {
    double x = 0;
    double y = 0;
    double scale = 1;
};

struct Config {
    WorldCfg world;
    RoadCfg road;
    SpeedsCfg speeds;
    RaceCfg race;
    GrandPrixCfg grandPrix;
    OrbitCfg orbit;
    ItemAnimCfg itemAnim;
    DelaysCfg delays;
    VisionCfg vision;
    HitboxesCfg hitboxes;
    PipeCfg pipe;
    BodiesCfg bodies;
    OffsetsCfg offsets;
    BlueShellCfg blueShell;
    LightningCfg lightning;
    KartStatsCfg kartStats;
    PhysicsCfg physics;
    WanderCfg wander;

    // Nombre de karts au depart (`roster.perRace` du JS), tires parmi les
    // personnages actives. `--karts=N` (developpement) le change et recycle
    // les personnages au-dela du roster (`kartCountForced`).
    int kartCount = 8;
    bool kartCountForced = false;

    // Poses par `derive_bodies`, dans l'ordre de `kartStats.characters`.
    std::vector<KartBody> bodiesByCharacter;
};

// Emprises reelles deduites des sprites (`deriveBodies` en JS). A appeler une
// fois la config complete, sinon toutes les hitboxes valent zero.
void derive_bodies(Config& cfg);

// Borne le nombre de karts a [1, 12] ; false (config intacte) hors bornes.
bool set_kart_count(Config& cfg, int requested);

} // namespace config
