// Les objets a l'ecran : celui qu'un kart tient, ceux qui lui tournent autour.

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
        case 'blueShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.blueShell.widthMobile : GAME_CONFIG.visuals.blueShell.width,
                src: imageCache['blueShell_1'] ? imageCache['blueShell_1'].src : GAME_CONFIG.resources.paths.blueShell(1),
                holdPosition: 'hands'
            };
        // Le souffle n'a pas de sprite : il est dessine en CSS, et sa taille
        // vient du rayon reellement utilise par le serveur.
        case 'blueBlast':
            return { size: WORLD.blastRadius * 2, src: null, holdPosition: 'behind' };
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
        case 'lightning':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.lightning.widthMobile : GAME_CONFIG.visuals.lightning.width,
                src: GAME_CONFIG.resources.paths.lightning,
                holdPosition: 'hands'
            };
        case 'bill':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.bill.widthMobile : GAME_CONFIG.visuals.bill.width,
                src: imageCache['bill_1'] ? imageCache['bill_1'].src : GAME_CONFIG.resources.paths.bill(1),
                holdPosition: 'hands'
            };
        default:
            return { size: 32, src: '', holdPosition: 'behind' };
    }
}

// Ou se pose l'objet TENU EN MAIN, en ecart au bord gauche du sprite. Du dessin
// et rien d'autre : en main, un objet n'a aucune emprise. Il peut donc se caler a
// l'oeil, et plus serre sur mobile. Recalcule a chaque image pour suivre un
// changement de breakpoint.
//
// L'objet TRAINE n'a pas son pendant ici : sa place est une position du monde
// (`heldBehindX`), pas un reglage de rendu.
function getHandsItemRenderOffset() {
    const r = GAME_CONFIG.offsets.render.heldItemHands;

    return {
        offset: cachedIsMobile ? r.x.mobile : r.x.pc,
        yShift: cachedIsMobile ? r.yShift.mobile : r.yShift.pc
    };
}

function createHeldItemElement(itemType, holdPosition) {
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';

    const visual = getItemVisualConfig(itemType);
    itemDiv.style.width = `${visual.size}px`;

    // Pose par son MILIEU, comme tous les corps de la scene : `worldX` est un
    // centre pour le moteur — ses hitboxes sont des ecarts entre centres — et
    // un element pose par son coin gauche se retrouve une demi-largeur trop a
    // droite de l'emprise qui le fait toucher. Le souffle de la bleue etait
    // seul a le faire ; ce qui valait pour lui vaut pour tout le monde.
    itemDiv.style.marginLeft = `${-visual.size / 2}px`;

    // Ancre au sol une fois pour toutes : la profondeur passe par la
    // transformation posee a chaque image (cf. depthToY), et non plus par un
    // `bottom` en pourcentage qui relancait la mise en page a chaque fois.
    itemDiv.style.bottom = '0px';

    // La demi-largeur reste attachee a l'element : elle sert a replacer un
    // objet TENU, qui se cale sur la silhouette du kart et non sur un centre.
    // La relire ici evite de reconstruire une config par objet a chaque frame.
    itemDiv._halfW = visual.size / 2;

    // Le souffle de la bleue est un element sans image, anime en CSS.
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
// place au loin, il passe sous le z-index du kart et c'est le sprite opaque qui
// l'occulte. La bascule se joue aux extremites laterales de l'ellipse, la ou
// l'objet est hors de la silhouette — le changement d'ordre y passe inapercu.
function renderOrbitItems(kart, rx, gameNow) {
    const held = kart.heldItem;
    const orbit = WORLD.orbit;

    // L'orbite tourne autour du kart, donc autour de `rx` : les objets se
    // posent par leur milieu et le kart est centre sur sa position. Il n'y a
    // plus rien a recentrer — ce calcul valait du temps ou les deux etaient
    // ancres par leur coin gauche, avec deux largeurs differentes a rattraper.
    const cx = rx;

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
        // Y positif = vers le bas : l'orbite entiere descend de `drop`, et la
        // profondeur de l'orbe se plie dans la meme transformation.
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
