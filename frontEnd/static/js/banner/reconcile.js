// Reconciliation du DOM avec l'etat : ce qui manque est cree, ce qui ne
// correspond plus a rien est supprime. L'etat fait foi, les evenements ne sont
// que decoratifs (un arrivant en pleine course voit la scene complete).

// Rapport de longueur du dessin au kart de reference, envoye par le serveur
// (1 pendant un vol de bill).
function kartDrawScale(kart) {
    if (kart.isBill) return 1;
    return (kart.body && kart.body.scale) || 1;
}

// Demi-longueur dessinee, en px (`worldX` est le centre du kart).
function kartDrawHalfWidth(kart) {
    return GAME_CONFIG.rendering.kartWidth * kartDrawScale(kart) / 2;
}

function ensureKartEl(kart) {
    let els = kartEls[kart.id];
    if (els) return els;

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.classList.add('kart-container-moving');
    wrapper.style.zIndex = getZIndex(kart.yPercent);

    // Longueur du dessin, en variable CSS.
    wrapper.style.setProperty('--kart-length', kartDrawScale(kart));

    // Intercalaire du rapetissement (porte une transition).
    const scaler = document.createElement('div');
    scaler.classList.add('kart-scaler');

    // Intercalaire du miroir (le bill occupe deja `transform` sur l'img).
    const sprite = document.createElement('div');
    sprite.classList.add('kart-sprite');

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.char(kart.charName);
    img.classList.add('kart-static-png');
    // starRainbow (0,3 s).
    alignAnimationPhase(img, 300);

    sprite.appendChild(img);
    scaler.appendChild(sprite);
    wrapper.appendChild(scaler);
    cachedContainer.appendChild(wrapper);

    // `spinFrame` vit avec l'element (0 = sprite pose ci-dessus).
    els = { wrapper: wrapper, scaler: scaler, sprite: sprite, img: img, spinFrame: 0, billOn: false, billFrame: 0 };
    kartEls[kart.id] = els;

    return els;
}

function ensureItemEl(itemId, itemType, holdPosition) {
    let el = itemEls[itemId];
    if (el) return el;
    el = createHeldItemElement(itemType, holdPosition).div;
    itemEls[itemId] = el;
    return el;
}

function ensureBoxEl(box, index) {
    if (boxEls[index]) return boxEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const size = GAME_CONFIG.visuals.box.size;
    const el = document.createElement('div');
    el.classList.add('item-box');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    // Centree sur sa position, comme sa zone de ramassage.
    el.style.marginLeft = `${-size / 2}px`;
    el.style.zIndex = getZIndex(box.y);

    cachedContainer.appendChild(el);
    boxEls[index] = el;
    return el;
}

// Tuyau ancre par sa base et centre sur sa position (comme sa hitbox).
function ensurePipeEl(pipe, index) {
    if (pipeEls[index]) return pipeEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    // Taille fournie par le serveur, posee en variables CSS.
    const size = WORLD.pipeDraw || OFFLINE_WORLD.pipeDraw;
    const el = document.createElement('div');
    el.classList.add('pipe');
    el.style.setProperty('--pipe-w', size.w);
    el.style.setProperty('--pipe-h', size.h);
    el.style.zIndex = getZIndex(pipe.y);

    // Dessin dans un enfant : le parent porte la transform du defilement.
    const sprite = document.createElement('div');
    sprite.classList.add('pipe-sprite');

    // Couleur sur le sprite (vert par defaut).
    if (pipe.kind === 'red') sprite.classList.add('pipe-red');

    el.appendChild(sprite);

    // Retire la classe a la fin du sursaut pour pouvoir le rejouer.
    el.addEventListener('animationend', () => el.classList.remove('pipe-shaken'));

    cachedContainer.appendChild(el);
    pipeEls[index] = el;
    return el;
}

// Supprime les elements d'objets qui ne sont ni sur la piste, ni tenus, ni en
// orbite (orphelins).
function reconcileItems() {
    const expected = {};

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        expected[item.id] = true;

        // Un objet lance par un kart ecrase ne reste pas aplati.
        releaseHeldItemSquash(ensureItemEl(item.id, item.type, 'behind'));
    }

    for (let i = 0; i < worldState.karts.length; i++) {
        const held = worldState.karts[i].heldItem;
        if (!held) continue;

        if (held.holdPosition === 'orbit') {
            for (let o = 0; o < held.orbs.length; o++) {
                expected[held.orbs[o].id] = true;
                ensureItemEl(held.orbs[o].id, held.childType, 'orbit');
            }
        } else {
            expected[held.id] = true;
            ensureItemEl(held.id, held.type, held.holdPosition);
        }
    }

    for (const id in itemEls) {
        if (expected[id]) continue;
        itemEls[id].remove();
        delete itemEls[id];
    }
}

