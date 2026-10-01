// Dessin d'une image a partir de l'etat interpole (lit `worldState`, ecrit le DOM).

// Cahot d'un kart en px vers le haut, deduit du temps de jeu. Applique au kart
// et a son objet tenu dans la meme image pour qu'ils restent en phase.
function kartBounceY(kart, gameNow) {
    if (kart.isBill) return 0;
    if (kart.state === 'hit' && kart.stopped) return 0;
    const b = GAME_CONFIG.rendering.kartBounce;
    const phase = (gameNow % b.periodMs) / b.periodMs;
    return b.amplitude * (1 - Math.cos(phase * 2 * Math.PI)) / 2;
}

// L'objet tenu en main s'aplatit avec son kart : l'echelle est posee sur l'img,
// avec le point d'appui de `.kart-scaler.is-flat` (bas du kart, en son milieu),
// mesure une seule fois au moment de l'ecrasement.
function squashHeldItem(hel, kart, hOffset, s) {
    hel.classList.add('held-item-hands');
    const flat = !!kart.isFlat;
    if (flat === hel.classList.contains('held-item-flat')) return;

    const img = hel.firstChild;
    if (flat && img) {
        const gap = hel.offsetHeight - img.offsetTop - img.offsetHeight;
        const ox = kartDrawHalfWidth(kart) - hOffset.offset * s;
        const oy = img.offsetHeight + gap + hOffset.yShift * s;
        img.style.transformOrigin = `${ox}px ${oy}px`;
    }
    // Au retour, l'objet se redresse autour du meme point d'appui.
    hel.classList.toggle('held-item-flat', flat);
}

// Objet traine ou lache : il reprend sa forme d'un coup.
function releaseHeldItemSquash(el) {
    el.classList.remove('held-item-hands', 'held-item-flat');
}

