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

// === VARIABLES GLOBALES ===

let globalTimeOffset = 0;
let pauseStartTime = 0;

let cachedBg = null;
let cachedContainer = null;
let cachedIsMobile = false;

const imageCache = {};

function getGameTime() {
    return Date.now() - globalTimeOffset;
}

let worldState = {
    cameraX: 0,
    karts: [],
    kartsById: {},
    items: [],
    itemBoxes: [],
    finishLine: null,
    nextSpawnTime: 0,
    cachedLeader: null
};

let leaderboardState = {
    container: null,
    slots: [],
    previousRanking: [],
    lastUpdateTime: 0
};

let lastFrameTime = 0;
let animationId = null;

// === UTILITAIRES ===

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function randomRange(min, max) {
    return Math.random() * (max - min) + min;
}

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.innerWidth < GAME_CONFIG.rendering.mobileBreakpoint;
    return cachedIsMobile;
}

function getInitialKartSpeed(stats) {
    const variation = randomRange(0.85, 0.95);
    return stats.topSpeed * variation;
}

function getNewMomentumTarget(stats) {
    const weightFactor = Math.min(stats.weight / 1.4, 1.0);
    const minMomentum = 0.55 - weightFactor * 0.15;
    return randomRange(minMomentum, 1.0);
}

function getMomentumSpeed(stats, momentum) {
    const minRatio = GAME_CONFIG.speeds.momentumMinRatio;
    return stats.topSpeed * (minRatio + (1.0 - minRatio) * momentum);
}

function getShortestDistance(fromX, toX) {
    const w = GAME_CONFIG.world.width;
    let diff = fromX - toX;
    if (diff < -w * 0.5) diff += w;
    if (diff > w * 0.5) diff -= w;
    return diff;
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

// === INITIALISATION ===

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
    leaderboardState.previousRanking = [];

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

    kart.leaderboardPP = ppDiv;
    kart.leaderboardPosition = -1;

    leaderboardState.container.appendChild(ppDiv);

    setTimeout(() => {
        ppDiv.classList.add('visible');
    }, 50);
}

function getKartScore(kart) {
    return kart.totalDistance;
}

function updateLeaderboard(gameNow) {
    if (!leaderboardState.container) return;
    if (gameNow - leaderboardState.lastUpdateTime < 500) return;
    leaderboardState.lastUpdateTime = gameNow;

    const karts = worldState.karts;
    const kartsLen = karts.length;

    const activeKarts = [];
    for (let i = 0; i < kartsLen; i++) {
        const k = karts[i];
        if (k.state === 'running' || k.state === 'hit') activeKarts.push(k);
    }
    if (activeKarts.length === 0) return;

    activeKarts.sort((a, b) => b.totalDistance - a.totalDistance);

    worldState.cachedLeader = activeKarts[0];

    const newRanking = [];
    const prevRanking = leaderboardState.previousRanking;

    for (let i = 0; i < activeKarts.length; i++) {
        const kart = activeKarts[i];
        const newPosition = i;
        kart.rank = newPosition + 1;
        newRanking.push(kart.id);

        if (!kart.leaderboardPP) continue;

        const prevPosition = prevRanking.indexOf(kart.id);
        const ppElement = kart.leaderboardPP;

        ppElement.classList.remove('overtaking', 'dropping');

        if (prevPosition !== -1 && prevPosition !== newPosition) {
            if (newPosition < prevPosition) {
                ppElement.classList.add('overtaking');
            } else {
                ppElement.classList.add('dropping');
            }

            setTimeout(() => {
                ppElement.classList.remove('overtaking', 'dropping');
                positionPPInSlot(kart, newPosition);
            }, 400);
        } else {
            positionPPInSlot(kart, newPosition);
        }

        kart.leaderboardPosition = newPosition;
    }

    leaderboardState.previousRanking = newRanking;
}

function positionPPInSlot(kart, slotIndex) {
    if (!kart.leaderboardPP || slotIndex >= leaderboardState.slots.length) return;

    const ppElement = kart.leaderboardPP;

    const slotWidth = cachedIsMobile ? 32 : 46;
    const totalSlots = leaderboardState.slots.length;
    const reversedIndex = (totalSlots - 1) - slotIndex;
    const xPos = reversedIndex * slotWidth;

    ppElement.style.top = '0px';
    ppElement.style.left = `${xPos}px`;
}

