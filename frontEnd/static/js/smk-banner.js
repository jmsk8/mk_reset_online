// Constantes de rendu du banner SMK.
//
// Uniquement de l'apparence : chemins d'assets, tailles en px, z-index,
// seuils mobile, animations. Les constantes qui decrivent le monde simule
// (vitesses, hitboxes, delais, distribution des objets) n'existent plus ici :
// elles vivent dans le service `race`, qui en transmet le strict necessaire
// dans son `hello` (voir WORLD plus bas, et docs/MIGRATION_BANNER_WSS.md).
const GAME_CONFIG = {
    debugMode: false,

    resources: {
        characters: ['mario', 'luigi', 'peach', 'toad', 'yoshi', 'bowser', 'dk', 'koopa'],
        initials: { 'mario': 'M', 'luigi': 'L', 'peach': 'P', 'toad': 'T', 'yoshi': 'Y', 'bowser': 'B', 'dk': 'D', 'koopa': 'K' },
        // Les 5 orientations disponibles en asset. Les 3 manquantes pour un 360
        // complet (sud-ouest, ouest, nord-ouest) sont obtenues en miroir.
        kartDirections: ['side-right', 'front-right', 'front', 'back-right', 'back'],
        paths: {
            char: (name) => `static/img/${name}/${name}-asset-anime/${name}-side-right.png`,
            charFrame: (name, dir) => `static/img/${name}/${name}-asset-anime/${name}-${dir}.png`,
            pp: (name) => `static/img/${name}/${name}-pp.png`,
            greenShell: (frame) => `static/img/green-shell/green-shell${frame}.png`,
            redShell: (frame) => `static/img/red-shell/red-shell${frame}.png`,
            lakitu: (group, frame) => `static/img/lakitu/${group}/${frame}.png`,
            banana: 'static/img/banana.png',
            shroom: 'static/img/shroom.png',
            star: 'static/img/star.png'
        }
    },
    rendering: {
        bufferZone: 200,
        zIndexBase: 400,
        mobileBreakpoint: 769,
        mobileScale: 0.6,
        // Miroir de .kart-container-moving en CSS. Sert a centrer une orbite
        // sur le kart : les elements sont ancres par leur coin gauche, il faut
        // donc connaitre la largeur du sprite pour trouver son milieu.
        kartWidth: { pc: 100, mobile: 80 },

        // Levitation decorative des item-boxes : amplitude en px, vitesse en
        // radians par ms. Aucun effet sur la simulation.
        boxFloat: { amplitude: 10, speed: 0.003 }
    },
    offsets: {
        // Rendu uniquement, jamais lu par la physique.
        render: {
            heldItemBehind: { pc: -50, mobile: -35 },
            heldItemHands: { x: { pc: 28, mobile: 18 }, yShift: { pc: 30, mobile: 25 } },
            // Abaissement de l'orbite, en pixels vers le bas. Au point le plus
            // recule l'objet monte de radiusY au-dessus des roues et donne
            // l'impression de leviter ; ce decalage le ramene au ras du sol sur
            // toute la rotation. Purement visuel : la hitbox suit toujours la
            // position monde calculee par getOrbitItemPosition().
            orbitDrop: { pc: 10, mobile: 8 }
        }
    },
    visuals: {
        greenShell: { width: 48, widthMobile: 32 },
        redShell: { width: 48, widthMobile: 32 },
        banana: { width: 32, widthMobile: 28 },
        shroom: { width: 36, widthMobile: 26 },
        star: { width: 36, widthMobile: 26 },
        box: { sizePC: 42, sizeMobile: 42 }
    },
    // Tête-à-queue joué pendant l'état 'hit'. La durée du malus n'est pas
    // configurable ici : elle reste delays.hitDecelDuration + hitPauseDuration.
    // durationRatio ne règle que la vitesse de la toupie, en la jouant sur une
    // fraction de ce malus ; le kart tient ensuite side-right jusqu'au départ.
    // Baisser = plus rapide (0.8 = 2 tours en 1600 ms, soit 100 ms/frame).
    kartSpin: {
        turns: 2,
        durationRatio: 0.8,
        // Un tour complet dans le sens horaire depuis side-right (est).
        // mirror: true = scaleX(-1) sur l'asset "droite" équivalent.
        frames: [
            { dir: 'side-right',  mirror: false }, // est
            { dir: 'front-right', mirror: false }, // sud-est
            { dir: 'front',       mirror: false }, // sud
            { dir: 'front-right', mirror: true  }, // sud-ouest
            { dir: 'side-right',  mirror: true  }, // ouest
            { dir: 'back-right',  mirror: true  }, // nord-ouest
            { dir: 'back',        mirror: false }, // nord
            { dir: 'back-right',  mirror: false }  // nord-est
        ]
    }
};

// Constantes du monde. Elles arrivent du serveur dans le `hello` : le client
// n'en garde aucune copie, sans quoi un reglage de gameplay pourrait changer
// d'un cote sans l'autre. Celles ci-dessous ne servent qu'a faire defiler le
// decor quand le serveur est injoignable — aucune course n'est jouee avec.
const OFFLINE_WORLD = {
    width: 3840,
    finishLineX: 1440,
    sunX: 1920,
    roadMinY: 0,
    roadMaxY: 30,
    roadPPS: 250,
    hitDuration: 2000,
    orbit: { count: 3, radiusX: 62, radiusY: 3.2 },
    shellAnimSpeed: 100
};

let WORLD = OFFLINE_WORLD;

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
    finishLine: null,
    sun: null,

    phase: 'countdown',
    leaderLap: 1,
    sign: null,
    finishOrder: []
};

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
    bound: false
};

let lastFrameTime = 0;
let animationId = null;

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.innerWidth < GAME_CONFIG.rendering.mobileBreakpoint;
    return cachedIsMobile;
}

// `cameraX` designe le **centre** de ce qu'on voit, pas son bord gauche : la
// fenetre s'etend symetriquement de part et d'autre, sur la largeur dont
// l'appareil dispose. Un ecran etroit montre donc moins de piste qu'un large,
// mais tous deux sont centres sur le meme point du monde — sans quoi un mobile
// et un PC, partant du meme bord gauche, regardent deux portions differentes.
function getScreenPosition(worldX, cameraX, screenWidth) {
    const w = WORLD.width;
    const buffer = GAME_CONFIG.rendering.bufferZone;

    let rawDiff = worldX - cameraX + screenWidth / 2;

    if (rawDiff > -buffer && rawDiff < screenWidth + buffer) {
        return rawDiff;
    }

    let diffPlus = rawDiff + w;
    if (diffPlus > -buffer && diffPlus < screenWidth + buffer) {
        return diffPlus;
    }

    let diffMinus = rawDiff - w;
    if (diffMinus > -buffer && diffMinus < screenWidth + buffer) {
        return diffMinus;
    }

    return rawDiff;
}

// Rend une promesse tenue quand toutes les images sont decodees : c'est l'une
// des conditions de levee du rideau (§ bannerLink). Une image qui manque ne doit
// pas bloquer le banner, d'ou le catch — au pire elle apparaitra en retard.
function preloadImages() {
    const waits = [];

    function cache(key, src) {
        const img = new Image();
        img.src = src;
        imageCache[key] = img;
        waits.push(img.decode ? img.decode().catch(() => {})
                              : new Promise(resolve => { img.onload = img.onerror = resolve; }));
        return img;
    }

    for (let i = 1; i <= 3; i++) {
        cache(`greenShell_${i}`, GAME_CONFIG.resources.paths.greenShell(i));
        cache(`redShell_${i}`, GAME_CONFIG.resources.paths.redShell(i));
    }

    // Lakitu : feux de depart, panneaux de tour, drapeau a damier.
    LAKITU_SPRITES.forEach(([group, frame]) => {
        cache(`lakitu_${group}_${frame}`, GAME_CONFIG.resources.paths.lakitu(group, frame));
    });

    cache('banana', GAME_CONFIG.resources.paths.banana);
    cache('shroom', GAME_CONFIG.resources.paths.shroom);
    cache('star', GAME_CONFIG.resources.paths.star);

    GAME_CONFIG.resources.characters.forEach(charName => {
        cache(`pp_${charName}`, GAME_CONFIG.resources.paths.pp(charName));

        // Toutes les orientations, sinon le premier tête-à-queue clignote
        // le temps que les frames se téléchargent.
        GAME_CONFIG.resources.kartDirections.forEach(dir => {
            cache(`kart_${charName}_${dir}`, GAME_CONFIG.resources.paths.charFrame(charName, dir));
        });
    });

    return Promise.all(waits);
}

