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

function updateRenderCamera() {
    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];

    if (!kart) {
        renderCameraX = worldState.cameraX;
        renderBgCameraX = worldState.bgCameraX;
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
