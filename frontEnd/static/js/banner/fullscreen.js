// Le plein ecran : le bandeau seul, telephone couche.
//
// Deux voies. La vraie — l'API Fullscreen — cache les barres du navigateur et
// laisse verrouiller l'ecran en paysage : Android la connait, l'iPhone non (il la
// reserve aux videos). A defaut, le bandeau recouvre la page : les barres
// restent, mais Safari les reduit de lui-meme une fois le telephone couche.
//
// Le mode se lit sur UNE classe, `is-fullscreen`, quelle que soit la voie : la
// feuille de style et `applyStageScale()` n'ont pas a savoir laquelle a servi.
// Le plein ecran ne demande rien au serveur : c'est un cadrage, comme la camera.
//
// Ce qui passe en plein ecran n'est pas le bandeau mais son cadre
// (`#bannerFrame`) : le navigateur force l'element plein ecran a la taille de
// l'ecran, et le bandeau doit pouvoir etre moins haut — c'est ce qui garde une
// longueur de piste minimale a l'ecran, quitte a laisser des bandes noires
// (banner.css, `--fullscreen-min-units`). Le cadre porte la classe aussi.

const fullscreenState = {
    // Voie de repli en cours : le bandeau recouvre la page.
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

// Un navigateur peut exposer l'API et la refuser quand meme — iPhone compris,
// selon les versions. Le refus arrive en promesse rejetee, ou en exception pour
// les implementations prefixees : les deux menent a la voie de repli.
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

// Le verrou n'est accepte qu'en vrai plein ecran, et seulement la ou il existe.
// Un refus n'empeche rien : le spectateur tourne son telephone lui-meme, et le
// message du portrait le lui demande. Le navigateur le leve seul a la sortie.
function lockLandscape() {
    const orientation = screen.orientation;
    if (!orientation || !orientation.lock) return;
    try {
        orientation.lock('landscape').catch(() => {});
    } catch (e) { /* pas de verrou ici */ }
}

// Tout changement d'etat passe par ici, y compris ceux que le navigateur decide
// seul : le geste retour d'Android sort du plein ecran sans nous demander.
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

    // Le cadre vient de changer de taille : echelle, largeur visible et hauteur
    // de piste sont a remesurer.
    onViewportChange();
}

function renderFullscreenButton() {
    const el = leaderboardState.fullscreenEl;
    if (!el) return;

    const on = isBannerFullscreen();
    el.classList.toggle('is-active', on);
    el.title = on ? 'Quitter le plein ecran' : 'Plein ecran (telephone couche)';
}

// Plein ecran tenu droit : la scene, calee sur la largeur, ne serait qu'une
// mince bande au milieu de l'ecran. Un voile demande de tourner le telephone, et
// offre la sortie — le bouton du classement est dessous. Il couvre le cadre, pas
// le bandeau : c'est tout l'ecran qu'il doit cacher.
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
    // Le refus d'une implementation prefixee n'arrive que par ici : son appel
    // ne rend pas de promesse.
    document.addEventListener('fullscreenerror', () => setPseudoFullscreen(true));
    document.addEventListener('webkitfullscreenerror', () => setPseudoFullscreen(true));

    // La voie de repli n'a pas de touche de sortie a elle : on lui donne celle
    // du vrai plein ecran.
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && fullscreenState.pseudo) setPseudoFullscreen(false);
    });
}
