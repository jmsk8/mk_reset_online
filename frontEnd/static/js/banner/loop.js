// La boucle d'animation et la mesure de sa sante.

// Quelques compteurs, assez legers pour rester en place : ils distinguent une
// saccade venue du reseau (le rendu attend un snapshot en retard, `gel` monte)
// d'une saccade venue de la machine (le framerate baisse sans gel).
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
    // Course figee : plus rien n'est lu du tampon ni repeint, la scene reste sur
    // sa derniere image. La boucle, elle, continue de tourner — c'est par elle
    // qu'on repartira au clic suivant. L'horloge ne se rattrape pas davantage :
    // corriger une derive sur une scene arretee ne se verrait pas, et le premier
    // stepClock() de la reprise s'en chargera, d'un saut s'il le faut.
    if (racePaused) {
        lastFrameTime = timestamp;
        animationId = requestAnimationFrame(animate);
        return;
    }

    stepClock();

    // Les dimensions viennent du cache, tenu a jour par `resize` : les lire ici
    // forcerait un recalcul de mise en page a chaque image. Un cache vide ne se
    // voit qu'au demarrage, quand le decor n'etait pas encore mesurable.
    if (!viewMetrics.containerWidth) refreshLayoutMetrics();

    if (viewMetrics.containerWidth) {
        // La largeur de monde visible EST la largeur du conteneur :
        // `getScreenPosition` rend un ecart en px de MISE EN PAGE dans ce
        // conteneur, ou se posent les `translate3d`.
        //
        // Elle etait divisee par `mobileScale`, et le compte etait fait deux fois
        // : la feuille de style donne au wrapper 166.67 % de largeur AVANT de le
        // reduire de 0.6, donc `offsetWidth` les rend deja. Le centre du cadre
        // tombait a 83 % du conteneur — invisible camera libre, mais un kart
        // suivi se posait colle au bord droit.
        const screenWidth = viewMetrics.containerWidth;

        const gameNow = getGameTime();

        // On affiche un instant deja passe, le temps d'avoir les deux snapshots
        // qui l'encadrent. Sans ce retard, rien a interpoler.
        const renderTime = gameNow - RENDER_DELAY_MS;
        const frame = bannerNet.frameFor(renderTime);

        // Un couple sans second terme, c'est un rendu hors tampon : la scene se
        // fige sur le dernier etat connu jusqu'au prochain snapshot.
        trackFrame(timestamp, !!frame && !frame.b);

        if (frame) {
            applyState(frame.a, frame.b, frame.t);
        } else if (!bannerNet.ready) {
            // Hors ligne : aucune course, mais le decor continue de defiler.
            const elapsed = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0;
            const advance = WORLD.roadPPS * Math.min(elapsed, 0.1);
            worldState.cameraX = (worldState.cameraX + advance) % WORLD.width;
            worldState.bgCameraX = (worldState.bgCameraX + advance / 2) % WORLD.width;
        }

        // Duree de l'image, bornee : un onglet revenu au premier plan rend un
        // premier ecart de plusieurs secondes, dont personne n'a rien a faire.
        const frameMs = lastFrameTime ? Math.min(timestamp - lastFrameTime, 100) : 0;

        // Les positions affichees sont celles de `renderTime` : la toupie, les
        // frames de carapace et la levitation des boites doivent suivre la meme
        // horloge, sinon elles avancent 120 ms devant la scene.
        renderState(renderTime, screenWidth, frameMs);
    }

    lastFrameTime = timestamp;

    if (GAME_CONFIG.debugMode) updateDebugHUD();
    updateAiHud();
    animationId = requestAnimationFrame(animate);
}
