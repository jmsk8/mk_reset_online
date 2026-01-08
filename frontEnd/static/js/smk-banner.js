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
    }
};

let kartsData = [];
let activeItems = []; 
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

    const shuffledChars = shuffleArray([...charactersList]);

    shuffledChars.forEach((charName, index) => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('kart-container-moving');
        
        const verticalPos = 2 + (index * 3); 
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

        const firstItemDelay = randomRange(7000, 15000);

        kartsData.push({
            id: index,
            element: wrapper,
            imgElement: img,
            x: startX,
            yPercent: verticalPos,
            speedPPS: 0, 
            state: 'waiting_initial', 
            charName: charName,
            hitEndTime: 0,
            nextItemTime: Date.now() + firstItemDelay,
            heldItem: null
        });
    });

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
    
    if (type === 'shell') {
        itemDiv.style.width = `${itemsConfig.shell.width}px`;
        img.src = getShellPath(1);
    } else {
        itemDiv.style.width = `${itemsConfig.banana.width}px`;
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

    // --- CORRECTION BUG CYCLE ---
    // Si un temps est déjà prévu dans le futur, on le garde ! 
    // Sinon on réinitialise (cas du premier spawn ou après un tir réussi)
    if (!kart.nextItemTime || kart.nextItemTime < Date.now()) {
        kart.nextItemTime = Date.now() + randomRange(7000, 15000);
    }

    kart.x = -150;
    kart.state = 'running';
    kart.element.style.opacity = '1';
    kart.element.style.filter = 'none';
    
    if (kart.heldItem && kart.heldItem.element) {
        kart.heldItem.element.remove();
        kart.heldItem = null;
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
   LOGIQUE ITEMS INDIVIDUELLE
   ========================================================================== */

function tryKartUseItem(kart, containerWidth) {
    if (kart.x < 50 || kart.x > containerWidth - 50) {
        // Si on rate le coche, on réessaie très vite (1s)
        kart.nextItemTime = Date.now() + 1000;
        return;
    }

    // On prépare le chrono pour le PROCHAIN item (dans 7 à 15s)
    kart.nextItemTime = Date.now() + randomRange(7000, 15000);

    // --- DECISION DU TYPE D'ITEM ---
    let itemType = 'banana';
    
    if (Math.random() > 0.5) {
        itemType = 'banana';
    } else {
        const averagePPS = calculateSpeedPPS(containerWidth);
        const maxGapDistance = averagePPS * 5; 

        const potentialTargets = kartsData.filter(k => 
            k.state === 'running' && 
            k.id !== kart.id && 
            k.x > kart.x && 
            (k.x - kart.x) < maxGapDistance
        );

        if (potentialTargets.length === 0) {
            itemType = 'banana';
        } else {
            itemType = 'shell';
        }
    }

    // --- CORRECTION POSITIONNEMENT (Banane vs Coquille) ---
    // Banane : Apparaît derrière (-50)
    // Coquille : Apparaît devant (+50)
    const offset = (itemType === 'banana') ? -50 : 50;
    
    const startX = kart.x + offset; 
    const startY = kart.yPercent;
    
    const dom = createItemDOM(itemType, startX, startY);

    kart.heldItem = {
        type: itemType,
        element: dom.div,
        imgElement: dom.img,
        spawnTime: Date.now(),
        offset: offset // On stocke l'offset pour qu'il suive correctement
    };
}

function activateItem(kart, containerWidth) {
    const item = kart.heldItem;
    if (!item) return;

    const newItem = {
        type: item.type,
        element: item.element,
        imgElement: item.imgElement,
        x: kart.x + item.offset, // Position finale au lâcher
        y: kart.yPercent,
        shooterId: kart.id,
        createdAt: Date.now()
    };

    if (item.type === 'banana') {
        newItem.vx = -itemsConfig.roadSpeedPPS;
        newItem.vy = 0;
        console.log(`🍌 ${kart.charName} lâche une banane derrière.`);
    } else {
        newItem.vx = calculateSpeedPPS(containerWidth, true);
        newItem.vy = randomRange(-1.5, 1.5);
        newItem.currentFrame = 1;
        newItem.lastAnimTime = 0;
        console.log(`🐢 ${kart.charName} projette une coquille devant !`);
    }

    activeItems.push(newItem);
    kart.heldItem = null; 
}

function updateItems(deltaTime, containerWidth) {
    const now = Date.now();

    for (let i = activeItems.length - 1; i >= 0; i--) {
        const item = activeItems[i];

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
            if (item.x < -200) {
                item.x += itemsConfig.lapDistance; 
                item.element.style.transform = `translateX(${item.x}px)`;
            }
        } else if (item.type === 'shell') {
            if (item.x > containerWidth + 200 || item.y < -10 || item.y > 100) {
                removeItem(i);
                continue;
            }
        }

        const dynamicZ = Math.floor(400 - item.y);
        item.element.style.zIndex = dynamicZ;
        item.element.style.transform = `translateX(${item.x}px)`;
        item.element.style.bottom = `${item.y}%`;

        if (checkItemCollisions(item, i)) {
            continue;
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

function checkItemCollisions(item, itemIndex) {
    const hitBoxX = 40; 
    const hitBoxY = 5;

    for (let kart of kartsData) {
        // --- REGLES DE COLLISION ---
        // 1. Un tireur ne se prend jamais sa propre coquille
        if (item.type === 'shell' && kart.id === item.shooterId) continue;
        
        // 2. CORRECTION : Un tireur ne se prend pas sa banane PENDANT les 2 premières secondes
        // Cela évite le bug où il la lâche et roule dessus immédiatement.
        // Après 2s, il peut se la prendre s'il refait un tour.
        if (item.type === 'banana' && kart.id === item.shooterId) {
            if (Date.now() - item.createdAt < 2000) {
                continue;
            }
        }

        if (kart.state !== 'running') continue;

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
            
            if (other.type === 'banana') {
                const dx = Math.abs(item.x - other.x);
                const dy = Math.abs(item.y - other.y);
                
                if (dx < hitBoxX && dy < hitBoxY) {
                    console.log("💥 Coquille détruit Banane !");
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
    const emoji = cause === 'banana' ? '🍌' : '🐢';
    console.log(`💥 ${kart.charName} a percuté ${emoji} !`);
    
    kart.state = 'hit';
    kart.hitEndTime = Date.now() + 2000; 
    
    kart.element.style.filter = "brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)"; 
    setTimeout(() => { kart.element.style.filter = "none"; }, 300);
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

        kartsData.forEach(kart => {
            if (kart.state === 'running' && now > kart.nextItemTime && !kart.heldItem) {
                tryKartUseItem(kart, screenWidth);
            }

            if (kart.heldItem) {
                // L'item suit le kart avec le bon offset (devant ou derrière)
                const holdX = kart.x + kart.heldItem.offset;
                kart.heldItem.element.style.transform = `translateX(${holdX}px)`;
                kart.heldItem.element.style.bottom = `${kart.yPercent}%`;
                kart.heldItem.element.style.zIndex = Math.floor(400 - kart.yPercent);

                if (now - kart.heldItem.spawnTime > 500) {
                    activateItem(kart, screenWidth);
                }
            }

            if (kart.state === 'running') {
                const moveAmount = kart.speedPPS * deltaTime;
                kart.x += moveAmount;
                kart.element.style.transform = `translateX(${kart.x}px)`;

                if (kart.x > limitX) {
                    kart.state = 'returning';
                    kart.element.style.opacity = '0'; 
                }
            } 
            else if (kart.state === 'returning') {
                const moveAmount = kart.speedPPS * deltaTime;
                kart.x -= moveAmount; 
                
                if (kart.x <= -150) {
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
        });

        updateItems(deltaTime, screenWidth);
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
    console.log("🏎️ MK Reset Banner : Correction Banane & Cycle Item appliqués.");
    initCharacters();
    requestAnimationFrame(animateKarts);
    showLogo();
});