function renderState(gameNow, screenWidth, frameMs) {
    const renderMargin = GAME_CONFIG.rendering.bufferZone;

    // Avant la camera de rendu, qui suit le kart choisi ici.
    raceDirector.update(gameNow);
    updateRenderCamera(gameNow, screenWidth);
    updateFocusHud(frameMs);
    updatePositionHud();

    if (domDirty) {
        domDirty = false;
        reconcileDom();
        renderResults();
        renderGrandPrix(gameNow);
        renderVote();
    }

    // Avance a chaque frame, pas seulement a l'arrivee d'un snapshot.
    stepGrandPrixAnimation(gameNow);

    renderLakitu(gameNow, screenWidth);
    renderStorm(gameNow, screenWidth);

    // Calques de decor recentres a la main (bord gauche = centre - demi-largeur).
    const halfView = screenWidth / 2;

    if (cachedBg) {
        // Été et automne : parallaxe, moitié vitesse.
        const bgX = cachedHasParallaxBg ? renderBgCameraX : renderCameraX;
        scrollLayer(cachedBg, halfView - bgX, bgScroll);
    } else {
        cachedBg = document.querySelector('.layer-scrolling-bg');
    }

    if (cachedMid) {
        // Second plan (automne) : moyenne des deux cameras (trois quarts de la
        // route). Le saut au bouclage vaut une texture (3840 px) et ne se voit pas.
        const midX = (renderCameraX + renderBgCameraX) / 2;
        scrollLayer(cachedMid, halfView - midX, midScroll);
    }

    if (cachedFg) {
        // Décor de premier plan (été et automne) : même vitesse que la route.
        const fgX = (renderCameraX - halfView) % WORLD.width;
        scrollLayer(cachedFg, -fgX, fgScroll);
    } else {
        cachedFg = document.querySelector('.layer-scrolling-fg');
    }

    if (cachedGround) {
        // Bordure de route : motif de 80 px ancre sur le monde (modulo positif).
        const roadX = (((renderCameraX - halfView) % ROAD_PATTERN_WIDTH) + ROAD_PATTERN_WIDTH) % ROAD_PATTERN_WIDTH;
        cachedGround.style.setProperty('--road-offset', `${-roadX}px`);
    } else {
        cachedGround = document.querySelector('.layer-ground');
    }

    if (worldState.finishLine && worldState.finishLine.element) {
        const rx = getScreenPosition(worldState.finishLine.worldX, renderCameraX, screenWidth);
        worldState.finishLine.element.style.transform = `translate3d(${rx}px, 0, 0)`;
    }

    if (worldState.sun && worldState.sun.element) {
        // Solidaire du fond.
        const sx = getScreenPosition(worldState.sun.worldX, renderBgCameraX, screenWidth);
        worldState.sun.element.style.transform = `translate3d(${sx}px, 0, 0)`;
    }

    const boxesLen = worldState.itemBoxes.length;
    const floatY = Math.sin(gameNow * GAME_CONFIG.rendering.boxFloat.speed) * GAME_CONFIG.rendering.boxFloat.amplitude;
    for (let i = 0; i < boxesLen; i++) {
        const box = worldState.itemBoxes[i];
        const el = boxEls[i];
        if (!el) continue;
        if (!box.active) { el.style.display = 'none'; continue; }

        const rx = getScreenPosition(box.worldX, renderCameraX, screenWidth);
        if (rx > -renderMargin && rx < screenWidth + renderMargin) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, ${depthToY(box.y) + floatY}px, 0)`;
        } else {
            el.style.display = 'none';
        }
    }

    for (let i = 0; i < worldState.pipes.length; i++) {
        const pipe = worldState.pipes[i];
        const el = pipeEls[i];
        if (!el) continue;

        const rx = getScreenPosition(pipe.worldX, renderCameraX, screenWidth);

        if (rx > -renderMargin && rx < screenWidth + renderMargin) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, ${depthToY(pipe.y)}px, 0)`;
        } else {
            el.style.display = 'none';
        }
    }

    // Demi-largeur du sprite propre a chaque kart ; `heldBehindX` est une
    // position du monde fournie par le serveur.
    const wBoxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;
    const heldBehindX = (wBoxes.heldBehindX !== undefined)
        ? wBoxes.heldBehindX : OFFLINE_WORLD.hitboxes.heldBehindX;

    const kartsLen = worldState.karts.length;
    for (let i = 0; i < kartsLen; i++) {
        const kart = worldState.karts[i];
        const els = kartEls[kart.id];
        if (!els) continue;
        const wrapper = els.wrapper;

        // Fige l'arc-en-ciel de l'etoile (le cahot est coupe dans kartBounceY).
        wrapper.classList.toggle('kart-stopped', kart.state === 'hit' && !!kart.stopped);

        const rx = getScreenPosition(kart.worldX, renderCameraX, screenWidth);
        const spriteX = rx - kartDrawHalfWidth(kart);
        const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

        if (isVisibleNow) {
            // Meme valeur que l'objet tenu en main.
            const bounceY = kartBounceY(kart, gameNow);
            wrapper.style.display = 'block';
            wrapper.style.transform = `translate3d(${spriteX}px, ${depthToY(kart.yPercent) - bounceY}px, 0)`;

            const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
            if (wrapper.style.zIndex != zVal) wrapper.style.zIndex = zVal;

            // En vol, le sprite du bill remplace le personnage ; spinFrame a -1
            // force la remise du personnage au retour.
            if (kart.isBill) {
                if (!els.billOn) {
                    els.billOn = true;
                    els.sprite.classList.remove('kart-mirrored');
                    els.wrapper.classList.add('kart-bill');
                    els.spinFrame = -1;
                    // Largeur du bill calee sur le kart de reference.
                    els.wrapper.style.setProperty('--kart-length', 1);
                }

                // Trois images cadencees par le temps de jeu.
                const billFrame = (Math.floor(gameNow / WORLD.billAnimSpeed) % 3) + 1;
                if (els.billFrame !== billFrame) {
                    els.billFrame = billFrame;
                    const cached = imageCache[`bill_${billFrame}`];
                    els.img.src = cached ? cached.src : GAME_CONFIG.resources.paths.bill(billFrame);
                }
            } else {
                if (els.billOn) {
                    els.billOn = false;
                    els.billFrame = 0;
                    els.wrapper.classList.remove('kart-bill');
                    els.wrapper.style.setProperty('--kart-length', kartDrawScale(kart));
                }

                // Choc contre un tuyau : le sprite ne change pas, seul le
                // tete-a-queue a des frames.
                const spinFrame = getSpinFrameIndex(kart, gameNow);
                if (els.spinFrame !== spinFrame) {
                    els.spinFrame = spinFrame;
                    applyKartSpinFrame(kart, els, spinFrame);
                }
            }

            if (kart.heldItem && kart.heldItem.holdPosition === 'orbit') {
                renderOrbitItems(kart, rx, gameNow);
            } else if (kart.heldItem) {
                const hel = itemEls[kart.heldItem.id];
                if (hel) {
                    hel.style.display = 'block';

                    // Le cahot ne concerne que l'objet tenu en main.
                    const inHands = kart.heldItem.holdPosition === 'hands';

                    // En main : place purement visuelle. Traine : a sa position
                    // du monde (worldX + heldBehindX), la ou le moteur le teste.
                    let hx, hy;
                    if (inHands) {
                        // Ecart proportionnel a la taille du sprite.
                        const hOffset = getHandsItemRenderOffset();
                        const s = kartDrawScale(kart);
                        hx = spriteX + hOffset.offset * s + (hel._halfW || 0);
                        // Meme cahot que le porteur.
                        hy = hOffset.yShift * s + bounceY;
                        squashHeldItem(hel, kart, hOffset, s);
                    } else {
                        hx = rx + heldBehindX;
                        hy = 0;
                        releaseHeldItemSquash(hel);
                    }
                    // Hauteur par rapport au porteur, plus sa profondeur.
                    hel.style.transform = `translate3d(${hx}px, ${depthToY(kart.yPercent) - hy}px, 0)`;
                    const itemZ = inHands ? zVal + 1 : zVal;
                    if (hel.style.zIndex != itemZ) hel.style.zIndex = itemZ;
                }
            }
        } else {
            wrapper.style.display = 'none';
            hideHeldItem(kart);
        }
    }

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        const el = itemEls[item.id];
        if (!el) continue;

        if (item.type === 'greenShell' || item.type === 'redShell' || item.type === 'blueShell') {
            const img = el.firstChild;
            if (img) {
                const cached = imageCache[`${item.type}_${item.currentFrame}`];
                const src = cached ? cached.src : GAME_CONFIG.resources.paths[item.type](item.currentFrame);
                if (img.getAttribute('src') !== src) img.src = src;
            }
        }

        const rx = getScreenPosition(item.worldX, renderCameraX, screenWidth);
        const isVisible = (rx > -renderMargin && rx < screenWidth + renderMargin);
        if (isVisible) {
            el.style.display = 'block';
            // `hop` souleve l'objet sans changer sa profondeur.
            el.style.transform = `translate3d(${rx}px, ${depthToY(item.y) - item.hop}px, 0)`;
            // Le souffle passe devant les karts.
            const zVal = item.type === 'blueBlast'
                ? GAME_CONFIG.rendering.zIndexBase + 60
                : (GAME_CONFIG.rendering.zIndexBase - item.y) | 0;
            if (el.style.zIndex != zVal) el.style.zIndex = zVal;
        } else {
            el.style.display = 'none';
        }
    }
}
