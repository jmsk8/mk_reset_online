// Orage et Lakitu.

// Orage de l'eclair : l'assombrissement est recalcule a chaque image depuis les
// dates du snapshot ; les eclairs sont une animation jouee a la frappe. Trois
// traits SVG (cadre 40x120 etire par le CSS), qui finissent a droite de leur
// depart.
const STORM_VIEWBOX_W = 40;
const STORM_BOLTS = [
    { left: 22, tip: 29, path: 'M12 0 L24 42 L13 47 L29 120' },
    { left: 54, tip: 34, path: 'M10 0 L22 38 L11 44 L34 120' },
    { left: 83, tip: 31, path: 'M14 0 L26 46 L15 51 L31 120' }
];

// Largeur des traits, identique a .storm-bolt (CSS).
const STORM_BOLT_W = 60;

const STORM_BOLT_CLEARANCE = 8;

let stormEls = null;

function ensureStormEls() {
    if (stormEls) return stormEls;

    const wrapper = document.querySelector('.game-content-wrapper');
    if (!wrapper) return null;

    const layer = document.createElement('div');
    layer.className = 'storm-layer';
    layer.setAttribute('aria-hidden', 'true');

    const dim = document.createElement('div');
    dim.className = 'storm-dim';
    layer.appendChild(dim);

    const bolts = document.createElement('div');
    bolts.className = 'storm-bolts';

    STORM_BOLTS.forEach(spec => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'storm-bolt');
        svg.setAttribute('viewBox', '0 0 40 120');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.left = `${spec.left}%`;

        // Trait large pour la lueur jaune, trait fin pour le coeur blanc.
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        glow.setAttribute('d', spec.path);
        glow.setAttribute('class', 'storm-bolt-glow');

        const core = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        core.setAttribute('d', spec.path);
        core.setAttribute('class', 'storm-bolt-core');

        svg.appendChild(glow);
        svg.appendChild(core);
        bolts.appendChild(svg);
    });

    layer.appendChild(bolts);

    const flash = document.createElement('div');
    flash.className = 'storm-flash';
    layer.appendChild(flash);

    wrapper.appendChild(layer);

    stormEls = { layer: layer, bolts: bolts, flash: flash, struckFor: 0 };
    return stormEls;
}

// Le trait qui viserait le lanceur est decale pour tomber a cote (un seul au plus).
function placeStormBolts(els, shooterId, screenWidth) {
    const svgs = els.bolts.children;
    const boltW = STORM_BOLT_W;
    // Zone epargnee : demi-largeur de ce kart plus la marge.
    const shooter = (shooterId === null || shooterId === undefined)
        ? null : worldState.kartsById[shooterId];
    const shooterCx = shooter
        ? getScreenPosition(shooter.worldX, renderCameraX, screenWidth)
        : null;

    for (let i = 0; i < STORM_BOLTS.length && i < svgs.length; i++) {
        const spec = STORM_BOLTS[i];
        const svg = svgs[i];
        svg.style.display = '';

        let anchor = (spec.left / 100) * screenWidth;

        if (shooterCx !== null) {
            const tipOffset = (spec.tip / STORM_VIEWBOX_W) * boltW - boltW / 2;
            const keepOut = kartDrawHalfWidth(shooter) + STORM_BOLT_CLEARANCE;

            if (Math.abs(anchor + tipOffset - shooterCx) < keepOut) {
                const half = boltW / 2;
                const before = shooterCx - keepOut - tipOffset;
                const after = shooterCx + keepOut - tipOffset;
                const beforeFits = before - half > 0;
                const afterFits = after + half < screenWidth;

                // On decale du cote du trait ; l'autre sert de repli.
                if (beforeFits && (anchor <= shooterCx || !afterFits)) {
                    anchor = before;
                } else if (afterFits) {
                    anchor = after;
                } else {
                // Aucune place : pas de trait.
                    svg.style.display = 'none';
                    continue;
                }
            }
        }

        svg.style.left = `${(anchor / screenWidth) * 100}%`;
    }
}

