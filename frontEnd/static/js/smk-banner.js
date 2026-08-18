const GAME_CONFIG = {
    debugMode: false,

    resources: {
        characters: ['mario', 'luigi', 'peach', 'toad', 'yoshi', 'bowser', 'dk', 'koopa'],
        initials: { 'mario': 'M', 'luigi': 'L', 'peach': 'P', 'toad': 'T', 'yoshi': 'Y', 'bowser': 'B', 'dk': 'D', 'koopa': 'K' },
        paths: {
            char: (name) => `static/img/${name}/${name}-static.png`,
            pp: (name) => `static/img/${name}/${name}-pp.png`,
            greenShell: (frame) => `static/img/green-shell/green-shell${frame}.png`,
            redShell: (frame) => `static/img/red-shell/red-shell${frame}.png`,
            banana: 'static/img/banana.png',
            shroom: 'static/img/shroom.png',
            star: 'static/img/star.png'
        }
    },
    characterStats: {
        mario:  { topSpeed: 510, acceleration: 1.0,  handling: 1.0,  weight: 1.0  },
        luigi:  { topSpeed: 505, acceleration: 1.05, handling: 1.05, weight: 0.95 },
        peach:  { topSpeed: 495, acceleration: 1.15, handling: 1.2,  weight: 0.8  },
        toad:   { topSpeed: 490, acceleration: 1.3,  handling: 1.3,  weight: 0.7  },
        yoshi:  { topSpeed: 500, acceleration: 1.1,  handling: 1.15, weight: 0.85 },
        bowser: { topSpeed: 530, acceleration: 0.7,  handling: 0.7,  weight: 1.4  },
        dk:     { topSpeed: 525, acceleration: 0.75, handling: 0.8,  weight: 1.3  },
        koopa:  { topSpeed: 485, acceleration: 1.25, handling: 1.25, weight: 0.75 }
    },
    world: {
        width: 3840,
        finishLineX: 1440,
        sunX: 1920,
        itemBoxX: 3456,
        itemBoxCount: 4
    },
    rendering: {
        bufferZone: 200,
        zIndexBase: 400,
        mobileBreakpoint: 769,
        mobileScale: 0.6
    },
    road: {
        minY: 0,
        maxY: 30,
        laneTolerance: 12,
        edgeSafetyMargin: 2,
        overtakeMargin: 5,
        wanderMargin: 8
    },
    physics: {
        smoothingFactor: 5,
        pushForce: 0.5,
        collisionBounceY: 10,
        floatAmplitude: 10,
        floatSpeed: 0.003
    },
    speeds: {
        roadPPS: 250,

        momentumMinRatio: 0.78,
        momentumChangeSpeed: 0.25,
        momentumDriftMin: 3000,
        momentumDriftMax: 7000,
        accelerationRate: 150,

        projectileSpeed: 750,
        redShellSpeed: 700,
        redShellTrackingSpeed: 8,

        shroomBoost: 250,
        shroomDuration: 1500,

        starSpeedMultiplier: 1.4,
        starDurationMin: 4000,
        starDurationMax: 10000,

        returnLane: 20,
        shellVertical: 1.5
    },
    offsets: {
        heldItemBehind: { pc: -50, mobile: -35 },
        heldItemHands: { x: { pc: 28, mobile: 18 }, yShift: { pc: 30, mobile: 25 } },
        shellSpawn: { pc: 50, mobile: 35 }
    },
    delays: {
        hitDecelDuration: 1500,
        hitPauseDuration: 500,
        boxRespawn: 1000,
        itemGrant: 3000,
        bananaLife: 40000,
        invincibilityOwnItem: 2000,
        invincibilityAfterHit: 2000,
        throwDelayAfterHit: 1000,
        spawnMin: 150,
        spawnMax: 800
    },
    itemDistribution: {
        leaderTier: { weights: { banana: 75, greenShell: 25, redShell: 0,  shroom: 0,  star: 0  } },
        starMinDistTop: 3000,
        starMinDistMid: 2000,
        tiers: [
            { maxDistance: 250,   weights: { banana: 55, greenShell: 35, redShell: 10, shroom: 0,  star: 0  } },
            { maxDistance: 600,   weights: { banana: 20, greenShell: 30, redShell: 40, shroom: 10, star: 0  } },
            { maxDistance: 1500,  weights: { banana: 10, greenShell: 15, redShell: 35, shroom: 40, star: 0  } },
            { maxDistance: 2500,  weights: { banana: 0,  greenShell: 5,  redShell: 15, shroom: 55, star: 25 } },
            { maxDistance: Infinity, weights: { banana: 0,  greenShell: 0,  redShell: 5,  shroom: 45, star: 50 } }
        ]
    },
    ai: {
        holdItemMin: 500, holdItemMax: 8000,
        detectionRange: 250, dodgeIntensityMin: 20, dodgeIntensityMax: 50,
        overtakeDetectionRange: 120, overtakeMinDistance: 12, overtakeSideSpeed: 10,
        boxDetectionRange: 400, boxSeekIntensity: 25,
        wanderIntervalMin: 2000, wanderIntervalMax: 6000,
        wanderDurationMin: 500, wanderDurationMax: 1500, wanderSpeed: 4
    },
    hitboxes: {
        kartVsKart: { x: 60, y: 5 },
        itemVsKart: { x: 40, y: 5 },
        itemBox: { x: 10, y: 8 }
    },
    visuals: {
        greenShell: { width: 48, widthMobile: 32, animSpeed: 100 },
        redShell: { width: 48, widthMobile: 32, animSpeed: 100 },
        banana: { width: 32, widthMobile: 28 },
        shroom: { width: 36, widthMobile: 26 },
        star: { width: 36, widthMobile: 26 },
        box: { sizePC: 42, sizeMobile: 42 }
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
    const w = GAME_CONFIG.world.width;
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
    });
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
    const speed = GAME_CONFIG.speeds.roadPPS;

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
            worldX: GAME_CONFIG.world.finishLineX
        };
    }

    const sunEl = document.querySelector('.layer-sun');
    if (sunEl) {
        // Solidaire du fond (bgCameraX), pas de la route.
        worldState.sun = {
            element: sunEl,
            worldX: GAME_CONFIG.world.sunX
        };
    }

    const currentBoxSize = cachedIsMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const roadHeight = GAME_CONFIG.road.maxY - GAME_CONFIG.road.minY;

    for (let i = 0; i < GAME_CONFIG.world.itemBoxCount; i++) {
        const boxDiv = document.createElement('div');
        boxDiv.classList.add('item-box');
        boxDiv.style.width = `${currentBoxSize}px`;
        boxDiv.style.height = `${currentBoxSize}px`;

        const boxY = GAME_CONFIG.road.minY + (i * (roadHeight / (GAME_CONFIG.world.itemBoxCount - 1)));
        boxDiv.style.bottom = `${boxY}%`;
        boxDiv.style.zIndex = getZIndex(boxY);

        cachedContainer.appendChild(boxDiv);
        boxEls.push(boxDiv);

        worldState.itemBoxes.push({
            worldX: GAME_CONFIG.world.itemBoxX,
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

        const verticalPos = GAME_CONFIG.road.minY + (index * step);
        const startWorldX = 0;

        wrapper.style.bottom = `${verticalPos}%`;
        wrapper.style.zIndex = getZIndex(verticalPos);

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.char(charName);
        img.classList.add('kart-static-png');

        wrapper.appendChild(img);
        cachedContainer.appendChild(wrapper);

        kartEls[index] = { wrapper, img };

        const stats = GAME_CONFIG.characterStats[charName];
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
            nextMomentumChange: Date.now() + randomRange(GAME_CONFIG.speeds.momentumDriftMin, GAME_CONFIG.speeds.momentumDriftMax),
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

            currentFilter: 'none'
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
        const fgX = worldState.cameraX % GAME_CONFIG.world.width;
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
    const floatY = Math.sin(gameNow * GAME_CONFIG.physics.floatSpeed) * GAME_CONFIG.physics.floatAmplitude;
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
            if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].style.display = 'none';
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

            const targetFilter = (kart.state === 'hit') ? 'hit' : 'none';
            if (kart.currentFilter !== targetFilter) {
                kart.currentFilter = targetFilter;
                wrapper.style.filter = targetFilter === 'hit'
                    ? 'brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)'
                    : 'none';
            }

            if (kart.heldItem) {
                const hel = itemEls[kart.heldItem.id];
                if (hel) {
                    hel.style.display = 'block';
                    const hx = rx + kart.heldItem.offset;
                    const hy = kart.heldItem.yShift || 0;
                    hel.style.transform = `translate3d(${hx}px, ${-hy}px, 0)`;
                    hel.style.bottom = `${kart.yPercent}%`;
                    const itemZ = kart.heldItem.holdPosition === 'hands' ? zVal + 1 : zVal;
                    if (hel.style.zIndex != itemZ) hel.style.zIndex = itemZ;
                }
            }
        } else {
            wrapper.style.display = 'none';
            if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].style.display = 'none';
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

        const events = PH.stepPhysics(GAME_CONFIG, worldState, rng, gameNow, deltaTime, cachedIsMobile);

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
    const finishPct = (GAME_CONFIG.world.finishLineX / GAME_CONFIG.world.width) * 100;
    finishLine.style.left = `${finishPct}%`;
    hud.appendChild(finishLine);

    worldState.itemBoxes.forEach((box, i) => {
        const dBox = document.createElement('div');
        dBox.className = 'debug-entity debug-itembox';
        dBox.id = `debug-box-${i}`;
        const bPct = (box.worldX / GAME_CONFIG.world.width) * 100;
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
        min-width: 120px;
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

    const worldW = GAME_CONFIG.world.width;
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
            const kPct = (kart.worldX / GAME_CONFIG.world.width) * 100;
            el.style.left = `${kPct}%`;
            el.style.backgroundColor = (kart.state === 'hit') ? 'red' : 'blue';
            if (kart.state === 'pending') el.style.backgroundColor = 'gray';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        }
    });

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        const sortedKarts = [...worldState.karts]
            .filter(k => k.state !== 'pending')
            .sort((a, b) => {
                if (b.lapCount !== a.lapCount) return b.lapCount - a.lapCount;
                return b.worldX - a.worldX;
            });

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            const laps = kart.lapCount;
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps}</span></div>`;
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

    const maxDrift = GAME_CONFIG.speeds.roadPPS * (containerHeight / 80);
    const maxDriftPercent = (maxDrift / containerWidth) * 100;
    const startX = Math.random() * (110 + maxDriftPercent) - 10;
    snowflake.style.left = `${startX}%`;

    const fallEndPercent = 0.65 + Math.random() * 0.30;
    const fallHeight = containerHeight * fallEndPercent;

    const fallSpeed = 80 + Math.random() * 70;
    const duration = fallHeight / fallSpeed;
    snowflake.style.animationDuration = `${duration}s`;

    snowflake.style.animationDelay = `${Math.random() * duration}s`;

    const driftDistance = -(GAME_CONFIG.speeds.roadPPS * duration);
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
    const driftDuration = (containerWidth * 1.5) / GAME_CONFIG.speeds.roadPPS;

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
