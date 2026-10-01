// Construction de la scene au demarrage et reconstruction complete sur `hello`
// (un arrivant en pleine course doit obtenir une scene complete).

// Suit la transition de .is-down (banner.css).
const CURTAIN_FALL_MS = 700;

// Duree minimale du rideau baisse, descente comprise.
const CURTAIN_MIN_MS = 1400;

// laps/2 a 4 existent dans les assets mais ne sont pas affiches.
const LAKITU_SPRITES = [
    ['start', 1], ['start', 2], ['start', 3], ['start', 4],
    ['laps', 'final'],
    ['finish', 1], ['finish', 2], ['finish', 3]
];

// Hauteur du sprite de Lakitu.
const LAKITU_HEIGHT = 120;
const LAKITU_BOTTOM = 32;
// Periode du flottement de Lakitu, identique a `lakituFloat` (banner.css).
const LAKITU_FLOAT_MS = 1800;

// Periode du motif de la bordure de route (80 px dans banner.css).
const ROAD_PATTERN_WIDTH = 80;

// Cale une animation CSS decorative sur l'horloge du serveur (animation-delay
// negatif) pour que tous les spectateurs voient la meme phase. `prop` : pour
// un pseudo-element, la phase est posee en variable CSS sur le parent.
function alignAnimationPhase(el, cycleMs, prop) {
    const delay = `${-(getGameTime() % cycleMs)}ms`;
    if (prop) el.style.setProperty(prop, delay);
    else el.style.animationDelay = delay;
}

// Recale les elements crees avant que l'horloge du serveur soit connue.
function realignAnimations() {
    for (const id in kartEls) alignAnimationPhase(kartEls[id].img, 300);
    for (const id in ppEls) {
        const img = ppEls[id].firstChild;
        if (img) alignAnimationPhase(img, 400);
    }
    const sunEl = worldState.sun && worldState.sun.element;
    if (sunEl) alignAnimationPhase(sunEl, 2400, '--sun-phase');
    if (lakituEls) alignAnimationPhase(lakituEls.img, LAKITU_FLOAT_MS);
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
        // sunGlow, 2,4 s (sur `.layer-sun::after`, d'ou la variable).
        alignAnimationPhase(sunEl, 2400, '--sun-phase');
        // Solidaire du fond (bgCameraX).
        worldState.sun = { element: sunEl, worldX: WORLD.sunX };
    }

    cachedBg = document.querySelector('.layer-scrolling-bg');
    cachedFg = document.querySelector('.layer-scrolling-fg');
    cachedGround = document.querySelector('.layer-ground');
    const _bannerElSeason = document.getElementById('bannerSection');
    // Fond lointain a mi-vitesse pour les saisons avec premier plan.
    const _season = _bannerElSeason && _bannerElSeason.dataset.season;
    cachedHasParallaxBg = _season === 'summer' || _season === 'autumn';
    // Second plan en automne seulement.
    cachedMid = _season === 'autumn' ? document.querySelector('.layer-scrolling-mid') : null;

    if (GAME_CONFIG.debugMode) initDebugHUD();
}

// Vide la scene sans toucher au decor (serveur injoignable).
function clearScene() {
    // La pause est levee : rien ne reste a montrer.
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

// Date de depart de la course en cours : distingue une simple reprise d'une
// course neuve.
let currentRaceT0 = null;

// Course neuve : les elements DOM sont recrees (personnages et ids d'objets
// changent).
function wipeSceneElements() {
    focusedKartId = null;
    lastFocusCameraX = null;
    // Nouveau depart en plan large.
    raceDirector.reset();
    // Le repere de vitesse du cartouche n'est plus valable.
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

// Construit la scene a partir du `hello`.
function buildWorldFromHello(hello) {
    WORLD = hello.world;

    if (isNewRace(hello)) wipeSceneElements();
    currentRaceT0 = hello.t0;

    worldState.karts = hello.karts.map(entry => ({
        id: entry.id,
        charName: entry.char,
        // Gabarit du kart (demi-emprise et echelle du dessin), ou repli commun.
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
    setLeaderboardSlots(worldState.karts.length);

    worldState.itemBoxes = hello.boxes.map(box => ({ worldX: box.x, y: box.y, active: true }));
    // Pas de liste sans obstacle.
    worldState.pipes = (hello.pipes || []).map(pipe => ({
        worldX: pipe.x, y: pipe.y, kind: pipe.kind || 'green'
    }));
    worldState.items = [];

    if (worldState.finishLine) worldState.finishLine.worldX = WORLD.finishLineX;
    if (worldState.sun) worldState.sun.worldX = WORLD.sunX;

    applyState(hello.snapshot, null, 0);
    domDirty = true;
    reconcileDom();

    // Carte de debug reconstruite a chaque `hello` (tuyaux et boites changent).
    if (GAME_CONFIG.debugMode) initDebugHUD();
}
