// Plein ecran du bandeau (telephone couche). API Fullscreen si possible, sinon
// le bandeau recouvre la page ; dans les deux cas la classe `is-fullscreen` est
// posee. C'est le cadre (#bannerFrame) qui passe en plein ecran, pour que le
// bandeau puisse etre moins haut que l'ecran (--fullscreen-min-units).

const fullscreenState = {
    pseudo: false,
    bound: false,
    hintEl: null
};

function bannerHero() {
    return document.getElementById('bannerSection');
}

function bannerFrame() {
    return document.getElementById('bannerFrame');
}

function nativeFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isBannerFullscreen() {
    const frame = bannerFrame();
    return !!frame && (fullscreenState.pseudo || nativeFullscreenElement() === frame);
}

// L'API peut etre exposee puis refusee (promesse rejetee ou exception) : on
// passe alors a la voie de repli.
function enterBannerFullscreen() {
    const frame = bannerFrame();
    if (!frame) return;

    const request = frame.requestFullscreen || frame.webkitRequestFullscreen;
    if (!request) {
        setPseudoFullscreen(true);
        return;
    }

    try {
        Promise.resolve(request.call(frame, { navigationUI: 'hide' }))
            .catch(() => setPseudoFullscreen(true));
    } catch (e) {
        setPseudoFullscreen(true);
    }
}

function exitBannerFullscreen() {
    if (fullscreenState.pseudo) {
        setPseudoFullscreen(false);
        return;
    }
    if (!nativeFullscreenElement()) return;

    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return;
    try {
        Promise.resolve(exit.call(document)).catch(() => {});
    } catch (e) { /* deja sorti */ }
}

function toggleBannerFullscreen() {
    if (isBannerFullscreen()) exitBannerFullscreen();
    else enterBannerFullscreen();
}

function setPseudoFullscreen(on) {
    fullscreenState.pseudo = on;
    syncBannerFullscreen();
}

// Verrou paysage, en vrai plein ecran seulement ; un refus est sans consequence.
function lockLandscape() {
    const orientation = screen.orientation;
    if (!orientation || !orientation.lock) return;
    try {
        orientation.lock('landscape').catch(() => {});
    } catch (e) { /* pas de verrou ici */ }
}

// Synchronise l'etat, y compris quand le navigateur sort seul du plein ecran.
function syncBannerFullscreen() {
    const hero = bannerHero();
    const frame = bannerFrame();
    if (!hero || !frame) return;

    const on = isBannerFullscreen();
    hero.classList.toggle('is-fullscreen', on);
    frame.classList.toggle('is-fullscreen', on);
    document.documentElement.classList.toggle('banner-pseudo-fullscreen', fullscreenState.pseudo);
    if (on && !fullscreenState.pseudo) lockLandscape();

    renderFullscreenButton();

        // Le cadre a change de taille : tout est a remesurer.
    onViewportChange();
}

function renderFullscreenButton() {
    const el = leaderboardState.fullscreenEl;
    if (!el) return;

    const on = isBannerFullscreen();
    el.classList.toggle('is-active', on);
    el.title = on ? 'Quitter le plein ecran' : 'Plein ecran (telephone couche)';
}

// Plein ecran en portrait : un voile demande de tourner le telephone et
// propose la sortie.
function ensureRotateHint(frame) {
    if (fullscreenState.hintEl) return;

    const hint = document.createElement('div');
    hint.className = 'race-rotate-hint';
    hint.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="7" y="2" width="10" height="20" rx="2"/>' +
        '<path d="M11 18h2"/></svg>' +
        '<p>Tourne ton telephone</p>' +
        '<button type="button">Quitter le plein ecran</button>';
    hint.querySelector('button').addEventListener('click', exitBannerFullscreen);
    frame.appendChild(hint);
    fullscreenState.hintEl = hint;
}

function initFullscreen() {
    const frame = bannerFrame();
    if (!frame || !bannerHero() || fullscreenState.bound) return;
    fullscreenState.bound = true;

    ensureRotateHint(frame);

    document.addEventListener('fullscreenchange', syncBannerFullscreen);
    document.addEventListener('webkitfullscreenchange', syncBannerFullscreen);
    // Refus d'une implementation prefixee (sans promesse).
    document.addEventListener('fullscreenerror', () => setPseudoFullscreen(true));
    document.addEventListener('webkitfullscreenerror', () => setPseudoFullscreen(true));

    // Echap pour sortir de la voie de repli.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && fullscreenState.pseudo) setPseudoFullscreen(false);
    });
}
