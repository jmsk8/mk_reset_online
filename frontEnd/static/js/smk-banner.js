/* ==========================================================================
   CONFIGURATIONS & VARIABLES GLOBALES
   ========================================================================== */

const charactersList = [
    'mario', 'luigi', 'peach', 'toad',
    'yoshi', 'bowser', 'dk', 'koopa'
];

const shellConfig = {
    folder: 'green-shell',
    baseName: 'green-shell',
    width: 48, 
    height: 48,
    animSpeed: 100, 
    roadSpeedPPS: 182 
};

let kartsData = [];
let shellData = {
    active: false,
    element: null,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0, 
    currentFrame: 1,
    lastAnimTime: 0,
    shooterId: null 
};

let lastFrameTime = 0;
let nextAvailableRespawnTime = 0;
let nextShellThrowTime = 0; 

// Nouvelle variable pour gérer le premier lancer fixe
let isFirstShell = true;

/* ==========================================================================
   UTILITAIRES
   ========================================================================== */

function getCharacterPath(charName) {
    return `static/img/${charName}/${charName}-static.png`;
}

function getShellPath(frame) {
    return `static/img/${shellConfig.folder}/${shellConfig.baseName}${frame}.png`;
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

function calculateSpeedPPS(screenWidth, isShell = false) {
    const isMobile = window.innerWidth < 769;
    const baseDuration = isMobile ? 4 : 8; 
    
    if (isShell) {
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
    isFirstShell = true; // Reset du flag

    createShellElement(container);

    const shuffledChars = shuffleArray([...charactersList]);

    shuffledChars.forEach((charName, index) => {
        const wrapper = document.createElement('div');
        wrapper.classList.add('kart-container-moving');
        
        const verticalPos = 2 + (index * 3); 
        wrapper.style.bottom = `${verticalPos}%`;
        // Z-Index initial des karts
        wrapper.style.zIndex = 350 - index; 
        
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
            speedPPS: 0, 
            state: 'waiting_initial', 
            charName: charName,
            hitEndTime: 0 
        });
    });

    scheduleNextShell();
    spawnNextKart(0);
}

function createShellElement(container) {
    const shellDiv = document.createElement('div');
    shellDiv.id = 'active-green-shell';
    shellDiv.style.position = 'absolute';
    shellDiv.style.width = '48px'; 
    shellDiv.style.zIndex = '400'; 
    shellDiv.style.display = 'none';
    shellDiv.style.pointerEvents = 'none';
    
    const shellImg = document.createElement('img');
    shellImg.src = getShellPath(1);
    shellImg.style.width = '100%';
    
    shellDiv.appendChild(shellImg);
    container.appendChild(shellDiv);
    
    shellData.element = shellDiv;
    shellData.imgElement = shellImg;
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

    kart.speedPPS = calculateSpeedPPS(screenWidth); 
    kart.x = -150;
    kart.state = 'running';
    
    kart.element.style.opacity = '1';
    kart.element.style.filter = 'none';
}

function scheduleRespawn(kart, extraDelay = 0) {
    const now = Date.now();
    const naturalDelay = randomRange(7500, 9000);
    let targetTime = now + naturalDelay + extraDelay;

    if (targetTime < nextAvailableRespawnTime) {
        targetTime = nextAvailableRespawnTime;
    }

    nextAvailableRespawnTime = targetTime + 800;
    const actualDelay = targetTime - now;

    setTimeout(() => {
        startKartRun(kart);
    }, actualDelay);
}

/* ==========================================================================
   LOGIQUE COQUILLE VERTE (INTELLIGENTE)
   ========================================================================== */

function scheduleNextShell() {
    let delay;
    
    // 1ere Directive : 8s fixe pour le premier lancer
    if (isFirstShell) {
        delay = 8000;
        isFirstShell = false;
        console.log("⏱️ Timer Shell initial : 8s");
    } else {
        delay = randomRange(10000, 20000);
        console.log(`⏱️ Prochaine Shell dans : ${(delay/1000).toFixed(1)}s`);
    }
    
    nextShellThrowTime = Date.now() + delay;
}

