const GAME_CONFIG = {
    debugMode: false, 

    resources: {
        characters: ['mario', 'luigi', 'peach', 'toad', 'yoshi', 'bowser', 'dk', 'koopa'],
        initials: { 'mario': 'M', 'luigi': 'L', 'peach': 'P', 'toad': 'T', 'yoshi': 'Y', 'bowser': 'B', 'dk': 'D', 'koopa': 'K' },
        paths: {
            char: (name) => `static/img/${name}/${name}-static.png`,
            shell: (frame) => `static/img/green-shell/green-shell${frame}.png`,
            banana: 'static/img/banana.png'
        }
    },
    world: {
        width: 3072,
        finishLineX: 1152, 
        itemBoxX: 3456,
        itemBoxCount: 4,
        spawnStartX: 0, 
        spawnSpacing: 0 
    },
    rendering: {
        bufferZone: 200, 
        zIndexBase: 400,
        mobileBreakpoint: 769
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
        roadPPS: 170,            
        
        kartBaseSpeed: 400, 
        kartMinSpeed: 380, 
        kartMaxSpeed: 420,
        speedVariationMin: 0.80, 
        speedVariationMax: 1.20,
        
        projectileSpeed: 600, 
        
        returnLane: 20,
        shellVertical: 1.5
    },
    offsets: {
        heldItem: { pc: -50, mobile: -20 },
        shellSpawn: { pc: 50, mobile: 20 }
    },
    delays: {
        stunDuration: 2000,
        boxRespawn: 2000,
        itemGrant: 3000,
        bananaLife: 40000,
        invincibilityOwnItem: 2000,
        throwDelayAfterHit: 1000,
        spawnMin: 150,  
        spawnMax: 800  
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
        shell: { width: 48, widthMobile: 20, animSpeed: 100 },
        banana: { width: 32, widthMobile: 20 },
        box: { sizePC: 42, sizeMobile: 28 }
    }
};


let globalTimeOffset = 0;
let pauseStartTime = 0;

function getGameTime() {
    return Date.now() - globalTimeOffset;
}

let worldState = {
    cameraX: 0,
    karts: [],
    items: [],
    itemBoxes: [],
    finishLine: null,
    nextSpawnTime: 0 
};

let lastFrameTime = 0;
let animationId = null;

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function randomRange(min, max) {
    return Math.random() * (max - min) + min;
}

function getZIndex(yPercent) {
    return Math.floor(GAME_CONFIG.rendering.zIndexBase - yPercent);
}

function isMobile() {
    return window.innerWidth < GAME_CONFIG.rendering.mobileBreakpoint;
}

function getInitialKartSpeed() {
    return randomRange(GAME_CONFIG.speeds.kartMinSpeed, GAME_CONFIG.speeds.kartMaxSpeed);
}

function getNewKartSpeed(currentSpeed) {
    const base = GAME_CONFIG.speeds.kartBaseSpeed;
    const factor = randomRange(GAME_CONFIG.speeds.speedVariationMin, GAME_CONFIG.speeds.speedVariationMax);
    const target = base * factor;
    
    if (!currentSpeed) return target;
    return (currentSpeed + target) / 2;
}

