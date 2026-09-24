// Les reglages, en une seule struct de donnees.
//
// <- raceEngine/src/config/*.js : sept fragments recolles par index.js. Ici un
// seul fichier, mais la meme regle qu'en JS : ce sont des LITTERAUX, aucune
// fonction de simulation, aucune reference croisee entre champs. Les seules
// valeurs calculees sont posees a la fin par `derive_bodies`, qui a besoin de
// l'objet entier.
//
// Couche la plus basse (cf. plan §4.1bis) : ce fichier n'inclut rien de
// `engine/`, `protocol/` ni `service/`.

#pragma once

#include <string>
#include <vector>

namespace config {

// Demi-emprise d'un corps, ou ecart entre deux CENTRES selon l'usage. Le plan
// §5.1 insiste sur la distinction : `hitboxes.*` sont des ecarts entre centres,
// donc deja des sommes de deux corps, la ou `bodies.*` sont des demi-emprises.
struct Extent {
    double x = 0;
    double y = 0;
};

// Une boite ou un tuyau, tels que le CIRCUIT les pose : en px de monde et en
// profondeur, plus en cellules.
struct Placed {
    double x = 0;
    double y = 0;
    // Tuyaux seulement : la couleur, qui ne sert qu'au decor.
    bool red = false;
};

struct WorldCfg {
    // Longueur du tour, ligne d'arrivee et decor : POSES PAR LE CIRCUIT
    // (`apply_track`), jamais regles ici — chaque dessin a les siens. Les
    // valeurs par defaut ne servent qu'a un monde sans circuit charge.
    double width = 7680;
    double finishLineX = 1440;

    // Le soleil, lui, n'est pas sur la piste : il est pose dans le fond en
    // parallaxe, que le dessin ne decrit pas.
    double sunX = 1920;

    std::vector<Placed> itemBoxes;
    std::vector<Placed> pipes;
};

struct RoadCfg {
    // La largeur de la piste reste ici : elle ne varie pas le long du tour, et
    // ne depend pas du circuit dessine (cf. track.js, « les rangees se
    // partagent la profondeur de la piste »).
    double minY = 0;
    double maxY = 35;
};

struct SpeedsCfg {
    double roadPPS = 250;

    // Le regime d'ELAN : la vitesse visee vaut
    // `topSpeed * (momentumMinRatio + (1 - momentumMinRatio) * momentum)`, ou
    // `momentum` est retire toutes les `momentumDrift*` ms dans
    // uniform(momentumFloor, 1) et rejoint a `momentumChangeSpeed`.
    double momentumMinRatio = 0.78;
    double momentumFloorBase = 0.70;
    double momentumFloorWeightGain = 0;
    double momentumChangeSpeed = 0.25;
    double momentumDriftMin = 3000;
    double momentumDriftMax = 7000;
    double accelerationRate = 150;
};

// La loi du volant. `steer()` est la SEULE fonction qui ecrit `vy` — invariant
// obtenu au prix fort (audit-pilotage-2026-08.md §7.2), il ne se reperd pas.
struct SteerCfg {
    double response = 5;

    // `drag` ce qu'on perd a FORCE d'aller vite, `bite` ce qu'on n'a pas encore
    // FAUTE d'avancer. Deux mecaniques distinctes : sans `bite`, un kart
    // IMMOBILE disposait de son volant maximum et repartait en crabe apres un
    // choc.
    double paceDrag = 0.35;
    double paceCurve = 1.0;
    double paceBite = 0.5;

    // Ce que les objets de vitesse rendent au volant.
    double boostGain = 1.0;

    // Le profil d'errance, seul actif tant que `choose_lane` est vide.
    double wanderSpeed = 4;
    double wanderGain = 6;
    double wanderTolerance = 0.6;
};

struct WallCfg {
    // Ce que le mur coute : la vitesse vers laquelle il tire, en fraction de la
    // pointe du kart. Racler est plus cher que lever le pied, moins cher que se
    // faire ecraser.
    double speedFactor = 0.55;
    double grip = 3;
};

struct PhysicsCfg {
    SteerCfg steer;
    WallCfg wall;
};

// L'errance : une profondeur cible tiree regulierement, en attendant que
// `choose_lane` decide vraiment (plan §3).
struct WanderCfg {
    double intervalMin = 2000;
    double intervalMax = 6000;
    // Marge gardee avec chaque bord : personne ne vise le rail.
    double margin = 8;

    // Ce que l'errance regarde devant elle pour ne pas viser un tuyau, et le
    // degagement qu'elle garde avec lui. Ce n'est PAS de la perception : la
    // vraie vision et le choix de couloir sont le travail de `choose_lane`.
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

