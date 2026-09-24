// La place du kart suivi, en haut a gauche : le « 1st », « 2nd »... de Mario
// Kart. Les images sont colorisees a part (scripts/colorize-positions.py) :
// or, argent, bronze, puis orange de la 4e a la 8e.
//
// Elle ne dit la place que d'UN kart, celui que la camera suit — la vue
// d'ensemble n'en suit aucun, et le classement du bas dit deja celle de tous.
//
// Le changement de place se VOIT : l'ancienne tourne vite vers la droite en
// retrecissant, la nouvelle surgit en rebondissant. Un depassement qui se joue
// a plusieurs reprises en quelques images ne doit pas pour autant empiler les
// animations : pendant qu'une transition tourne, seule la DERNIERE place
// demandee est retenue, et elle s'affiche a la fin de celle en cours.

const POSITION_OUT_MS = 160;
const POSITION_IN_MS = 300;

const positionHud = {
    el: null,
    img: null,
    shown: 0,       // place affichee, 0 = rien
    wanted: 0,      // place a afficher
    busy: false     // une transition tourne
};

function positionReducedMotion() {
    return window.matchMedia &&
           window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Rend une promesse tenue a la fin de l'animation, ou tout de suite si le
// navigateur ne sait pas animer (ou si l'utilisateur prefere s'en passer).
function positionAnimate(frames, duration, easing) {
    const img = positionHud.img;
    if (!img.animate || positionReducedMotion()) return Promise.resolve();
    const anim = img.animate(frames, { duration, easing, fill: 'forwards' });
    return anim.finished.catch(() => {});
}

function positionOut() {
    return positionAnimate([
        { transform: 'rotate(0deg) scale(1)', opacity: 1 },
        { transform: 'rotate(140deg) scale(0.15)', opacity: 0 }
    ], POSITION_OUT_MS, 'cubic-bezier(0.55, 0, 1, 0.45)');
}

function positionIn() {
    return positionAnimate([
        { transform: 'scale(0.2)', opacity: 0 },
        { transform: 'scale(1.28)', opacity: 1, offset: 0.55 },
        { transform: 'scale(0.9)', offset: 0.78 },
        { transform: 'scale(1)', opacity: 1 }
    ], POSITION_IN_MS, 'ease-out');
}

// Une transition complete : sortie de l'ancienne place s'il y en a une, puis
// entree de la place demandee A CET INSTANT — pas celle qui l'a declenchee, qui
// a pu changer entre-temps. On boucle tant que la demande bouge.
async function positionTransition() {
    positionHud.busy = true;
    while (positionHud.shown !== positionHud.wanted) {
        if (positionHud.shown) await positionOut();

        const next = positionHud.wanted;
        positionHud.shown = next;
        if (!next) {
            positionHud.el.classList.remove('is-on');
            break;
        }
        const cached = imageCache[`position_${next}`];
        positionHud.img.src = cached ? cached.src : GAME_CONFIG.resources.paths.position(next);
        positionHud.img.alt = `Place ${next}`;
        positionHud.el.classList.add('is-on');
        await positionIn();
    }
    positionHud.busy = false;
}

// Appelee a chaque image. Ne touche au DOM que quand la place change.
function updatePositionHud() {
    if (!positionHud.el) {
        positionHud.el = document.getElementById('race-position');
        if (!positionHud.el) return;
        positionHud.img = positionHud.el.querySelector('img');
    }

    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
    // Sur la grille aussi, comme dans le jeu : on part avec sa place de depart.
    const rank = kart ? Math.max(1, Math.min(8, kart.rank | 0)) : 0;

    positionHud.wanted = rank;
    if (!positionHud.busy && positionHud.shown !== rank) positionTransition();
}
