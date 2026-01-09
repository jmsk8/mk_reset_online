/* ==========================================================================
   CONFIGURATIONS & VARIABLES GLOBALES
   ========================================================================== */

const charactersList = [
    'mario', 'luigi', 'peach', 'toad',
    'yoshi', 'bowser', 'dk', 'koopa'
];

/**
 * GAME_CONFIG : 
 * Centralise tous les paramètres du jeu. 
 * Modifie ces valeurs pour ajuster le gameplay.
 */
const GAME_CONFIG = {
    // --- VITESSES ET DISTANCES ---
    speeds: {
        roadPPS: 182,            // Vitesse de défilement de la route (Pixels Par Seconde)
        lapDistance: 4000,       // Distance pour "boucler" un tour
        kartBaseSpeedPC: 8,      // Diviseur de vitesse (plus petit = plus vite) sur PC
        kartBaseSpeedMobile: 4,  // Diviseur de vitesse sur Mobile
        projectileSpeedMult: 2.0,// Multiplicateur de vitesse des carapaces
        returnLaneSpeed: 20      // Vitesse à laquelle un kart revient sur sa ligne après esquive
    },

    // --- TEMPS ET DÉLAIS (RESTAURÉ ICI !) ---
    delays: {
        stunDuration: 2000,      // Temps d'immobilisation après un choc
        boxRespawn: 2000,        // Temps de désactivation d'une Item Box après contact
        itemGrant: 3000,         // Temps d'attente pour obtenir l'objet après la boîte
        bananaLife: 40000,       // Durée de vie d'une banane au sol
        invincibilityOwnItem: 2000 // Temps invulnérabilité propre banane
    },

    // --- INTELLIGENCE ARTIFICIELLE (FUSIONNÉE) ---
    ai: {
        // Gestion de l'item (tir/pose)
        holdItemMin: 500,        
        holdItemMax: 8000,       
        
        // Détection Danger (Bananes) - PRIORITÉ 1
        detectionRange: 250,     
        dodgeIntensityMin: 20,   
        dodgeIntensityMax: 50,   

        // Overtaking (Dépassement) - PRIORITÉ 2
        overtakeDetectionRange: 120, // Distance pour commencer à se décaler si un kart est devant
        overtakeMinDistance: 12,     // Distance verticale min à respecter entre 2 karts
        overtakeSideSpeed: 10,       // Vitesse latérale pour doubler

        // Détection Boîtes - PRIORITÉ 3
        boxDetectionRange: 400,  
        boxSeekIntensity: 25,     

        // Wandering (Flânerie / Décalage aléatoire) - PRIORITÉ 4
        wanderIntervalMin: 2000,     // Temps min entre deux décalages aléatoires
        wanderIntervalMax: 6000,     // Temps max entre deux décalages aléatoires
        wanderDurationMin: 500,      // Durée du décalage
        wanderDurationMax: 1500,     // Durée max du décalage
        wanderSpeed: 4               // Vitesse douce du décalage
    },

    // --- HITBOXES (Zones de collision) ---
    hitboxes: {
        // Collision Kart contre Kart
        kartVsKart: { x: 60, y: 5 },
        
        // Collision Objet contre Kart (ou Objet contre Objet)
        itemVsKart: { x: 40, y: 5 }, 

        // Collision Kart contre Item Box
        itemBox: { 
            toleranceX: 10,
            toleranceY: 8
        }
    },

    // --- VISUELS ITEMS ---
    visuals: {
        shell: {
            width: 48,
            widthMobile: 20,
            animSpeed: 100
        },
        banana: {
            width: 32,
            widthMobile: 20 
        },
        box: {
            sizePC: 42,
            sizeMobile: 28
        }
    }
};

/* --- VARIABLES D'ÉTAT (NE PAS TOUCHER) --- */
let kartsData = [];
let activeItems = []; 
let itemBoxes = [];
let lastFrameTime = 0;
let nextAvailableRespawnTime = 0; 
let animationId = null; // Pour gérer la pause/reprise

/* ==========================================================================
   UTILITAIRES
   ========================================================================== */

function getCharacterPath(charName) {
    return `static/img/${charName}/${charName}-static.png`;
}

