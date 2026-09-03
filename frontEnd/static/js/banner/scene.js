// La scene : la batir au demarrage, l'effacer, la rebatir sur un `hello`.
//
// Un spectateur qui arrive en pleine course doit obtenir une scene complete a
// partir du seul `hello` — c'est la regle qui gouverne le protocole, et c'est
// ici qu'elle se paie.

// A tenir en phase avec la transition de .is-down dans banner.css.
const CURTAIN_FALL_MS = 700;

// Duree minimale du rideau baisse, descente comprise : sans plancher, il
// repartirait vers le haut avant d'avoir fini de tomber.
const CURTAIN_MIN_MS = 1400;

// laps/2 a 4 existent dans les assets mais ne sont pas affiches.
const LAKITU_SPRITES = [
    ['start', 1], ['start', 2], ['start', 3], ['start', 4],
    ['laps', 'final'],
    ['finish', 1], ['finish', 2], ['finish', 3]
];

// Hauteur du sprite de Lakitu et sa position au-dessus de la route.
const LAKITU_HEIGHT = { pc: 120, mobile: 82 };
const LAKITU_BOTTOM = 32;

// Periode du damier rouge/blanc de la bordure de route, en unites monde : la
// bande se repete tous les 80px (repeating-linear-gradient, banner.css).
const ROAD_PATTERN_WIDTH = 80;

// Les animations CSS decoratives sont calees sur l'horloge du serveur via un
// animation-delay negatif : deux navigateurs qui creent le meme element a des
// instants differents jouent malgre tout la meme phase. Sans ca, le rebond des
// karts et l'arc-en-ciel de l'etoile differeraient d'un spectateur a l'autre.
// `prop` sert aux animations portees par un pseudo-element, qui n'accepte aucun
// style inline : la phase se pose alors en variable CSS sur le parent, que la
// regle lit dans son `animation-delay`.
function alignAnimationPhase(el, cycleMs, prop) {
    const delay = `${-(getGameTime() % cycleMs)}ms`;
    if (prop) el.style.setProperty(prop, delay);
    else el.style.animationDelay = delay;
}

// Les elements crees avant que l'horloge du serveur ne soit connue portent une
// phase calee sur l'heure locale, donc fausse. Elle ne se corrigerait jamais
// d'elle-meme : un sprite garde son animation-delay tant qu'il existe.
function realignAnimations() {
    for (const id in kartEls) alignAnimationPhase(kartEls[id].img, 300);
    for (const id in ppEls) {
        const img = ppEls[id].firstChild;
        if (img) alignAnimationPhase(img, 400);
    }
    const sunEl = worldState.sun && worldState.sun.element;
    if (sunEl) alignAnimationPhase(sunEl, 2400, '--sun-phase');
}

const boxEls = [];
const pipeEls = [];

function initScene() {
    cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return;

    refreshLayoutMetrics();
    initLeaderboard();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = { element: finishLineEl, worldX: WORLD.finishLineX };
    }

    const sunEl = document.querySelector('.layer-sun');
    if (sunEl) {
        // sunGlow, 2,4 s. Portee par `.layer-sun::after`, d'ou la variable.
        alignAnimationPhase(sunEl, 2400, '--sun-phase');
        // Solidaire du fond (bgCameraX), pas de la route.
        worldState.sun = { element: sunEl, worldX: WORLD.sunX };
    }

    cachedBg = document.querySelector('.layer-scrolling-bg');
    cachedFg = document.querySelector('.layer-scrolling-fg');
    cachedGround = document.querySelector('.layer-ground');
    const _bannerElSeason = document.getElementById('bannerSection');
    cachedIsSummerBanner = !!_bannerElSeason && _bannerElSeason.dataset.season === 'summer';

    if (GAME_CONFIG.debugMode) initDebugHUD();
}

// Vide la scene sans toucher au decor : c'est ce qu'on affiche quand le serveur
// est injoignable. Pas de course locale, pas de karts fantomes fige a l'ecran —
// le bandeau continue simplement de defiler.
function clearScene() {
    // On efface la scene que le gel tenait a l'ecran : la garder figee sur une
    // piste vide n'aurait plus rien a montrer, et le clic de reprise arriverait
    // sur une image morte. Le lien coupe leve donc la pause de lui-meme.
    if (racePaused) {
        racePaused = false;
        renderPause();
    }

    worldState.karts = [];
    worldState.kartsById = {};
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.finishOrder = [];
    worldState.gp = null;
    worldState.sign = null;
    worldState.vision = null;
    domDirty = true;
    reconcileDom();
    renderResults();
    renderGrandPrix();
}

