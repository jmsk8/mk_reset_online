// L'orage et Lakitu : les deux animations qui debordent de la piste.

// Orage de l'eclair. Deux mecaniques dans le meme calque : l'assombrissement est
// DERIVE DU TEMPS, recalcule a chaque image depuis les trois dates du snapshot —
// c'est ce qui donne le bon niveau de noir a un arrivant ; les eclairs sont une
// animation ponctuelle, jouee au passage de la frappe, qu'un retardataire rate
// sans consequence.
//
// Trois traits en SVG, dans un cadre de 40x120 etire par le CSS. Chaque trace se
// termine A DROITE de son depart : les karts vont vers la droite, un eclair qui
// derive a gauche semble tomber derriere eux.
const STORM_VIEWBOX_W = 40;
const STORM_BOLTS = [
    { left: 22, tip: 29, path: 'M12 0 L24 42 L13 47 L29 120' },
    { left: 54, tip: 34, path: 'M10 0 L22 38 L11 44 L34 120' },
    { left: 83, tip: 31, path: 'M14 0 L26 46 L15 51 L31 120' }
];

// Largeur des traits, miroir de .storm-bolt en CSS : l'ecart se calcule en
// pixels de conteneur, il lui faut la meme mesure que le rendu.
const STORM_BOLT_W = { pc: 60, mobile: 40 };

// Marge entre la pointe et le bord du kart epargne.
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

        // Deux traits sur le meme chemin : le large porte la lueur jaune, le fin
        // le coeur blanc. Un seul trait donnerait une barre plate.
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

// Le lanceur traverse son propre orage indemne : le trait qui viserait sa
// position est ecarte juste assez pour tomber a cote. Au plus un est concerne,
// les ancres etant trop espacees pour qu'un meme kart en couvre deux.
function placeStormBolts(els, shooterId, screenWidth) {
    const svgs = els.bolts.children;
    const boltW = cachedIsMobile ? STORM_BOLT_W.mobile : STORM_BOLT_W.pc;
    // Le milieu du kart EST sa position : le sprite y est centre, comme sa
    // hitbox. `keepOut` ci-dessous s'en deduit — la demi-largeur DE CE KART,
    // qui n'est pas la meme pour tous depuis que le dessin suit le sprite, plus
    // la marge de confort.
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

                // On decale du cote ou le trait etait deja ; l'autre sert de
                // repli quand celui-la sort de l'ecran.
                if (beforeFits && (anchor <= shooterCx || !afterFits)) {
                    anchor = before;
                } else if (afterFits) {
                    anchor = after;
                } else {
                    // Nulle part ou tomber : plutot pas de trait du tout.
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

    // Le ciel se charge jusqu'a la frappe, tient, puis se degage sur la fin.
    // Avec strikeAt a zero la premiere branche ne sert pas : le noir est pose
    // d'un coup, sur la frame meme ou les eclairs partent. Elle reste la pour
    // qu'un `strikeAt` non nul redonne un ciel qui se charge.
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

    // Une seule fois par orage, au passage de la frappe. Le retrait/reflow/repose
    // est ce qui relance une animation CSS deja jouee : sans lui, un second
    // orage dans la meme course laisserait le ciel noir sans le moindre eclair.
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

// Lakitu est ancre sur la ligne de depart : c'est la camera qui le fait entrer
// et sortir du cadre, et le serveur qui decide du panneau qu'il tient.
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

    lakituEls = { wrapper: wrapper, img: img, key: null, height: '' };
    return lakituEls;
}

function lakituSrc(group, frame, gameNow) {
    // Le drapeau s'anime a partir du temps : le serveur n'envoie que le groupe.
    if (group === 'finish') {
        frame = (Math.floor(gameNow / WORLD.flagAnimSpeed) % 3) + 1;
    }
    const cached = imageCache[`lakitu_${group}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.lakitu(group, frame);
}

function renderLakitu(gameNow, screenWidth) {
    const els = ensureLakituEl();
    if (!els) return;

    const sign = worldState.sign;
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

    els.wrapper.style.display = 'block';

    // `height` est une propriete de mise en page : on ne la reecrit que lorsque
    // l'appareil a change de gabarit, pas soixante fois par seconde.
    const h = `${cachedIsMobile ? LAKITU_HEIGHT.mobile : LAKITU_HEIGHT.pc}px`;
    if (els.height !== h) {
        els.height = h;
        els.wrapper.style.height = h;
    }
    // Centre sur la ligne : la moitie de largeur gagnee compte sur mobile.
    //
    // Sa profondeur passe par la meme conversion que les corps de la piste : il
    // survole le bitume, et doit donc rester colle a lui quand le cadre change
    // de hauteur. En pourcentage de scene il aurait derive vers le haut.
    els.wrapper.style.transform =
        `translate3d(${rx}px, ${depthToY(LAKITU_BOTTOM)}px, 0) translateX(-50%)`;
}