function getKartFrameSrc(charName, dir) {
    const cached = imageCache[`kart_${charName}_${dir}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.charFrame(charName, dir);
}

// Kart suivi par la camera, ou null pour la camera par defaut. Purement local :
// deux spectateurs peuvent regarder des karts differents, ils voient la meme
// course sous un autre angle. Cet etat ne part jamais au serveur.
let focusedKartId = null;

// Camera effectivement utilisee pour le rendu. Elle vaut celle du serveur en
// mode par defaut, et la position du kart suivi sinon.
let renderCameraX = 0;
let renderBgCameraX = 0;
let lastFocusCameraX = null;

function wrapWorld(x) {
    const w = WORLD.width;
    if (x < 0) return x + w;
    if (x >= w) return x - w;
    return x;
}

function shortestDelta(from, to) {
    const w = WORLD.width;
    let delta = to - from;
    if (delta > w / 2) delta -= w;
    else if (delta < -w / 2) delta += w;
    return delta;
}

function updateRenderCamera() {
    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];

    if (!kart) {
        renderCameraX = worldState.cameraX;
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = null;
        return;
    }

    // Le fond ne peut pas garder sa propre vitesse : il avance de la moitie du
    // deplacement de la camera, sinon decor et route se desolidarisent des que
    // celle-ci change d'allure.
    if (lastFocusCameraX === null) {
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = worldState.cameraX;
    }

    renderBgCameraX = wrapWorld(renderBgCameraX + shortestDelta(lastFocusCameraX, kart.worldX) / 2);
    renderCameraX = kart.worldX;
    lastFocusCameraX = kart.worldX;
}

function setFocus(kartId) {
    focusedKartId = kartId;
    lastFocusCameraX = null;
    updateFocusMarks();
}

function updateFocusMarks() {
    const cameraBtn = leaderboardState.cameraEl;
    if (cameraBtn) cameraBtn.classList.toggle('is-focused', focusedKartId === null);

    for (const id in ppEls) {
        ppEls[id].classList.toggle('is-focused', String(focusedKartId) === id);
    }
}

function onLeaderboardClick(event) {
    const target = event.target.closest('.leaderboard-camera, [data-kart-id]');
    if (!target) return;

    setFocus(target.classList.contains('leaderboard-camera') ? null : Number(target.dataset.kartId));
}

function initLeaderboard() {
    leaderboardState.container = document.getElementById('race-leaderboard');
    if (!leaderboardState.container) return;

    leaderboardState.container.innerHTML = '';
    leaderboardState.slots = [];

    if (!leaderboardState.bound) {
        leaderboardState.bound = true;
        leaderboardState.container.addEventListener('click', onLeaderboardClick);
    }

    const camera = document.createElement('div');
    camera.className = 'leaderboard-pp leaderboard-camera visible';
    camera.title = 'Vue par defaut';
    camera.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>' +
        '<path d="M15 11.2l5-2.7v7l-5-2.7z"/></svg>';
    leaderboardState.container.appendChild(camera);
    leaderboardState.cameraEl = camera;

    updateFocusMarks();

    const totalKarts = GAME_CONFIG.resources.characters.length;
    for (let i = 0; i < totalKarts; i++) {
        const slot = document.createElement('div');
        slot.className = 'leaderboard-slot';
        slot.dataset.slotIndex = i;
        leaderboardState.container.appendChild(slot);
        leaderboardState.slots.push(slot);
    }
}

function ensurePPEl(kart) {
    if (!leaderboardState.container) return null;
    if (ppEls[kart.id]) return ppEls[kart.id];

    const ppDiv = document.createElement('div');
    ppDiv.className = 'leaderboard-pp';
    ppDiv.dataset.kartId = kart.id;

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
    img.alt = kart.charName;
    // ppStarRainbow, 0,4 s.
    alignAnimationPhase(img, 400);
    ppDiv.appendChild(img);

    ppEls[kart.id] = ppDiv;

    leaderboardState.container.appendChild(ppDiv);

    setTimeout(() => {
        ppDiv.classList.add('visible');
    }, 50);

    return ppDiv;
}

function applyLeaderboardPosition(kartId, newPosition, prevPosition) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('overtaking', 'dropping');

    if (prevPosition !== -1 && prevPosition !== newPosition) {
        if (newPosition < prevPosition) {
            ppElement.classList.add('overtaking');
        } else {
            ppElement.classList.add('dropping');
        }

        ppAnimating[kartId] = true;
        setTimeout(() => {
            ppElement.classList.remove('overtaking', 'dropping');
            ppAnimating[kartId] = false;
            positionPPInSlot(kartId, newPosition);
        }, 400);
    } else {
        positionPPInSlot(kartId, newPosition);
    }
}

function positionPPInSlot(kartId, slotIndex) {
    const ppElement = ppEls[kartId];
    if (!ppElement || slotIndex >= leaderboardState.slots.length) return;

    const slotWidth = cachedIsMobile ? 32 : 46;
    const totalSlots = leaderboardState.slots.length;
    const reversedIndex = (totalSlots - 1) - slotIndex;
    const xPos = reversedIndex * slotWidth;

    ppElement.style.top = '0px';
    ppElement.style.left = `${xPos}px`;
    ppSlots[kartId] = slotIndex;
}

function triggerPPHitAnimation(kartId) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('hit');
    void ppElement.offsetWidth;
    ppElement.classList.add('hit');

    setTimeout(() => {
        ppElement.classList.remove('hit');
    }, 600);
}

// A tenir en phase avec la transition de .is-down dans smk-banner.css.
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
// bande se repete tous les 80px (repeating-linear-gradient, smk-banner.css).
const ROAD_PATTERN_WIDTH = 80;

// Les animations CSS decoratives sont calees sur l'horloge du serveur via un
// animation-delay negatif : deux navigateurs qui creent le meme element a des
// instants differents jouent malgre tout la meme phase. Sans ca, le rebond des
// karts et l'arc-en-ciel de l'etoile differeraient d'un spectateur a l'autre.
function alignAnimationPhase(el, cycleMs) {
    el.style.animationDelay = `${-(getGameTime() % cycleMs)}ms`;
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
    if (sunEl) alignAnimationPhase(sunEl, 2400);
}

const boxEls = [];

function initScene() {
    cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return;

    updateMobileStatus();
    initLeaderboard();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = { element: finishLineEl, worldX: WORLD.finishLineX };
    }

    const sunEl = document.querySelector('.layer-sun');
    if (sunEl) {
        // sunGlow, 2,4 s.
        alignAnimationPhase(sunEl, 2400);
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
    worldState.karts = [];
    worldState.kartsById = {};
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.finishOrder = [];
    worldState.sign = null;
    domDirty = true;
    reconcileDom();
    renderResults();
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

    if (lakituEls) {
        lakituEls.wrapper.remove();
        lakituEls = null;
    }
    resultsShown = -1;

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
    worldState.items = [];

    if (worldState.finishLine) worldState.finishLine.worldX = WORLD.finishLineX;
    if (worldState.sun) worldState.sun.worldX = WORLD.sunX;

    applyState(hello.snapshot, null, 0);
    domDirty = true;
    reconcileDom();
}

function getItemVisualConfig(itemType) {
    switch (itemType) {
        case 'greenShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.greenShell.widthMobile : GAME_CONFIG.visuals.greenShell.width,
                src: imageCache['greenShell_1'] ? imageCache['greenShell_1'].src : GAME_CONFIG.resources.paths.greenShell(1),
                holdPosition: 'behind'
            };
        case 'redShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.redShell.widthMobile : GAME_CONFIG.visuals.redShell.width,
                src: imageCache['redShell_1'] ? imageCache['redShell_1'].src : GAME_CONFIG.resources.paths.redShell(1),
                holdPosition: 'behind'
            };
        case 'banana':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.banana.widthMobile : GAME_CONFIG.visuals.banana.width + 4,
                src: imageCache['banana'] ? imageCache['banana'].src : GAME_CONFIG.resources.paths.banana,
                holdPosition: 'behind'
            };
        // Les triples n'ont pas de sprite propre : ils reprennent celui de
        // l'objet qu'ils larguent. Ce cas ne sert qu'aux appels directs, le
        // rendu de l'orbite interrogeant deja le type enfant.
        case 'tripleBanana':
            return Object.assign(getItemVisualConfig('banana'), { holdPosition: 'orbit' });
        case 'tripleGreenShell':
            return Object.assign(getItemVisualConfig('greenShell'), { holdPosition: 'orbit' });
        case 'tripleRedShell':
            return Object.assign(getItemVisualConfig('redShell'), { holdPosition: 'orbit' });
        case 'shroom':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.shroom.widthMobile : GAME_CONFIG.visuals.shroom.width,
                src: imageCache['shroom'] ? imageCache['shroom'].src : GAME_CONFIG.resources.paths.shroom,
                holdPosition: 'hands'
            };
        case 'star':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.star.widthMobile : GAME_CONFIG.visuals.star.width,
                src: imageCache['star'] ? imageCache['star'].src : GAME_CONFIG.resources.paths.star,
                holdPosition: 'hands'
            };
        default:
            return { size: 32, src: '', holdPosition: 'behind' };
    }
}

// Recalculé à chaque frame (pas figé à l'attribution) pour suivre un
// changement de breakpoint pendant que l'objet est tenu.
function getHeldItemRenderOffset(holdPosition) {
    const r = GAME_CONFIG.offsets.render;

    if (holdPosition === 'hands') {
        return {
            offset: cachedIsMobile ? r.heldItemHands.x.mobile : r.heldItemHands.x.pc,
            yShift: cachedIsMobile ? r.heldItemHands.yShift.mobile : r.heldItemHands.yShift.pc
        };
    }
    return {
        offset: cachedIsMobile ? r.heldItemBehind.mobile : r.heldItemBehind.pc,
        yShift: 0
    };
}

function createHeldItemElement(itemType, holdPosition) {
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';

    const img = document.createElement('img');
    img.style.width = '100%';

    const visual = getItemVisualConfig(itemType);
    itemDiv.style.width = `${visual.size}px`;
    img.src = visual.src;

    if (holdPosition === 'hands') {
        itemDiv.classList.add('held-item-bouncing');
        alignAnimationPhase(img, 300);
    }

    itemDiv.appendChild(img);
    cachedContainer.appendChild(itemDiv);
    return { div: itemDiv, img: img };
}

// Les carapaces tournent sur elles-memes. La frame est derivee du temps de jeu
// plutot que stockee, comme le tete-a-queue : rien a maintenir, et les trois
// orbes ne peuvent pas se desynchroniser entre eux. Rend null pour un objet
// sans animation, la banane par exemple.
function getOrbitFrameSrc(childType, gameNow) {
    if (childType !== 'greenShell' && childType !== 'redShell') return null;

    const frame = (Math.floor(gameNow / WORLD.shellAnimSpeed) % 3) + 1;
    const cached = imageCache[`${childType}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths[childType](frame);
}

// Un objet en orbite reste visible sur toute sa rotation : quand sa phase le
// place au loin, il passe simplement sous le z-index du kart et c'est le
// sprite, opaque, qui l'occulte. Il reapparait donc progressivement de part et
// d'autre du pilote au lieu de s'effacer d'un coup.
//
// La bascule se joue aux extremites laterales de l'ellipse (sin change de signe
// quand cos vaut +/-1), la ou l'objet est justement hors de la silhouette du
// kart : le changement d'ordre y passe inapercu.
function renderOrbitItems(kart, rx, gameNow) {
    const held = kart.heldItem;
    const orbit = WORLD.orbit;
    const visual = getItemVisualConfig(held.childType);

    // Recentrage sur le milieu du sprite : les elements sont ancres par leur
    // coin gauche, et la largeur depend de l'objet (une carapace est plus large
    // qu'une banane), d'ou le calcul plutot qu'une constante.
    const kartW = cachedIsMobile ? GAME_CONFIG.rendering.kartWidth.mobile : GAME_CONFIG.rendering.kartWidth.pc;
    const cx = rx + (kartW - visual.size) / 2;

    const d = GAME_CONFIG.offsets.render.orbitDrop;
    const drop = cachedIsMobile ? d.mobile : d.pc;
    const kartZ = getZIndex(kart.yPercent);
    const animSrc = getOrbitFrameSrc(held.childType, gameNow);

    for (let i = 0; i < held.orbs.length; i++) {
        const orb = held.orbs[i];
        const el = itemEls[orb.id];
        if (!el) continue;

        if (animSrc) {
            const img = el.firstChild;
            if (img && img.getAttribute('src') !== animSrc) img.src = animSrc;
        }

        const angle = held.orbitAngle + orb.phase;
        const sin = Math.sin(angle);
        const by = kart.yPercent + sin * orbit.radiusY;

        // getZIndex suit la profondeur reelle, ce qui garde l'objet bien
        // ordonne vis-a-vis des autres karts. Mais son arrondi entier peut
        // l'egaler au kart porteur quand sin frole 0 : a egalite c'est l'ordre
        // du DOM qui tranche, et l'objet scintillerait devant/derriere. D'ou
        // l'ecart d'au moins un cran force du bon cote.
        const bz = (sin > 0) ? Math.min(getZIndex(by), kartZ - 1)
                             : Math.max(getZIndex(by), kartZ + 1);

        el.style.display = 'block';
        // Y positif = vers le bas : l'orbite entiere descend de `drop`.
        el.style.transform = `translate3d(${cx + Math.cos(angle) * orbit.radiusX}px, ${drop}px, 0)`;
        el.style.bottom = `${by}%`;
        if (el.style.zIndex != bz) el.style.zIndex = bz;
    }
}

function hideOrbitItems(kart) {
    const held = kart.heldItem;
    for (let i = 0; i < held.orbs.length; i++) {
        const el = itemEls[held.orbs[i].id];
        if (el) el.style.display = 'none';
    }
}

// itemEls n'a pas d'entree pour l'id de groupe d'un objet en orbite, les acces
// generiques a itemEls[heldItem.id] sont donc des no-op sur ces types : ce
// wrapper est le seul chemin qui masque reellement un bouclier.
function hideHeldItem(kart) {
    if (!kart.heldItem) return;
    if (kart.heldItem.holdPosition === 'orbit') {
        hideOrbitItems(kart);
        return;
    }
    const el = itemEls[kart.heldItem.id];
    if (el) el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Rideau de depart et etat de la connexion
//
// Le rideau ne se leve que sur une scene complete : images decodees, `hello`
// recu, et deux snapshots en tampon — avec un seul, l'interpolation demarre a
// vide et la premiere seconde saccade.
//
// L'indicateur dit au spectateur ce qu'il regarde : une course en direct
// (point vert) ou le decor seul, faute de connexion (point rouge).
// ---------------------------------------------------------------------------
const bannerLink = {
    curtainEl: null,
    statusEl: null,
    labelEl: null,
    leaderboardEl: null,

    // Le rideau se leve quand les deux verrous sont ouverts : les images
    // decodees, et le flux en etat de fournir une scene — soit deux snapshots
    // en tampon, soit la certitude qu'il n'y aura pas de course.
    gates: { assets: false, stream: false },
    loweredAt: 0,

    open(gate) {
        this.gates[gate] = true;
        if (!this.gates.assets || !this.gates.stream) return;

        // Sans plancher, le rideau clignoterait entre deux courses.
        const shown = Date.now() - this.loweredAt;
        if (shown < CURTAIN_MIN_MS) {
            setTimeout(() => this.raiseCurtain(), CURTAIN_MIN_MS - shown);
            return;
        }

        this.raiseCurtain();
    },

    init() {
        this.curtainEl = document.getElementById('race-curtain');
        this.statusEl = document.getElementById('race-status');
        this.labelEl = this.statusEl ? this.statusEl.querySelector('.race-status-label') : null;
        this.leaderboardEl = document.getElementById('race-leaderboard');
    },

    lowerCurtain() {
        this.loweredAt = Date.now();
        if (this.curtainEl) this.curtainEl.classList.add('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.add('is-veiled');
    },

    raiseCurtain() {
        if (this.curtainEl) this.curtainEl.classList.remove('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.remove('is-veiled');
    },

    setStatus(state) {
        if (!this.statusEl) return;
        this.statusEl.classList.remove('is-connecting', 'is-online', 'is-offline');
        this.statusEl.classList.add(`is-${state}`);
        if (this.labelEl) {
            this.labelEl.textContent = state === 'online' ? 'online'
                                     : state === 'offline' ? 'offline'
                                     : 'connexion';
        }
    }
};

// ---------------------------------------------------------------------------
// Reconciliation du DOM avec l'etat du monde
//
// Regle : l'etat fait foi, les evenements ne sont que de la decoration. A
// chaque nouvel etat recu, le DOM est aligne dessus — ce qui manque est cree,
// ce qui ne correspond plus a rien est supprime. Aucun element visible ne doit
// dependre d'un evenement qu'il aurait fallu voir passer.
//
// C'est ce qui rend affichable une course deja commencee : un spectateur qui
// arrive a la 187e seconde n'a vu aucun `kartSpawned`, aucun `spawnHeldItem`,
// aucun `starOn`, et doit pourtant voir la scene complete et juste. Meme chose
// apres une micro-coupure, ou un evenement peut simplement s'etre perdu.
// ---------------------------------------------------------------------------

function ensureKartEl(kart) {
    let els = kartEls[kart.id];
    if (els) return els;

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.classList.add('kart-container-moving');
    wrapper.style.bottom = `${kart.yPercent}%`;
    wrapper.style.zIndex = getZIndex(kart.yPercent);

    // Intercalaire dédié au miroir : snesBounce occupe déjà `transform`
    // sur l'img, on ne peut pas y empiler un scaleX(-1).
    const sprite = document.createElement('div');
    sprite.classList.add('kart-sprite');

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.char(kart.charName);
    img.classList.add('kart-static-png');
    // snesBounce (0,15 s en alternate = cycle de 0,3 s) et starRainbow (0,3 s).
    alignAnimationPhase(img, 300);

    sprite.appendChild(img);
    wrapper.appendChild(sprite);
    cachedContainer.appendChild(wrapper);

    // `spinFrame` decrit ce que cet element affiche : il vit donc avec lui, et
    // non dans l'etat du kart, qui est reconstruit a chaque `hello`. Sinon le
    // rendu croirait n'avoir rien a changer et laisserait le sprite fige sur
    // une image de tete-a-queue. 0 correspond au sprite pose ci-dessus.
    els = { wrapper: wrapper, sprite: sprite, img: img, spinFrame: 0 };
    kartEls[kart.id] = els;

    return els;
}

function ensureItemEl(itemId, itemType, holdPosition) {
    let el = itemEls[itemId];
    if (el) return el;
    el = createHeldItemElement(itemType, holdPosition).div;
    itemEls[itemId] = el;
    return el;
}

function ensureBoxEl(box, index) {
    if (boxEls[index]) return boxEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const size = cachedIsMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const el = document.createElement('div');
    el.classList.add('item-box');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.bottom = `${box.y}%`;
    el.style.zIndex = getZIndex(box.y);

    cachedContainer.appendChild(el);
    boxEls[index] = el;
    return el;
}

// Un objet peut exister a trois endroits : libre sur la piste, tenu par un
// kart, ou en orbite autour de lui (auquel cas ce sont les orbes qui portent
// les ids, pas le groupe). Tout ce qui n'est dans aucun des trois est un
// orphelin : element laisse par un objet detruit, ou reliquat d'une course
// precedente. Sans ce balayage, chaque reconnexion fuirait quelques divs.
function reconcileItems() {
    const expected = {};

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        expected[item.id] = true;
        ensureItemEl(item.id, item.type, 'behind');
    }

    for (let i = 0; i < worldState.karts.length; i++) {
        const held = worldState.karts[i].heldItem;
        if (!held) continue;

        if (held.holdPosition === 'orbit') {
            for (let o = 0; o < held.orbs.length; o++) {
                expected[held.orbs[o].id] = true;
                ensureItemEl(held.orbs[o].id, held.childType, 'orbit');
            }
        } else {
            expected[held.id] = true;
            ensureItemEl(held.id, held.type, held.holdPosition);
        }
    }

    for (const id in itemEls) {
        if (expected[id]) continue;
        itemEls[id].remove();
        delete itemEls[id];
    }
}

// Le classement se reconstruit de zero : un arrivant doit voir les huit photos
// deja rangees dans l'ordre, sans avoir vu le moindre depassement. Les karts
// encore `pending` n'y figurent pas — ils ne sont pas entres en course.
function reconcileLeaderboard() {
    for (let i = 0; i < worldState.karts.length; i++) {
        const kart = worldState.karts[i];

        ensurePPEl(kart);

        const slot = kart.rank - 1;
        if (!ppAnimating[kart.id] && ppSlots[kart.id] !== slot) {
            positionPPInSlot(kart.id, slot);
        }
    }

    for (const id in ppEls) {
        if (!worldState.kartsById[id]) removePPEl(id);
    }

    updateFocusMarks();
}

function removePPEl(kartId) {
    const el = ppEls[kartId];
    if (!el) return;
    el.remove();
    delete ppEls[kartId];
    delete ppSlots[kartId];
    delete ppAnimating[kartId];
}

// Le halo d'etoile est un etat, pas un evenement : `starOn` / `starOff` ne sont
// que les instants ou il bascule, invisibles pour qui arrive entre les deux.
function reconcileStar(kart) {
    const on = !!kart.isInvincible;
    const els = kartEls[kart.id];
    if (els) els.wrapper.classList.toggle('star-active', on);
    const pp = ppEls[kart.id];
    if (pp) pp.classList.toggle('pp-star-active', on);
}

function reconcileDom() {
    for (let i = 0; i < worldState.karts.length; i++) ensureKartEl(worldState.karts[i]);

    for (const id in kartEls) {
        if (worldState.kartsById[id]) continue;
        kartEls[id].wrapper.remove();
        delete kartEls[id];
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) ensureBoxEl(worldState.itemBoxes[i], i);
    while (boxEls.length > worldState.itemBoxes.length) boxEls.pop().remove();

    reconcileItems();
    reconcileLeaderboard();

    for (let i = 0; i < worldState.karts.length; i++) reconcileStar(worldState.karts[i]);
}

// Les evenements ne creent et ne detruisent plus rien : ils ne declenchent que
// des animations ponctuelles, qu'un spectateur arrive en retard peut rater sans
// que sa scene en soit fausse. Tout le reste est deduit de l'etat par
// reconcileDom(). Les types non listes ici (kartSpawned, spawnHeldItem,
// removeHeldItem, killItem, launchItem, starOn, starOff) n'ont donc plus
// d'effet propre.
function applyEvent(ev) {
    switch (ev.type) {
        case 'kartHit': {
            triggerPPHitAnimation(ev.kartId);
            break;
        }
        case 'leaderboardPosition': {
            // Le glissement n'a de sens que si la photo etait deja quelque part.
            if (ppEls[ev.kartId]) applyLeaderboardPosition(ev.kartId, ev.newPosition, ev.prevPosition);
            break;
        }
    }
}

// Dérivé uniquement de l'état physique (state + hitEndTime) : aucun timer de
// rendu à maintenir, donc rien qui puisse désynchroniser du reste de la course.
// Le kart boucle kartSpin.turns fois sur la fraction durationRatio du malus,
// puis reste sur side-right jusqu'à ce qu'il reparte.
function getSpinFrameIndex(kart, gameNow) {
    if (kart.state !== 'hit') return 0;

    const hitDuration = WORLD.hitDuration;
    const spinDuration = hitDuration * GAME_CONFIG.kartSpin.durationRatio;
    const elapsed = gameNow - (kart.hitEndTime - hitDuration);
    if (elapsed <= 0 || elapsed >= spinDuration) return 0;

    const frameCount = GAME_CONFIG.kartSpin.frames.length;
    return Math.floor((elapsed / spinDuration) * GAME_CONFIG.kartSpin.turns * frameCount) % frameCount;
}

function applyKartSpinFrame(kart, els, frameIndex) {
    const frame = GAME_CONFIG.kartSpin.frames[frameIndex];
    els.img.src = getKartFrameSrc(kart.charName, frame.dir);
    els.sprite.classList.toggle('kart-mirrored', frame.mirror);
}

// Lakitu est ancre sur la ligne de depart : c'est la camera qui le fait entrer
// et sortir du cadre, et le serveur qui decide du panneau qu'il tient.
let lakituEls = null;

function ensureLakituEl() {
    if (lakituEls) return lakituEls;
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'lakitu';

    const img = document.createElement('img');
    wrapper.appendChild(img);
    cachedContainer.appendChild(wrapper);

    lakituEls = { wrapper: wrapper, img: img, key: null };
    return lakituEls;
}

function lakituSrc(group, frame, gameNow) {
    // Le drapeau s'anime a partir du temps : le serveur n'envoie que le groupe.
    if (group === 'finish') {
        frame = (Math.floor(gameNow / WORLD.flagAnimSpeed) % 3) + 1;
    }
    const cached = imageCache[`lakitu_${group}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.lakitu(group, frame);
}

function renderLakitu(gameNow, screenWidth) {
    const els = ensureLakituEl();
    if (!els) return;

    const sign = worldState.sign;
    if (!sign) {
        els.wrapper.style.display = 'none';
        return;
    }

    const rx = getScreenPosition(WORLD.finishLineX, renderCameraX, screenWidth);
    const margin = GAME_CONFIG.rendering.bufferZone;
    if (rx < -margin || rx > screenWidth + margin) {
        els.wrapper.style.display = 'none';
        return;
    }

    const src = lakituSrc(sign[0], sign[1], gameNow);
    if (els.key !== src) {
        els.key = src;
        els.img.src = src;
    }

    els.wrapper.style.display = 'block';
    els.wrapper.style.height = `${cachedIsMobile ? LAKITU_HEIGHT.mobile : LAKITU_HEIGHT.pc}px`;
    els.wrapper.style.bottom = `${LAKITU_BOTTOM}%`;
    // Centre sur la ligne : la moitie de largeur gagnee compte sur mobile.
    els.wrapper.style.transform = `translate3d(${rx}px, 0, 0) translateX(-50%)`;
}

let resultsEl = null;
let resultsShown = -1;

// Reconstruit entierement depuis `finishOrder` : un spectateur qui arrive en
// plein classement le voit en entier, sans avoir assiste aux arrivees.
function renderResults() {
    if (!resultsEl) resultsEl = document.getElementById('race-results');
    if (!resultsEl) return;

    const order = worldState.finishOrder || [];
    const visible = order.length > 0;

    resultsEl.classList.toggle('is-visible', visible);
    if (!visible) {
        resultsShown = 0;
        resultsEl.innerHTML = '';
        return;
    }

    if (resultsShown === order.length) return;
    resultsShown = order.length;

    resultsEl.innerHTML = '';
    order.forEach((kartId, index) => {
        const kart = worldState.kartsById[kartId];
        if (!kart) return;

        const entry = document.createElement('div');
        entry.className = 'race-result';

        const rank = document.createElement('span');
        rank.className = 'race-result-rank';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
        img.alt = kart.charName;

        entry.appendChild(rank);
        entry.appendChild(img);
        resultsEl.appendChild(entry);
    });
}

function renderState(gameNow, screenWidth) {
    const renderMargin = GAME_CONFIG.rendering.bufferZone;

    updateRenderCamera();

    if (domDirty) {
        domDirty = false;
        reconcileDom();
        renderResults();
    }

    renderLakitu(gameNow, screenWidth);

    // Les trois calques de decor sont des textures, pas des elements places :
    // ils ne passent pas par getScreenPosition et doivent donc appliquer le
    // meme recentrage a la main. Le bord gauche de la fenetre, c'est le centre
    // moins la moitie de la largeur visible.
    const halfView = screenWidth / 2;

    if (cachedBg) {
        // Été : parallaxe, moitié vitesse.
        const bgX = cachedIsSummerBanner ? renderBgCameraX : renderCameraX;
        cachedBg.style.backgroundPosition = `${halfView - bgX}px 0px`;
    } else {
        cachedBg = document.querySelector('.layer-scrolling-bg');
    }

    if (cachedFg) {
        // Décor de premier plan (été uniquement) : même vitesse que la route.
        const fgX = (renderCameraX - halfView) % WORLD.width;
        cachedFg.style.backgroundPosition = `${-fgX}px 0px`;
    } else {
        cachedFg = document.querySelector('.layer-scrolling-fg');
    }

    if (cachedGround) {
        // Bordure de route : la bande est un motif de 80px ancre sur le monde,
        // il suffit de la decaler du reste de la division. Modulo positif, un
        // reste negatif donnerait une valeur CSS invalide.
        const roadX = (((renderCameraX - halfView) % ROAD_PATTERN_WIDTH) + ROAD_PATTERN_WIDTH) % ROAD_PATTERN_WIDTH;
        cachedGround.style.setProperty('--road-offset', `${-roadX}px`);
    } else {
        cachedGround = document.querySelector('.layer-ground');
    }

    if (worldState.finishLine && worldState.finishLine.element) {
        const rx = getScreenPosition(worldState.finishLine.worldX, renderCameraX, screenWidth);
        worldState.finishLine.element.style.transform = `translate3d(${rx}px, 0, 0)`;
    }

    if (worldState.sun && worldState.sun.element) {
        // Solidaire du fond, pas de la route.
        const sx = getScreenPosition(worldState.sun.worldX, renderBgCameraX, screenWidth);
        worldState.sun.element.style.transform = `translate3d(${sx}px, 0, 0)`;
    }

    const boxesLen = worldState.itemBoxes.length;
    const floatY = Math.sin(gameNow * GAME_CONFIG.rendering.boxFloat.speed) * GAME_CONFIG.rendering.boxFloat.amplitude;
    for (let i = 0; i < boxesLen; i++) {
        const box = worldState.itemBoxes[i];
        const el = boxEls[i];
        if (!el) continue;
        if (!box.active) { el.style.display = 'none'; continue; }

        const rx = getScreenPosition(box.worldX, renderCameraX, screenWidth);
        if (rx > -renderMargin && rx < screenWidth + renderMargin) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, ${floatY}px, 0)`;
        } else {
            el.style.display = 'none';
        }
    }

    const kartsLen = worldState.karts.length;
    for (let i = 0; i < kartsLen; i++) {
        const kart = worldState.karts[i];
        const els = kartEls[kart.id];
        if (!els) continue;
        const wrapper = els.wrapper;

        if (kart.state === 'hit') {
            if (kart.stopped) {
                if (!wrapper.classList.contains('kart-stopped')) wrapper.classList.add('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.add('item-stopped');
            } else {
                wrapper.classList.remove('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
            }
        } else {
            wrapper.classList.remove('kart-stopped');
            if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
        }

        const rx = getScreenPosition(kart.worldX, renderCameraX, screenWidth);
        const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

        if (isVisibleNow) {
            wrapper.style.display = 'block';
            wrapper.style.transform = `translate3d(${rx}px, 0, 0)`;
            wrapper.style.bottom = `${kart.yPercent}%`;

            const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
            if (wrapper.style.zIndex != zVal) wrapper.style.zIndex = zVal;

            const spinFrame = getSpinFrameIndex(kart, gameNow);
            if (els.spinFrame !== spinFrame) {
                els.spinFrame = spinFrame;
                applyKartSpinFrame(kart, els, spinFrame);
            }

            if (kart.heldItem && kart.heldItem.holdPosition === 'orbit') {
                renderOrbitItems(kart, rx, gameNow);
            } else if (kart.heldItem) {
                const hel = itemEls[kart.heldItem.id];
                if (hel) {
                    hel.style.display = 'block';
                    const hOffset = getHeldItemRenderOffset(kart.heldItem.holdPosition);
                    const hx = rx + hOffset.offset;
                    const hy = hOffset.yShift;
                    hel.style.transform = `translate3d(${hx}px, ${-hy}px, 0)`;
                    hel.style.bottom = `${kart.yPercent}%`;
                    const itemZ = kart.heldItem.holdPosition === 'hands' ? zVal + 1 : zVal;
                    if (hel.style.zIndex != itemZ) hel.style.zIndex = itemZ;
                }
            }
        } else {
            wrapper.style.display = 'none';
            hideHeldItem(kart);
        }
    }

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        const el = itemEls[item.id];
        if (!el) continue;

        if (item.type === 'greenShell' || item.type === 'redShell') {
            const img = el.firstChild;
            if (img) {
                const cached = imageCache[`${item.type}_${item.currentFrame}`];
                const src = cached ? cached.src : (item.type === 'greenShell'
                    ? GAME_CONFIG.resources.paths.greenShell(item.currentFrame)
                    : GAME_CONFIG.resources.paths.redShell(item.currentFrame));
                if (img.getAttribute('src') !== src) img.src = src;
            }
        }

        const rx = getScreenPosition(item.worldX, renderCameraX, screenWidth);
        const isVisible = (rx > -renderMargin && rx < screenWidth + renderMargin);
        if (isVisible) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, 0, 0)`;
            el.style.bottom = `${item.y}%`;
            const zVal = (GAME_CONFIG.rendering.zIndexBase - item.y) | 0;
            if (el.style.zIndex != zVal) el.style.zIndex = zVal;
        } else {
            el.style.display = 'none';
        }
    }
}

// ---------------------------------------------------------------------------
// Reception : horloge, tampon, interpolation
//
// Le client ne simule rien. Il recoit des snapshots dates en temps serveur, les
// empile, et affiche en permanence un instant leger retard — assez pour avoir
// toujours deux snapshots a interpoler. C'est ce retard, et lui seul, qui rend
// le mouvement fluide malgre une diffusion a 10 Hz.
// ---------------------------------------------------------------------------

// Retard de rendu : deux intervalles de diffusion (100 ms a 10 Hz). C'est la
// tolerance a la gigue du reseau. En dessous d'un intervalle il n'y a rien a
// interpoler ; juste au-dessus, le moindre snapshot en retard fait tomber le
// rendu sur son dernier etat connu — la scene se fige puis saute, ce qui ne se
// distingue pas d'une chute de framerate. A reajuster si SEND_HZ change.
const RENDER_DELAY_MS = 200;

const BUFFER_KEEP_MS = 3000;

// Vitesse de rattrapage de l'horloge, en millisecondes par frame. A 60 images
// par seconde, 1 ms par frame absorbe 60 ms d'ecart en une seconde : assez
// rapide pour suivre une derive reelle, assez lent pour ne pas se voir.
const CLOCK_SLEW_MS_PER_FRAME = 1;

// Au-dela, ce n'est plus une derive mais un decrochage — retour d'un onglet
// endormi, changement de reseau. On se recale d'un coup, quitte a sauter.
const CLOCK_JUMP_THRESHOLD_MS = 1000;

function stepClock() {
    const drift = targetClockOffset - serverClockOffset;
    if (drift === 0) return;

    if (Math.abs(drift) > CLOCK_JUMP_THRESHOLD_MS) {
        serverClockOffset = targetClockOffset;
        return;
    }

    serverClockOffset += Math.max(-CLOCK_SLEW_MS_PER_FRAME,
                                  Math.min(CLOCK_SLEW_MS_PER_FRAME, drift));
}

const PING_INTERVAL_MS = 30000;

// Duree de vie d'une mesure d'horloge. Sans peremption, la meilleure mesure
// jamais faite gagne pour toujours — y compris apres que l'horloge locale a
// change sous nos pieds.
const CLOCK_SAMPLE_TTL_MS = 120000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Une coupure d'une seconde ne merite pas d'annoncer une panne au visiteur ;
// deux echecs de suite, si.
const OFFLINE_AFTER_ATTEMPTS = 2;

// Interpolation sur un monde qui boucle : entre x=3830 et x=20, le chemin court
// fait 30 unites vers la droite, pas 3810 vers la gauche. Interpoler
// naivement ferait traverser toute la carte a l'envers a chaque tour.
function lerpWrapped(from, to, t, width) {
    let delta = to - from;
    if (delta > width / 2) delta -= width;
    else if (delta < -width / 2) delta += width;

    let value = from + delta * t;
    if (value < 0) value += width;
    if (value >= width) value -= width;
    return value;
}

function lerp(from, to, t) {
    return from + (to - from) * t;
}

// Ecrit un tuple de kart dans le miroir local. Les champs continus sont
// interpoles, les champs discrets (etat, rang, objet tenu) sont pris sur le
// snapshot de depart : les faire apparaitre en avance donnerait un halo ou un
// tete-a-queue avant le fait.
function writeKart(kart, ta, tb, t) {
    if (tb) {
        kart.worldX = lerpWrapped(ta[1], tb[1], t, WORLD.width);
        kart.yPercent = lerp(ta[2], tb[2], t);
        kart.totalDistance = lerp(ta[3], tb[3], t);
    } else {
        kart.worldX = ta[1];
        kart.yPercent = ta[2];
        kart.totalDistance = ta[3];
    }

    const flags = ta[4];
    kart.state = (flags & 1) ? 'grid' : ((flags & 2) ? 'hit' : 'running');
    kart.stopped = !!(flags & 4);
    kart.isInvincible = !!(flags & 8);
    kart.finished = !!(flags & 16);
    kart.rank = ta[5];

    // Un serveur qui ne date pas le malus (`hitEnd` absent) ne doit pas priver
    // le kart de sa toupie : on la cale alors sur l'instant ou l'etat 'hit' est
    // apparu. Approximatif pour un arrivant, juste pour tous les autres.
    if (kart.state === 'hit') {
        kart.hitEndTime = ta[11] || kart.hitEndTime || (getGameTime() + WORLD.hitDuration);
    } else {
        kart.hitEndTime = 0;
    }

    if (ta[6] === null) {
        kart.heldItem = null;
        return;
    }

    const held = (kart.heldItem && kart.heldItem.id === ta[6]) ? kart.heldItem : {};
    held.id = ta[6];
    held.type = ta[7];
    held.holdPosition = ta[8];

    if (ta[8] === 'orbit') {
        held.childType = ta[7];
        held.orbitAngle = ta[9];
        // Les phases sont figees a la creation de l'orbite et reparties
        // regulierement : le serveur n'a pas a les transmettre.
        held.orbs = ta[10].map((id, i) => ({ id: id, phase: (i * 2 * Math.PI) / WORLD.orbit.count }));
    }

    kart.heldItem = held;
}

// Applique un etat au miroir local. `b` absent = pas d'interpolation, on colle
// au snapshot `a` — c'est le cas du premier `hello` et des rattrapages.
// Structures reutilisees d'une frame a l'autre. `applyState` tourne soixante
// fois par seconde : tout ce qu'elle allouerait deviendrait du dechet a
// ramasser, et le ramassage se voit sur mobile — de petites pauses regulieres,
// exactement ce qu'on prend pour une chute de framerate.
const nextKartTuples = new Map();
const nextItemTuples = new Map();
const itemMirrors = new Map();

// Vrai quand la structure de la scene a pu changer, c'est-a-dire uniquement a
// l'arrivee d'un nouveau snapshot. Entre deux, rien ne peut apparaitre ni
// disparaitre : reconcilier a chaque frame reviendrait a refaire six fois le
// meme travail pour rien.
let lastAppliedSnapshot = null;
let domDirty = true;

function applyState(a, b, t) {
    worldState.cameraX = b ? lerpWrapped(a.cx, b.cx, t, WORLD.width) : a.cx;
    worldState.bgCameraX = b ? lerpWrapped(a.bx, b.bx, t, WORLD.width) : a.bx;

    const fresh = a !== lastAppliedSnapshot;
    if (fresh) {
        lastAppliedSnapshot = a;
        domDirty = true;
    }

    nextKartTuples.clear();
    if (b) for (const tuple of b.k) nextKartTuples.set(tuple[0], tuple);

    for (const tuple of a.k) {
        const kart = worldState.kartsById[tuple[0]];
        if (kart) writeKart(kart, tuple, b ? nextKartTuples.get(tuple[0]) : null, t);
    }

    nextItemTuples.clear();
    if (b) for (const tuple of b.i) nextItemTuples.set(tuple[0], tuple);

    worldState.items.length = 0;
    for (const tuple of a.i) {
        let item = itemMirrors.get(tuple[0]);
        if (!item) {
            item = { id: tuple[0], type: tuple[1], worldX: 0, y: 0, currentFrame: 1 };
            itemMirrors.set(tuple[0], item);
        }

        const to = b ? nextItemTuples.get(tuple[0]) : null;
        item.type = tuple[1];
        item.worldX = to ? lerpWrapped(tuple[2], to[2], t, WORLD.width) : tuple[2];
        item.y = to ? lerp(tuple[3], to[3], t) : tuple[3];
        item.currentFrame = tuple[4];

        worldState.items.push(item);
    }

    // Les identifiants d'objets ne sont jamais reutilises : sans ce menage, la
    // table grossirait indefiniment sur une course qui dure. Une seule fois par
    // snapshot suffit.
    if (fresh && itemMirrors.size > worldState.items.length) {
        for (const id of itemMirrors.keys()) {
            if (!nextItemTuples.has(id) && !worldState.items.some(item => item.id === id)) {
                itemMirrors.delete(id);
            }
        }
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) {
        worldState.itemBoxes[i].active = a.b[i] === 1;
    }

    worldState.phase = a.ph;
    worldState.leaderLap = a.lp;
    worldState.sign = a.sg;
    worldState.finishOrder = a.fo;
}

const bannerNet = {
    ws: null,
    buffer: [],
    attempts: 0,
    hidden: false,
    ready: false,
    gotHello: false,
    wasOffline: false,
    pendingHello: null,
    rebuildTimer: null,
    reconnectTimer: null,
    pingTimer: null,
    rttSamples: [],

    url() {
        // Jamais `wss://` en dur : en local le site est en clair, et l'erreur ne
        // se verrait qu'a l'execution.
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws/race`;
    },

    connect() {
        if (this.ws) return;

        if (this.attempts === 0) bannerLink.setStatus('connecting');

        let ws;
        try {
            ws = new WebSocket(this.url());
        } catch (err) {
            this.onDisconnected();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempts = 0;
            this.rttSamples = [];
            // Trois mesures rapprochees : l'ecart d'horloge se stabilise en une
            // seconde au lieu d'attendre le premier ping periodique.
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
            this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
        };

        ws.onmessage = event => this.onMessage(event.data);
        ws.onclose = () => this.onDisconnected();
        ws.onerror = () => { try { ws.close(); } catch (err) { /* deja fermee */ } };
    },

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            return;
        }

        if (msg.t === 'pong') {
            this.onPong(msg);
            return;
        }

        if (msg.t === 'hello') {
            if (msg.protocol !== 2) {
                // Version incompatible : mieux vaut le decor seul qu'une scene
                // interpretee de travers.
                console.warn(`banner : protocole ${msg.protocol} non gere`);
                this.giveUp();
                return;
            }
            // Course neuve alors qu'une autre etait a l'ecran : le rideau tombe
            // d'abord, la scene n'est refaite qu'une fois qu'il est en bas.
            // Sinon la nouvelle grille apparait derriere un rideau a mi-hauteur.
            if (isNewRace(msg) && this.ready) {
                this.ready = false;
                this.gotHello = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();

                this.pendingHello = msg;
                clearTimeout(this.rebuildTimer);
                this.rebuildTimer = setTimeout(() => {
                    if (this.pendingHello) this.applyHello(this.pendingHello);
                }, CURTAIN_FALL_MS);
                return;
            }

            // Retour apres coupure : la scene est deja vide, rien a cacher.
            if (this.wasOffline) {
                this.wasOffline = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();
            }

            this.applyHello(msg);
            return;
        }

        if (msg.t === 's' && this.gotHello) {
            this.buffer.push(msg);
            if (msg.ev) for (const ev of msg.ev) applyEvent(ev);

            const cutoff = getGameTime() - BUFFER_KEEP_MS;
            while (this.buffer.length > 2 && this.buffer[0].ts < cutoff) this.buffer.shift();

            // Le rideau ne se leve qu'avec deux snapshots en main : avec un
            // seul, l'interpolation demarre a vide et la premiere seconde
            // saccade.
            if (!this.ready && this.buffer.length >= 2) {
                this.ready = true;
                bannerLink.setStatus('online');
                bannerLink.open('stream');
            }
        }
    },

    applyHello(msg) {
        this.pendingHello = null;
        this.buffer = [];
        this.gotHello = true;
        buildWorldFromHello(msg);
        this.buffer.push(msg.snapshot);
    },

    ping() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        this.ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));
    },

    // On garde la meilleure mesure plutot que la moyenne : un aller-retour
    // rapide est forcement moins deforme par les files d'attente qu'un lent.
    onPong(msg) {
        const now = Date.now();
        const rtt = now - msg.c;
        const offset = msg.s + rtt / 2 - now;

        this.rttSamples.push({ rtt: rtt, offset: offset, at: now });

        // Une mesure vieille de plusieurs minutes decrit peut-etre une horloge
        // qui n'existe plus : un appareil qui sort de veille resynchronise
        // souvent la sienne sur le reseau. La garder reviendrait a laisser son
        // faible aller-retour l'emporter indefiniment, et le rendu resterait
        // cale sur l'ancienne heure — une course coherente, mais decalee de
        // celle que tout le monde regarde.
        this.rttSamples = this.rttSamples
            .filter(sample => now - sample.at < CLOCK_SAMPLE_TTL_MS)
            .slice(-8);

        let best = this.rttSamples[0];
        for (const sample of this.rttSamples) if (sample.rtt < best.rtt) best = sample;

        targetClockOffset = best.offset;

        // Premiere mesure : on se cale d'un coup, il n'y a encore rien a
        // secouer. Les elements deja crees portent en revanche une phase
        // d'animation calee sur l'heure locale, donc fausse : c'est le seul
        // moment ou il faut les reprendre.
        if (!clockCalibrated) {
            clockCalibrated = true;
            serverClockOffset = targetClockOffset;
            realignAnimations();
        }
    },

    setHidden(hidden) {
        this.hidden = hidden;
        this.buffer = [];

        if (!hidden) {
            // L'horloge locale a pu etre resynchronisee pendant la mise en
            // veille, et le tampon est de toute facon perime. On repart de zero
            // sur l'estimation : la prochaine mesure sera adoptee telle quelle
            // au lieu d'etre rejointe en douceur, puisqu'il ne s'agit pas d'une
            // derive mais d'un saut.
            this.rttSamples = [];
            clockCalibrated = false;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: 'vis', hidden: hidden }));
        }

        if (!hidden) {
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
        }
    },

    onDisconnected() {
        this.ws = null;
        this.ready = false;
        this.gotHello = false;
        this.buffer = [];
        this.pendingHello = null;
        clearTimeout(this.rebuildTimer);

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        this.attempts++;
        if (this.attempts >= OFFLINE_AFTER_ATTEMPTS) {
            this.wasOffline = true;
            bannerLink.setStatus('offline');
            bannerLink.open('stream');
            clearScene();
        }

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.attempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    },

    // Abandon definitif : protocole incompatible. Reessayer ne servirait qu'a
    // tenir une connexion inutile ouverte.
    giveUp() {
        this.wasOffline = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
        bannerLink.setStatus('offline');
        bannerLink.open('stream');
        clearScene();
    },

    // Choisit les deux snapshots qui encadrent l'instant a afficher.
    frameFor(renderTime) {
        const buffer = this.buffer;
        if (buffer.length === 0) return null;

        for (let i = buffer.length - 1; i > 0; i--) {
            const a = buffer[i - 1];
            const b = buffer[i];
            if (a.ts <= renderTime && renderTime <= b.ts) {
                const span = b.ts - a.ts;
                return { a: a, b: b, t: span > 0 ? (renderTime - a.ts) / span : 0 };
            }
        }

        // Hors tampon : soit le reseau a decroche et on affiche le dernier etat
        // connu, soit l'horloge est en retard et on affiche le plus ancien.
        const last = buffer[buffer.length - 1];
        if (renderTime > last.ts) return { a: last, b: null, t: 0 };
        return { a: buffer[0], b: null, t: 0 };
    }
};

// Quelques compteurs, assez legers pour rester en place : ils distinguent une
// saccade venue du reseau (le rendu attend un snapshot en retard, `gel` monte)
// d'une saccade venue de la machine (le framerate baisse sans gel).
const perf = { frames: 0, stalls: 0, fps: 0, windowStart: 0, windowFrames: 0 };

function trackFrame(timestamp, stalled) {
    perf.frames++;
    if (stalled) perf.stalls++;

    if (!perf.windowStart) perf.windowStart = timestamp;
    perf.windowFrames++;

    const span = timestamp - perf.windowStart;
    if (span >= 1000) {
        perf.fps = Math.round((perf.windowFrames * 1000) / span);
        perf.windowStart = timestamp;
        perf.windowFrames = 0;
    }
}

function animate(timestamp) {
    updateMobileStatus();
    stepClock();

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    if (cachedContainer) {
        let screenWidth = cachedContainer.offsetWidth;
        if (cachedIsMobile) {
            screenWidth = screenWidth / GAME_CONFIG.rendering.mobileScale;
        }

        const gameNow = getGameTime();

        // On affiche un instant deja passe, le temps d'avoir les deux snapshots
        // qui l'encadrent. Sans ce retard, rien a interpoler.
        const renderTime = gameNow - RENDER_DELAY_MS;
        const frame = bannerNet.frameFor(renderTime);

        // Un couple sans second terme, c'est un rendu hors tampon : la scene se
        // fige sur le dernier etat connu jusqu'au prochain snapshot.
        trackFrame(timestamp, !!frame && !frame.b);

        if (frame) {
            applyState(frame.a, frame.b, frame.t);
        } else if (!bannerNet.ready) {
            // Hors ligne : aucune course, mais le decor continue de defiler.
            const elapsed = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0;
            const advance = WORLD.roadPPS * Math.min(elapsed, 0.1);
            worldState.cameraX = (worldState.cameraX + advance) % WORLD.width;
            worldState.bgCameraX = (worldState.bgCameraX + advance / 2) % WORLD.width;
        }

        // Les positions affichees sont celles de `renderTime` : la toupie, les
        // frames de carapace et la levitation des boites doivent suivre la meme
        // horloge, sinon elles avancent 120 ms devant la scene.
        renderState(renderTime, screenWidth);
    }

    lastFrameTime = timestamp;

    if (GAME_CONFIG.debugMode) updateDebugHUD();
    animationId = requestAnimationFrame(animate);
}

function initDebugHUD() {
    let hud = document.getElementById('debug-hud');
    if (!hud) {
        hud = document.createElement('div');
        hud.id = 'debug-hud';
        document.body.appendChild(hud);
    }
    hud.innerHTML = '';
    hud.style.display = 'block';

    const finishLine = document.createElement('div');
    finishLine.className = 'debug-entity debug-finish';
    const finishPct = (WORLD.finishLineX / WORLD.width) * 100;
    finishLine.style.left = `${finishPct}%`;
    hud.appendChild(finishLine);

    worldState.itemBoxes.forEach((box, i) => {
        const dBox = document.createElement('div');
        dBox.className = 'debug-entity debug-itembox';
        dBox.id = `debug-box-${i}`;
        const bPct = (box.worldX / WORLD.width) * 100;
        dBox.style.left = `${bPct}%`;
        hud.appendChild(dBox);
    });

    worldState.karts.forEach(kart => {
        const dKart = document.createElement('div');
        dKart.className = 'debug-entity debug-kart';
        dKart.id = `debug-kart-${kart.id}`;
        dKart.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        hud.appendChild(dKart);
    });

    const camView = document.createElement('div');
    camView.className = 'debug-camera-view';
    hud.appendChild(camView);

    const camViewLoop = document.createElement('div');
    camViewLoop.className = 'debug-camera-view';
    camViewLoop.id = 'debug-camera-view-loop';
    camViewLoop.style.display = 'none';
    hud.appendChild(camViewLoop);

    const leaderboard = document.createElement('div');
    leaderboard.id = 'debug-leaderboard';
    leaderboard.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 10px 15px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 14px;
        z-index: 9999;
        min-width: 200px;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: bold; margin-bottom: 8px; text-align: center; border-bottom: 1px solid #555; padding-bottom: 5px;';
    title.innerText = '🏁 Classement';
    leaderboard.appendChild(title);

    const list = document.createElement('div');
    list.id = 'debug-leaderboard-list';
    leaderboard.appendChild(list);

    document.body.appendChild(leaderboard);
}

function updateDebugHUD() {
    const hud = document.getElementById('debug-hud');
    if (!hud) return;

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    const screenWidth = cachedContainer ? cachedContainer.offsetWidth : window.innerWidth;

    const camViews = hud.getElementsByClassName('debug-camera-view');
    if (camViews.length < 2) return;

    const camMain = camViews[0];
    const camLoop = camViews[1];

    const worldW = WORLD.width;
    // camera = centre de la vue : le bord gauche est a mi-largeur en arriere.
    const camX = (((renderCameraX - screenWidth / 2) % worldW) + worldW) % worldW;

    const camPct = (camX / worldW) * 100;
    const viewPct = (screenWidth / worldW) * 100;

    camMain.style.left = `${camPct}%`;
    camMain.style.width = `${viewPct}%`;

    const overflow = (camX + screenWidth) - worldW;

    if (overflow > 0) {
        camLoop.style.display = 'block';
        camLoop.style.left = '0%';
        camLoop.style.width = `${(overflow / worldW) * 100}%`;
    } else {
        camLoop.style.display = 'none';
    }

    worldState.karts.forEach(kart => {
        const el = document.getElementById(`debug-kart-${kart.id}`);
        if (el) {
            const kPct = (kart.worldX / WORLD.width) * 100;
            el.style.left = `${kPct}%`;
            el.style.backgroundColor = (kart.state === 'hit') ? 'red' : 'blue';
            if (kart.state === 'grid') el.style.backgroundColor = 'gray';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        }
    });

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        // Meme reference que la physique : rollItem() mesure l'ecart au premier
        // via totalDistance, jamais via worldX. Trier ici sur autre chose
        // afficherait des ecarts incoherents avec le tirage d'items.
        const sortedKarts = [...worldState.karts]
            .sort((a, b) => b.totalDistance - a.totalDistance);

        const leader = sortedKarts[0] || null;

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            // Le nombre de tours n'est pas diffuse : il se deduit de la
            // distance parcourue, qui l'est.
            const laps = Math.floor(kart.totalDistance / WORLD.width);
            const gap = (leader && leader.id !== kart.id)
                ? `${Math.round(leader.totalDistance - kart.totalDistance)}px`
                : '\u2014';
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps} \u00B7 ${gap}</span></div>`;
        }).join('');
    }
}

