/* ==========================================================================
   CONFIGURATIONS & VARIABLES GLOBALES
   ========================================================================== */

const charactersList = [
    'mario', 'luigi', 'peach', 'toad',
    'yoshi', 'bowser', 'dk', 'koopa'
];

const itemsConfig = {
    roadSpeedPPS: 182, 
    lapDistance: 4000, 
    bananaLifeTime: 20000, 
    shell: {
        folder: 'green-shell',
        baseName: 'green-shell',
        width: 48, 
        height: 48,
        animSpeed: 100
    },
    banana: {
        path: 'static/img/banana.png',
        width: 32,
        height: 32
    },
    box: {
        path: 'static/img/item_box.png',
        // --- TAILLE DES ITEM BOX ---
        sizePC: 42,
        sizeMobile: 28,
        
        hitboxX: 10,
        hitboxY: 8
    }
};

const ROAD_LIMITS = {
    min: 0,   
    max: 30   
};

let kartsData = [];
let activeItems = []; 
let itemBoxes = [];
let lastFrameTime = 0;
let nextAvailableRespawnTime = 0; 

/* ==========================================================================
   UTILITAIRES
   ========================================================================== */

function getCharacterPath(charName) {
    return `static/img/${charName}/${charName}-static.png`;
}

function getShellPath(frame) {
    return `static/img/${itemsConfig.shell.folder}/${itemsConfig.shell.baseName}${frame}.png`;
}

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

function calculateSpeedPPS(screenWidth, isProjectile = false) {
    const isMobile = window.innerWidth < 769;
    const baseDuration = isMobile ? 4 : 8; 
    
    if (isProjectile) {
        const distance = screenWidth + 150;
        const baseSpeed = distance / baseDuration;
        return baseSpeed * 2.0; 
    }

    const variation = randomRange(0.93, 1.07);
    const distance = screenWidth + 150;
    return (distance / baseDuration) * variation;
}

/* ==========================================================================
   INITIALISATION ET LOGIQUE DES KARTS
   ========================================================================== */

function initCharacters() {
    const container = document.getElementById('karts-container');
    if (!container) return;

    container.innerHTML = ''; 
    kartsData = [];
    activeItems = []; 
    itemBoxes = [];

    const shuffledChars = shuffleArray([...charactersList]);

    const roadHeight = ROAD_LIMITS.max - ROAD_LIMITS.min;
    const step = roadHeight / (shuffledChars.length - 1 || 1);

    shuffledChars.forEach((charName, index) => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('kart-container-moving');
        
        const verticalPos = ROAD_LIMITS.min + (index * step); 
        
        wrapper.style.bottom = `${verticalPos}%`;
        wrapper.style.zIndex = Math.floor(400 - verticalPos);
        
        const startX = -150;
        wrapper.style.transform = `translateX(${startX}px)`;

        const img = document.createElement('img');
        img.src = getCharacterPath(charName);
        img.alt = charName;
        img.classList.add('kart-static-png');
        
        wrapper.appendChild(img);
        container.appendChild(wrapper);

        kartsData.push({
            id: index,
            element: wrapper,
            imgElement: img,
            x: startX,
            yPercent: verticalPos,
            vy: 0, 
            targetVy: 0,
            
            aiState: 'cruising',
            originalLaneY: verticalPos,
            dodgeIntensity: 30,
            willReturnToLane: false,

            speedPPS: 0, 
            state: 'waiting_initial', 
            charName: charName,
            hitEndTime: 0,
            throwTime: 0, 
            heldItem: null
        });
    });

    const isMobile = window.innerWidth < 769;
    const currentBoxSize = isMobile ? itemsConfig.box.sizeMobile : itemsConfig.box.sizePC;

    for(let i = 0; i < 4; i++) {
        const boxDiv = document.createElement('div');
        boxDiv.classList.add('item-box');
        
        boxDiv.style.width = `${currentBoxSize}px`;
        boxDiv.style.height = `${currentBoxSize}px`;

        const boxY = ROAD_LIMITS.min + (i * (roadHeight / 3));
        
        boxDiv.style.bottom = `${boxY}%`;
        boxDiv.style.zIndex = Math.floor(400 - boxY);
        
        container.appendChild(boxDiv);

        itemBoxes.push({
            element: boxDiv,
            x: 4000, 
            y: boxY,
            state: 'running', 
            active: true,
            reactivateTime: 0,
            returnSpeed: 0
        });
    }

    spawnNextKart(0);
}