function getShellPath(frame) {
    return `static/img/green-shell/green-shell${frame}.png`;
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
    const baseDuration = isMobile ? GAME_CONFIG.speeds.kartBaseSpeedMobile : GAME_CONFIG.speeds.kartBaseSpeedPC; 
    
    if (isProjectile) {
        const distance = screenWidth + 150;
        const baseSpeed = distance / baseDuration;
        return baseSpeed * GAME_CONFIG.speeds.projectileSpeedMult; 
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
    const ROAD_LIMITS = { min: 0, max: 30 };

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
            heldItem: null,
            nextWanderTime: Date.now() + randomRange(1000, 5000),
            wanderEndTime: 0,
            wanderVy: 0
        });
    });

    const isMobile = window.innerWidth < 769;
    const currentBoxSize = isMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;

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
        const size = isMobile ? GAME_CONFIG.visuals.shell.widthMobile : GAME_CONFIG.visuals.shell.width; 
        itemDiv.style.width = `${size}px`;
        img.src = getShellPath(1);
    } else {
        const size = isMobile ? GAME_CONFIG.visuals.banana.widthMobile : GAME_CONFIG.visuals.banana.width + 4; 
        itemDiv.style.width = `${size}px`;
        img.src = 'static/img/banana.png';
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
    
    // ROBUSTESSE : Si le kart a un item en revenant en jeu, on s'assure
    // qu'il est prêt à être affiché correctement (mais l'opacité sera gérée par animateKarts)
    if (kart.heldItem && kart.heldItem.element) {
        // On ne force pas l'opacité ici, on laisse animateKarts le faire
        // au moment où le kart entrera vraiment sur l'écran.
        // Mais on peut repousser légèrement le tir pour éviter un tir immédiat au spawn
        if (kart.throwTime < Date.now()) {
            kart.throwTime = Date.now() + randomRange(1000, 3000);
        }
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
    const aiConfig = GAME_CONFIG.ai;
    const laneWidth = 12; 
    const ROAD_LIMITS = { min: 0, max: 30 };
    const now = Date.now();
    
    // --- 1. DETECTION DES DANGERS (Bananes) - PRIORITÉ ABSOLUE ---
    let dangerFound = false;
    let avoidDirection = 0; 

    for (const item of activeItems) {
        if (!item) continue;
        if (kart.state === 'running' && item.state !== 'active') continue;
        if (kart.state === 'returning' && item.state !== 'returning') continue;
        if (item.type !== 'banana') continue; 

        let distFront = (kart.state === 'running') ? item.x - kart.x : kart.x - item.x;
        
        if (distFront > 0 && distFront < aiConfig.detectionRange) {
            if (Math.abs(item.y - kart.yPercent) < laneWidth) {
                dangerFound = true;
                let naturalDir = (item.y > kart.yPercent) ? -1 : 1;
                const safetyMargin = 2; 

                // Logique pour ne pas sortir de la route en esquivant
                if (naturalDir === 1) { 
                    avoidDirection = (kart.yPercent > ROAD_LIMITS.max - safetyMargin) ? -1 : 1;
                } else { 
                    avoidDirection = (kart.yPercent < ROAD_LIMITS.min + safetyMargin) ? 1 : -1;
                }
                break; 
            }
        }
    }
    
    // SI DANGER : On coupe court, on esquive et on sort de la fonction
    if (dangerFound) {
        if (kart.aiState !== 'dodging') {
            kart.aiState = 'dodging';
            kart.originalLaneY = kart.yPercent; // On mémorise où on était
            kart.dodgeIntensity = randomRange(aiConfig.dodgeIntensityMin, aiConfig.dodgeIntensityMax); 
        }
        kart.targetVy = avoidDirection * kart.dodgeIntensity;
        // Application lissée
        kart.vy += (kart.targetVy - kart.vy) * 5 * deltaTime;
        return; // FIN DE L'IA POUR CETTE FRAME
    } 

    // --- 2. GESTION DU DÉPASSEMENT (OVERTAKING) ---
    // Si pas de danger, on vérifie si on va rentrer dans un autre kart
    let overtakeFound = false;
    
    if (kart.state === 'running') { // On ne gère le dépassement qu'en course normale
        for (const other of kartsData) {
            if (other.id === kart.id) continue;
            if (other.state !== 'running') continue;

            const distX = other.x - kart.x;
            const distY = Math.abs(other.yPercent - kart.yPercent);

            // Si le kart est juste devant (0 à detectionRange) ET trop proche verticalement
            if (distX > 0 && distX < aiConfig.overtakeDetectionRange && distY < aiConfig.overtakeMinDistance) {
                overtakeFound = true;
                kart.aiState = 'overtaking';
                
                // On décide si on passe par le haut ou le bas
                // Si on est déjà un peu au dessus, on va en haut, sinon en bas
                let dir = (kart.yPercent > other.yPercent) ? 1 : -1;
                
                // Vérif limites route
                if (kart.yPercent > ROAD_LIMITS.max - 5) dir = -1;
                if (kart.yPercent < ROAD_LIMITS.min + 5) dir = 1;

                kart.targetVy = dir * aiConfig.overtakeSideSpeed;
                break; // On gère un dépassement à la fois
            }
        }
    }

    if (overtakeFound) {
        kart.originalLaneY = kart.yPercent; // On met à jour notre nouvelle ligne de ref
        kart.vy += (kart.targetVy - kart.vy) * 5 * deltaTime;
        return;
    }

    // --- 3. RECHERCHE D'ITEM BOX ---
    // Si pas danger et pas dépassement
    let boxTargetFound = false;
    if (!kart.heldItem) {
        for (const box of itemBoxes) {
            if (!box.active) continue;
            if (kart.state === 'running' && box.state !== 'running') continue;
            if (kart.state === 'returning' && box.state !== 'returning') continue;

            let distToBox = (kart.state === 'running') ? box.x - kart.x : kart.x - box.x;

            if (distToBox > 0 && distToBox < aiConfig.boxDetectionRange) {
                const diffY = box.y - kart.yPercent;
                if (Math.abs(diffY) > 2) {
                    kart.aiState = 'seeking_box';
                    boxTargetFound = true;
                    kart.targetVy = (diffY > 0) ? aiConfig.boxSeekIntensity : -aiConfig.boxSeekIntensity;
                    break;
                }
            }
        }
    }

    if (boxTargetFound) {
        kart.vy += (kart.targetVy - kart.vy) * 5 * deltaTime;
        return;
    }

    // --- 4. FLÂNERIE (WANDERING) ---
    // Si rien de tout ça, on peut se balader un peu
    
    // Est-il temps de lancer un nouveau mouvement aléatoire ?
    if (now > kart.nextWanderTime) {
        // Calcul du prochain temps
        kart.nextWanderTime = now + randomRange(aiConfig.wanderIntervalMin, aiConfig.wanderIntervalMax);
        
        // Définition du mouvement
        kart.wanderEndTime = now + randomRange(aiConfig.wanderDurationMin, aiConfig.wanderDurationMax);
        
        // Choix direction (Haut ou Bas)
        let dir = (Math.random() > 0.5) ? 1 : -1;

        // CONTRAINTE : Si en haut -> Bas obligatoire. Si en bas -> Haut obligatoire.
        if (kart.yPercent > ROAD_LIMITS.max - 8) dir = -1;
        if (kart.yPercent < ROAD_LIMITS.min + 8) dir = 1;

        kart.wanderVy = dir * aiConfig.wanderSpeed;
        kart.aiState = 'wandering';
    }

    // Est-on en cours de flânerie ?
    if (now < kart.wanderEndTime) {
        kart.targetVy = kart.wanderVy;
        // Pendant qu'on flâne, on met à jour "originalLaneY" pour ne pas que le kart revienne en arrière quand c'est fini
        kart.originalLaneY = kart.yPercent; 
    } 
    else {
        // --- 5. RETOUR AU CALME (CRUISING) ---
        // Si aucun événement, on se stabilise
        
        // Si on sortait d'une esquive (dodging), on essaie de revenir à la ligne d'origine
        if (kart.aiState === 'dodging') {
            kart.aiState = 'returning';
        }
        
        // État de retour à la ligne (après esquive seulement)
        if (kart.aiState === 'returning') {
            if (kart.willReturnToLane) {
                const diff = kart.originalLaneY - kart.yPercent;
                if (Math.abs(diff) < 1) {
                    kart.targetVy = 0;
                    kart.yPercent = kart.originalLaneY; 
                    kart.aiState = 'cruising';
                } else {
                    const returnSpeed = GAME_CONFIG.speeds.returnLaneSpeed;
                    kart.targetVy = (diff > 0 ? 1 : -1) * returnSpeed;
                }
            } else {
                kart.targetVy = 0;
                kart.aiState = 'cruising';
                kart.originalLaneY = kart.yPercent;
            }
        } else {
            // Mode croisière standard
            kart.targetVy = 0;
            kart.aiState = 'cruising';
            kart.originalLaneY = kart.yPercent;
        }
    }

    // Application finale de la vélocité avec inertie
    kart.vy += (kart.targetVy - kart.vy) * 5 * deltaTime;
}

function checkKartKartCollisions(kart) {
    const hitboxSize = GAME_CONFIG.hitboxes.kartVsKart.y; 

    for (const other of kartsData) {
        if (other.id === kart.id) continue;
        
        if (other.state !== kart.state) continue;
        if (other.state !== 'running' && other.state !== 'returning') continue;

        const distCmdX = Math.abs(kart.x - other.x);
        const distCmdY = Math.abs(kart.yPercent - other.yPercent);

        if (distCmdX < GAME_CONFIG.hitboxes.kartVsKart.x && distCmdY < hitboxSize) {
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

    kart.throwTime = Date.now() + randomRange(GAME_CONFIG.ai.holdItemMin, GAME_CONFIG.ai.holdItemMax);
}

function activateItem(kart, containerWidth) {
    const item = kart.heldItem;
    if (!item) return;

    // --- 1. DEFINITION DE L'ETAT INITIAL ---
    // L'item hérite de l'état du kart.
    // Si le kart est en mode retour (invisible), l'item naît en mode retour.
    let initialState = 'active';
    if (kart.state === 'returning' || kart.state === 'waiting_respawn') {
        initialState = 'returning';
    }

    // Calcul de la position de départ
    let startX = kart.x + item.offset;
    const isMobile = window.innerWidth < 769;

    if (item.type === 'shell') {
        const shellOffset = isMobile ? 20 : 50; 
        startX = kart.x + shellOffset; 
    }

    const newItem = {
        type: item.type,
        state: initialState, 
        element: item.element,
        imgElement: item.imgElement,
        x: startX, 
        y: kart.yPercent,
        shooterId: kart.id,
        createdAt: Date.now(),
        
        // NOUVEAU : On stocke la vitesse de retour pour plus tard (sera écrasée par le calcul dynamique)
        returnSpeed: 0 
    };
    
    // Application de la visibilité initiale
    if (initialState === 'returning') {
        newItem.element.style.opacity = '0';
    } else {
        newItem.element.style.opacity = '1';
    }

    // --- 2. VITESSE INITIALE ---
    if (item.type === 'banana') {
        // La banane est statique par rapport à la route, donc elle recule à la vitesse de la route
        // (Sauf si elle est en mode returning, voir updateItems)
        newItem.vx = -GAME_CONFIG.speeds.roadPPS;
        newItem.vy = 0;
    } 
    else {
        // Logique des coquilles (projectiles)
        const shellSpeed = calculateSpeedPPS(containerWidth, true);
        if (initialState === 'returning') {
            // Si tirée par un fantôme, elle part vers la gauche (sens du retour)
            newItem.vx = -shellSpeed;
        } else {
            newItem.vx = shellSpeed;
        }
        newItem.vy = randomRange(-1.5, 1.5);
    }

    newItem.currentFrame = 1;
    newItem.lastAnimTime = 0;

    activeItems.push(newItem);
    kart.heldItem = null; 
}

function updateItems(deltaTime, containerWidth) {
    const now = Date.now();
    
    // --- CALCUL DES LIMITES POUR LE CYCLE (Comme pour les Item Boxes) ---
    const limitXRight = containerWidth + 150;
    const limitXLeft = -150;

    // Calcul mathématique précis pour que la banane reste synchronisée avec le sol
    const loopTime = GAME_CONFIG.speeds.lapDistance / GAME_CONFIG.speeds.roadPPS;
    const visibleDistance = limitXRight - limitXLeft;
    const timeVisible = visibleDistance / GAME_CONFIG.speeds.roadPPS;
    const timeInvisible = loopTime - timeVisible;
    
    // C'est la vitesse à laquelle la banane doit voyager dans le monde invisible
    // pour réapparaître exactement au même endroit au tour suivant.
    const bananaReturnSpeed = visibleDistance / timeInvisible;


    for (let i = activeItems.length - 1; i >= 0; i--) {
        const item = activeItems[i];
        if (!item) continue; 

        // --- GESTION DU MOUVEMENT EN FONCTION DU TYPE ---

        if (item.type === 'banana') {
            // LOGIQUE DE CYCLE (BOUCLE INFINIE)
            
            if (item.state === 'active') {
                // Monde Visible : Elle recule avec la route
                item.vx = -GAME_CONFIG.speeds.roadPPS;
                item.x += item.vx * deltaTime;

                // Sortie à gauche -> Passage dans le monde invisible
                if (item.x < limitXLeft) {
                    item.state = 'returning';
                    // Elle est maintenant au bout gauche, elle va repartir vers la droite
                }
            } 
            else if (item.state === 'returning') {
                // Monde Invisible : Elle voyage vers la droite pour boucler le tour
                item.vx = bananaReturnSpeed;
                item.x += item.vx * deltaTime;

                // Arrivée à droite -> Retour dans le monde visible
                if (item.x > limitXRight) {
                    item.state = 'active';
                }
            }

            // Durée de vie globale (sécurité)
            if (now - item.createdAt > GAME_CONFIG.delays.bananaLife) {
                removeItem(i);
                continue;
            }

        } else {
            // LOGIQUE COQUILLES (Projectiles classiques)
            // Elles ne bouclent pas (trop dangereux), elles sont détruites aux bords
            item.x += item.vx * deltaTime;
            item.y += item.vy * deltaTime;
        }

        // --- ANIMATION VISUELLE (COQUILLES) ---
        if (item.type === 'shell') {
            if (now - item.lastAnimTime > GAME_CONFIG.visuals.shell.animSpeed) {
                item.currentFrame++;
                if (item.currentFrame > 3) item.currentFrame = 1;
                item.imgElement.src = getShellPath(item.currentFrame);
                item.lastAnimTime = now;
            }
        }

        // --- NETTOYAGE HORS CADRE (Seulement pour les coquilles) ---
        if (item.type === 'shell') {
            if (item.x > limitXRight + 200 || item.x < limitXLeft - 200 || item.y < -10 || item.y > 100) {
                removeItem(i);
                continue;
            }
        }

        // --- GESTION DE L'AFFICHAGE ---
        const dynamicZ = Math.floor(400 - item.y);
        item.element.style.zIndex = dynamicZ;
        item.element.style.transform = `translateX(${item.x}px)`;
        item.element.style.bottom = `${item.y}%`;

        // Gestion de l'opacité (Visible ou Invisible selon l'état)
        if (item.state === 'returning') {
            item.element.style.opacity = '0';
        } else {
            item.element.style.opacity = '1';
            // Collisions actives seulement si visible
            if (checkItemCollisions(item, i)) {
                continue;
            }
        }
        
        // Note : Si l'item est returning, on peut aussi vouloir vérifier les collisions
        // avec les karts qui sont EUX AUSSI en returning (collisions dans le monde invisible).
        // Si tu veux ça, ajoute ce bloc :
        if (item.state === 'returning') {
             checkItemCollisions(item, i); 
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
    // Utilisation des nouvelles variables de hitbox
    const hitBoxX = GAME_CONFIG.hitboxes.itemVsKart.x; 
    const hitBoxY = GAME_CONFIG.hitboxes.itemVsKart.y;

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
    const hitBoxX = GAME_CONFIG.hitboxes.itemVsKart.x; 
    const hitBoxY = GAME_CONFIG.hitboxes.itemVsKart.y;

    for (let kart of kartsData) {
        if (item.type === 'shell' && kart.id === item.shooterId) continue;
        
        if (item.type === 'banana' && kart.id === item.shooterId) {
            if (Date.now() - item.createdAt < GAME_CONFIG.delays.invincibilityOwnItem) {
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
    
    // On définit la fin du stunt
    const stunDuration = GAME_CONFIG.delays.stunDuration;
    kart.hitEndTime = Date.now() + stunDuration; 
    
    // --- MODIFICATION ICI ---
    // Si le kart tient un item, IL LE GARDE.
    // MAIS on repousse le moment où il a le droit de tirer.
    // Le tir sera autorisé seulement 1 seconde après qu'il ait fini de tourner.
    if (kart.heldItem) {
        kart.throwTime = Date.now() + stunDuration + 1000;
    }
    // ------------------------

    kart.element.style.filter = "brightness(2) sepia(1) hue-rotate(-50deg) saturate(5)"; 
    setTimeout(() => { kart.element.style.filter = "none"; }, 300);
}

function updateItemBoxes(deltaTime, screenWidth) {
    const now = Date.now();
    
    // Récupération des réglages de hitbox depuis la nouvelle config
    const hitBoxX = GAME_CONFIG.hitboxes.itemBox.toleranceX;
    const hitBoxY = GAME_CONFIG.hitboxes.itemBox.toleranceY;

    const limitXRight = screenWidth + 150;
    const limitXLeft = -150;

    const loopTime = GAME_CONFIG.speeds.lapDistance / GAME_CONFIG.speeds.roadPPS;
    const visibleDistance = limitXRight - limitXLeft; 
    const timeVisible = visibleDistance / GAME_CONFIG.speeds.roadPPS;
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
            box.x -= GAME_CONFIG.speeds.roadPPS * deltaTime;
            
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
                    // Utilisation des délais configurables
                    box.reactivateTime = now + GAME_CONFIG.delays.boxRespawn;
                    
                    setTimeout(() => {
                        giveKartItem(kart);
                    }, GAME_CONFIG.delays.itemGrant);
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
    const ROAD_LIMITS = { min: 0, max: 30 };
    
    if (container) {
        const screenWidth = container.offsetWidth;
        const limitX = screenWidth + 150;
        const now = Date.now();

        checkHeldItemCollisions();

        kartsData.forEach(kart => {
            // --- LOGIQUE DE DEPLACEMENT ---
            if (kart.state === 'running' || kart.state === 'returning') {
                
                // On ne permet le tir QUE si le kart est en course active (pas en retour)
                if (kart.state === 'running' && kart.heldItem && now > kart.throwTime) {
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

                // Gestion des sorties d'écran
                if (kart.state === 'running' && kart.x > limitX) {
                    kart.state = 'returning';
                    kart.element.style.opacity = '0'; 
                }
                else if (kart.state === 'returning' && kart.x <= -150) {
                    startKartRun(kart);
                }
            } 
            else if (kart.state === 'hit') {
                const moveAmount = -GAME_CONFIG.speeds.roadPPS * deltaTime;
                kart.x += moveAmount;
                kart.element.style.transform = `translateX(${kart.x}px)`;

                if (kart.x < -150) {
                    kart.element.style.opacity = '0';
                    kart.state = 'waiting_respawn'; // Le kart devient invisible ici
                    const remainingStun = Math.max(0, kart.hitEndTime - Date.now());
                    const specialDelay = remainingStun * 1.5;
                    scheduleRespawnForHit(kart, specialDelay);
                }
                else if (Date.now() > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.speedPPS = calculateSpeedPPS(screenWidth);
                }
            }

            // --- GESTION ROBUSTE DE L'ITEM TENU ---
                if (kart.heldItem && kart.heldItem.element) {
                // Règle de visibilité stricte :
                // L'item est visible SI ET SEULEMENT SI le kart est visible.
                // Le kart est visible quand il court ou est touché, ET qu'il est dans l'écran (x > -100).
                
                const isKartVisible = (kart.state === 'running' || kart.state === 'hit') && kart.x > -100;

                if (isKartVisible) {
                    // On affiche l'item
                    kart.heldItem.element.style.opacity = '1';
                    
                    // On colle l'item au kart
                    const holdX = kart.x + kart.heldItem.offset;
                    kart.heldItem.element.style.transform = `translateX(${holdX}px)`;
                    kart.heldItem.element.style.bottom = `${kart.yPercent}%`;
                    kart.heldItem.element.style.zIndex = Math.floor(400 - kart.yPercent);
                } else {
                    // Si le kart est caché (waiting_respawn, returning...) on cache l'item
                    kart.heldItem.element.style.opacity = '0';
                }
            }
        });

        updateItems(deltaTime, screenWidth);
        updateItemBoxes(deltaTime, screenWidth);
    }

    animationId = requestAnimationFrame(animateKarts);
}

function showLogo() {
    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => {
        setTimeout(() => {
            el.classList.add('visible');
        }, 100);
    });
}

/* ==========================================================================
   GESTION DU DEMARRAGE ET DE LA VISIBILITÉ (TAB ACTIVE/INACTIVE)
   ========================================================================== */

function handleVisibilityChange() {
    if (document.hidden) {
        if (animationId) {
            cancelAnimationFrame(animationId);
            animationId = null;
        }

        const container = document.getElementById('karts-container');
        if (container) container.innerHTML = '';
        
        kartsData = [];
        activeItems = [];
        itemBoxes = [];
        
    } else {
        lastFrameTime = 0;
        initCharacters();
        animateKarts(0);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initCharacters();
    animateKarts(0);
    showLogo();

    document.addEventListener('visibilitychange', handleVisibilityChange);
});