// Classement reconstruit de zero (karts `pending` exclus).
function reconcileLeaderboard() {
    for (let i = 0; i < worldState.karts.length; i++) {
        const kart = worldState.karts[i];

        ensurePPEl(kart);

        const slot = kart.rank - 1;
        if (!ppAnimating[kart.id] && ppSlots[kart.id] !== slot) {
            positionPPInSlot(kart.id, slot);
        }
    }

    for (const id in ppEls) {
        if (!worldState.kartsById[id]) removePPEl(id);
    }

    updateFocusMarks();
}

function removePPEl(kartId) {
    const el = ppEls[kartId];
    if (!el) return;
    el.remove();
    delete ppEls[kartId];
    delete ppSlots[kartId];
    delete ppAnimating[kartId];
}

// Halo d'etoile : un etat, pas un evenement.
function reconcileStar(kart) {
    const on = !!kart.isInvincible;
    const els = kartEls[kart.id];
    if (els) els.wrapper.classList.toggle('star-active', on);
    const pp = ppEls[kart.id];
    if (pp) pp.classList.toggle('pp-star-active', on);
}

// Rapetissement : etat lu dans le snapshot et pose en classe.
function reconcileShrink(kart) {
    const els = kartEls[kart.id];
    if (!els) return;
    els.scaler.style.setProperty('--kart-scale', kart.isShrunk ? WORLD.shrinkScale : 1);

    // Ecrasement cumulable avec le rapetissement, purement visuel.
    els.scaler.classList.toggle('is-flat', !!kart.isFlat);

    // La carte de debug suit le rapetissement (mise a jour au changement seulement).
    if (!GAME_CONFIG.debugMode || !kart.body) return;
    const shrink = kart.isShrunk ? WORLD.shrinkScale : 1;
    if (els.debugShrink === shrink) return;
    els.debugShrink = shrink;
    const mark = document.getElementById(`debug-kart-${kart.id}`);
    if (mark) sizeEntity(mark, { x: kart.body.x * shrink, y: kart.body.y * shrink });
}

function reconcileDom() {
    for (let i = 0; i < worldState.karts.length; i++) ensureKartEl(worldState.karts[i]);

    for (const id in kartEls) {
        if (worldState.kartsById[id]) continue;
        kartEls[id].wrapper.remove();
        delete kartEls[id];
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) ensureBoxEl(worldState.itemBoxes[i], i);
    while (boxEls.length > worldState.itemBoxes.length) boxEls.pop().remove();

    for (let i = 0; i < worldState.pipes.length; i++) ensurePipeEl(worldState.pipes[i], i);
    while (pipeEls.length > worldState.pipes.length) pipeEls.pop().remove();

    reconcileItems();
    reconcileLeaderboard();

    for (let i = 0; i < worldState.karts.length; i++) {
        reconcileStar(worldState.karts[i]);
        reconcileShrink(worldState.karts[i]);
    }
}

// Evenements : animations ponctuelles uniquement (tout le reste est deduit de
// l'etat par reconcileDom()).
function applyEvent(ev) {
    switch (ev.type) {
        case 'kartHit': {
            triggerPPHitAnimation(ev.kartId);
            break;
        }
        // Sursaut decoratif d'un tuyau traverse par une etoile.
        case 'pipeShaken': {
            const el = pipeEls[ev.pipeIndex];
            if (el) {
                el.classList.remove('pipe-shaken');
                // Lecture forcee pour relancer l'animation.
                void el.offsetWidth;
                el.classList.add('pipe-shaken');
            }
            break;
        }
        case 'leaderboardPosition': {
            // Glissement seulement si la photo existait deja.
            if (ppEls[ev.kartId]) applyLeaderboardPosition(ev.kartId, ev.newPosition, ev.prevPosition);
            break;
        }
    }
}

// Frame du tete-a-queue, derivee de state et hitEndTime : kartSpin.turns tours
// sur la fraction durationRatio du malus, puis side-right jusqu'au depart.
function getSpinFrameIndex(kart, gameNow) {
    if (kart.state !== 'hit') return 0;

    const hitDuration = kart.hitDuration || WORLD.hitDuration;
    const spinDuration = hitDuration * GAME_CONFIG.kartSpin.durationRatio;
    const elapsed = gameNow - (kart.hitEndTime - hitDuration);
    if (elapsed <= 0 || elapsed >= spinDuration) return 0;

    const frameCount = GAME_CONFIG.kartSpin.frames.length;
    return Math.floor((elapsed / spinDuration) * GAME_CONFIG.kartSpin.turns * frameCount) % frameCount;
}

function applyKartSpinFrame(kart, els, frameIndex) {
    const frame = GAME_CONFIG.kartSpin.frames[frameIndex];
    els.img.src = getKartFrameSrc(kart.charName, frame.dir);
    els.sprite.classList.toggle('kart-mirrored', frame.mirror);
}