function getShortestDistance(fromX, toX) {
    const w = GAME_CONFIG.world.width;
    let diff = fromX - toX;
    if (diff < -w / 2) diff += w;
    if (diff > w / 2) diff -= w;
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
    const container = document.getElementById('karts-container');
    if (!container) return;
    container.innerHTML = '';
    
    worldState.karts = [];
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.cameraX = 0;
    worldState.nextSpawnTime = getGameTime() + 500; 

    syncRoadAnimation();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = {
            element: finishLineEl,
            worldX: GAME_CONFIG.world.finishLineX
        };
    }

    const currentBoxSize = isMobile() ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const roadHeight = GAME_CONFIG.road.maxY - GAME_CONFIG.road.minY;

    for (let i = 0; i < GAME_CONFIG.world.itemBoxCount; i++) {
        const boxDiv = document.createElement('div');
        boxDiv.classList.add('item-box');
        boxDiv.style.width = `${currentBoxSize}px`;
        boxDiv.style.height = `${currentBoxSize}px`;
        
        const boxY = GAME_CONFIG.road.minY + (i * (roadHeight / (GAME_CONFIG.world.itemBoxCount - 1)));
        boxDiv.style.bottom = `${boxY}%`;
        boxDiv.style.zIndex = getZIndex(boxY);
        
        container.appendChild(boxDiv);
        
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
        container.appendChild(wrapper);

        worldState.karts.push({
            id: index,
            charName: charName,
            element: wrapper,
            imgElement: img,
            worldX: startWorldX,
            yPercent: verticalPos,
            
            absoluteVelocity: getInitialKartSpeed(),
            vy: 0,
            targetVy: 0,
            
            state: 'pending', 
            isVisible: false,
            
            aiState: 'cruising',
            originalLaneY: verticalPos,
            dodgeIntensity: 30,
            
            hitEndTime: 0,
            heldItem: null,
            throwTime: 0,
            pendingItemGrantTime: 0,
            
            nextWanderTime: getGameTime() + randomRange(1000, 5000),
            wanderEndTime: 0,
            wanderVy: 0
        });
    });

    if (GAME_CONFIG.debugMode) initDebugHUD();
}

function handleSpawns(now) {
    if (now > worldState.nextSpawnTime) {
        const pendingKart = worldState.karts.find(k => k.state === 'pending');
        if (pendingKart) {
            pendingKart.state = 'running';
            pendingKart.absoluteVelocity = getInitialKartSpeed();
            
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

    for (const item of worldState.items) {
        if (item.type !== 'banana') continue;
        
        let dist = getShortestDistance(item.worldX, kart.worldX); 
        
        if (dist > 0 && dist < GAME_CONFIG.ai.detectionRange) {
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
            kart.dodgeIntensity = randomRange(GAME_CONFIG.ai.dodgeIntensityMin, GAME_CONFIG.ai.dodgeIntensityMax);
        }
        kart.targetVy = avoidDirection * kart.dodgeIntensity;
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * deltaTime;
        return;
    }

    let overtakeFound = false;
    for (const other of worldState.karts) {
        if (other.id === kart.id || other.state !== 'running') continue;
        
        let dist = getShortestDistance(other.worldX, kart.worldX);
        const distY = Math.abs(other.yPercent - kart.yPercent);
        
        if (dist > 0 && dist < GAME_CONFIG.ai.overtakeDetectionRange && distY < GAME_CONFIG.ai.overtakeMinDistance) {
            overtakeFound = true;
            let dir = (kart.yPercent > other.yPercent) ? 1 : -1;
            if (kart.yPercent > GAME_CONFIG.road.maxY - GAME_CONFIG.road.overtakeMargin) dir = -1;
            if (kart.yPercent < GAME_CONFIG.road.minY + GAME_CONFIG.road.overtakeMargin) dir = 1;
            kart.targetVy = dir * GAME_CONFIG.ai.overtakeSideSpeed;
            break;
        }
    }

    if (overtakeFound) {
        kart.originalLaneY = kart.yPercent;
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * deltaTime;
        return;
    }

    let boxTargetFound = false;
    if (!kart.heldItem) {
        for (const box of worldState.itemBoxes) {
            if (!box.active) continue;
            let dist = getShortestDistance(box.worldX, kart.worldX);
            if (dist > 0 && dist < GAME_CONFIG.ai.boxDetectionRange) {
                const diffY = box.y - kart.yPercent;
                if (Math.abs(diffY) > 2) {
                    kart.targetVy = (diffY > 0) ? GAME_CONFIG.ai.boxSeekIntensity : -GAME_CONFIG.ai.boxSeekIntensity;
                    boxTargetFound = true;
                    break;
                }
            }
        }
    }

    if (boxTargetFound) {
        kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * deltaTime;
        return;
    }

    if (now > kart.nextWanderTime) {
        kart.nextWanderTime = now + randomRange(GAME_CONFIG.ai.wanderIntervalMin, GAME_CONFIG.ai.wanderIntervalMax);
        kart.wanderEndTime = now + randomRange(GAME_CONFIG.ai.wanderDurationMin, GAME_CONFIG.ai.wanderDurationMax);
        let dir = (Math.random() > 0.5) ? 1 : -1;
        if (kart.yPercent > GAME_CONFIG.road.maxY - GAME_CONFIG.road.wanderMargin) dir = -1;
        if (kart.yPercent < GAME_CONFIG.road.minY + GAME_CONFIG.road.wanderMargin) dir = 1;
        kart.wanderVy = dir * GAME_CONFIG.ai.wanderSpeed;
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
                kart.targetVy = (diff > 0 ? 1 : -1) * GAME_CONFIG.speeds.returnLane;
            }
        } else {
            kart.targetVy = 0;
            kart.aiState = 'cruising';
        }
    }

    kart.vy += (kart.targetVy - kart.vy) * GAME_CONFIG.physics.smoothingFactor * deltaTime;
}

