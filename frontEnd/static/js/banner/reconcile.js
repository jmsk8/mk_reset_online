// Le DOM mis au pas de l'etat : creer, deplacer, retirer.
//
// Aucune fonction d'ici ne decide de quoi que ce soit. Elles comparent ce qui
// est affiche a ce que le serveur a envoye, et corrigent la difference.

// Reconciliation du DOM avec l'etat du monde. Regle : l'etat fait foi, les
// evenements ne sont que de la decoration. A chaque etat recu, le DOM est aligne
// dessus — ce qui manque est cree, ce qui ne correspond plus a rien est supprime.
//
// C'est ce qui rend affichable une course deja commencee : un spectateur qui
// arrive a la 187e seconde n'a vu aucun evenement et doit pourtant voir la scene
// complete.

// La longueur d'un kart a l'ecran n'est plus la meme pour tous : chaque
// personnage est dessine au prorata de son PNG, et son emprise l'est du meme
// rapport. Le serveur envoie ce rapport dans son `hello` — le client ne le deduit
// pas.
//
// 1 pendant un vol de bill : le sprite n'est plus celui du personnage, et le bill
// a une emprise a lui, la meme quel que soit son porteur.
function kartDrawScale(kart) {
    if (kart.isBill) return 1;
    return (kart.body && kart.body.scale) || 1;
}

// Demi-longueur DESSINEE, en px. `worldX` est le CENTRE du kart et l'element se
// pose par son coin gauche : il faut reculer d'autant pour que le dessin tombe
// sur l'emprise qui le fait toucher. Tout ce qui se cale sur la SILHOUETTE part
// de ce meme bord gauche.
function kartDrawHalfWidth(kart) {
    const base = cachedIsMobile ? GAME_CONFIG.rendering.kartWidth.mobile
                                : GAME_CONFIG.rendering.kartWidth.pc;
    return base * kartDrawScale(kart) / 2;
}

function ensureKartEl(kart) {
    let els = kartEls[kart.id];
    if (els) return els;

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.classList.add('kart-container-moving');
    wrapper.style.zIndex = getZIndex(kart.yPercent);

    // La longueur du dessin, en rapport au kart de reference. Une variable CSS et
    // non des pixels : c'est la feuille de style qui connait la largeur de base,
    // et elle n'est pas la meme sur mobile.
    wrapper.style.setProperty('--kart-length', kartDrawScale(kart));

    // Intercalaire dédié au rapetissement de l'éclair : il porte une transition,
    // que le miroir du tête-à-queue ne doit surtout pas subir.
    const scaler = document.createElement('div');
    scaler.classList.add('kart-scaler');

    // Intercalaire dédié au miroir : snesBounce occupe déjà `transform`
    // sur l'img, on ne peut pas y empiler un scaleX(-1).
    const sprite = document.createElement('div');
    sprite.classList.add('kart-sprite');

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.char(kart.charName);
    img.classList.add('kart-static-png');
    // snesBounce (0,15 s en alternate = cycle de 0,3 s) et starRainbow (0,3 s).
    alignAnimationPhase(img, 300);

    sprite.appendChild(img);
    scaler.appendChild(sprite);
    wrapper.appendChild(scaler);
    cachedContainer.appendChild(wrapper);

    // `spinFrame` decrit ce que cet element affiche : il vit donc avec lui, et
    // non dans l'etat du kart, qui est reconstruit a chaque `hello`. Sinon le
    // rendu croirait n'avoir rien a changer et laisserait le sprite fige sur
    // une image de tete-a-queue. 0 correspond au sprite pose ci-dessus.
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

    const size = cachedIsMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const el = document.createElement('div');
    el.classList.add('item-box');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    // Centree sur sa position, comme le tuyau et comme les karts : la zone de
    // ramassage (hitboxes.itemBox, +/-10) est centree sur `worldX`, une boite
    // posee par son coin gauche se ramasserait a 21 px de la ou elle est vue.
    el.style.marginLeft = `${-size / 2}px`;
    el.style.zIndex = getZIndex(box.y);

    cachedContainer.appendChild(el);
    boxEls[index] = el;
    return el;
}

// Le tuyau est ancre par sa base a sa profondeur, comme un kart, et centre sur
// sa position : la hitbox du serveur l'est aussi, et un element pose par son
// bord gauche s'arreterait une demi-largeur trop loin. Le recentrage se pose
// une fois ici, comme pour les karts, les boites et les objets — aucun corps ne
// le refait a chaque frame.
function ensurePipeEl(pipe, index) {
    if (pipeEls[index]) return pipeEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    // Du serveur et de lui seul : c'est cette taille qui a servi a calculer
    // l'emprise du tuyau, les deux ne peuvent donc plus diverger. Posee en
    // variables et non en pixels — le retrecissement mobile du DESSIN vit dans la
    // feuille de style, et un tuyau une fois cree n'est jamais recree.
    const size = WORLD.pipeDraw || OFFLINE_WORLD.pipeDraw;
    const el = document.createElement('div');
    el.classList.add('pipe');
    el.style.setProperty('--pipe-w', size.w);
    el.style.setProperty('--pipe-h', size.h);
    el.style.zIndex = getZIndex(pipe.y);

    // Le dessin vit dans un enfant, et non sur l'element place. Le defilement
    // pose une `transform` a chaque frame sur le parent ; une animation CSS sur
    // la meme propriete l'emporterait dans la cascade et figerait le tuyau a
    // l'ecran pendant tout son sursaut.
    const sprite = document.createElement('div');
    sprite.classList.add('pipe-sprite');

    // La couleur, et c'est tout ce qu'elle fait. Elle vit sur le sprite et non
    // sur l'element place : le parent porte le defilement et l'etat (le
    // sursaut), l'enfant porte le dessin. Le vert est le defaut de
    // `.pipe-sprite`, donc un tuyau sans couleur s'affiche quand meme.
    if (pipe.kind === 'red') sprite.classList.add('pipe-red');

    el.appendChild(sprite);

    // Le sursaut se joue en ajoutant une classe. Sans ce retrait a la fin, un
    // second passage d'etoile ne rejouerait rien. L'evenement remonte de
    // l'enfant anime jusqu'ici.
    el.addEventListener('animationend', () => el.classList.remove('pipe-shaken'));

    cachedContainer.appendChild(el);
    pipeEls[index] = el;
    return el;
}

