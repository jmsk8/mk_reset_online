// La mise en page : profondeur, echelle, z-index, defilement des couches.
//
// Le seul endroit qui lit les dimensions reelles du bandeau. Tout le reste
// raisonne en coordonnees de monde et passe par ici pour atterrir en pixels.

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.matchMedia(GAME_CONFIG.rendering.compactQuery).matches;
    return cachedIsMobile;
}

// Hauteur de la scene PC, en px de mise en page : les 408 px du bandeau moins sa
// bordure basse de 4 (Bulma pose `border-box` partout).
const SCENE_HEIGHT = 404;

// Sur telephone, la scene EST celle du PC, reduite d'un bloc. La feuille de
// style choisit la hauteur du bandeau — elle suit la largeur de l'ecran, pour
// que chaque telephone voie la meme longueur de piste —, et l'echelle s'en
// deduit : la scene garde ses 404 px de haut, la piste ses proportions, le
// decor les siennes, et les sprites leur taille PC.
//
// En plein ecran (fullscreen.js), la meme regle vaut : la hauteur du bandeau
// fixe l'echelle. La feuille de style la plafonne pour que la largeur montre au
// moins `--fullscreen-min-units` de piste (banner.css) : un ecran trop haut pour
// ca — un PC en 16:9, une tablette — garde des bandes noires plutot que de
// zoomer sur un bout de route. La scene garde donc partout ses proportions.
//
// Posee avant toute mesure : les largeurs lues ensuite en dependent.
let cachedHero = null;
let cachedFrame = null;

// Marge du classement sous la scene, en haut et en bas : celle de la page.
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

// Les bandes noires du plein ecran. Centree, la scene en laisse une en haut et
// une en bas ; des que l'ecart le permet, celle du bas prend de quoi loger le
// classement, qui retrouve alors sa place de la page — sous la piste, sans rien
// cacher. Sinon il remonte dans le ciel (`has-board-room` absente, banner.css).
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

// Remesure la scene. Le seul endroit du fichier qui a le droit de lire une
// dimension du DOM : partout ailleurs on lit `viewMetrics`.
//
// Une mesure nulle est ignoree plutot que memorisee : le decor peut n'etre pas
// encore mis en page au premier appel, et retenir un zero figerait la scene sur
// une hauteur de repli pour toute la session.
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

    // La piste ne se mesure pas : aucun element ne la dessine, elle est plus
    // courte que l'asphalte qui la porte. La feuille de style la declare, on la
    // lit. Un seul `getComputedStyle` par changement de fenetre.
    if (cachedGameWrapper && viewMetrics.wrapperHeight > 0) {
        const pct = parseFloat(getComputedStyle(cachedGameWrapper)
            .getPropertyValue('--road-band-pct'));
        if (pct > 0) viewMetrics.roadBandHeight = (pct / 100) * viewMetrics.wrapperHeight;
    }

    // La bande d'arrivee se mesure ici plutot qu'a la demande : sa largeur vient
    // du CSS et change avec l'appareil, et `finishBandWidth()` est appele depuis
    // le rendu, ou plus rien ne doit toucher le DOM.
    const bandEl = document.querySelector('.layer-finish-line');
    const bw = bandEl ? bandEl.offsetWidth : 0;
    if (bw > 0) cachedFinishBand = bw;

    // Le cadre de la carte de debug, quand il existe : il se construit apres le
    // decor, d'ou la remesure depuis `initDebugHUD()`.
    const hudEl = document.getElementById('debug-hud');
    const hw = hudEl ? hudEl.clientWidth : 0;
    if (hw > 0) viewMetrics.hudWidth = hw;
}

// Un seul rafraichissement par image, quoi qu'il arrive : redimensionner une
// fenetre emet des dizaines d'evenements, et chacun coute une mise en page.
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

// La profondeur d'un corps, en pixels de translation verticale.
//
// Les corps se posaient a `bottom: N%`, propriete de MISE EN PAGE : chaque
// ecriture invalidait la mise en page du conteneur et annulait les `will-change:
// transform` poses a cote. Le meme deplacement, plie dans la `translate3d` deja
// la, ne coute plus qu'une composition.
//
// Negatif : dans le repere des transformations, monter c'est aller vers les Y
// negatifs.
function depthToY(yPercent) {
    return -yPercent * depthToWorldPx();
}

// Le decor defile par TRANSFORMATION, pas par `background-position` : ecrire
// celle-ci a chaque image repeint la texture du calque entier, et aucun moteur ne
// sait compositer un fond qui glisse.
//
// Le calque est donc elargi d'un PAS et translate. Le motif se repetant, il
// suffit de garder la translation dans [-pas, 0] et de rattraper les multiples du
// pas sur `background-position` — une fois toutes les deux secondes au lieu de
// soixante fois par seconde.
const LAYER_TILE = 3840;
const LAYER_STEP = 480;

// `phase` est le decalage de motif voulu au bord gauche du cadre : exactement
// ce qui s'ecrivait en `background-position`.
function scrollLayer(el, phase, state) {
    const m = ((phase % LAYER_TILE) + LAYER_TILE) % LAYER_TILE;
    const q = Math.floor(m / LAYER_STEP) * LAYER_STEP;

    if (state.bp !== q) {
        state.bp = q;
        // Le pas ajoute compense la translation, qui est toujours negative :
        // c'est ce qui garde le bord gauche du calque hors du cadre.
        el.style.backgroundPosition = `${q + LAYER_STEP}px 0px`;
    }

    el.style.transform = `translate3d(${(m - q) - LAYER_STEP}px, 0, 0)`;
}

const bgScroll = { bp: null };
const fgScroll = { bp: null };
const midScroll = { bp: null };

// `cameraX` designe le **centre** de ce qu'on voit, pas son bord gauche : la
// fenetre s'etend symetriquement de part et d'autre, sur la largeur dont
// l'appareil dispose. Un ecran etroit montre donc moins de piste qu'un large,
// mais tous deux sont centres sur le meme point du monde — sans quoi un mobile
// et un PC, partant du meme bord gauche, regardent deux portions differentes.
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
