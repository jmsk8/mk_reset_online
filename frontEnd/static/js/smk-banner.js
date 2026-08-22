// Constantes de rendu du banner SMK.
//
// Uniquement de l'apparence : chemins d'assets, tailles en px, z-index,
// seuils mobile, animations. Les constantes qui decrivent le monde simule
// (vitesses, hitboxes, delais, distribution des objets) sont dans
// physics-config.js et sont lues via PHYS ci-dessous — elles viendront du
// serveur une fois la migration WSS terminee (docs/MIGRATION_BANNER_WSS.md).
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
        kartWidth: { pc: 100, mobile: 80 }

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

let globalTimeOffset = 0;
let pauseStartTime = 0;

let cachedBg = null;
let cachedFg = null;
let cachedIsSummerBanner = false;
let cachedContainer = null;
let cachedIsMobile = false;

const imageCache = {};

function getGameTime() {
    return Date.now() - globalTimeOffset;
}

const PH = (typeof BannerPhysics !== 'undefined') ? BannerPhysics : null;

// Constantes du monde simule (physics-config.js). Le client n'en lit qu'une
// poignee, listee ci-dessous par usage — c'est exactement ce que le serveur
// devra transmettre dans son `hello` une fois la migration WSS faite :
//   world.width / finishLineX / sunX / itemBoxX / itemBoxCount, road.minY /
//   road.maxY, speeds.roadPPS, orbit (geometrie), delays.hitDecelDuration +
//   delays.hitPauseDuration (duree de la toupie).
const PHYS = (typeof BannerPhysicsConfig !== 'undefined') ? BannerPhysicsConfig : null;

const rng = Math.random;

let worldState = {
    cameraX: 0,
    bgCameraX: 0,
    karts: [],
    kartsById: {},
    items: [],
    itemBoxes: [],
    finishLine: null,
    sun: null,
    nextSpawnTime: 0,
    cachedLeader: null,

    nextItemId: 1,
    previousRanking: [],
    lastLeaderboardUpdate: 0
};

const kartEls = {};
const itemEls = {};
const ppEls = {};

let leaderboardState = {
    container: null,
    slots: []
};

let lastFrameTime = 0;
let animationId = null;

function shuffleArray(array) {
    return PH.shuffleArray(array, rng);
}

function randomRange(min, max) {
    return PH.randomRange(rng, min, max);
}

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.innerWidth < GAME_CONFIG.rendering.mobileBreakpoint;
    return cachedIsMobile;
}

function getInitialKartSpeed(stats) {
    return PH.getInitialKartSpeed(rng, stats);
}

function getNewMomentumTarget(stats) {
    return PH.getNewMomentumTarget(rng, stats);
}