function createItemDOM(type, x, y) {
    const container = document.getElementById('karts-container');
    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.zIndex = Math.floor(400 - y); 
    itemDiv.style.pointerEvents = 'none';
    
    const img = document.createElement('img');
    img.style.width = '100%';
    
    const isMobile = window.innerWidth < 769;

    if (type === 'shell') {
        const size = isMobile ? 20 : itemsConfig.shell.width; 
        itemDiv.style.width = `${size}px`;
        img.src = getShellPath(1);
    } else {
        const size = isMobile ? 20 : itemsConfig.banana.width + 4; 
        itemDiv.style.width = `${size}px`;
        img.src = itemsConfig.banana.path;
    }

    itemDiv.appendChild(img);
    itemDiv.style.bottom = `${y}%`;
    itemDiv.style.transform = `translateX(${x}px)`;

    container.appendChild(itemDiv);
    return { div: itemDiv, img: img };
}

function spawnNextKart(index) {
    if (index >= kartsData.length) return;
    const kart = kartsData[index];
    startKartRun(kart);
    const delay = randomRange(500, 2000);
    setTimeout(() => { spawnNextKart(index + 1); }, delay);
}

function startKartRun(kart) {
    const container = document.getElementById('karts-container');
    if (!container) return;
    const screenWidth = container.offsetWidth;

    const newTargetSpeed = calculateSpeedPPS(screenWidth);

    if (kart.speedPPS > 0) {
        kart.speedPPS = (kart.speedPPS + newTargetSpeed) / 2;
    } else {
        kart.speedPPS = newTargetSpeed;
    }

    kart.x = -150;
    kart.state = 'running';
    kart.vy = 0; 
    kart.aiState = 'cruising';
    
    kart.element.style.opacity = '1';
    kart.element.style.filter = 'none';
    
    if (kart.heldItem && kart.heldItem.element) {
        kart.heldItem.element.style.opacity = '1';
    }
}

function scheduleRespawnForHit(kart, delay) {
    const now = Date.now();
    let targetTime = now + delay;

    if (targetTime < nextAvailableRespawnTime) {
        targetTime = nextAvailableRespawnTime;
    }

    nextAvailableRespawnTime = targetTime + 400;
    const actualDelay = targetTime - now;

    setTimeout(() => {
        startKartRun(kart);
    }, actualDelay);
}

/* ==========================================================================
   IA & PHYSIQUE
   ========================================================================== */