function tryThrowShell(containerWidth) {
    if (shellData.active) return;

    // Récupérer uniquement les karts en course et sur l'écran
    // On trie par position X décroissante (celui le plus à droite en premier)
    // Cela nous aide pour trouver "celui de devant"
    let racers = kartsData
        .filter(k => k.state === 'running' && k.x > 0 && k.x < (containerWidth - 100))
        .sort((a, b) => b.x - a.x);

    if (racers.length < 2) return; // Il faut au moins un tireur et une cible

    // Calculer la distance équivalente à 5 secondes de course
    // On prend la vitesse moyenne d'un kart pour cette estimation
    const averagePPS = calculateSpeedPPS(containerWidth);
    const maxGapDistance = averagePPS * 5; 

    // Filtrer les tireurs potentiels selon la regle 3 (écart)
    let validShooters = [];

    // On parcourt la liste (qui est triée du premier au dernier)
    // Un tireur potentiel est quelqu'un qui a un kart devant lui (index inférieur dans le tableau trié)
    for (let i = 1; i < racers.length; i++) {
        const shooter = racers[i];
        const target = racers[i - 1]; // Le kart juste devant lui

        const gap = target.x - shooter.x;

        // 3eme Directive : Si l'écart est INFÉRIEUR à 5 secondes (distance), c'est validé
        if (gap < maxGapDistance) {
            validShooters.push(shooter);
        }
    }

    if (validShooters.length === 0) {
        console.log("🚫 Pas de tireur valide (trop d'écart entre les karts).");
        // On retente plus tard rapidement
        nextShellThrowTime = Date.now() + 2000;
        return;
    }

    // Sélection aléatoire parmi les valides
    const shooter = validShooters[Math.floor(Math.random() * validShooters.length)];
    
    shellData.active = true;
    shellData.shooterId = shooter.id;
    
    shellData.x = shooter.x + 70; 
    shellData.y = shooter.yPercent; 

    shellData.vx = calculateSpeedPPS(containerWidth, true);
    shellData.vy = randomRange(-1.5, 1.5); 

    shellData.element.style.display = 'block';
    shellData.element.style.bottom = `${shellData.y}%`;
    shellData.element.style.transform = `translateX(${shellData.x}px)`;
    
    console.log(`🐢 Green Shell lancée par ${shooter.charName} !`);
}

function updateShell(deltaTime, containerWidth) {
    if (!shellData.active) return;

    shellData.x += shellData.vx * deltaTime;
    shellData.y += shellData.vy * deltaTime; 

    // Animation frames
    const now = Date.now();
    if (now - shellData.lastAnimTime > shellConfig.animSpeed) {
        shellData.currentFrame++;
        if (shellData.currentFrame > 3) shellData.currentFrame = 1;
        shellData.imgElement.src = getShellPath(shellData.currentFrame);
        shellData.lastAnimTime = now;
    }

    // 2eme Directive : Gestion du Z-Index (Profondeur)
    // Plus Y est grand (haut dans l'écran), plus Z doit être petit (derrière)
    // Base 360 permet d'être au dessus de 350 (Y=0) mais dessous si Y augmente
    const dynamicZ = Math.floor(360 - shellData.y);
    shellData.element.style.zIndex = dynamicZ;

    // Mise à jour visuelle
    shellData.element.style.transform = `translateX(${shellData.x}px)`;
    shellData.element.style.bottom = `${shellData.y}%`;

    // Sortie d'écran
    if (shellData.x > containerWidth + 100 || shellData.y < -10 || shellData.y > 100) {
        resetShell();
        scheduleNextShell();
        return;
    }

    checkCollisions();
}

function checkCollisions() {
    const shellHitX = 50; 
    const shellHitY = 5;  

    for (let kart of kartsData) {
        if (kart.id === shellData.shooterId || kart.state !== 'running') continue;

        const deltaX = Math.abs(shellData.x - kart.x);
        const deltaY = Math.abs(shellData.y - kart.yPercent);

        if (deltaX < shellHitX && deltaY < shellHitY) {
            handleKartHit(kart);
            resetShell();
            scheduleNextShell();
            break; 
        }
    }
}

function resetShell() {
    shellData.active = false;
    shellData.element.style.display = 'none';
}

function handleKartHit(kart) {
    console.log(`💥 ${kart.charName} a été touché !`);
    
    kart.state = 'hit';
    kart.hitEndTime = Date.now() + 4000; 
    
    kart.element.style.filter = "brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)"; 
    setTimeout(() => { kart.element.style.filter = "none"; }, 300);
}

/* ==========================================================================
   BOUCLE D'ANIMATION
   ========================================================================== */

function animateKarts(timestamp) {
    if (!lastFrameTime) lastFrameTime = timestamp;
    const deltaTime = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;

    const container = document.getElementById('karts-container');
    
    if (container) {
        const screenWidth = container.offsetWidth;
        const limitX = screenWidth + 150;

        if (Date.now() > nextShellThrowTime && !shellData.active) {
            tryThrowShell(screenWidth);
        }

        updateShell(deltaTime, screenWidth);

        kartsData.forEach(kart => {
            if (kart.state === 'running') {
                const moveAmount = kart.speedPPS * deltaTime;
                kart.x += moveAmount;
                kart.element.style.transform = `translateX(${kart.x}px)`;

                if (kart.x > limitX) {
                    kart.state = 'waiting_respawn';
                    scheduleRespawn(kart);
                }
            } 
            else if (kart.state === 'hit') {
                const moveAmount = -shellConfig.roadSpeedPPS * deltaTime;
                kart.x += moveAmount;
                kart.element.style.transform = `translateX(${kart.x}px)`;

                if (kart.x < -150) {
                    kart.state = 'waiting_respawn';
                    const remainingStun = Math.max(0, kart.hitEndTime - Date.now());
                    const penaltyDelay = 2000 + remainingStun;
                    scheduleRespawn(kart, penaltyDelay);
                }
                else if (Date.now() > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.speedPPS = calculateSpeedPPS(screenWidth);
                }
            }
        });
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
    console.log("🏎️ MK Reset Banner : Shell IA v2 chargée (8s, Profondeur, Ecart Max).");
    initCharacters();
    requestAnimationFrame(animateKarts);
    showLogo();
});
