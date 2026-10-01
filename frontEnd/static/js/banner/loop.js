// Boucle d'animation et mesure de sa sante.

// Compteurs : un gel (`stalls`) indique un snapshot en retard, une baisse de
// fps sans gel indique la machine.
const perf = { frames: 0, stalls: 0, fps: 0, windowStart: 0, windowFrames: 0 };

function trackFrame(timestamp, stalled) {
    perf.frames++;
    if (stalled) perf.stalls++;

    if (!perf.windowStart) perf.windowStart = timestamp;
    perf.windowFrames++;

    const span = timestamp - perf.windowStart;
    if (span >= 1000) {
        perf.fps = Math.round((perf.windowFrames * 1000) / span);
        perf.windowStart = timestamp;
        perf.windowFrames = 0;
    }
}

function animate(timestamp) {
    // Course figee : la boucle tourne sans lire ni repeindre.
    if (racePaused) {
        lastFrameTime = timestamp;
        animationId = requestAnimationFrame(animate);
        return;
    }

    stepClock();

    // Dimensions en cache (mises a jour par `resize`).
    if (!viewMetrics.containerWidth) refreshLayoutMetrics();

    if (viewMetrics.containerWidth) {
        // Largeur de monde visible = largeur du conteneur (deja a l'echelle).
        const screenWidth = viewMetrics.containerWidth;

        const gameNow = getGameTime();

        // Rendu en retard sur le temps de jeu, pour interpoler entre deux snapshots.
        const renderTime = gameNow - RENDER_DELAY_MS;
        const frame = bannerNet.frameFor(renderTime);

        // Pas de second snapshot : la scene reste sur le dernier etat.
        trackFrame(timestamp, !!frame && !frame.b);

        if (frame) {
            applyState(frame.a, frame.b, frame.t);
        } else if (!bannerNet.ready) {
            // Hors ligne : seul le decor defile.
            const elapsed = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0;
            const advance = WORLD.roadPPS * Math.min(elapsed, 0.1);
            worldState.cameraX = (worldState.cameraX + advance) % WORLD.width;
            worldState.bgCameraX = (worldState.bgCameraX + advance / 2) % WORLD.width;
        }

        // Duree de l'image, bornee (retour d'un onglet en arriere-plan).
        const frameMs = lastFrameTime ? Math.min(timestamp - lastFrameTime, 100) : 0;

        // Toutes les animations suivent `renderTime`.
        renderState(renderTime, screenWidth, frameMs);
    }

    lastFrameTime = timestamp;

    if (GAME_CONFIG.debugMode) updateDebugHUD();
    updateAiHud();
    animationId = requestAnimationFrame(animate);
}