function updateKartAI(kart, deltaTime) {
    const detectionRange = 250; 
    const laneWidth = 12; 
    
    let dangerFound = false;
    let avoidDirection = 0; 

    for (const item of activeItems) {
        if (!item) continue;
        
        if (kart.state === 'running' && item.state !== 'active') continue;
        if (kart.state === 'returning' && item.state !== 'returning') continue;

        if (item.type !== 'banana') continue; 

        let distFront = 0;
        if (kart.state === 'running') {
            distFront = item.x - kart.x;
        } else {
            distFront = kart.x - item.x;
        }
        
        if (distFront > 0 && distFront < detectionRange) {
            if (Math.abs(item.y - kart.yPercent) < laneWidth) {
                dangerFound = true;
                
                let naturalDir = (item.y > kart.yPercent) ? -1 : 1;
                const safetyMargin = 2; 

                if (naturalDir === 1) { 
                    if (kart.yPercent > ROAD_LIMITS.max - safetyMargin) {
                        avoidDirection = -1;
                    } else {
                        avoidDirection = 1;
                    }
                } else { 
                    if (kart.yPercent < ROAD_LIMITS.min + safetyMargin) {
                        avoidDirection = 1;
                    } else {
                        avoidDirection = -1;
                    }
                }
                break; 
            }
        }
    }
    
    if (dangerFound) {
        if (kart.aiState !== 'dodging') {
            kart.aiState = 'dodging';
            kart.originalLaneY = kart.yPercent;
            kart.willReturnToLane = Math.random() > 0.5;
            kart.dodgeIntensity = randomRange(20, 50); 
        }
        kart.targetVy = avoidDirection * kart.dodgeIntensity;
    } 
    else {
        if (kart.aiState === 'dodging') {
            kart.aiState = 'returning';
        }

        if (kart.aiState === 'returning') {
            if (kart.willReturnToLane) {
                const diff = kart.originalLaneY - kart.yPercent;
                if (Math.abs(diff) < 1) {
                    kart.targetVy = 0;
                    kart.yPercent = kart.originalLaneY; 
                    kart.aiState = 'cruising';
                } else {
                    const returnSpeed = 15;
                    kart.targetVy = (diff > 0 ? 1 : -1) * returnSpeed;
                }
            } else {
                kart.targetVy = 0;
                kart.aiState = 'cruising';
                kart.originalLaneY = kart.yPercent;
            }
        } else {
            kart.targetVy = 0;
        }
    }

    kart.vy += (kart.targetVy - kart.vy) * 5 * deltaTime;
}

function checkKartKartCollisions(kart) {
    const hitboxSize = 5; 

    for (const other of kartsData) {
        if (other.id === kart.id) continue;
        
        if (other.state !== kart.state) continue;
        if (other.state !== 'running' && other.state !== 'returning') continue;

        const distCmdX = Math.abs(kart.x - other.x);
        const distCmdY = Math.abs(kart.yPercent - other.yPercent);

        if (distCmdX < 60 && distCmdY < hitboxSize) {
            const pushForce = 0.5; 
            
            if (kart.yPercent > other.yPercent) {
                kart.yPercent += pushForce;
                kart.vy = 10; 
            } else {
                kart.yPercent -= pushForce;
                kart.vy = -10; 
            }
            
            kart.targetVy = 0;
            kart.aiState = 'cruising';
            kart.originalLaneY = kart.yPercent;
        }
    }
}

/* ==========================================================================
   LOGIQUE ITEMS INDIVIDUELLE
   ========================================================================== */

function giveKartItem(kart) {
    if (kart.heldItem) return;

    let itemType = 'banana';
    if (Math.random() > 0.5) {
        itemType = 'banana';
    } else {
        itemType = 'shell';
    }

    const isMobile = window.innerWidth < 769;
    const offset = isMobile ? -20 : -50; 
    const startX = kart.x + offset; 
    const startY = kart.yPercent;
    
    const dom = createItemDOM(itemType, startX, startY);

    kart.heldItem = {
        type: itemType,
        element: dom.div,
        imgElement: dom.img,
        spawnTime: Date.now(),
        offset: offset,
    };

    if (kart.state === 'returning') {
        kart.heldItem.element.style.opacity = '0';
    } else {
        kart.heldItem.element.style.opacity = '1';
    }

    kart.throwTime = Date.now() + randomRange(1000, 5000);
}

function activateItem(kart, containerWidth) {
    const item = kart.heldItem;
    if (!item) return;

    let startX = kart.x + item.offset;
    const isMobile = window.innerWidth < 769;

    if (item.type === 'shell') {
        const shellOffset = isMobile ? 20 : 50; 
        startX = kart.x + shellOffset; 
    }

    let initialState = 'active';
    let initialOpacity = '1';
    
    if (kart.state === 'returning') {
        initialState = 'returning';
        initialOpacity = '0';
    }

    const newItem = {
        type: item.type,
        state: initialState, 
        element: item.element,
        imgElement: item.imgElement,
        x: startX, 
        y: kart.yPercent,
        shooterId: kart.id,
        createdAt: Date.now()
    };
    
    newItem.element.style.opacity = initialOpacity;

    if (initialState === 'returning') {
        if (item.type === 'banana') {
            newItem.vx = -itemsConfig.roadSpeedPPS;
            newItem.vy = 0;
        } else {
            const shellSpeed = calculateSpeedPPS(containerWidth, true);
            newItem.vx = -shellSpeed;
            newItem.vy = randomRange(-1.5, 1.5);
        }
    } 
    else {
        if (item.type === 'banana') {
            newItem.vx = -itemsConfig.roadSpeedPPS;
            newItem.vy = 0;
        } else {
            newItem.vx = calculateSpeedPPS(containerWidth, true);
            newItem.vy = randomRange(-1.5, 1.5);
        }
    }

    newItem.currentFrame = 1;
    newItem.lastAnimTime = 0;

    activeItems.push(newItem);
    kart.heldItem = null; 
}

