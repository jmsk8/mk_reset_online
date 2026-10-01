// Mise en page : profondeur, echelle, z-index, defilement des couches. Seul
// fichier qui lit les dimensions reelles du bandeau.

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.matchMedia(GAME_CONFIG.rendering.compactQuery).matches;
    return cachedIsMobile;
}

// Hauteur de la scene PC en px : 408 moins la bordure basse de 4.
const SCENE_HEIGHT = 404;

// Sur telephone et en plein ecran, la scene PC est reduite d'un bloc : la
// hauteur du bandeau (choisie par la feuille de style) fixe l'echelle.
let cachedHero = null;
let cachedFrame = null;

// Marge du classement sous la scene.
const LEADERBOARD_GAP = 8;

function applyStageScale() {
    if (!cachedHero) cachedHero = document.getElementById('bannerSection');
    if (!cachedHero) return;

    const h = cachedHero.clientHeight;
    const w = cachedHero.clientWidth;
    const fullscreen = cachedHero.classList.contains('is-fullscreen');
    const staged = (cachedIsMobile || fullscreen) && h > 0 && w > 0;

    if (staged) {
        cachedHero.style.setProperty('--stage-scale', (h / SCENE_HEIGHT).toFixed(4));
    } else {
        cachedHero.style.removeProperty('--stage-scale');
    }
    cachedHero.classList.toggle('is-staged', staged);

    placeInFrame(fullscreen && staged);
}

// Plein ecran : la bande du bas loge le classement si la place le permet
// (has-board-room), sinon il remonte dans le ciel.
function placeInFrame(on) {
    if (!cachedFrame) cachedFrame = document.getElementById('bannerFrame');
    const board = document.getElementById('race-leaderboard');

    let top = 0;
    let room = false;
    if (on && cachedFrame) {
        const spare = Math.max(0, cachedFrame.clientHeight - cachedHero.clientHeight);
        const need = (board ? board.offsetHeight : 0) + 2 * LEADERBOARD_GAP;
        room = spare >= need;
        top = room ? Math.min(spare / 2, spare - need) : spare / 2;
    }

    if (on) cachedHero.style.setProperty('--frame-top', `${Math.round(top)}px`);
    else cachedHero.style.removeProperty('--frame-top');
    cachedHero.classList.toggle('has-board-room', room);
}

// Remesure la scene (seule lecture de dimensions du DOM). Une mesure nulle est
// ignoree (decor pas encore mis en page).
function refreshLayoutMetrics() {
    updateMobileStatus();
    applyStageScale();

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedGameWrapper) cachedGameWrapper = document.querySelector('.game-content-wrapper');

    const w = cachedContainer ? cachedContainer.offsetWidth : 0;
    if (w > 0) viewMetrics.containerWidth = w;

    const h = cachedGameWrapper ? cachedGameWrapper.offsetHeight : 0;
    if (h > 0) viewMetrics.wrapperHeight = h;

    if (!cachedGround) cachedGround = document.querySelector('.layer-ground');
    const gh = cachedGround ? cachedGround.offsetHeight : 0;
    if (gh > 0) viewMetrics.groundHeight = gh;

    // Hauteur de la piste, declaree par la feuille de style (--road-band-pct).
    if (cachedGameWrapper && viewMetrics.wrapperHeight > 0) {
        const pct = parseFloat(getComputedStyle(cachedGameWrapper)
            .getPropertyValue('--road-band-pct'));
        if (pct > 0) viewMetrics.roadBandHeight = (pct / 100) * viewMetrics.wrapperHeight;
    }

    // Largeur de la bande d'arrivee, mesuree ici pour que le rendu ne lise pas le DOM.
    const bandEl = document.querySelector('.layer-finish-line');
    const bw = bandEl ? bandEl.offsetWidth : 0;
    if (bw > 0) cachedFinishBand = bw;

    // Cadre de la carte de debug (construit apres le decor).
    const hudEl = document.getElementById('debug-hud');
    const hw = hudEl ? hudEl.clientWidth : 0;
    if (hw > 0) viewMetrics.hudWidth = hw;
}

// Un seul rafraichissement par image.
let layoutRefreshQueued = false;

function onViewportChange() {
    if (layoutRefreshQueued) return;
    layoutRefreshQueued = true;
    requestAnimationFrame(() => {
        layoutRefreshQueued = false;
        refreshLayoutMetrics();
    });
}

window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);

// Profondeur d'un corps en translation verticale (negative vers le haut),
// pliee dans la translate3d.
function depthToY(yPercent) {
    return -yPercent * depthToWorldPx();
}

// Defilement par transform : le calque est elargi d'un pas et translate dans
// [-pas, 0] ; les multiples du pas sont rattrapes sur background-position.
const LAYER_TILE = 3840;
const LAYER_STEP = 480;

// `phase` : decalage du motif au bord gauche du cadre.
function scrollLayer(el, phase, state) {
    const m = ((phase % LAYER_TILE) + LAYER_TILE) % LAYER_TILE;
    const q = Math.floor(m / LAYER_STEP) * LAYER_STEP;

    if (state.bp !== q) {
        state.bp = q;
        // Le pas compense la translation negative.
        el.style.backgroundPosition = `${q + LAYER_STEP}px 0px`;
    }

    el.style.transform = `translate3d(${(m - q) - LAYER_STEP}px, 0, 0)`;
}

const bgScroll = { bp: null };
const fgScroll = { bp: null };
const midScroll = { bp: null };

// `cameraX` est le centre de la vue, qui s'etend symetriquement selon la
// largeur de l'appareil.
function getScreenPosition(worldX, cameraX, screenWidth) {
    const w = WORLD.width;
    const buffer = GAME_CONFIG.rendering.bufferZone;

    let rawDiff = worldX - cameraX + screenWidth / 2;

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