// Un objet peut exister a trois endroits : libre sur la piste, tenu par un
// kart, ou en orbite autour de lui (auquel cas ce sont les orbes qui portent
// les ids, pas le groupe). Tout ce qui n'est dans aucun des trois est un
// orphelin : element laisse par un objet detruit, ou reliquat d'une course
// precedente. Sans ce balayage, chaque reconnexion fuirait quelques divs.
function reconcileItems() {
    const expected = {};

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        expected[item.id] = true;

        // L'element a ete cree quand l'objet etait encore en main, donc avec le
        // rebond. Une fois lance, il n'y a plus rien pour le retirer : sans
        // cette ligne, une banane sautille au sol.
        ensureItemEl(item.id, item.type, 'behind').classList.remove('held-item-bouncing');
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

// Le classement se reconstruit de zero : un arrivant doit voir les huit photos
// deja rangees dans l'ordre, sans avoir vu le moindre depassement. Les karts
// encore `pending` n'y figurent pas — ils ne sont pas entres en course.
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

// Le halo d'etoile est un etat, pas un evenement : `starOn` / `starOff` ne sont
// que les instants ou il bascule, invisibles pour qui arrive entre les deux.
function reconcileStar(kart) {
    const on = !!kart.isInvincible;
    const els = kartEls[kart.id];
    if (els) els.wrapper.classList.toggle('star-active', on);
    const pp = ppEls[kart.id];
    if (pp) pp.classList.toggle('pp-star-active', on);
}

// Le rapetissement est un etat, pas une animation : il se lit dans le snapshot
// et se pose en classe. La transition CSS fait le reste, a l'aller comme au
// retour — un arrivant en cours de malus voit un kart deja petit, sans a-coup.
function reconcileShrink(kart) {
    const els = kartEls[kart.id];
    if (!els) return;
    els.scaler.style.setProperty('--kart-scale', kart.isShrunk ? WORLD.shrinkScale : 1);

    // L'ecrasement se pose sur le meme calque, et les deux se multiplient : un
    // kart peut etre petit ET aplati, les deux comptes a rebours etant
    // independants.
    //
    // Contrairement au rapetissement, l'ampleur est ecrite en CSS et non
    // transmise : un kart aplati a exactement la meme emprise qu'avant, ce n'est
    // plus que du dessin.
    els.scaler.classList.toggle('is-flat', !!kart.isFlat);

    // La carte de debug suit le rapetissement : l'emprise a vraiment maigri, pas
    // seulement le dessin. Ecrit au CHANGEMENT seulement — une mesure du DOM par
    // kart et par image pour un etat qui bouge deux fois en dix secondes serait
    // payee cher.
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

// Les evenements ne creent et ne detruisent plus rien : ils ne declenchent que
// des animations ponctuelles, qu'un spectateur arrive en retard peut rater sans
// que sa scene en soit fausse. Tout le reste est deduit de l'etat par
// reconcileDom(). Les types non listes ici (kartSpawned, spawnHeldItem,
// removeHeldItem, killItem, launchItem, starOn, starOff) n'ont donc plus
// d'effet propre.
function applyEvent(ev) {
    switch (ev.type) {
        case 'kartHit': {
            triggerPPHitAnimation(ev.kartId);
            break;
        }
        // Un pipe traverse par une etoile : il sursaute, et se remet en place.
        // Purement decoratif, et invisible dans le snapshot — le tuyau est au
        // meme endroit avant et apres. Un arrivant en retard le rate sans que sa
        // scene en soit fausse.
        case 'pipeShaken': {
            const el = pipeEls[ev.pipeIndex];
            if (el) {
                el.classList.remove('pipe-shaken');
                // Force le navigateur a reprendre l'animation depuis le debut :
                // sans cette lecture, retirer puis remettre la classe dans la
                // meme frame ne relance rien.
                void el.offsetWidth;
                el.classList.add('pipe-shaken');
            }
            break;
        }
        case 'leaderboardPosition': {
            // Le glissement n'a de sens que si la photo etait deja quelque part.
            if (ppEls[ev.kartId]) applyLeaderboardPosition(ev.kartId, ev.newPosition, ev.prevPosition);
            break;
        }
    }
}

// Dérivé uniquement de l'état physique (state + hitEndTime) : aucun timer de
// rendu à maintenir, donc rien qui puisse désynchroniser du reste de la course.
// Le kart boucle kartSpin.turns fois sur la fraction durationRatio du malus,
// puis reste sur side-right jusqu'à ce qu'il reparte.
function getSpinFrameIndex(kart, gameNow) {
    if (kart.state !== 'hit') return 0;

    const hitDuration = WORLD.hitDuration;
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