function updateItems(deltaTime, containerWidth) {
    const now = Date.now();

    for (let i = activeItems.length - 1; i >= 0; i--) {
        const item = activeItems[i];
        if (!item) continue; 

        item.x += item.vx * deltaTime;
        item.y += item.vy * deltaTime;

        if (item.type === 'shell') {
            if (now - item.lastAnimTime > itemsConfig.shell.animSpeed) {
                item.currentFrame++;
                if (item.currentFrame > 3) item.currentFrame = 1;
                item.imgElement.src = getShellPath(item.currentFrame);
                item.lastAnimTime = now;
            }
        }

        if (item.type === 'banana') {
            if (now - item.createdAt > itemsConfig.bananaLifeTime) {
                removeItem(i);
                continue;
            }
            if (item.state === 'active' && item.x < -200) {
                item.x += itemsConfig.lapDistance; 
                item.element.style.transform = `translateX(${item.x}px)`;
            }
            if (item.state === 'returning' && item.x < -200) {
                 removeItem(i); 
                 continue;
            }
        } else if (item.type === 'shell') {
            if (item.state === 'active' && item.x > containerWidth + 200) {
                removeItem(i);
                continue;
            }
            if (item.state === 'returning' && item.x < -200) {
                removeItem(i);
                continue;
            }
            if (item.y < -10 || item.y > 100) {
                removeItem(i);
                continue;
            }
        }

        const dynamicZ = Math.floor(400 - item.y);
        item.element.style.zIndex = dynamicZ;
        item.element.style.transform = `translateX(${item.x}px)`;
        item.element.style.bottom = `${item.y}%`;

        if (item.state === 'active' || item.state === 'returning') {
            if (checkItemCollisions(item, i)) {
                continue;
            }
        }
    }
}

function removeItem(index) {
    if (activeItems[index]) {
        if (activeItems[index].element) {
            activeItems[index].element.remove();
        }
        activeItems.splice(index, 1);
    }
}

function checkHeldItemCollisions() {
    const hitBoxX = 40; 
    const hitBoxY = 5;

    for (let i = activeItems.length - 1; i >= 0; i--) {
        const activeItem = activeItems[i];
        if (!activeItem) continue; 
        
        for (let kart of kartsData) {
            if (!kart.heldItem) continue;
            if (kart.state !== 'running' && kart.state !== 'returning') continue; 
            
            if (kart.state === 'running' && activeItem.state !== 'active') continue;
            if (kart.state === 'returning' && activeItem.state !== 'returning') continue;

            const heldX = kart.x + kart.heldItem.offset;
            const heldY = kart.yPercent;

            const dx = Math.abs(activeItem.x - heldX);
            const dy = Math.abs(activeItem.y - heldY);

            if (dx < hitBoxX && dy < hitBoxY) {
                removeItem(i);
                kart.heldItem.element.remove();
                kart.heldItem = null;
                break; 
            }
        }
    }

    for (let kartHolder of kartsData) {
        if (!kartHolder.heldItem) continue;
        if (kartHolder.state !== 'running' && kartHolder.state !== 'returning') continue;

        const heldX = kartHolder.x + kartHolder.heldItem.offset;
        const heldY = kartHolder.yPercent;

        for (let kartCrasher of kartsData) {
            if (kartCrasher.id === kartHolder.id) continue;
            
            if (kartCrasher.state !== kartHolder.state) continue;

            const dx = Math.abs(kartCrasher.x - heldX);
            const dy = Math.abs(kartCrasher.yPercent - heldY);

            if (dx < hitBoxX && dy < hitBoxY) {
                handleKartHit(kartCrasher, kartHolder.heldItem.type);
                kartHolder.heldItem.element.remove();
                kartHolder.heldItem = null;
                break;
            }
        }
    }
}