function giveKartItem(kart) {
    if (kart.heldItem) return;

    let itemType = (Math.random() > 0.5) ? 'banana' : 'shell';
    
    const container = document.getElementById('karts-container');
    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';
    
    const img = document.createElement('img');
    img.style.width = '100%';
    
    let offset = isMobile() ? GAME_CONFIG.offsets.heldItem.mobile : GAME_CONFIG.offsets.heldItem.pc; 
    
    if (itemType === 'shell') {
        const size = isMobile() ? GAME_CONFIG.visuals.shell.widthMobile : GAME_CONFIG.visuals.shell.width;
        itemDiv.style.width = `${size}px`;
        img.src = GAME_CONFIG.resources.paths.shell(1);
    } else {
        const size = isMobile() ? GAME_CONFIG.visuals.banana.widthMobile : GAME_CONFIG.visuals.banana.width + 4;
        itemDiv.style.width = `${size}px`;
        img.src = GAME_CONFIG.resources.paths.banana;
    }

    itemDiv.appendChild(img);
    container.appendChild(itemDiv);

    kart.heldItem = {
        type: itemType,
        element: itemDiv,
        imgElement: img,
        offset: offset
    };

    kart.throwTime = getGameTime() + randomRange(GAME_CONFIG.ai.holdItemMin, GAME_CONFIG.ai.holdItemMax);
}

function activateItem(kart) {
    const held = kart.heldItem;
    if (!held) return;

    let startX = kart.worldX + held.offset;
    if (held.type === 'shell') {
        const shellOffset = isMobile() ? GAME_CONFIG.offsets.shellSpawn.mobile : GAME_CONFIG.offsets.shellSpawn.pc; 
        startX = kart.worldX + shellOffset;
    }

    let itemAbsVelX = 0;
    if (held.type === 'banana') {
        itemAbsVelX = 0; 
    } else {
        itemAbsVelX = GAME_CONFIG.speeds.projectileSpeed;
    }

    const newItem = {
        type: held.type,
        element: held.element,
        imgElement: held.imgElement,
        worldX: startX,
        y: kart.yPercent,
        vx: itemAbsVelX,
        vy: (held.type === 'shell') ? randomRange(-GAME_CONFIG.speeds.shellVertical, GAME_CONFIG.speeds.shellVertical) : 0,
        shooterId: kart.id,
        createdAt: getGameTime(),
        currentFrame: 1,
        lastAnimTime: 0
    };

    worldState.items.push(newItem);
    kart.heldItem = null;
}