// La course continue sans nous. Il n'y a donc rien a « reprendre » : au retour,
// on jette le tampon devenu faux, on recale l'horloge, et le serveur renvoie un
// `hello` complet — un onglet qui revient est un arrivant comme un autre.
function handleVisibilityChange() {
    if (document.hidden) {
        if (animationId) cancelAnimationFrame(animationId);
        animationId = null;
        bannerNet.setHidden(true);
        return;
    }

    bannerNet.setHidden(false);

    if (!animationId) animationId = requestAnimationFrame(animate);
}

function initSnow() {
    const banner = document.querySelector('.hero.smk-snes-banner');
    if (!banner) return;

    let snowContainer = document.querySelector('.snow-container');
    if (!snowContainer) {
        snowContainer = document.createElement('div');
        snowContainer.className = 'snow-container';
        const gameWrapper = banner.querySelector('.game-content-wrapper');
        if (gameWrapper) {
            gameWrapper.appendChild(snowContainer);
        } else {
            banner.appendChild(snowContainer);
        }
    }

    const snowflakeCount = cachedIsMobile ? 50 : 100;
    const containerHeight = snowContainer.offsetHeight || 360;
    const containerWidth = snowContainer.offsetWidth || 1200;

    for (let i = 0; i < snowflakeCount; i++) {
        createFallingSnowflake(snowContainer, containerHeight, containerWidth);
    }

    const landedCount = cachedIsMobile ? 15 : 30;
    for (let i = 0; i < landedCount; i++) {
        createLandedSnowflake(snowContainer, containerWidth);
    }
}