    // Deux tours pleins plus cette marge : la camera ne sait que RALENTIR, il
    // lui faut ce couloir pour se garer pile sur la ligne. La distance elle-meme
    // est derivee de la longueur du tour par `apply_track`, jamais ecrite en dur
    // — sinon chaque circuit d'une autre longueur redemanderait le calcul.
    double cameraApproachMargin = 40;
    double cameraApproachDistance = 0;

    // Au-dela, les karts encore en piste sont classes d'office.
    double maxRaceMs = 180000;
    double resultsDelayMs = 10000;
    double finalResultsDelayMs = 20000;

    // Le tour d'honneur se court au ralenti.
    double finishedSpeedRatio = 0.6;

    // Le depart : turbo, depart normal, et le reste est un moteur noye.
    double startTurboChance = 0.8;
    double startNormalChance = 0.1;
    double turboBoostMs = 1200;
    double failStallMs = 1000;

    // Le decompte. Duree totale = countdownHoldMs + 2 * lightIntervalMs.
    double countdownHoldMs = 3000;
    double lightIntervalMs = 1500;
    double goSignMs = 5000;
    double finalSignMs = 6000;

    // Le drapeau ne sort qu'a l'approche REELLE de la ligne, pas des le
    // repositionnement de la camera : la camera se gare deux tours avant la fin
    // et le laisserait sinon plante la une demi-course.
    double flagDistance = 1400;

    // La course se clot des que ce nombre de karts est arrive : le dernier ne
    // fait pas attendre tout le monde.
    int stopAtFinisher = 7;

    double parkStartOffset = 0;
    double parkFinishOffset = -150;

    // Les points d'une manche, dans l'ordre d'arrivee.
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

    // Le cube se rallume au bout d'une seconde ; l'objet, lui, n'arrive dans les
    // mains qu'au bout de trois — c'est ce delai qui laisse voir un kart
    // traverser la zone avant d'etre arme.
    double boxRespawn = 1000;
    double itemGrant = 3000;
};

struct VisionCfg {
    double rangeFront = 1400;
    double rangeBack = 1000;
    double pressureRange = 700;
    double threatLane = 12;
    // Le DEGAGEMENT : `itemVsKart.y + vision.place.margin.item`. Derive, comme
    // les hitboxes ci-dessous — pose par `derive_bodies`.
    double clear = 0;
    double marginItem = 2;
};

// Ecarts entre CENTRES. Seul `itemBox` se regle a la main : c'est une zone de
// ramassage, pas une somme de corps. Les autres sont DERIVES des sprites par
// `derive_bodies` — les laisser a zero ici est voulu.
struct HitboxesCfg {
    Extent kartVsKart;
    Extent itemVsKart;
    Extent kartVsPipe;
    Extent itemBox { 10, 8 };
};

struct PipeCfg {
    // Demi-axes d'un DISQUE (le tuyau est le seul corps rond du moteur), et
    // eux aussi derives de son dessin par `derive_bodies`.
    Extent hitbox;
    double drawW = 0;
    double drawH = 0;

    // Passage libre minimal en profondeur, une fois les tuyaux poses. Un mur de
    // tuyaux ne provoquerait aucune erreur a l'execution : les karts se
    // cogneraient jusqu'au delai maximum et la course serait close sur un
    // classement d'office, sans que rien dans les journaux n'accuse le circuit.
    double minPassageY = 6;

    // Le choc : arret net, puis contrecoup. `immuneMs` evite qu'un kart colle au
    // tuyau rejoue le choc a chaque tick.
    double bumpMs = 600;
    double recoilPx = 90;
    double recoilMs = 250;
    double immuneMs = 700;

    // De combien le kart est ecarte du tuyau, en profondeur : sans ca, un kart
    // pousse par le peloton resterait plaque contre lui.
    double slideAway = 18;

    // Combien de temps la consigne d'ecartement tient avant que l'errance
    // reprenne la main. Il faut couvrir le degagement du tuyau : plus court, le
    // kart se recogne au meme endroit sans fin.
    double clearWanderMs = 2500;
};

// La LOI des corps : rien ne se regle corps par corps, `derive_bodies` en tire
// les nombres a partir de la taille reelle des sprites.
struct BodiesCfg {
    double kartDraw = 100;
    double fill = 0.75;
    double flatten = 10.0 / 3.0;
    double depthPx = 3.6;
    double orbitSlack = 3;