function triggerPPHitAnimation(kart) {
    if (!kart.leaderboardPP) return;

    const ppElement = kart.leaderboardPP;
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

function initWorld() {
    cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return;
    cachedContainer.innerHTML = '';
    
    updateMobileStatus();
    
    worldState.karts = [];
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.cameraX = 0;
    worldState.nextSpawnTime = getGameTime() + 500;

    syncRoadAnimation();
    initLeaderboard();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = {
            element: finishLineEl,
            worldX: GAME_CONFIG.world.finishLineX
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
        
        worldState.itemBoxes.push({
            element: boxDiv,
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

        const stats = GAME_CONFIG.characterStats[charName];
        worldState.karts.push({
            id: index,
            charName: charName,
            element: wrapper,
            imgElement: img,
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
            currentFilter: 'none'
        });

        worldState.kartsById[index] = worldState.karts[worldState.karts.length - 1];
    });

    cachedBg = document.querySelector('.layer-scrolling-bg');

    if (GAME_CONFIG.debugMode) initDebugHUD();
}

// === LOGIQUE DE JEU & IA ===

function handleSpawns(now) {
    if (now > worldState.nextSpawnTime) {
        const pendingKart = worldState.karts.find(k => k.state === 'pending');
        if (pendingKart) {
            pendingKart.state = 'running';
            pendingKart.absoluteVelocity = getInitialKartSpeed(pendingKart.stats);

            addKartToLeaderboard(pendingKart);

            const delay = randomRange(GAME_CONFIG.delays.spawnMin, GAME_CONFIG.delays.spawnMax);
            worldState.nextSpawnTime = now + delay;
        }
    }
}

function updateAI(kart, deltaTime) {
    if (kart.state !== 'running') return;

    const now = getGameTime();
    let dangerFound = false;
    let avoidDirection = 0;

    const handling = kart.stats.handling;
    const itemsLen = worldState.items.length;
    for (let i = 0; i < itemsLen; i++) {
        const item = worldState.items[i];
        if (item.isDead) continue;

        const isBanana = (item.type === 'banana');
        const isShell = (item.type === 'greenShell' || item.type === 'redShell');
        if (!isBanana && !isShell) continue;

        let dist = getShortestDistance(item.worldX, kart.worldX);
        const detectionRange = GAME_CONFIG.ai.detectionRange * (isShell ? 1.5 : 1.0);

        if (dist > 0 && dist < detectionRange) {
             if (Math.abs(item.y - kart.yPercent) < GAME_CONFIG.road.laneTolerance) {
                dangerFound = true;
                let naturalDir = (item.y > kart.yPercent) ? -1 : 1;
                if (naturalDir === 1) avoidDirection = (kart.yPercent > GAME_CONFIG.road.maxY - GAME_CONFIG.road.edgeSafetyMargin) ? -1 : 1;
                else avoidDirection = (kart.yPercent < GAME_CONFIG.road.minY + GAME_CONFIG.road.edgeSafetyMargin) ? 1 : -1;
                break;
            }
        }
    }

    if (dangerFound) {
        if (kart.aiState !== 'dodging') {
            kart.aiState = 'dodging';
            kart.originalLaneY = kart.yPercent;
            kart.dodgeIntensity = randomRange(
                GAME_CONFIG.ai.dodgeIntensityMin * handling,
                GAME_CONFIG.ai.dodgeIntensityMax * handling
            );
        }
        kart.targetVy = avoidDirection * kart.dodgeIntensity;
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * handling * deltaTime;
        return;
    }

    let overtakeFound = false;
    const kartsLen = worldState.karts.length;
    for (let i = 0; i < kartsLen; i++) {
        const other = worldState.karts[i];
        if (other.id === kart.id || other.state !== 'running') continue;

        let dist = getShortestDistance(other.worldX, kart.worldX);
        const distY = Math.abs(other.yPercent - kart.yPercent);

        if (dist > 0 && dist < GAME_CONFIG.ai.overtakeDetectionRange && distY < GAME_CONFIG.ai.overtakeMinDistance) {
            overtakeFound = true;
            let dir = (kart.yPercent > other.yPercent) ? 1 : -1;
            if (kart.yPercent > GAME_CONFIG.road.maxY - GAME_CONFIG.road.overtakeMargin) dir = -1;
            if (kart.yPercent < GAME_CONFIG.road.minY + GAME_CONFIG.road.overtakeMargin) dir = 1;
            kart.targetVy = dir * GAME_CONFIG.ai.overtakeSideSpeed * handling;
            break;
        }
    }

    if (overtakeFound) {
        kart.originalLaneY = kart.yPercent;
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * handling * deltaTime;
        return;
    }

    let boxTargetFound = false;
    if (!kart.heldItem) {
        const boxesLen = worldState.itemBoxes.length;
        for (let i = 0; i < boxesLen; i++) {
            const box = worldState.itemBoxes[i];
            if (!box.active) continue;
            let dist = getShortestDistance(box.worldX, kart.worldX);
            if (dist > 0 && dist < GAME_CONFIG.ai.boxDetectionRange) {
                const diffY = box.y - kart.yPercent;
                if (Math.abs(diffY) > 2) {
                    kart.targetVy = ((diffY > 0) ? GAME_CONFIG.ai.boxSeekIntensity : -GAME_CONFIG.ai.boxSeekIntensity) * handling;
                    boxTargetFound = true;
                    break;
                }
            }
        }
    }

    if (boxTargetFound) {
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * handling * deltaTime;
        return;
    }

    if (now > kart.nextWanderTime) {
        kart.nextWanderTime = now + randomRange(GAME_CONFIG.ai.wanderIntervalMin, GAME_CONFIG.ai.wanderIntervalMax);
        kart.wanderEndTime = now + randomRange(GAME_CONFIG.ai.wanderDurationMin, GAME_CONFIG.ai.wanderDurationMax);
        let dir = (Math.random() > 0.5) ? 1 : -1;
        if (kart.yPercent > GAME_CONFIG.road.maxY - GAME_CONFIG.road.wanderMargin) dir = -1;
        if (kart.yPercent < GAME_CONFIG.road.minY + GAME_CONFIG.road.wanderMargin) dir = 1;
        kart.wanderVy = dir * GAME_CONFIG.ai.wanderSpeed * handling;
    }

    if (now < kart.wanderEndTime) {
        kart.targetVy = kart.wanderVy;
        kart.originalLaneY = kart.yPercent;
    } else {
        if (kart.aiState === 'dodging') {
            const diff = kart.originalLaneY - kart.yPercent;
            if (Math.abs(diff) < 1) {
                kart.targetVy = 0;
                kart.yPercent = kart.originalLaneY;
                kart.aiState = 'cruising';
            } else {
                kart.targetVy = (diff > 0 ? 1 : -1) * GAME_CONFIG.speeds.returnLane * handling;
            }
        } else {
            kart.targetVy = 0;
            kart.aiState = 'cruising';
        }
    }

    kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * handling * deltaTime;
}

// === GESTION DES ITEMS ===

function getDistanceToLeader(kart) {
    const leader = worldState.cachedLeader;
    if (!leader || leader.id === kart.id) return 0;
    return leader.totalDistance - kart.totalDistance;
}

function rollItem(kart) {
    const distToLeader = getDistanceToLeader(kart);
    const itemDist = GAME_CONFIG.itemDistribution;
    const tiers = itemDist.tiers;

    let tier;
    if (kart.rank === 1) {
        tier = itemDist.leaderTier;
    } else {
        tier = tiers.find(t => distToLeader <= t.maxDistance) || tiers[tiers.length - 1];
    }

    const totalKarts = worldState.karts.length;
    const isLastTwo = kart.rank >= totalKarts - 1;
    let canGetStar = false;
    if (kart.rank === 1) {
        canGetStar = false;
    } else if (kart.rank <= 3) {
        canGetStar = distToLeader >= itemDist.starMinDistTop;
    } else if (isLastTwo) {
        canGetStar = true;
    } else {
        canGetStar = distToLeader >= itemDist.starMinDistMid;
    }

    const weights = {};
    for (const key in tier.weights) {
        weights[key] = (key === 'star' && !canGetStar) ? 0 : tier.weights[key];
    }

    const total = Object.values(weights).reduce((s, w) => s + w, 0);
    let roll = Math.random() * total;

    for (const [itemType, weight] of Object.entries(weights)) {
        roll -= weight;
        if (roll <= 0) return itemType;
    }
    return 'banana';
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

function giveKartItem(kart) {
    if (kart.heldItem) return;

    const itemType = rollItem(kart);

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';

    const img = document.createElement('img');
    img.style.width = '100%';

    const visual = getItemVisualConfig(itemType);
    itemDiv.style.width = `${visual.size}px`;
    img.src = visual.src;

    let offset;
    let yShift = 0;
    if (visual.holdPosition === 'hands') {
        itemDiv.classList.add('held-item-bouncing');
        offset = cachedIsMobile ? GAME_CONFIG.offsets.heldItemHands.x.mobile : GAME_CONFIG.offsets.heldItemHands.x.pc;
        yShift = cachedIsMobile ? GAME_CONFIG.offsets.heldItemHands.yShift.mobile : GAME_CONFIG.offsets.heldItemHands.yShift.pc;
    } else {
        offset = cachedIsMobile ? GAME_CONFIG.offsets.heldItemBehind.mobile : GAME_CONFIG.offsets.heldItemBehind.pc;
    }

    itemDiv.appendChild(img);
    cachedContainer.appendChild(itemDiv);

    kart.heldItem = {
        type: itemType,
        element: itemDiv,
        imgElement: img,
        offset: offset,
        yShift: yShift,
        holdPosition: visual.holdPosition
    };

    kart.throwTime = getGameTime() + randomRange(GAME_CONFIG.ai.holdItemMin, GAME_CONFIG.ai.holdItemMax);
}

function getKartByRank(rank) {
    return worldState.karts.find(k => k.rank === rank && (k.state === 'running' || k.state === 'hit')) || null;
}

function activateItem(kart) {
    const held = kart.heldItem;
    if (!held) return;

    const gameNow = getGameTime();

    if (held.type === 'shroom') {
        kart.boostEndTime = gameNow + GAME_CONFIG.speeds.shroomDuration;
        kart.absoluteVelocity = kart.stats.topSpeed;
        kart.momentum = 1.0;
        held.element.remove();
        kart.heldItem = null;
        return;
    }

    if (held.type === 'star') {
        const totalKarts = worldState.karts.length;
        const rankRatio = (kart.rank - 1) / Math.max(totalKarts - 1, 1);
        const starDur = GAME_CONFIG.speeds.starDurationMin + rankRatio * (GAME_CONFIG.speeds.starDurationMax - GAME_CONFIG.speeds.starDurationMin);
        kart.starEndTime = gameNow + starDur;
        kart.isInvincible = true;
        kart.absoluteVelocity = kart.stats.topSpeed;
        kart.momentum = 1.0;
        kart.element.classList.add('star-active');
        if (kart.leaderboardPP) kart.leaderboardPP.classList.add('pp-star-active');
        held.element.remove();
        kart.heldItem = null;
        return;
    }

    let startX = kart.worldX + held.offset;
    if (held.type === 'greenShell' || held.type === 'redShell') {
        const shellOffset = cachedIsMobile ? GAME_CONFIG.offsets.shellSpawn.mobile : GAME_CONFIG.offsets.shellSpawn.pc;
        startX = kart.worldX + shellOffset;
    }

    let itemAbsVelX = 0;
    let vy = 0;
    let targetKartId = null;

    if (held.type === 'banana') {
        itemAbsVelX = 0;
    } else if (held.type === 'greenShell') {
        itemAbsVelX = GAME_CONFIG.speeds.projectileSpeed;
        vy = randomRange(-GAME_CONFIG.speeds.shellVertical, GAME_CONFIG.speeds.shellVertical);
    } else if (held.type === 'redShell') {
        itemAbsVelX = GAME_CONFIG.speeds.redShellSpeed;
        const targetRank = kart.rank - 1;
        const target = getKartByRank(targetRank);
        if (target) {
            targetKartId = target.id;
        } else {
            vy = randomRange(-GAME_CONFIG.speeds.shellVertical, GAME_CONFIG.speeds.shellVertical);
        }
    }

    const newItem = {
        type: held.type,
        element: held.element,
        imgElement: held.imgElement,
        worldX: startX,
        y: kart.yPercent,
        vx: itemAbsVelX,
        vy: vy,
        shooterId: kart.id,
        targetKartId: targetKartId,
        createdAt: gameNow,
        currentFrame: 1,
        lastAnimTime: 0,
        isDead: false
    };

    worldState.items.push(newItem);
    kart.heldItem = null;
}

// === BOUCLE D'ANIMATION ===

function animate(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    let deltaTime = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    if (deltaTime > 0.1) deltaTime = 0.016;

    const gameNow = getGameTime();
    updateMobileStatus();
    handleSpawns(gameNow);

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    
    if (cachedContainer) {
        let screenWidth = cachedContainer.offsetWidth;
        if (cachedIsMobile) {
            screenWidth = screenWidth / GAME_CONFIG.rendering.mobileScale;
        }
        const renderMargin = GAME_CONFIG.rendering.bufferZone;
        
        worldState.cameraX += GAME_CONFIG.speeds.roadPPS * deltaTime;
        if (worldState.cameraX >= GAME_CONFIG.world.width) {
            worldState.cameraX -= GAME_CONFIG.world.width;
        }

        if (cachedBg) {
            const bgX = worldState.cameraX % GAME_CONFIG.world.width;
            cachedBg.style.backgroundPosition = `-${bgX}px 0px`;
        } else {
            cachedBg = document.querySelector('.layer-scrolling-bg');
        }

        if (worldState.finishLine && worldState.finishLine.element) {
            const rx = getScreenPosition(worldState.finishLine.worldX, worldState.cameraX, screenWidth);
            worldState.finishLine.element.style.transform = `translate3d(${rx}px, 0, 0)`;
        }

        const boxesLen = worldState.itemBoxes.length;
        const floatY = Math.sin(gameNow * GAME_CONFIG.physics.floatSpeed) * GAME_CONFIG.physics.floatAmplitude;

        for (let i = 0; i < boxesLen; i++) {
            const box = worldState.itemBoxes[i];
            if (!box.active && gameNow > box.reactivateTime) {
                box.active = true;
                box.element.style.display = 'block';
            }
            if (!box.active) box.element.style.display = 'none';

            const rx = getScreenPosition(box.worldX, worldState.cameraX, screenWidth);
            
            if (rx > -renderMargin && rx < screenWidth + renderMargin) {
                box.element.style.transform = `translate3d(${rx}px, ${floatY}px, 0)`;
                if (box.active) {
                    box.element.style.display = 'block';
                    
                    const kartsLen = worldState.karts.length;
                    for (let k = 0; k < kartsLen; k++) {
                        const kart = worldState.karts[k];
                        if (kart.state !== 'running' && kart.state !== 'hit') continue; 
                        
                        const dist = getShortestDistance(box.worldX, kart.worldX);
                        const dy = Math.abs(box.y - kart.yPercent);
                        if (Math.abs(dist) < GAME_CONFIG.hitboxes.itemBox.x && dy < GAME_CONFIG.hitboxes.itemBox.y) {
                            box.active = false;
                            box.reactivateTime = gameNow + GAME_CONFIG.delays.boxRespawn;
                            if (!kart.heldItem) {
                                kart.pendingItemGrantTime = gameNow + GAME_CONFIG.delays.itemGrant;
                            }
                        }
                    }
                }
            } else {
                box.element.style.display = 'none';
            }
        }

        const kartsLen = worldState.karts.length;
        for (let i = 0; i < kartsLen; i++) {
            const kart = worldState.karts[i];

            if (kart.state === 'pending') {
                kart.element.style.display = 'none';
                if (kart.heldItem) kart.heldItem.element.style.display = 'none';
                continue;
            }

            if (kart.state === 'running') {
                if (kart.pendingItemGrantTime && gameNow > kart.pendingItemGrantTime) {
                    giveKartItem(kart);
                    kart.pendingItemGrantTime = 0;
                }

                updateAI(kart, deltaTime);

                const isBoosted = kart.boostEndTime > gameNow || kart.starEndTime > gameNow;

                if (isBoosted) {
                    kart.absoluteVelocity = kart.stats.topSpeed;
                    kart.momentum = 1.0;
                    kart.nextMomentumChange = gameNow + randomRange(GAME_CONFIG.speeds.momentumDriftMin, GAME_CONFIG.speeds.momentumDriftMax);
                } else {
                    if (gameNow > kart.nextMomentumChange) {
                        kart.momentumTarget = getNewMomentumTarget(kart.stats);
                        kart.nextMomentumChange = gameNow + randomRange(GAME_CONFIG.speeds.momentumDriftMin, GAME_CONFIG.speeds.momentumDriftMax);
                    }
                    const mChangeSpeed = GAME_CONFIG.speeds.momentumChangeSpeed;
                    if (kart.momentum < kart.momentumTarget) {
                        kart.momentum = Math.min(kart.momentumTarget, kart.momentum + mChangeSpeed * deltaTime);
                    } else {
                        kart.momentum = Math.max(kart.momentumTarget, kart.momentum - mChangeSpeed * deltaTime);
                    }

                    const targetSpeed = getMomentumSpeed(kart.stats, kart.momentum);
                    const accRate = GAME_CONFIG.speeds.accelerationRate * kart.stats.acceleration;
                    if (kart.absoluteVelocity < targetSpeed) {
                        kart.absoluteVelocity = Math.min(targetSpeed, kart.absoluteVelocity + accRate * deltaTime);
                    } else if (kart.absoluteVelocity > targetSpeed) {
                        kart.absoluteVelocity = Math.max(targetSpeed, kart.absoluteVelocity - accRate * 0.25 * deltaTime);
                    }
                    if (kart.absoluteVelocity > kart.stats.topSpeed) {
                        kart.absoluteVelocity = kart.stats.topSpeed;
                    }
                }

                let effectiveSpeed = kart.absoluteVelocity;
                if (kart.boostEndTime > gameNow) {
                    effectiveSpeed = kart.stats.topSpeed + GAME_CONFIG.speeds.shroomBoost;
                }

                if (kart.starEndTime > gameNow) {
                    effectiveSpeed = Math.max(effectiveSpeed, kart.stats.topSpeed * GAME_CONFIG.speeds.starSpeedMultiplier);
                    kart.isInvincible = true;
                } else if (kart.isInvincible) {
                    kart.isInvincible = false;
                    kart.element.style.filter = 'none';
                    kart.element.classList.remove('star-active');
                    if (kart.leaderboardPP) kart.leaderboardPP.classList.remove('pp-star-active');
                }

                const moveDist = effectiveSpeed * deltaTime;
                kart.totalDistance += moveDist;

                const prevWorldX = kart.worldX;
                kart.worldX += moveDist;
                kart.yPercent += kart.vy * deltaTime;

                const finishX = GAME_CONFIG.world.finishLineX;
                if (prevWorldX < finishX && kart.worldX >= finishX) {
                    if (kart.hasPassedFinishLine) {
                        kart.lapCount++;
                    } else {
                        kart.hasPassedFinishLine = true;
                    }
                }

                if (kart.worldX >= GAME_CONFIG.world.width) {
                    kart.worldX -= GAME_CONFIG.world.width;
                }
                if (kart.worldX < 0) {
                    kart.worldX += GAME_CONFIG.world.width;
                }

                if (kart.yPercent > GAME_CONFIG.road.maxY) { kart.yPercent = GAME_CONFIG.road.maxY; kart.vy = 0; }
                if (kart.yPercent < GAME_CONFIG.road.minY) { kart.yPercent = GAME_CONFIG.road.minY; kart.vy = 0; }

                for (let j = i + 1; j < kartsLen; j++) {
                    const other = worldState.karts[j];
                    if (other.state !== 'running') continue;
                    const dx = Math.abs(getShortestDistance(other.worldX, kart.worldX));
                    const dy = Math.abs(other.yPercent - kart.yPercent);
                    if (dx < GAME_CONFIG.hitboxes.kartVsKart.x && dy < GAME_CONFIG.hitboxes.kartVsKart.y) {
                         if (kart.isInvincible && other.isInvincible) continue;
                         if (kart.isInvincible) {
                             if (other.hitInvincibleUntil > gameNow) continue;
                             other.state = 'hit';
                             other.hitEndTime = gameNow + GAME_CONFIG.delays.hitDecelDuration + GAME_CONFIG.delays.hitPauseDuration;
                             triggerPPHitAnimation(other);
                             if (other.heldItem) other.throwTime = other.hitEndTime + GAME_CONFIG.delays.throwDelayAfterHit;
                             continue;
                         }
                         if (other.isInvincible) {
                             if (kart.hitInvincibleUntil > gameNow) continue;
                             kart.state = 'hit';
                             kart.hitEndTime = gameNow + GAME_CONFIG.delays.hitDecelDuration + GAME_CONFIG.delays.hitPauseDuration;
                             triggerPPHitAnimation(kart);
                             if (kart.heldItem) kart.throwTime = kart.hitEndTime + GAME_CONFIG.delays.throwDelayAfterHit;
                             continue;
                         }
                         const myWeight = kart.stats.weight;
                         const otherWeight = other.stats.weight;
                         const totalWeight = myWeight + otherWeight;
                         const myRatio = otherWeight / totalWeight;
                         const otherRatio = myWeight / totalWeight;
                         const pushForce = GAME_CONFIG.physics.pushForce;
                         const myBounceY = GAME_CONFIG.physics.collisionBounceY * myRatio;
                         const otherBounceY = GAME_CONFIG.physics.collisionBounceY * otherRatio;
                         if (kart.yPercent > other.yPercent) {
                             kart.yPercent += pushForce * myRatio; kart.vy = myBounceY;
                             other.yPercent -= pushForce * otherRatio; other.vy = -otherBounceY;
                         } else {
                             kart.yPercent -= pushForce * myRatio; kart.vy = -myBounceY;
                             other.yPercent += pushForce * otherRatio; other.vy = otherBounceY;
                         }
                    }
                }

                if (kart.heldItem && kart.state === 'running' && kart.heldItem.holdPosition === 'behind') {
                    let itemWorldX = kart.worldX + kart.heldItem.offset;
                    if (itemWorldX < 0) itemWorldX += GAME_CONFIG.world.width;
                    if (itemWorldX >= GAME_CONFIG.world.width) itemWorldX -= GAME_CONFIG.world.width;

                    const itemY = kart.yPercent;

                    for (let j = 0; j < kartsLen; j++) {
                        const victim = worldState.karts[j];
                        if (victim.id === kart.id || victim.state !== 'running') continue;
                        if (victim.hitInvincibleUntil > gameNow) continue;

                        const dx = Math.abs(getShortestDistance(itemWorldX, victim.worldX));
                        const dy = Math.abs(itemY - victim.yPercent);

                        const hitThresholdY = 8;

                        if (dx < GAME_CONFIG.hitboxes.itemVsKart.x && dy < hitThresholdY) {
                            if (victim.isInvincible) {
                                kart.heldItem.element.remove();
                                kart.heldItem = null;
                                break;
                            }
                            kart.heldItem.element.remove();
                            kart.heldItem = null;

                            victim.state = 'hit';
                            victim.hitEndTime = gameNow + GAME_CONFIG.delays.hitDecelDuration + GAME_CONFIG.delays.hitPauseDuration;
                            triggerPPHitAnimation(victim);
                            if (victim.heldItem) {
                                victim.throwTime = victim.hitEndTime + GAME_CONFIG.delays.throwDelayAfterHit;
                            }
                            break;
                        }
                    }
                }

                if (kart.heldItem && gameNow > kart.throwTime) activateItem(kart);

            } else if (kart.state === 'hit') {
                const totalHitTime = GAME_CONFIG.delays.hitDecelDuration + GAME_CONFIG.delays.hitPauseDuration;
                const hitStart = kart.hitEndTime - totalHitTime;
                const elapsed = gameNow - hitStart;
                const decelDuration = GAME_CONFIG.delays.hitDecelDuration;

                if (elapsed < decelDuration) {
                    const decelProgress = elapsed / decelDuration;
                    const hitSpeedFactor = 0.3 * Math.max(0, 1.0 - decelProgress * decelProgress);
                    const moveDist = GAME_CONFIG.speeds.roadPPS * hitSpeedFactor * deltaTime;
                    kart.worldX += moveDist;
                    kart.totalDistance += moveDist;
                    kart.element.classList.remove('kart-stopped');
                    if (kart.heldItem) kart.heldItem.element.classList.remove('item-stopped');
                } else {
                    if (!kart.element.classList.contains('kart-stopped')) {
                        kart.element.classList.add('kart-stopped');
                    }
                    if (kart.heldItem && !kart.heldItem.element.classList.contains('item-stopped')) {
                        kart.heldItem.element.classList.add('item-stopped');
                    }
                }

                if (kart.worldX >= GAME_CONFIG.world.width) {
                    kart.worldX -= GAME_CONFIG.world.width;
                }
                if (gameNow > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.element.classList.remove('kart-stopped');
                    if (kart.heldItem) kart.heldItem.element.classList.remove('item-stopped');
                    kart.absoluteVelocity = 0;
                    kart.momentum = 0.2;
                    kart.momentumTarget = randomRange(0.6, 1.0);
                    kart.nextMomentumChange = gameNow + randomRange(GAME_CONFIG.speeds.momentumDriftMin, GAME_CONFIG.speeds.momentumDriftMax);
                    kart.hitInvincibleUntil = gameNow + GAME_CONFIG.delays.invincibilityAfterHit;
                }
            }

            const rx = getScreenPosition(kart.worldX, worldState.cameraX, screenWidth);
            const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

            if (isVisibleNow) {
                kart.element.style.display = 'block';
                kart.element.style.transform = `translate3d(${rx}px, 0, 0)`;
                kart.element.style.bottom = `${kart.yPercent}%`;
                
                const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
                if (kart.element.style.zIndex != zVal) kart.element.style.zIndex = zVal;

                const targetFilter = (kart.state === 'hit') ? 'hit' : 'none';
                if (kart.currentFilter !== targetFilter) {
                    kart.currentFilter = targetFilter;
                    kart.element.style.filter = targetFilter === 'hit'
                        ? 'brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)'
                        : 'none';
                }
                
                if (kart.heldItem) {
                    kart.heldItem.element.style.display = 'block';
                    const hx = rx + kart.heldItem.offset;
                    const hy = kart.heldItem.yShift || 0;
                    kart.heldItem.element.style.transform = `translate3d(${hx}px, ${-hy}px, 0)`;
                    kart.heldItem.element.style.bottom = `${kart.yPercent}%`;
                    const itemZ = kart.heldItem.holdPosition === 'hands' ? zVal + 1 : zVal;
                    if (kart.heldItem.element.style.zIndex != itemZ) kart.heldItem.element.style.zIndex = itemZ;
                }
            } else {
                kart.element.style.display = 'none';
                if (kart.heldItem) kart.heldItem.element.style.display = 'none';
            }
        }

        for (let i = worldState.items.length - 1; i >= 0; i--) {
            const item = worldState.items[i];
            if (item.isDead) continue;

            for (let j = i - 1; j >= 0; j--) {
                const other = worldState.items[j];
                if (other.isDead) continue;
                const dx = Math.abs(getShortestDistance(item.worldX, other.worldX));
                const dy = Math.abs(item.y - other.y);
                if (dx < GAME_CONFIG.hitboxes.itemVsKart.x && dy < GAME_CONFIG.hitboxes.itemVsKart.y) {
                    item.isDead = true;
                    other.isDead = true;
                }
            }
        }

        for (let i = worldState.items.length - 1; i >= 0; i--) {
            const item = worldState.items[i];
            if (item.isDead) continue;

            if (item.type !== 'banana') {
                if (item.type === 'redShell' && item.targetKartId !== null) {
                    const target = worldState.kartsById[item.targetKartId];
                    if (target && (target.state === 'running' || target.state === 'hit')) {
                        const diffY = target.yPercent - item.y;
                        item.vy = diffY * GAME_CONFIG.speeds.redShellTrackingSpeed;
                    } else {
                        let newTarget = null;
                        let bestDist = Infinity;
                        for (let k = 0; k < kartsLen; k++) {
                            const candidate = worldState.karts[k];
                            if (candidate.id === item.shooterId) continue;
                            if (candidate.state !== 'running') continue;
                            const dist = getShortestDistance(candidate.worldX, item.worldX);
                            if (dist > 0 && dist < bestDist) {
                                bestDist = dist;
                                newTarget = candidate;
                            }
                        }
                        if (newTarget) {
                            item.targetKartId = newTarget.id;
                        } else {
                            item.targetKartId = null;
                            item.vy = randomRange(-GAME_CONFIG.speeds.shellVertical, GAME_CONFIG.speeds.shellVertical);
                        }
                    }
                }

                item.worldX += item.vx * deltaTime;
                item.y += item.vy * deltaTime;

                if (item.y > GAME_CONFIG.road.maxY) {
                    item.y = GAME_CONFIG.road.maxY;
                    if (item.type !== 'redShell') item.vy = -item.vy;
                } else if (item.y < GAME_CONFIG.road.minY) {
                    item.y = GAME_CONFIG.road.minY;
                    if (item.type !== 'redShell') item.vy = -item.vy;
                }
            }

            if (item.worldX >= GAME_CONFIG.world.width) item.worldX -= GAME_CONFIG.world.width;
            if (item.worldX < 0) item.worldX += GAME_CONFIG.world.width;

            if (item.type === 'greenShell') {
                if (gameNow - item.lastAnimTime > GAME_CONFIG.visuals.greenShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    const cached = imageCache[`greenShell_${item.currentFrame}`];
                    item.imgElement.src = cached ? cached.src : GAME_CONFIG.resources.paths.greenShell(item.currentFrame);
                    item.lastAnimTime = gameNow;
                }
            } else if (item.type === 'redShell') {
                if (gameNow - item.lastAnimTime > GAME_CONFIG.visuals.redShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    const cached = imageCache[`redShell_${item.currentFrame}`];
                    item.imgElement.src = cached ? cached.src : GAME_CONFIG.resources.paths.redShell(item.currentFrame);
                    item.lastAnimTime = gameNow;
                }
            }
            if (item.type === 'banana' && gameNow - item.createdAt > GAME_CONFIG.delays.bananaLife) {
                item.isDead = true;
            }

            const rx = getScreenPosition(item.worldX, worldState.cameraX, screenWidth);
            const isVisible = (rx > -renderMargin && rx < screenWidth + renderMargin);

            if (isVisible && !item.isDead) {
                item.element.style.display = 'block';
                item.element.style.transform = `translate3d(${rx}px, 0, 0)`;
                item.element.style.bottom = `${item.y}%`;

                const zVal = (GAME_CONFIG.rendering.zIndexBase - item.y) | 0;
                if (item.element.style.zIndex != zVal) item.element.style.zIndex = zVal;

                const kartsLen = worldState.karts.length;
                for (let k = 0; k < kartsLen; k++) {
                    const kart = worldState.karts[k];
                    if (item.type === 'banana' && kart.id === item.shooterId && gameNow - item.createdAt < GAME_CONFIG.delays.invincibilityOwnItem) continue;
                    if ((item.type === 'greenShell' || item.type === 'redShell') && kart.id === item.shooterId) continue;
                    if (kart.state !== 'running' && kart.state !== 'hit') continue;

                    if (kart.isInvincible) {
                        const dk = Math.abs(getShortestDistance(item.worldX, kart.worldX));
                        const dky = Math.abs(item.y - kart.yPercent);
                        if (dk < GAME_CONFIG.hitboxes.itemVsKart.x && dky < GAME_CONFIG.hitboxes.itemVsKart.y) {
                            item.isDead = true;
                            break;
                        }
                        continue;
                    }

                    let hitHeldItem = false;
                    if (kart.heldItem && kart.heldItem.holdPosition === 'behind') {
                        let hX = kart.worldX + kart.heldItem.offset;
                        if (hX < 0) hX += GAME_CONFIG.world.width;
                        if (hX >= GAME_CONFIG.world.width) hX -= GAME_CONFIG.world.width;

                        const dh = Math.abs(getShortestDistance(item.worldX, hX));
                        const dhy = Math.abs(item.y - kart.yPercent);

                        if (dh < GAME_CONFIG.hitboxes.itemVsKart.x && dhy < GAME_CONFIG.hitboxes.itemVsKart.y) {
                             kart.heldItem.element.remove();
                             kart.heldItem = null;
                             item.isDead = true;
                             hitHeldItem = true;
                        }
                    }

                    if (hitHeldItem) break;

                    const dk = Math.abs(getShortestDistance(item.worldX, kart.worldX));
                    const dky = Math.abs(item.y - kart.yPercent);

                    if (dk < GAME_CONFIG.hitboxes.itemVsKart.x && dky < GAME_CONFIG.hitboxes.itemVsKart.y) {
                        if (kart.state === 'running' && kart.hitInvincibleUntil <= gameNow) {
                            kart.state = 'hit';
                            kart.hitEndTime = gameNow + GAME_CONFIG.delays.hitDecelDuration + GAME_CONFIG.delays.hitPauseDuration;
                            triggerPPHitAnimation(kart);
                            if (kart.heldItem) kart.throwTime = kart.hitEndTime + GAME_CONFIG.delays.throwDelayAfterHit;
                        }
                        item.isDead = true;
                        break;
                    }
                }
            } else {
                item.element.style.display = 'none';
            }
        }

        let writeIdx = 0;
        for (let i = 0; i < worldState.items.length; i++) {
            if (worldState.items[i].isDead) {
                worldState.items[i].element.remove();
            } else {
                worldState.items[writeIdx++] = worldState.items[i];
            }
        }
        worldState.items.length = writeIdx;
    }

    updateLeaderboard(gameNow);
    if (GAME_CONFIG.debugMode) updateDebugHUD();
    animationId = requestAnimationFrame(animate);
}

// === DEBUG HUD ===

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

// === GESTION EVENEMENTS ===

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

// === WINTER THEME - SNOW EFFECT ===

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
