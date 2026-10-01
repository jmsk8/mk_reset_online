// Place du kart suivi (« 1st », « 2nd »...), images colorisees par
// scripts/colorize-positions.py. Pendant une transition, seule la derniere
// place demandee est retenue.

const POSITION_OUT_MS = 160;
const POSITION_IN_MS = 300;

const positionHud = {
    el: null,
    img: null,
    shown: 0, // place affichee, 0 = rien
    wanted: 0, // place a afficher
    busy: false // une transition tourne
};

function positionReducedMotion() {
    return window.matchMedia &&
           window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Promesse tenue a la fin de l'animation (immediate sans animation).
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

// Sortie de l'ancienne place puis entree de la place demandee a cet instant ;
// on boucle tant que la demande change.
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

// Appelee a chaque image ; ne touche au DOM que si la place change.
function updatePositionHud() {
    if (!positionHud.el) {
        positionHud.el = document.getElementById('race-position');
        if (!positionHud.el) return;
        positionHud.img = positionHud.el.querySelector('img');
    }

    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
    const rank = kart ? Math.max(1, Math.min(8, kart.rank | 0)) : 0;

    positionHud.wanted = rank;
    if (!positionHud.busy && positionHud.shown !== rank) positionTransition();
}