function getScreenPosition(worldX, cameraX, screenWidth) {
    const w = PHYS.world.width;
    const buffer = GAME_CONFIG.rendering.bufferZone;

    let rawDiff = worldX - cameraX;

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

function preloadImages() {
    for (let i = 1; i <= 3; i++) {
        const gImg = new Image();
        gImg.src = GAME_CONFIG.resources.paths.greenShell(i);
        imageCache[`greenShell_${i}`] = gImg;

        const rImg = new Image();
        rImg.src = GAME_CONFIG.resources.paths.redShell(i);
        imageCache[`redShell_${i}`] = rImg;
    }

    const banana = new Image();
    banana.src = GAME_CONFIG.resources.paths.banana;
    imageCache['banana'] = banana;

    const shroom = new Image();
    shroom.src = GAME_CONFIG.resources.paths.shroom;
    imageCache['shroom'] = shroom;

    const star = new Image();
    star.src = GAME_CONFIG.resources.paths.star;
    imageCache['star'] = star;

    GAME_CONFIG.resources.characters.forEach(charName => {
        const ppImg = new Image();
        ppImg.src = GAME_CONFIG.resources.paths.pp(charName);
        imageCache[`pp_${charName}`] = ppImg;

        // Toutes les orientations, sinon le premier tête-à-queue clignote
        // le temps que les frames se téléchargent.
        GAME_CONFIG.resources.kartDirections.forEach(dir => {
            const dirImg = new Image();
            dirImg.src = GAME_CONFIG.resources.paths.charFrame(charName, dir);
            imageCache[`kart_${charName}_${dir}`] = dirImg;
        });
    });
}

function getKartFrameSrc(charName, dir) {
    const cached = imageCache[`kart_${charName}_${dir}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.charFrame(charName, dir);
}

function initLeaderboard() {
    leaderboardState.container = document.getElementById('race-leaderboard');
    if (!leaderboardState.container) return;

    leaderboardState.container.innerHTML = '';
    leaderboardState.slots = [];

    const totalKarts = GAME_CONFIG.resources.characters.length;
    for (let i = 0; i < totalKarts; i++) {
        const slot = document.createElement('div');
        slot.className = 'leaderboard-slot';
        slot.dataset.slotIndex = i;
        leaderboardState.container.appendChild(slot);
        leaderboardState.slots.push(slot);
    }
}

function addKartToLeaderboard(kart) {
    if (!leaderboardState.container) return;
    const ppDiv = document.createElement('div');
    ppDiv.className = 'leaderboard-pp';
    ppDiv.dataset.kartId = kart.id;

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
    img.alt = kart.charName;
    ppDiv.appendChild(img);

    ppEls[kart.id] = ppDiv;

    leaderboardState.container.appendChild(ppDiv);

    setTimeout(() => {
        ppDiv.classList.add('visible');
    }, 50);
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

        setTimeout(() => {
            ppElement.classList.remove('overtaking', 'dropping');
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

function syncRoadAnimation() {
    const groundLayer = document.querySelector('.layer-ground');
    if (!groundLayer) return;

    const patternWidth = 80;
    const speed = PHYS.speeds.roadPPS;

    if (speed > 0) {
        const duration = patternWidth / speed;
        groundLayer.style.setProperty('--road-anim-duration', `${duration}s`);
    }
}

const boxEls = [];

function initWorld() {
    cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return;
    cachedContainer.innerHTML = '';

    updateMobileStatus();

    worldState.karts = [];
    worldState.kartsById = {};
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.cameraX = 0;
    worldState.bgCameraX = 0;
    worldState.nextSpawnTime = getGameTime() + 500;
    worldState.cachedLeader = null;
    worldState.nextItemId = 1;
    worldState.previousRanking = [];
    worldState.lastLeaderboardUpdate = 0;

    boxEls.length = 0;
    for (const id in kartEls) delete kartEls[id];
    for (const id in itemEls) delete itemEls[id];
    for (const id in ppEls) delete ppEls[id];

    syncRoadAnimation();
    initLeaderboard();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = {
            element: finishLineEl,
            worldX: PHYS.world.finishLineX
        };
    }

    const sunEl = document.querySelector('.layer-sun');
    if (sunEl) {
        // Solidaire du fond (bgCameraX), pas de la route.
        worldState.sun = {
            element: sunEl,
            worldX: PHYS.world.sunX
        };
    }

    const currentBoxSize = cachedIsMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const roadHeight = PHYS.road.maxY - PHYS.road.minY;

    for (let i = 0; i < PHYS.world.itemBoxCount; i++) {
        const boxDiv = document.createElement('div');
        boxDiv.classList.add('item-box');
        boxDiv.style.width = `${currentBoxSize}px`;
        boxDiv.style.height = `${currentBoxSize}px`;

        const boxY = PHYS.road.minY + (i * (roadHeight / (PHYS.world.itemBoxCount - 1)));
        boxDiv.style.bottom = `${boxY}%`;
        boxDiv.style.zIndex = getZIndex(boxY);

        cachedContainer.appendChild(boxDiv);
        boxEls.push(boxDiv);

        worldState.itemBoxes.push({
            worldX: PHYS.world.itemBoxX,
            y: boxY,
            active: true,
            reactivateTime: 0
        });
    }

    const shuffledChars = shuffleArray([...GAME_CONFIG.resources.characters]);
    const step = roadHeight / (shuffledChars.length - 1 || 1);

    shuffledChars.forEach((charName, index) => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('kart-container-moving');

        const verticalPos = PHYS.road.minY + (index * step);
        const startWorldX = 0;

        wrapper.style.bottom = `${verticalPos}%`;
        wrapper.style.zIndex = getZIndex(verticalPos);

        // Intercalaire dédié au miroir : snesBounce occupe déjà `transform`
        // sur l'img, on ne peut pas y empiler un scaleX(-1).
        const sprite = document.createElement('div');
        sprite.classList.add('kart-sprite');

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.char(charName);
        img.classList.add('kart-static-png');

        sprite.appendChild(img);
        wrapper.appendChild(sprite);
        cachedContainer.appendChild(wrapper);

        kartEls[index] = { wrapper, sprite, img };

        const stats = PHYS.characterStats[charName];
        const kart = {
            id: index,
            charName: charName,
            worldX: startWorldX,
            yPercent: verticalPos,
            totalDistance: 0,

            stats: stats,
            absoluteVelocity: getInitialKartSpeed(stats),
            momentum: randomRange(0.5, 0.8),
            momentumTarget: getNewMomentumTarget(stats),
            nextMomentumChange: Date.now() + randomRange(PHYS.speeds.momentumDriftMin, PHYS.speeds.momentumDriftMax),
            vy: 0,
            targetVy: 0,

            state: 'pending',
            rank: index + 1,

            aiState: 'cruising',
            originalLaneY: verticalPos,
            dodgeIntensity: 30,

            hitEndTime: 0,
            heldItem: null,
            throwTime: 0,
            pendingItemGrantTime: 0,

            boostEndTime: 0,
            starEndTime: 0,
            isInvincible: false,
            hitInvincibleUntil: 0,

            nextWanderTime: getGameTime() + randomRange(1000, 5000),
            wanderEndTime: 0,
            wanderVy: 0,

            lapCount: 0,
            hasPassedFinishLine: false,
            stopped: false,

            currentSpinFrame: 0
        };

        worldState.karts.push(kart);
        worldState.kartsById[index] = kart;
    });

    cachedBg = document.querySelector('.layer-scrolling-bg');
    cachedFg = document.querySelector('.layer-scrolling-fg');
    const _bannerElSeason = document.getElementById('bannerSection');
    cachedIsSummerBanner = !!_bannerElSeason && _bannerElSeason.dataset.season === 'summer';

    if (GAME_CONFIG.debugMode) initDebugHUD();
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

    const frame = (Math.floor(gameNow / GAME_CONFIG.visuals[childType].animSpeed) % 3) + 1;
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
    const orbit = PHYS.orbit;
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

function applyEvent(ev) {
    switch (ev.type) {
        case 'kartSpawned': {
            const kart = worldState.kartsById[ev.kartId];
            if (kart) addKartToLeaderboard(kart);
            break;
        }
        case 'spawnHeldItem': {
            const el = createHeldItemElement(ev.itemType, ev.holdPosition);
            itemEls[ev.itemId] = el.div;

            break;
        }
        case 'removeHeldItem':
        case 'killItem': {
            const el = itemEls[ev.itemId];
            if (el) { el.remove(); delete itemEls[ev.itemId]; }
            break;
        }
        case 'launchItem': {

            break;
        }
        case 'kartHit': {
            triggerPPHitAnimation(ev.kartId);
            break;
        }
        case 'starOn': {
            const els = kartEls[ev.kartId];
            if (els) els.wrapper.classList.add('star-active');
            if (ppEls[ev.kartId]) ppEls[ev.kartId].classList.add('pp-star-active');
            break;
        }
        case 'starOff': {
            const els = kartEls[ev.kartId];
            if (els) { els.wrapper.style.filter = 'none'; els.wrapper.classList.remove('star-active'); }
            if (ppEls[ev.kartId]) ppEls[ev.kartId].classList.remove('pp-star-active');
            break;
        }
        case 'leaderboardPosition': {
            applyLeaderboardPosition(ev.kartId, ev.newPosition, ev.prevPosition);
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

    const hitDuration = PHYS.delays.hitDecelDuration + PHYS.delays.hitPauseDuration;
    const spinDuration = hitDuration * GAME_CONFIG.kartSpin.durationRatio;
    const elapsed = gameNow - (kart.hitEndTime - hitDuration);
    if (elapsed <= 0 || elapsed >= spinDuration) return 0;

    const frameCount = GAME_CONFIG.kartSpin.frames.length;
    return Math.floor((elapsed / spinDuration) * GAME_CONFIG.kartSpin.turns * frameCount) % frameCount;
}

function applyKartSpinFrame(kart, els) {
    const frame = GAME_CONFIG.kartSpin.frames[kart.currentSpinFrame];
    els.img.src = getKartFrameSrc(kart.charName, frame.dir);
    els.sprite.classList.toggle('kart-mirrored', frame.mirror);
}

function renderState(gameNow, screenWidth) {
    const renderMargin = GAME_CONFIG.rendering.bufferZone;

    if (cachedBg) {
        // Été : parallaxe, moitié vitesse.
        const bgX = cachedIsSummerBanner ? worldState.bgCameraX : worldState.cameraX;
        cachedBg.style.backgroundPosition = `-${bgX}px 0px`;
    } else {
        cachedBg = document.querySelector('.layer-scrolling-bg');
    }

    if (cachedFg) {
        // Décor de premier plan (été uniquement) : même vitesse que la route.
        const fgX = worldState.cameraX % PHYS.world.width;
        cachedFg.style.backgroundPosition = `-${fgX}px 0px`;
    } else {
        cachedFg = document.querySelector('.layer-scrolling-fg');
    }

    if (worldState.finishLine && worldState.finishLine.element) {
        const rx = getScreenPosition(worldState.finishLine.worldX, worldState.cameraX, screenWidth);
        worldState.finishLine.element.style.transform = `translate3d(${rx}px, 0, 0)`;
    }

    if (worldState.sun && worldState.sun.element) {
        // Solidaire du fond, pas de la route.
        const sx = getScreenPosition(worldState.sun.worldX, worldState.bgCameraX, screenWidth);
        worldState.sun.element.style.transform = `translate3d(${sx}px, 0, 0)`;
    }

    const boxesLen = worldState.itemBoxes.length;
    const floatY = Math.sin(gameNow * GAME_CONFIG.rendering.boxFloat.speed) * GAME_CONFIG.rendering.boxFloat.amplitude;
    for (let i = 0; i < boxesLen; i++) {
        const box = worldState.itemBoxes[i];
        const el = boxEls[i];
        if (!el) continue;
        if (!box.active) { el.style.display = 'none'; continue; }

        const rx = getScreenPosition(box.worldX, worldState.cameraX, screenWidth);
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

        if (kart.state === 'pending') {
            wrapper.style.display = 'none';
            hideHeldItem(kart);
            continue;
        }

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

        const rx = getScreenPosition(kart.worldX, worldState.cameraX, screenWidth);
        const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

        if (isVisibleNow) {
            wrapper.style.display = 'block';
            wrapper.style.transform = `translate3d(${rx}px, 0, 0)`;
            wrapper.style.bottom = `${kart.yPercent}%`;

            const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
            if (wrapper.style.zIndex != zVal) wrapper.style.zIndex = zVal;

            const spinFrame = getSpinFrameIndex(kart, gameNow);
            if (kart.currentSpinFrame !== spinFrame) {
                kart.currentSpinFrame = spinFrame;
                applyKartSpinFrame(kart, els);
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

        const rx = getScreenPosition(item.worldX, worldState.cameraX, screenWidth);
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

function animate(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    let deltaTime = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    if (deltaTime > 0.1) deltaTime = 0.016;

    const gameNow = getGameTime();
    updateMobileStatus();

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    if (cachedContainer) {
        let screenWidth = cachedContainer.offsetWidth;
        if (cachedIsMobile) {
            screenWidth = screenWidth / GAME_CONFIG.rendering.mobileScale;
        }

        const events = PH.stepPhysics(PHYS, worldState, rng, gameNow, deltaTime);

        for (let e = 0; e < events.length; e++) applyEvent(events[e]);

        renderState(gameNow, screenWidth);
    }

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
    const finishPct = (PHYS.world.finishLineX / PHYS.world.width) * 100;
    finishLine.style.left = `${finishPct}%`;
    hud.appendChild(finishLine);

    worldState.itemBoxes.forEach((box, i) => {
        const dBox = document.createElement('div');
        dBox.className = 'debug-entity debug-itembox';
        dBox.id = `debug-box-${i}`;
        const bPct = (box.worldX / PHYS.world.width) * 100;
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

    const worldW = PHYS.world.width;
    const camX = worldState.cameraX;

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
            const kPct = (kart.worldX / PHYS.world.width) * 100;
            el.style.left = `${kPct}%`;
            el.style.backgroundColor = (kart.state === 'hit') ? 'red' : 'blue';
            if (kart.state === 'pending') el.style.backgroundColor = 'gray';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        }
    });

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        // Meme reference que la physique : rollItem() mesure l'ecart au premier
        // via cachedLeader et totalDistance, jamais via worldX. Trier ici sur
        // autre chose afficherait des ecarts incoherents avec le tirage d'items.
        const leader = worldState.cachedLeader;
        const sortedKarts = [...worldState.karts]
            .filter(k => k.state !== 'pending')
            .sort((a, b) => b.totalDistance - a.totalDistance);

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            const laps = kart.lapCount;
            const gap = (leader && leader.id !== kart.id)
                ? `${Math.round(leader.totalDistance - kart.totalDistance)}px`
                : '\u2014';
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps} \u00B7 ${gap}</span></div>`;
        }).join('');
    }
}