function createFallingSnowflake(container, containerHeight, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake falling';

    const size = Math.random() * 3 + 2;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    const maxDrift = WORLD.roadPPS * (containerHeight / 80);
    const maxDriftPercent = (maxDrift / containerWidth) * 100;
    const startX = Math.random() * (110 + maxDriftPercent) - 10;
    snowflake.style.left = `${startX}%`;

    const fallEndPercent = 0.65 + Math.random() * 0.30;
    const fallHeight = containerHeight * fallEndPercent;

    const fallSpeed = 80 + Math.random() * 70;
    const duration = fallHeight / fallSpeed;
    snowflake.style.animationDuration = `${duration}s`;

    snowflake.style.animationDelay = `${Math.random() * duration}s`;

    const driftDistance = -(WORLD.roadPPS * duration);
    snowflake.style.setProperty('--snow-drift', driftDistance);
    snowflake.style.setProperty('--snow-fall-height', fallHeight);

    container.appendChild(snowflake);
}

function createLandedSnowflake(container, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake landed';

    const size = Math.random() * 1.5 + 1.5;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    const bottomPercent = Math.random() * 32 + 1;
    snowflake.style.bottom = `${bottomPercent}%`;

    const zIndex = (GAME_CONFIG.rendering.zIndexBase - bottomPercent) | 0;
    snowflake.style.zIndex = zIndex;

    snowflake.style.left = `${80 + Math.random() * 40}%`;

    const driftDistance = -containerWidth * 1.5;
    const driftDuration = (containerWidth * 1.5) / WORLD.roadPPS;

    snowflake.style.setProperty('--drift-distance', driftDistance);
    snowflake.style.animationDuration = `${driftDuration}s`;

    snowflake.style.animationDelay = `${Math.random() * driftDuration}s`;

    snowflake.addEventListener('animationend', () => {
        snowflake.remove();
        createLandedSnowflake(container, containerWidth);
    });

    container.appendChild(snowflake);
}