    // Le tuyau : sa longueur DESSINEE ne suit pas l'echelle commune (67.2 au
    // lieu de 84) parce qu'a taille reelle il mangeait trop de piste. C'est un
    // choix de trace, pas une erreur de mesure.
    double pipeDraw = 67.2;
    double pipeFill = 0.65;
    double spritePipeW = 95;
    double spritePipeH = 124;

    // L'objet au sol ou en vol : demi-emprise prise directement, pas deduite
    // par soustraction (cf. protocol.js, « a fill 0.75 une carapace se
    // dessinait quatre fois trop petite »).
    Extent item { 17, 5 };

    // Les karts dont la moyenne fait le kart de reference, figes sur le plateau
    // d'origine : `bodies.referenceKarts` du JS, meme raison. Un personnage
    // ajoute, ou retire du tirage, ne redimensionne pas les autres.
    std::vector<std::string> referenceKarts = {
        "bowser", "dk", "mario", "luigi", "yoshi", "peach", "toad", "koopa"
    };

    // Posees par `derive_bodies`.
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

// Un personnage : ses trois axes bruts, et la mesure de son sprite. Le budget
// est verifie au chargement — un total qui ne tombe pas juste est une erreur
// d'auteur, pas un reglage.
struct CharacterSpec {
    std::string name;
    int weight = 0;
    int power = 0;
    int handling = 0;
    // Mesures du sprite (scripts/sprite-metrics.py) : largeur, hauteur, surface
    // dessinee en pixels opaques.
    double spriteW = 0;
    double spriteH = 0;
    double spritePx = 0;
    // Dans le tirage ou non : `roster.enabled` du JS. A false, le personnage
    // garde ses stats et ses mesures mais n'est plus aligne.
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

    // Les trois axes derives, et les lois qui les tirent des points bruts.
    Range mass  { 0.72, 1.25 };
    Range force { 0.85, 1.40 };
    Range grip  { 0.45, 1.32 };

    // L'axe handling est COURBE, pas droit : un point de maniabilite rend plus
    // en haut de plage qu'en bas.
    double gripCurve = 2.5;

    // Pointe ADDITIVE : chaque axe apporte ses px/s, et les apporte seul. La
    // forme multiplicative d'avant faisait dependre le rendement du poids de la
    // puissance — il n'y avait plus de triangle, juste un axe fort.
    double speedBase = 490;
    double speedPerWeight = 35;
    double speedPerPower = 10;

    double massDragAccel = 1.75;
    Range accelClamp { 0.75, 1.85 };

    double massDragAgility = 1.70;
    Range agilityClamp { 0.25, 1.70 };

    // Ce qui tient un kart quand il tourne. Meme forme que ses deux voisines,
    // mais avec ses PROPRES exposants : elle ne se deduit d'aucune autre stat.
    double cornerGripGain = 1.0;
    double cornerPowerGain = 1.0;
    double cornerMassDrag = 5.0;

    // L'ordre compte : c'est celui du roster avant tirage. Il reprend l'ordre
    // de `Object.keys` du JS (`kartStats.characters` et `bodies.sprite.kart`
    // de raceEngine/src/config/bodies.js).
    //
    // Derniere colonne : l'interrupteur du tirage, miroir de `roster.enabled`.
    // Chaque course aligne `kartCount` karts tires parmi les `true`.
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

// Emprise d'un kart, deduite de son sprite. Ce qui part dans
// `hello.karts[].body`.
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

    // Nombre de karts au depart : `roster.perRace` du JS. Tires parmi les
    // personnages actives ; s'il y en a moins, la course se fait avec eux.
    //
    // `--karts=N` le change entre 1 et 12 pour le developpement (plan §3), et
    // lui seul RECYCLE les personnages au-dela du roster (`kartCountForced`).
    // Ce n'est PAS un reglage de production : docker-compose.yml ne l'expose
    // sur aucune variable d'environnement.
    int kartCount = 8;
    bool kartCountForced = false;

    // Posees par `derive_bodies`, dans l'ordre de `kartStats.characters`.
    std::vector<KartBody> bodiesByCharacter;
};

// Ce que `deriveBodies` fait en JS : les emprises reelles, deduites de la
// taille des sprites. A appeler une fois la config complete — d'ou sa place
// hors des litteraux ci-dessus. Sans cet appel, toutes les hitboxes valent
// zero et les corps se traverseraient sans qu'aucune erreur ne le dise.
void derive_bodies(Config& cfg);

// Borne le nombre de karts a [1, 12] (plan §3). Rend `false` et laisse la
// config intacte si la valeur demandee est hors bornes.
bool set_kart_count(Config& cfg, int requested);

} // namespace config