function renderStorm(gameNow, screenWidth) {
    const storm = worldState.storm;

    if (!storm) {
        if (stormEls && stormEls.layer.style.display !== 'none') {
            stormEls.layer.style.display = 'none';
            stormEls.bolts.classList.remove('storm-firing');
            stormEls.flash.classList.remove('storm-firing');
            stormEls.struckFor = 0;
        }
        return;
    }

    const els = ensureStormEls();
    if (!els) return;

    const startedAt = storm[0];
    const strikeAt = storm[1];
    const until = storm[2];

    // Le ciel se charge jusqu'a la frappe, tient, puis se degage.
    const STORM_CLEAR_MS = 700;
    let level;
    if (gameNow < strikeAt) {
        const build = Math.max(1, strikeAt - startedAt);
        level = (gameNow - startedAt) / build;
    } else if (gameNow > until - STORM_CLEAR_MS) {
        level = (until - gameNow) / STORM_CLEAR_MS;
    } else {
        level = 1;
    }
    level = Math.max(0, Math.min(1, level));

    els.layer.style.display = 'block';
    els.layer.style.opacity = level.toFixed(3);

    // Une fois par orage : retrait, reflow et remise relancent l'animation CSS.
    if (gameNow >= strikeAt && els.struckFor !== strikeAt) {
        els.struckFor = strikeAt;
        placeStormBolts(els, storm[3], screenWidth);
        els.bolts.classList.remove('storm-firing');
        els.flash.classList.remove('storm-firing');
        void els.bolts.offsetWidth;
        els.bolts.classList.add('storm-firing');
        els.flash.classList.add('storm-firing');
    }
}

// Lakitu, ancre sur la ligne de depart ; le serveur choisit le panneau.
let lakituEls = null;

function ensureLakituEl() {
    if (lakituEls) return lakituEls;
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'lakitu';

    const img = document.createElement('img');
    wrapper.appendChild(img);
    cachedContainer.appendChild(wrapper);

    lakituEls = { wrapper: wrapper, img: img, key: null, height: '', floating: false };
    return lakituEls;
}

function lakituSrc(group, frame, gameNow) {
    // Drapeau anime a partir du temps.
    if (group === 'finish') {
        frame = (Math.floor(gameNow / WORLD.flagAnimSpeed) % 3) + 1;
    }
    const cached = imageCache[`lakitu_${group}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.lakitu(group, frame);
}

// Panneau a montrer : celui du kart suivi s'il est dans son dernier tour
// (`finalLap`), sinon celui du service.
function lakituSignFor(kartId) {
    const sign = worldState.sign;
    const kart = kartId === null ? null : worldState.kartsById[kartId];
    if (kart && kart.finalLap && sign && sign[0] === 'finish') return ['laps', 'final'];
    return sign;
}

function renderLakitu(gameNow, screenWidth) {
    const els = ensureLakituEl();
    if (!els) return;

    const sign = lakituSignFor(focusedKartId);
    if (!sign) {
        els.wrapper.style.display = 'none';
        return;
    }

    const rx = getScreenPosition(WORLD.finishLineX, renderCameraX, screenWidth);
    const margin = GAME_CONFIG.rendering.bufferZone;
    if (rx < -margin || rx > screenWidth + margin) {
        els.wrapper.style.display = 'none';
        return;
    }

    const src = lakituSrc(sign[0], sign[1], gameNow);
    if (els.key !== src) {
        els.key = src;
        els.img.src = src;
    }

    // Flottement CSS avec les feux et le panneau du dernier tour, phase recalee
    // sur l'horloge du serveur a chaque reprise.
    const floating = sign[0] === 'start' || sign[0] === 'laps';
    if (els.floating !== floating) {
        els.floating = floating;
        if (floating) alignAnimationPhase(els.img, LAKITU_FLOAT_MS);
        els.wrapper.classList.toggle('is-floating', floating);
    }

    els.wrapper.style.display = 'block';

    // Hauteur posee une seule fois.
    const h = `${LAKITU_HEIGHT}px`;
    if (els.height !== h) {
        els.height = h;
        els.wrapper.style.height = h;
    }
    // Centre sur la ligne, profondeur convertie comme les corps de la piste.
    els.wrapper.style.transform =
        `translate3d(${rx}px, ${depthToY(LAKITU_BOTTOM)}px, 0) translateX(-50%)`;
}
