// Le dessin d'une image, a partir de l'etat interpole.
//
// Une seule fonction, appelee soixante fois par seconde. Elle ne lit que
// `worldState` et n'ecrit que dans le DOM.

function renderState(gameNow, screenWidth, frameMs) {
    const renderMargin = GAME_CONFIG.rendering.bufferZone;

    // Avant la camera de rendu : elle suit le kart choisi ici, et le faire
    // apres afficherait une image de retard a chaque changement de plan.
    raceDirector.update(gameNow);
    updateRenderCamera();
    updateFocusHud(frameMs);

    if (domDirty) {
        domDirty = false;
        reconcileDom();
        renderResults();
        renderGrandPrix(gameNow);
        renderVote();
    }

    // Hors du bloc ci-dessus : le compteur et le glissement vers le general
    // doivent avancer a chaque frame, pas seulement quand un snapshot arrive.
    stepGrandPrixAnimation(gameNow);

    renderLakitu(gameNow, screenWidth);
    renderStorm(gameNow, screenWidth);

    // Les trois calques de decor sont des textures, pas des elements places :
    // ils ne passent pas par getScreenPosition et doivent donc appliquer le
    // meme recentrage a la main. Le bord gauche de la fenetre, c'est le centre
    // moins la moitie de la largeur visible.
    const halfView = screenWidth / 2;

    if (cachedBg) {
        // Été : parallaxe, moitié vitesse.
        const bgX = cachedIsSummerBanner ? renderBgCameraX : renderCameraX;
        scrollLayer(cachedBg, halfView - bgX, bgScroll);
    } else {
        cachedBg = document.querySelector('.layer-scrolling-bg');
    }

    if (cachedFg) {
        // Décor de premier plan (été uniquement) : même vitesse que la route.
        const fgX = (renderCameraX - halfView) % WORLD.width;
        scrollLayer(cachedFg, -fgX, fgScroll);
    } else {
        cachedFg = document.querySelector('.layer-scrolling-fg');
    }

    if (cachedGround) {
        // Bordure de route : un motif de 80 px ancre sur le monde, decale du
        // reste de la division. Modulo positif, un reste negatif donnerait une
        // valeur CSS invalide. Pas de rattrapage a la `scrollLayer` : le pas EST
        // la periode du motif.
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
        // Solidaire du fond, pas de la route.
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

    // La demi-largeur du sprite se lit par kart (`kartDrawHalfWidth`) : deux
    // personnages n'ont pas la meme longueur. `heldBehindX` est une position du
    // monde publiee par le serveur — le moteur y teste l'emprise de l'objet
    // traine, et la carte de debug l'y dessine.
    const wBoxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;
    const heldBehindX = (wBoxes.heldBehindX !== undefined)
        ? wBoxes.heldBehindX : OFFLINE_WORLD.hitboxes.heldBehindX;

    const kartsLen = worldState.karts.length;
    for (let i = 0; i < kartsLen; i++) {
        const kart = worldState.karts[i];
        const els = kartEls[kart.id];
        if (!els) continue;
        const wrapper = els.wrapper;

        if (kart.state === 'hit') {
            if (kart.stopped) {
                if (!wrapper.classList.contains('kart-stopped')) wrapper.classList.add('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.add('item-stopped');
            } else {
                wrapper.classList.remove('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
            }
        } else {
            wrapper.classList.remove('kart-stopped');
            if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
        }

        const rx = getScreenPosition(kart.worldX, renderCameraX, screenWidth);
        const spriteX = rx - kartDrawHalfWidth(kart);
        const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

        if (isVisibleNow) {
            wrapper.style.display = 'block';
            wrapper.style.transform = `translate3d(${spriteX}px, ${depthToY(kart.yPercent)}px, 0)`;

            const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
            if (wrapper.style.zIndex != zVal) wrapper.style.zIndex = zVal;

            // Pendant le vol, le sprite du personnage cede la place au bill : plus
            // de tete-a-queue, plus de miroir, plus de rebond. `spinFrame` est
            // remis a -1 pour qu'au retour la frame courante soit forcement vue
            // comme un changement et le personnage repose.
            if (kart.isBill) {
                if (!els.billOn) {
                    els.billOn = true;
                    els.sprite.classList.remove('kart-mirrored');
                    els.wrapper.classList.add('kart-bill');
                    els.spinFrame = -1;
                    // Le bill se dessine sur l'emprise du bill, pas sur celle du
                    // personnage : sa largeur CSS se compte en pourcentage du
                    // conteneur, qu'on ramene donc a la reference le temps du vol.
                    els.wrapper.style.setProperty('--kart-length', 1);
                }

                // Trois images, cadencees par le temps de jeu comme les carapaces :
                // rien a memoriser, et deux bills en vol restent en phase.
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

                // Le choc contre un tuyau ne touche PAS au sprite : le kart garde
                // sa pose, et le choc se lit entierement dans ce qu'il fait —
                // l'arret net, le recul, la glissade. La pose de face qu'il
                // prenait avant donnait l'impression d'un bug plutot que d'un
                // choc. Ne reste ici que le tete-a-queue, qui a bien ses frames a
                // jouer.
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

                    // Un objet passe de la main au trainage pendant sa vie :
                    // le rebond suit, il n'appartient qu'a l'objet tenu en main.
                    const inHands = kart.heldItem.holdPosition === 'hands';
                    hel.classList.toggle('held-item-bouncing', inHands);

                    // Deux objets tenus, deux natures, deux placements.
                    //
                    // EN MAIN, l'objet n'a pas d'emprise : sa place est du dessin
                    // pur, calee sur la silhouette. TRAINE, il a une emprise, et
                    // c'est tout l'interet — le moteur la teste a `worldX +
                    // heldBehindX`, une position du monde. La dessiner ailleurs,
                    // c'est montrer une banane a cote de celle qui touche.
                    let hx, hy;
                    if (inHands) {
                        const hOffset = getHandsItemRenderOffset();
                        hx = spriteX + hOffset.offset + (hel._halfW || 0);
                        hy = hOffset.yShift;
                    } else {
                        hx = rx + heldBehindX;
                        hy = 0;
                    }
                    // `hy` monte l'objet par rapport a son porteur ; la
                    // profondeur du porteur s'y ajoute, dans la meme
                    // transformation.
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
            // `hop` souleve l'objet sans toucher a sa profondeur de piste : une
            // banane en cloche passe au-dessus, elle ne change pas de couloir.
            // Les deux se somment dans la transformation, le sol reste a zero.
            el.style.transform = `translate3d(${rx}px, ${depthToY(item.y) - item.hop}px, 0)`;
            // Le souffle passe devant tout le monde : il doit recouvrir les
            // karts qu'il emporte.
            const zVal = item.type === 'blueBlast'
                ? GAME_CONFIG.rendering.zIndexBase + 60
                : (GAME_CONFIG.rendering.zIndexBase - item.y) | 0;
            if (el.style.zIndex != zVal) el.style.zIndex = zVal;
        } else {
            el.style.display = 'none';
        }
    }
}