function animate(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    let deltaTime = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    if (deltaTime > 0.1) deltaTime = 0.016;

    const gameNow = getGameTime();
    handleSpawns(gameNow);

    const bg = document.querySelector('.layer-scrolling-bg');
    const container = document.getElementById('karts-container');
    
    if (container) {
        const screenWidth = container.offsetWidth;
        const renderMargin = GAME_CONFIG.rendering.bufferZone;
        
        worldState.cameraX += GAME_CONFIG.speeds.roadPPS * deltaTime;
        if (worldState.cameraX >= GAME_CONFIG.world.width) {
            worldState.cameraX -= GAME_CONFIG.world.width;
        }

        if (bg) {
            bg.style.backgroundPosition = `-${worldState.cameraX}px 0px`;
        }

        if (worldState.finishLine && worldState.finishLine.element) {
            const rx = getScreenPosition(worldState.finishLine.worldX, worldState.cameraX, screenWidth);
            worldState.finishLine.element.style.transform = `translateX(${rx}px)`;
        }

        worldState.itemBoxes.forEach(box => {
            if (!box.active && gameNow > box.reactivateTime) {
                box.active = true;
                box.element.style.display = 'block';
            }
            if (!box.active) box.element.style.display = 'none';

            const rx = getScreenPosition(box.worldX, worldState.cameraX, screenWidth);
            
            if (rx > -renderMargin && rx < screenWidth + renderMargin) {
                box.element.style.transform = `translateX(${rx}px)`;
                if (box.active) {
                    box.element.style.display = 'block';
                    
                    for (const kart of worldState.karts) {
                        if (kart.state !== 'running' || kart.heldItem) continue;
                        const dist = getShortestDistance(box.worldX, kart.worldX);
                        const dy = Math.abs(box.y - kart.yPercent);
                        if (Math.abs(dist) < GAME_CONFIG.hitboxes.itemBox.x && dy < GAME_CONFIG.hitboxes.itemBox.y) {
                            box.active = false;
                            box.reactivateTime = gameNow + GAME_CONFIG.delays.boxRespawn;
                            kart.pendingItemGrantTime = gameNow + GAME_CONFIG.delays.itemGrant;
                        }
                    }
                }
            } else {
                box.element.style.display = 'none';
            }
            const floatY = Math.sin(gameNow * GAME_CONFIG.physics.floatSpeed) * GAME_CONFIG.physics.floatAmplitude;
            box.element.style.transform += ` translateY(${floatY}px)`;
        });

        worldState.karts.forEach(kart => {
            if (kart.state === 'pending') {
                kart.element.style.display = 'none';
                if (kart.heldItem) kart.heldItem.element.style.display = 'none';
                return;
            }

            if (kart.state === 'running') {
                if (kart.pendingItemGrantTime && gameNow > kart.pendingItemGrantTime) {
                    giveKartItem(kart);
                    kart.pendingItemGrantTime = 0;
                }

                updateAI(kart, deltaTime);
                
                kart.worldX += kart.absoluteVelocity * deltaTime;
                kart.yPercent += kart.vy * deltaTime;

                if (kart.worldX >= GAME_CONFIG.world.width) {
                    kart.worldX -= GAME_CONFIG.world.width;
                    kart.absoluteVelocity = getNewKartSpeed(kart.absoluteVelocity);
                }
                if (kart.worldX < 0) {
                    kart.worldX += GAME_CONFIG.world.width;
                    kart.absoluteVelocity = getNewKartSpeed(kart.absoluteVelocity);
                }

                if (kart.yPercent > GAME_CONFIG.road.maxY) { kart.yPercent = GAME_CONFIG.road.maxY; kart.vy = 0; }
                if (kart.yPercent < GAME_CONFIG.road.minY) { kart.yPercent = GAME_CONFIG.road.minY; kart.vy = 0; }

                for (const other of worldState.karts) {
                    if (other.id === kart.id || other.state !== 'running') continue;
                    const dx = Math.abs(getShortestDistance(other.worldX, kart.worldX));
                    const dy = Math.abs(other.yPercent - kart.yPercent);
                    if (dx < GAME_CONFIG.hitboxes.kartVsKart.x && dy < GAME_CONFIG.hitboxes.kartVsKart.y) {
                         const pushForce = GAME_CONFIG.physics.pushForce;
                         const bounceY = GAME_CONFIG.physics.collisionBounceY;
                         if (kart.yPercent > other.yPercent) { kart.yPercent += pushForce; kart.vy = bounceY; }
                         else { kart.yPercent -= pushForce; kart.vy = -bounceY; }
                    }
                }

                if (kart.heldItem && gameNow > kart.throwTime) activateItem(kart);

            } else if (kart.state === 'hit') {
                kart.worldX += (GAME_CONFIG.speeds.roadPPS * 0.5) * deltaTime; 
                if (kart.worldX >= GAME_CONFIG.world.width) {
                    kart.worldX -= GAME_CONFIG.world.width;
                }
                if (gameNow > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.absoluteVelocity = getInitialKartSpeed();
                }
            }

            const rx = getScreenPosition(kart.worldX, worldState.cameraX, screenWidth);
            const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

            kart.isVisible = isVisibleNow;

            if (isVisibleNow) {
                kart.element.style.display = 'block';
                kart.element.style.transform = `translateX(${rx}px)`;
                kart.element.style.bottom = `${kart.yPercent}%`;
                kart.element.style.zIndex = getZIndex(kart.yPercent);
                if (kart.state === 'hit') kart.element.style.filter = "brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)";
                else kart.element.style.filter = "none";
                
                if (kart.heldItem) {
                    kart.heldItem.element.style.display = 'block';
                    const hx = rx + kart.heldItem.offset;
                    kart.heldItem.element.style.transform = `translateX(${hx}px)`;
                    kart.heldItem.element.style.bottom = `${kart.yPercent}%`;
                    kart.heldItem.element.style.zIndex = getZIndex(kart.yPercent);
                }
            } else {
                kart.element.style.display = 'none';
                if (kart.heldItem) kart.heldItem.element.style.display = 'none';
            }
        });

        for (let i = worldState.items.length - 1; i >= 0; i--) {
            const item = worldState.items[i];
            
            if (item.type !== 'banana') {
                item.worldX += item.vx * deltaTime;
                item.y += item.vy * deltaTime;
            }

            if (item.worldX >= GAME_CONFIG.world.width) item.worldX -= GAME_CONFIG.world.width;
            if (item.worldX < 0) item.worldX += GAME_CONFIG.world.width;

            if (item.type === 'shell') {
                 if (gameNow - item.lastAnimTime > GAME_CONFIG.visuals.shell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.imgElement.src = GAME_CONFIG.resources.paths.shell(item.currentFrame);
                    item.lastAnimTime = gameNow;
                }
            }
            if (item.type === 'banana' && gameNow - item.createdAt > GAME_CONFIG.delays.bananaLife) {
                item.element.remove();
                worldState.items.splice(i, 1);
                continue;
            }

            const rx = getScreenPosition(item.worldX, worldState.cameraX, screenWidth);
            const isVisible = (rx > -renderMargin && rx < screenWidth + renderMargin);

            if (isVisible) {
                item.element.style.display = 'block';
                item.element.style.transform = `translateX(${rx}px)`;
                item.element.style.bottom = `${item.y}%`;
                item.element.style.zIndex = getZIndex(item.y);

                for (const kart of worldState.karts) {
                    if (item.type === 'banana' && kart.id === item.shooterId && gameNow - item.createdAt < GAME_CONFIG.delays.invincibilityOwnItem) continue;
                    if (item.type === 'shell' && kart.id === item.shooterId) continue;
                    if (kart.state !== 'running') continue;

                    const kx = getScreenPosition(kart.worldX, worldState.cameraX, screenWidth);
                    const dx = Math.abs(rx - kx);
                    const dy = Math.abs(item.y - kart.yPercent);

                    if (dx < GAME_CONFIG.hitboxes.itemVsKart.x && dy < GAME_CONFIG.hitboxes.itemVsKart.y) {
                        kart.state = 'hit';
                        kart.hitEndTime = gameNow + GAME_CONFIG.delays.stunDuration;
                        if (kart.heldItem) kart.throwTime = kart.hitEndTime + GAME_CONFIG.delays.throwDelayAfterHit;
                        item.element.remove();
                        worldState.items.splice(i, 1);
                        break;
                    }
                }
            } else {
                item.element.style.display = 'none';
                if (item.type === 'shell') {
                    item.element.remove();
                    worldState.items.splice(i, 1);
                }
            }
        }
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
}

function updateDebugHUD() {
    const hud = document.getElementById('debug-hud');
    if (!hud) return;

    const container = document.getElementById('karts-container');
    const screenWidth = container ? container.offsetWidth : window.innerWidth;
    
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
        }
    });
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

document.addEventListener('DOMContentLoaded', () => {
    initWorld();
    animate(0);
    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
