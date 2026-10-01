// Etat du client entre deux images : caches de mise en page, references DOM et
// dernier snapshot recu (la course elle-meme vit dans le service `race`).

// Ecart entre l'horloge locale et celle du serveur (ping/pong). La valeur
// effective rejoint doucement la mesure pour eviter les sauts.
let serverClockOffset = 0;
let targetClockOffset = 0;
let clockCalibrated = false;

let cachedBg = null;
let cachedFg = null;
let cachedMid = null;
let cachedGround = null;
let cachedHasParallaxBg = false;
let cachedContainer = null;
let cachedIsMobile = false;
let cachedGameWrapper = null;
let cachedFinishBand = 0;

// Mesures de mise en page, lues une fois par changement de fenetre :
//   wrapperHeight   hauteur de mise en page du wrapper des corps
//   hudWidth        largeur du cadre de la carte de debug
//   roadBandHeight  hauteur de la piste roulable (conversion des profondeurs)
//   groundHeight    hauteur de l'asphalte (limite de la neige)
const viewMetrics = { containerWidth: 0, wrapperHeight: 0, hudWidth: 0, groundHeight: 0, roadBandHeight: 0 };

const imageCache = {};

// Heure estimee du serveur, seule horloge du banner.
function getGameTime() {
    return Date.now() + serverClockOffset;
}

// Miroir local de l'etat recu (seulement ce dont le rendu a besoin).
let worldState = {
    cameraX: 0,
    bgCameraX: 0,
    karts: [],
    kartsById: {},
    items: [],
    itemBoxes: [],
    // Fournis par le `hello`, jamais modifies.
    pipes: [],
    finishLine: null,
    sun: null,

    phase: 'countdown',
    leaderLap: 1,
    sign: null,
    // [debut, frappe, fin] en temps serveur, ou null.
    storm: null,
    finishOrder: [],
    // [manche, points de la course, points du grand prix], alignes sur les ids.
    gp: null,
    // [voix posees, spectateurs] ; notre voix est dans `myVote`.
    vote: [0, 0],

    // Releve de vision du kart suivi (mode debug, sur demande), ou null.
    vision: null
};

// Voix de ce navigateur, remise a zero a chaque course.
let myVote = false;

const kartEls = {};
const itemEls = {};
const ppEls = {};

// Emplacement de chaque photo du classement ; la reconciliation ne deplace pas
// celles en cours d'animation.
const ppSlots = {};
const ppAnimating = {};

let leaderboardState = {
    container: null,
    slots: [],
    cameraEl: null,
    pauseEl: null,
    voteEl: null,
    fullscreenEl: null,
    bound: false
};

let lastFrameTime = 0;
let animationId = null;
