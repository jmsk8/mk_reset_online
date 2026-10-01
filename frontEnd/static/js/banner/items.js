// Objets a l'ecran : objet tenu et objets en orbite.

function getItemVisualConfig(itemType) {
    switch (itemType) {
        case 'greenShell':
            return {
                size: GAME_CONFIG.visuals.greenShell.width,
                src: imageCache['greenShell_1'] ? imageCache['greenShell_1'].src : GAME_CONFIG.resources.paths.greenShell(1),
                holdPosition: 'behind'
            };
        case 'redShell':
            return {
                size: GAME_CONFIG.visuals.redShell.width,
                src: imageCache['redShell_1'] ? imageCache['redShell_1'].src : GAME_CONFIG.resources.paths.redShell(1),
                holdPosition: 'behind'
            };
        case 'banana':
            return {
                size: GAME_CONFIG.visuals.banana.width + 4,
                src: imageCache['banana'] ? imageCache['banana'].src : GAME_CONFIG.resources.paths.banana,
                holdPosition: 'behind'
            };
        // Les triples reprennent le sprite de l'objet largue.
        case 'tripleBanana':
            return Object.assign(getItemVisualConfig('banana'), { holdPosition: 'orbit' });
        case 'tripleGreenShell':
            return Object.assign(getItemVisualConfig('greenShell'), { holdPosition: 'orbit' });
        case 'tripleRedShell':
            return Object.assign(getItemVisualConfig('redShell'), { holdPosition: 'orbit' });
        case 'blueShell':
            return {
                size: GAME_CONFIG.visuals.blueShell.width,
                src: imageCache['blueShell_1'] ? imageCache['blueShell_1'].src : GAME_CONFIG.resources.paths.blueShell(1),
                holdPosition: 'hands'
            };
        // Souffle dessine en CSS, taille selon le rayon du serveur.
        case 'blueBlast':
            return { size: WORLD.blastRadius * 2, src: null, holdPosition: 'behind' };
        case 'shroom':
            return {
                size: GAME_CONFIG.visuals.shroom.width,
                src: imageCache['shroom'] ? imageCache['shroom'].src : GAME_CONFIG.resources.paths.shroom,
                holdPosition: 'hands'
            };
        case 'star':
            return {
                size: GAME_CONFIG.visuals.star.width,
                src: imageCache['star'] ? imageCache['star'].src : GAME_CONFIG.resources.paths.star,
                holdPosition: 'hands'
            };
        case 'lightning':
            return {
                size: GAME_CONFIG.visuals.lightning.width,
                src: GAME_CONFIG.resources.paths.lightning,
                holdPosition: 'hands'
            };
        case 'bill':
            return {
                size: GAME_CONFIG.visuals.bill.width,
                src: imageCache['bill_1'] ? imageCache['bill_1'].src : GAME_CONFIG.resources.paths.bill(1),
                holdPosition: 'hands'
            };
        default:
            return { size: 32, src: '', holdPosition: 'behind' };
    }
}

// Decalage de l'objet tenu en main, par rapport au bord gauche du sprite (rendu
// seulement ; l'objet traine a une position du monde).
function getHandsItemRenderOffset() {
    const r = GAME_CONFIG.offsets.render.heldItemHands;

    return {
        offset: r.x,
        yShift: r.yShift
    };
}

function createHeldItemElement(itemType, holdPosition) {
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';

    const visual = getItemVisualConfig(itemType);
    itemDiv.style.width = `${visual.size}px`;

    // Pose par son milieu : worldX est un centre pour le moteur.
    itemDiv.style.marginLeft = `${-visual.size / 2}px`;

    // Profondeur posee par la transform de chaque image (depthToY).
    itemDiv.style.bottom = '0px';

    // Demi-largeur gardee pour replacer un objet tenu.
    itemDiv._halfW = visual.size / 2;

    // Souffle de la bleue : sans image, anime en CSS.
    if (!visual.src) {
        itemDiv.classList.add('blue-blast');

        const wave = document.createElement('div');
        wave.className = 'blue-blast-wave';
        itemDiv.appendChild(wave);

        cachedContainer.appendChild(itemDiv);
        return { div: itemDiv, img: null };
    }

    const img = document.createElement('img');
    img.style.width = '100%';
    img.src = visual.src;

    itemDiv.appendChild(img);
    cachedContainer.appendChild(itemDiv);
    return { div: itemDiv, img: img };
}

// Frame d'une carapace en rotation, derivee du temps de jeu (null si l'objet
// n'est pas anime).
function getOrbitFrameSrc(childType, gameNow) {
    if (childType !== 'greenShell' && childType !== 'redShell') return null;

    const frame = (Math.floor(gameNow / WORLD.shellAnimSpeed) % 3) + 1;
    const cached = imageCache[`${childType}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths[childType](frame);
}

// Objets en orbite : ils passent derriere le kart quand ils sont au loin, la
// bascule se faisant aux extremites de l'ellipse.
function renderOrbitItems(kart, rx, gameNow) {
    const held = kart.heldItem;
    const orbit = WORLD.orbit;

    // Orbite centree sur le kart.
    const cx = rx;

    const drop = GAME_CONFIG.offsets.render.orbitDrop;
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

        // Au moins un cran d'ecart avec le kart porteur, pour eviter le scintillement.
        const bz = (sin > 0) ? Math.min(getZIndex(by), kartZ - 1)
                             : Math.max(getZIndex(by), kartZ + 1);

        el.style.display = 'block';
        // Orbite decalee de `drop` vers le bas.
        el.style.transform = `translate3d(${cx + Math.cos(angle) * orbit.radiusX}px, ${depthToY(by) + drop}px, 0)`;
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

// Seul chemin qui masque reellement un bouclier (pas d'entree itemEls pour son groupe).
function hideHeldItem(kart) {
    if (!kart.heldItem) return;
    if (kart.heldItem.holdPosition === 'orbit') {
        hideOrbitItems(kart);
        return;
    }
    const el = itemEls[kart.heldItem.id];
    if (el) el.style.display = 'none';
}