// Date de depart de la course en cours. Un `hello` peut arriver pour deux
// raisons tres differentes : une simple reprise (retour d'onglet, reconnexion),
// ou une course entierement neuve — redemarrage manuel, ou relance apres un
// arret faute de spectateurs. Seul `t0` les distingue.
let currentRaceT0 = null;

// Une course neuve retire les personnages au sort et remet les identifiants
// d'objets a 1. Les elements DOM sont indexes par identifiant et leur sprite
// n'est pose qu'a la creation : sans ce menage, le kart 3 garderait le visage
// du personnage precedent. La reconciliation ne verrait rien a corriger, les
// identifiants n'ayant pas bouge.
function wipeSceneElements() {
    focusedKartId = null;
    lastFocusCameraX = null;
    // Le depart se regarde de nouveau en plan large, et l'historique des plans
    // ne vaut plus rien : les personnages ont ete retires au sort.
    raceDirector.reset();
    // Le cartouche mesure une vitesse par ecarts de distance : son repere ne
    // vaut plus rien quand les compteurs repartent de zero.
    resetFocusHud();

    if (lakituEls) {
        lakituEls.wrapper.remove();
        lakituEls = null;
    }
    resultsShown = -1;
    gpShown = '';
    myVote = false;

    for (const id in kartEls) {
        kartEls[id].wrapper.remove();
        delete kartEls[id];
    }
    for (const id in itemEls) {
        itemEls[id].remove();
        delete itemEls[id];
    }
    for (const id in ppEls) removePPEl(id);

    while (boxEls.length) boxEls.pop().remove();
    while (pipeEls.length) pipeEls.pop().remove();
}

function isNewRace(hello) {
    return hello.t0 !== currentRaceT0;
}

// Construit la scene a partir du `hello`. Rien n'est invente ici : identites,
// geometrie du monde et etat courant viennent tous du serveur.
function buildWorldFromHello(hello) {
    WORLD = hello.world;

    if (isNewRace(hello)) wipeSceneElements();
    currentRaceT0 = hello.t0;

    worldState.karts = hello.karts.map(entry => ({
        id: entry.id,
        charName: entry.char,
        // Son gabarit, tire de son sprite par le serveur : `body.x`/`body.y`
        // sont sa demi-emprise reelle — ce que la carte de debug dessine — et
        // `body.scale` le rapport de son dessin a celui du kart de reference.
        // Un serveur qui ne l'enverrait pas laisse le repli commun prendre le
        // relais, et tous les karts retrouvent la meme longueur.
        body: entry.body || null,
        worldX: 0,
        yPercent: WORLD.roadMinY,
        totalDistance: 0,
        state: 'grid',
        stopped: false,
        isInvincible: false,
        finished: false,
        rank: entry.id + 1,
        hitEndTime: 0,
        heldItem: null
    }));

    worldState.kartsById = {};
    for (const kart of worldState.karts) worldState.kartsById[kart.id] = kart;

    worldState.itemBoxes = hello.boxes.map(box => ({ worldX: box.x, y: box.y, active: true }));
    // Un circuit sans obstacle n'envoie pas de liste : elle vaut alors vide.
    worldState.pipes = (hello.pipes || []).map(pipe => ({
        worldX: pipe.x, y: pipe.y, kind: pipe.kind || 'green'
    }));
    worldState.items = [];

    if (worldState.finishLine) worldState.finishLine.worldX = WORLD.finishLineX;
    if (worldState.sun) worldState.sun.worldX = WORLD.sunX;

    applyState(hello.snapshot, null, 0);
    domDirty = true;
    reconcileDom();

    // La carte de debug se rebatit ICI, et pas seulement au demarrage :
    // `initScene` tourne avant que la connexion ne parte, quand il n'y a ni kart,
    // ni boite, ni tuyau. Une course neuve change les tuyaux et les boites — la
    // reconstruire a chaque `hello` est aussi ce qui la garde juste d'un circuit
    // a l'autre.
    if (GAME_CONFIG.debugMode) initDebugHUD();
}