// ---------------------------------------------------------------------------
// Outils de developpement — a retirer a la fin de la migration.
//
//   bannerDev.wipeDom()    efface tout le DOM du banner. La frame suivante doit
//                          le reconstruire a partir du seul snapshot courant :
//                          c'est le test de l'arrivant, joue en direct.
//   bannerDev.offline()    coupe la connexion pour de bon (mode degrade).
//   bannerDev.reconnect()  relance la connexion.
//   bannerDev.curtain(b)   baisse (true) ou leve (false) le rideau.
//   bannerDev.status(s)    force l'indicateur : connecting | online | offline.
//   bannerDev.clock()      ecart d'horloge estime avec le serveur.
// ---------------------------------------------------------------------------
const bannerDev = {
    wipeDom() {
        if (cachedContainer) cachedContainer.innerHTML = '';
        if (leaderboardState.container) leaderboardState.container.innerHTML = '';

        boxEls.length = 0;
        for (const id in kartEls) delete kartEls[id];
        for (const id in itemEls) delete itemEls[id];
        for (const id in ppEls) delete ppEls[id];
        for (const id in ppSlots) delete ppSlots[id];
        for (const id in ppAnimating) delete ppAnimating[id];

        initLeaderboard();
        domDirty = true;
        return 'DOM efface : la frame suivante doit tout reconstruire';
    },

    offline() {
        bannerNet.giveUp();
        return 'connexion coupee : decor seul, pastille rouge';
    },

    reconnect() {
        bannerNet.attempts = 0;
        bannerNet.connect();
        return 'reconnexion demandee';
    },

    curtain(down) {
        if (down) bannerLink.lowerCurtain(); else bannerLink.raiseCurtain();
        return down ? 'rideau baisse' : 'rideau leve';
    },

    status(state) {
        bannerLink.setStatus(state);
        return `etat affiche : ${state}`;
    },

    stats() {
        return {
            fps: perf.fps,
            frames: perf.frames,
            gel: perf.stalls,
            part_gelee: `${((perf.stalls / (perf.frames || 1)) * 100).toFixed(1)} %`,
            tampon: bannerNet.buffer.length,
            retard_de_rendu: `${RENDER_DELAY_MS} ms`
        };
    },

    clock() {
        const last = bannerNet.buffer[bannerNet.buffer.length - 1];
        const renderTime = getGameTime() - RENDER_DELAY_MS;

        return {
            ecart: `${Math.round(serverClockOffset)} ms`,
            cible: `${Math.round(targetClockOffset)} ms`,
            derive: `${Math.round(targetClockOffset - serverClockOffset)} ms`,
            mesures: bannerNet.rttSamples.map(s => `${s.rtt} ms`),
            tampon: bannerNet.buffer.length,
            // Ecart entre l'instant affiche et le dernier etat recu. Doit valoir
            // a peu pres -RENDER_DELAY_MS : franchement positif, le client rend
            // un futur qu'il n'a pas ; tres negatif, il rend un passe.
            retard: last ? `${Math.round(renderTime - last.ts)} ms` : 'aucun snapshot'
        };
    }
};

window.bannerDev = bannerDev;

// Au-dela de ce delai on ouvre le verrou des assets meme s'il en manque : mieux
// vaut un sprite qui arrive en retard qu'un banner masque.
const ASSETS_TIMEOUT_MS = 2500;

// Filet de securite : quoi qu'il arrive — serveur muet, images bloquees — le
// rideau se leve. Un bandeau cache est le seul echec vraiment visible.
const CURTAIN_FAILSAFE_MS = 5000;

document.addEventListener('DOMContentLoaded', () => {
    bannerLink.init();
    bannerLink.lowerCurtain();
    bannerLink.setStatus('connecting');

    Promise.race([
        preloadImages(),
        new Promise(resolve => setTimeout(resolve, ASSETS_TIMEOUT_MS))
    ]).then(() => bannerLink.open('assets'));

    setTimeout(() => bannerLink.raiseCurtain(), CURTAIN_FAILSAFE_MS);

    initScene();
    const _bannerEl = document.getElementById('bannerSection');
    if (!_bannerEl || _bannerEl.dataset.season === 'winter') initSnow();

    // La connexion part tout de suite, en parallele du chargement des images :
    // c'est elle qui met le plus de temps a fournir une scene affichable.
    bannerNet.connect();

    animate(0);

    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
