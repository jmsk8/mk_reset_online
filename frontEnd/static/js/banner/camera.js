// La camera de rendu : ou le monde se trouve a l'ecran.
//
// Le serveur envoie SA camera ; celle-ci la suit en douceur, ou s'en detache
// quand le spectateur a choisi de suivre un kart en particulier.

// Kart suivi par la camera, ou null pour la camera par defaut. Purement local :
// deux spectateurs peuvent regarder des karts differents, ils voient la meme
// course sous un autre angle. Cet etat ne part jamais au serveur.
let focusedKartId = null;

// Course figee. Aussi local que la camera : le serveur continue de courir et
// de diffuser, c'est notre rendu seul qui s'arrete sur l'image. Rien ne part
// donc au serveur — un spectateur qui met en pause ne fige la course de
// personne d'autre, et la reprise le remet sur le direct, pas la ou il l'avait
// laissee. C'est le meme parti que l'onglet endormi : « la course continue sans
// nous, il n'y a rien a reprendre ».
let racePaused = false;

// Camera effectivement utilisee pour le rendu. Elle vaut celle du serveur en
// mode par defaut, et la position du kart suivi sinon.
let renderCameraX = 0;
let renderBgCameraX = 0;
let lastFocusCameraX = null;

function wrapWorld(x) {
    const w = WORLD.width;
    if (x < 0) return x + w;
    if (x >= w) return x - w;
    return x;
}

function shortestDelta(from, to) {
    const w = WORLD.width;
    let delta = to - from;
    if (delta > w / 2) delta -= w;
    else if (delta < -w / 2) delta += w;
    return delta;
}

// Le cadrage du depart, sur un ecran etroit.
//
// Le serveur gare sa camera face a la ligne, et une seule camera pour tous : un
// PC voit la grille entiere de part et d'autre, un telephone (~650 unites
// visibles) n'en voit que la moitie avant. Le recadrage est donc local : la vue
// recule, juste assez pour la grille, sans jamais laisser la ligne sortir — elle
// reste a `START_LINE_MARGIN` du bord droit, bande a damier et Lakitu compris.
// Sur un ecran assez large, le decalage vaut zero et rien ne change.
const START_LINE_MARGIN = 70;
const START_BACK_PAD = 10;

// Au feu vert, le decalage fond au lieu de sauter : la camera du serveur part
// en defilement, et un saut de plusieurs centaines d'unites se verrait.
const START_SHIFT_RELEASE_MS = 3000;

let startShift = 0;
let startShiftReleasedAt = null;

function measureStartShift(screenWidth) {
    const half = screenWidth / 2;
    const camX = worldState.cameraX;

    // Le fond de grille lu sur les karts eux-memes : sa profondeur est un
    // reglage du serveur, que le client ne recopie pas.
    let back = 0;
    for (const kart of worldState.karts) {
        const behind = shortestDelta(kart.worldX, camX) + kartDrawHalfWidth(kart);
        if (behind > back) back = behind;
    }

    const lineX = shortestDelta(camX, WORLD.finishLineX);
    const needed = back + START_BACK_PAD - half;
    const allowed = half - lineX - START_LINE_MARGIN;
    return Math.max(0, Math.min(needed, allowed));
}

// Ce qu'il faut retrancher a la camera du serveur, maintenant.
function startFrameShift(gameNow, screenWidth) {
    const phase = worldState.phase;

    if (phase === 'countdown') {
        startShift = measureStartShift(screenWidth);
        startShiftReleasedAt = null;
        return startShift;
    }

    if (phase !== 'racing' || startShift === 0) {
        startShift = 0;
        return 0;
    }

    if (startShiftReleasedAt === null) startShiftReleasedAt = gameNow;
    // Horloge recalee en arriere (cf. `stepClock`) : on repart de la.
    if (startShiftReleasedAt > gameNow) startShiftReleasedAt = gameNow;

    const t = (gameNow - startShiftReleasedAt) / START_SHIFT_RELEASE_MS;
    if (t >= 1) {
        startShift = 0;
        return 0;
    }
    return startShift * (1 - t * t * (3 - 2 * t));
}

function updateRenderCamera(gameNow, screenWidth) {
    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
    // Mesure meme quand un kart est suivi : le fondu part du feu vert, pas du
    // retour a la vue par defaut.
    const shift = startFrameShift(gameNow, screenWidth);

    if (!kart) {
        renderCameraX = wrapWorld(worldState.cameraX - shift);
        // Le fond recule de moitie, comme il avance de moitie.
        renderBgCameraX = wrapWorld(worldState.bgCameraX - shift / 2);
        lastFocusCameraX = null;
        return;
    }

    // Le fond ne peut pas garder sa propre vitesse : il avance de la moitie du
    // deplacement de la camera, sinon decor et route se desolidarisent des que
    // celle-ci change d'allure.
    if (lastFocusCameraX === null) {
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = worldState.cameraX;
    }

    renderBgCameraX = wrapWorld(renderBgCameraX + shortestDelta(lastFocusCameraX, kart.worldX) / 2);
    renderCameraX = kart.worldX;
    lastFocusCameraX = kart.worldX;
}
