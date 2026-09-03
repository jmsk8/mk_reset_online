// L'etat du client : ce que le banner garde d'une image a l'autre.
//
// Rien ici n'est un etat de JEU — la course vit dans le service `race`. Ce sont
// des caches de mise en page, des references DOM et le dernier instantane recu,
// c'est-a-dire tout ce qu'il faudrait rejeter pour repartir d'une page neuve.

// Ecart entre l'horloge locale et celle du serveur, estime par ping/pong :
// aucune date locale ne doit entrer dans un calcul partage, celles des
// visiteurs sont fausses, parfois de plusieurs secondes.
//
// Deux valeurs et non une : la mesure vise une cible que l'horloge effective
// rejoint doucement. Appliquer chaque mesure telle quelle ferait sauter
// l'instant affiche, donc toute la scene, a chaque recalage.
let serverClockOffset = 0;
let targetClockOffset = 0;
let clockCalibrated = false;

let cachedBg = null;
let cachedFg = null;
let cachedGround = null;
let cachedIsSummerBanner = false;
let cachedContainer = null;
let cachedIsMobile = false;
let cachedGameWrapper = null;
let cachedFinishBand = 0;

// Mesures de mise en page, lues UNE fois par changement de fenetre et jamais
// pendant le rendu : une lecture de `offsetWidth` au milieu d'une frame force le
// navigateur a recalculer toute la mise en page sur-le-champ.
//
//   wrapperHeight   hauteur du CONTAINING BLOCK des corps places. Sur mobile ce
//                   wrapper est plus grand qu'a l'ecran (166,67 % puis scale 0.6),
//                   et c'est bien sa hauteur de MISE EN PAGE qu'il faut.
//   hudWidth        largeur du cadre de la carte de debug.
//   roadBandHeight  hauteur de la PISTE, celle que les karts atteignent. C'est elle
//                   qui convertit une profondeur en pixels (`--road-band-pct`).
//   groundHeight    hauteur de l'ASPHALTE, plus grande : les derniers pixels du
//                   haut sont du bitume ou rien ne roule. Sert seulement a savoir
//                   jusqu'ou la neige peut se poser.
//
// Les trois dernieres ont longtemps ete confondues, l'asphalte valant 35 % d'une
// scene de 360 px pour une piste de 35 unites.
const viewMetrics = { containerWidth: 0, wrapperHeight: 0, hudWidth: 0, groundHeight: 0, roadBandHeight: 0 };

const imageCache = {};

// L'heure du serveur, telle qu'on l'estime. C'est la seule horloge du banner :
// elle date les snapshots, cale les animations decoratives et sert de reference
// au retard de rendu.
function getGameTime() {
    return Date.now() + serverClockOffset;
}

// Miroir local de l'etat recu. Ne contient que ce dont le rendu a besoin : les
// dix-sept autres champs d'un kart restent au serveur.
let worldState = {
    cameraX: 0,
    bgCameraX: 0,
    karts: [],
    kartsById: {},
    items: [],
    itemBoxes: [],
    // Statiques et indestructibles : ils arrivent dans le `hello` et ne
    // bougent plus. Aucun snapshot ne les porte.
    pipes: [],
    finishLine: null,
    sun: null,

    phase: 'countdown',
    leaderLap: 1,
    sign: null,
    // [debut, frappe, fin] en temps serveur, ou null hors orage.
    storm: null,
    finishOrder: [],
    // [manche, points de la course, points du grand prix], les deux tableaux
    // etant alignes sur les identifiants de kart.
    gp: null,
    // [voix posees, spectateurs connectes]. Le snapshot etant commun a tous, il
    // ne porte que le total : savoir si c'est nous qui avons vote est une
    // affaire locale, tenue par `myVote`.
    vote: [0, 0],

    // Le releve de vision du kart suivi, ou null. Il n'arrive que sur demande
    // (`requestVision`), donc jamais hors mode debug, et il ne sert qu'a la
    // carte : un client qui l'ignore affiche exactement la meme course.
    vision: null
};

// Notre propre voix. Effacee a chaque course neuve, le serveur remettant alors
// tous les compteurs a zero.
let myVote = false;

const kartEls = {};
const itemEls = {};
const ppEls = {};

// Emplacement courant de chaque photo du classement, et drapeau pose le temps
// qu'une animation de depassement joue. La reconciliation ne repositionne que
// les photos qui ne sont pas en train de glisser, sinon elle couperait
// l'animation a la frame suivante.
const ppSlots = {};
const ppAnimating = {};

let leaderboardState = {
    container: null,
    slots: [],
    cameraEl: null,
    pauseEl: null,
    voteEl: null,
    bound: false
};

let lastFrameTime = 0;
let animationId = null;
