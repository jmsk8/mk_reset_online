// Camera de rendu : suit celle du serveur, ou le kart choisi par le spectateur.

// Kart suivi, ou null pour la camera par defaut (local au spectateur).
let focusedKartId = null;

// Course figee, localement seulement : la reprise revient au direct.
let racePaused = false;

// Camera utilisee pour le rendu.
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

// Cadrage du depart sur ecran etroit : la vue recule pour montrer la grille,
// en gardant la ligne a START_LINE_MARGIN du bord droit.
const START_LINE_MARGIN = 70;
const START_BACK_PAD = 10;

// Au feu vert, le decalage s'annule progressivement.
const START_SHIFT_RELEASE_MS = 3000;

let startShift = 0;
let startShiftReleasedAt = null;

function measureStartShift(screenWidth) {
    const half = screenWidth / 2;
    const camX = worldState.cameraX;

    // Fond de grille lu sur les karts.
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

// Decalage a retrancher a la camera du serveur.
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
    // Horloge recalee en arriere (voir stepClock).
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
    // Calcule meme quand un kart est suivi : le fondu part du feu vert.
    const shift = startFrameShift(gameNow, screenWidth);

    if (!kart) {
        renderCameraX = wrapWorld(worldState.cameraX - shift);
        // Le fond se deplace a mi-vitesse.
        renderBgCameraX = wrapWorld(worldState.bgCameraX - shift / 2);
        lastFocusCameraX = null;
        return;
    }

    // Le fond avance de la moitie du deplacement de la camera.
    if (lastFocusCameraX === null) {
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = worldState.cameraX;
    }

    renderBgCameraX = wrapWorld(renderBgCameraX + shortestDelta(lastFocusCameraX, kart.worldX) / 2);
    renderCameraX = kart.worldX;
    lastFocusCameraX = kart.worldX;
}