function checkItemCollisions(item, itemIndex) {
    const hitBoxX = 40; 
    const hitBoxY = 5;

    for (let kart of kartsData) {
        if (item.type === 'shell' && kart.id === item.shooterId) continue;
        
        if (item.type === 'banana' && kart.id === item.shooterId) {
            if (Date.now() - item.createdAt < 2000) {
                continue;
            }
        }

        if (kart.state !== 'running' && kart.state !== 'returning') continue; 

        if (kart.state === 'running' && item.state !== 'active') continue;
        if (kart.state === 'returning' && item.state !== 'returning') continue;

        const deltaX = Math.abs(item.x - kart.x);
        const deltaY = Math.abs(item.y - kart.yPercent);

        if (deltaX < hitBoxX && deltaY < hitBoxY) {
            handleKartHit(kart, item.type);
            removeItem(itemIndex);
            return true; 
        }
    }

    if (item.type === 'shell') {
        for (let j = 0; j < activeItems.length; j++) {
            if (j === itemIndex) continue;
            const other = activeItems[j];
            if (!other) continue; 

            if (item.state !== other.state) continue;
            
            if (other.type === 'banana') {
                const dx = Math.abs(item.x - other.x);
                const dy = Math.abs(item.y - other.y);
                
                if (dx < hitBoxX && dy < hitBoxY) {
                    const maxIdx = Math.max(itemIndex, j);
                    const minIdx = Math.min(itemIndex, j);
                    removeItem(maxIdx);
                    removeItem(minIdx);
                    return true;
                }
            }
        }
    }

    return false;
}

function handleKartHit(kart, cause) {
    kart.state = 'hit';
    kart.vy = 0; 
    kart.hitEndTime = Date.now() + 2000; 
    
    kart.element.style.filter = "brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)"; 
    setTimeout(() => { kart.element.style.filter = "none"; }, 300);
}

function updateItemBoxes(deltaTime, screenWidth) {
    const now = Date.now();
    
    const hitBoxX = itemsConfig.box.hitboxX;
    const hitBoxY = itemsConfig.box.hitboxY;

    const limitXRight = screenWidth + 150;
    const limitXLeft = -150;

    const loopTime = itemsConfig.lapDistance / itemsConfig.roadSpeedPPS;
    const visibleDistance = limitXRight - limitXLeft; 
    const timeVisible = visibleDistance / itemsConfig.roadSpeedPPS;
    const timeInvisible = loopTime - timeVisible;
    const returnSpeed = visibleDistance / timeInvisible;

    itemBoxes.forEach(box => {
        if (!box.active) {
            if (now > box.reactivateTime) {
                box.active = true;
                box.element.style.display = 'block';
            } else {
                box.element.style.display = 'none';
            }
        }

        if (box.state === 'running') {
            box.x -= itemsConfig.roadSpeedPPS * deltaTime;
            
            if (box.x < limitXLeft) {
                box.state = 'returning';
                box.returnSpeed = returnSpeed;
            }
        } else {
            box.x += box.returnSpeed * deltaTime;
            
            if (box.x > limitXRight) {
                box.state = 'running';
            }
        }

        if (box.active) {
            for (let kart of kartsData) {
                if (kart.heldItem) continue;
                if (kart.state !== 'running' && kart.state !== 'returning') continue;

                if (box.state === 'running' && kart.state !== 'running') continue;
                if (box.state === 'returning' && kart.state !== 'returning') continue;

                const dx = Math.abs(box.x - kart.x);
                const dy = Math.abs(box.y - kart.yPercent);

                if (dx < hitBoxX && dy < hitBoxY) {
                    box.active = false;
                    box.reactivateTime = now + 3000;
                    
                    setTimeout(() => {
                        giveKartItem(kart);
                    }, 3000);
                    break;
                }
            }
        }

        if (box.state === 'returning') {
            box.element.style.opacity = '0';
        } else {
            box.element.style.opacity = '1';
        }

        const floatY = Math.sin(now * 0.003) * 10; 
        box.element.style.transform = `translateX(${box.x}px) translateY(${floatY}px)`;
    });
}