function handleVisibilityChange() {
    const pauseOverlay = document.getElementById('pause-overlay');

    if (document.hidden) {
        if (animationId) cancelAnimationFrame(animationId);

        pauseStartTime = Date.now();

        if (pauseOverlay) pauseOverlay.style.display = 'flex';

    } else {
        if (pauseStartTime > 0) {
            const pauseDuration = Date.now() - pauseStartTime;

            globalTimeOffset += pauseDuration;

            pauseStartTime = 0;
        }

        if (pauseOverlay) pauseOverlay.style.display = 'none';

        lastFrameTime = 0;
        animationId = requestAnimationFrame(animate);
    }
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

    const maxDrift = PHYS.speeds.roadPPS * (containerHeight / 80);
    const maxDriftPercent = (maxDrift / containerWidth) * 100;
    const startX = Math.random() * (110 + maxDriftPercent) - 10;
    snowflake.style.left = `${startX}%`;

    const fallEndPercent = 0.65 + Math.random() * 0.30;
    const fallHeight = containerHeight * fallEndPercent;

    const fallSpeed = 80 + Math.random() * 70;
    const duration = fallHeight / fallSpeed;
    snowflake.style.animationDuration = `${duration}s`;

    snowflake.style.animationDelay = `${Math.random() * duration}s`;

    const driftDistance = -(PHYS.speeds.roadPPS * duration);
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
    const driftDuration = (containerWidth * 1.5) / PHYS.speeds.roadPPS;

    snowflake.style.setProperty('--drift-distance', driftDistance);
    snowflake.style.animationDuration = `${driftDuration}s`;

    snowflake.style.animationDelay = `${Math.random() * driftDuration}s`;

    snowflake.addEventListener('animationend', () => {
        snowflake.remove();
        createLandedSnowflake(container, containerWidth);
    });

    container.appendChild(snowflake);
}

document.addEventListener('DOMContentLoaded', () => {
    preloadImages();
    initWorld();
    const _bannerEl = document.getElementById('bannerSection');
    if (!_bannerEl || _bannerEl.dataset.season === 'winter') initSnow();
    animate(0);
    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