/* ==========================================================================
   BOUCLE D'ANIMATION
   ========================================================================== */

function animateKarts(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;

    let deltaTime = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;

    if (deltaTime > 0.1) {
        deltaTime = 0.016;
    }

    const container = document.getElementById('karts-container');
    
    if (container) {
        const screenWidth = container.offsetWidth;
        const limitX = screenWidth + 150;
        const now = Date.now();

        checkHeldItemCollisions();

        kartsData.forEach(kart => {
            if (kart.state === 'running' || kart.state === 'returning') {
                
                if (kart.heldItem && now > kart.throwTime) {
                    activateItem(kart, screenWidth);
                }

                updateKartAI(kart, deltaTime);

                let moveAmountX = 0;
                let moveAmountY = kart.vy * deltaTime;
                
                if (kart.state === 'running') {
                    moveAmountX = kart.speedPPS * deltaTime;
                    kart.x += moveAmountX;
                } else {
                    moveAmountX = (kart.speedPPS / 2) * deltaTime;
                    kart.x -= moveAmountX;
                }
                
                kart.yPercent += moveAmountY;

                if (kart.yPercent > ROAD_LIMITS.max) { kart.yPercent = ROAD_LIMITS.max; kart.vy = 0; }
                if (kart.yPercent < ROAD_LIMITS.min) { kart.yPercent = ROAD_LIMITS.min; kart.vy = 0; }
                
                checkKartKartCollisions(kart);

                kart.element.style.transform = `translateX(${kart.x}px)`;
                kart.element.style.bottom = `${kart.yPercent}%`;
                const zVal = Math.floor(400 - kart.yPercent);
                kart.element.style.zIndex = zVal;

                if (kart.state === 'running' && kart.x > limitX) {
                    kart.state = 'returning';
                    kart.element.style.opacity = '0'; 
                }
                else if (kart.state === 'returning' && kart.x <= -150) {
                    startKartRun(kart);
                }
            } 
            else if (kart.state === 'hit') {
                const moveAmount = -itemsConfig.roadSpeedPPS * deltaTime;
                kart.x += moveAmount;
                kart.element.style.transform = `translateX(${kart.x}px)`;

                if (kart.x < -150) {
                    kart.element.style.opacity = '0';
                    kart.state = 'waiting_respawn';
                    const remainingStun = Math.max(0, kart.hitEndTime - Date.now());
                    const specialDelay = remainingStun * 1.5;
                    scheduleRespawnForHit(kart, specialDelay);
                }
                else if (Date.now() > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.speedPPS = calculateSpeedPPS(screenWidth);
                }
            }

            if (kart.heldItem && kart.heldItem.element) {
                if (kart.state === 'returning') {
                    kart.heldItem.element.style.opacity = '0';
                } 
                else {
                    kart.heldItem.element.style.opacity = '1';
                }
                
                const holdX = kart.x + kart.heldItem.offset;
                kart.heldItem.element.style.transform = `translateX(${holdX}px)`;
                kart.heldItem.element.style.bottom = `${kart.yPercent}%`;
                kart.heldItem.element.style.zIndex = Math.floor(400 - kart.yPercent);
            }
        });

        updateItems(deltaTime, screenWidth);
        updateItemBoxes(deltaTime, screenWidth);
    }

    requestAnimationFrame(animateKarts);
}

function showLogo() {
    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => {
        setTimeout(() => {
            el.classList.add('visible');
        }, 100);
    });
}

document.addEventListener('DOMContentLoaded', () => {
    initCharacters();
    requestAnimationFrame(animateKarts);
    showLogo();
});
