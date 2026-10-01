// Kart suivi : cartouche, releve de decision et selection.

// Cartouche du kart suivi : son tour (et sa vitesse en mode debug), deduits de
// `totalDistance`.
let focusHudEl = null;
let focusHudPrevDistance = null;
let focusHudSpeed = 0;
let focusHudText = '';

// Constante de temps du lissage de la vitesse, en ms.
const FOCUS_HUD_SMOOTH_MS = 220;

function resetFocusHud() {
    focusHudPrevDistance = null;
    focusHudSpeed = 0;
    focusHudText = '';
    if (focusHudEl) focusHudEl.classList.remove('is-on');
}

function updateFocusHud(frameMs) {
    if (!focusHudEl) {
        focusHudEl = document.getElementById('race-focus-hud');
        if (!focusHudEl) return;
    }

    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
    if (!kart) {
        if (focusHudPrevDistance !== null) resetFocusHud();
        return;
    }

    // Premier passage : pose le repere sans afficher de vitesse.
    if (focusHudPrevDistance === null) {
        focusHudPrevDistance = kart.totalDistance;
        focusHudEl.classList.add('is-on');
    } else if (frameMs > 0) {
        const moved = kart.totalDistance - focusHudPrevDistance;
        focusHudPrevDistance = kart.totalDistance;

        // Pas de vitesse negative (recul contre un tuyau).
        const raw = Math.max(0, (moved * 1000) / frameMs);
        const k = frameMs / FOCUS_HUD_SMOOTH_MS;
        focusHudSpeed += (raw - focusHudSpeed) * (k > 1 ? 1 : k);
    }

    const lap = Math.min(WORLD.laps || 1, Math.floor(kart.totalDistance / WORLD.width) + 1);
    let text = `TOUR ${lap}/${WORLD.laps || 1}`;
    if (GAME_CONFIG.debugMode) text += ` \u00B7 ${Math.round(focusHudSpeed)} px/s`;

    // DOM modifie seulement si le texte change.
    if (text !== focusHudText) {
        focusHudText = text;
        focusHudEl.textContent = text;
    }
}

// Releve de decision du kart suivi (mode debug), traduit de `kart.ai`. Libelles
// indexes par cle (ordre fourni par WORLD.ai) ; une cle inconnue s'affiche telle quelle.
const AI_STATE_LABELS = {
    cruising: 'roule',
    pipe: 'contourne un tuyau',
    dodging: 'esquive',
    safety: 'se range',
    giveWay: 'laisse passer',
    aiming: 'vise',
    yieldLead: 'cede la tete'
};
const AI_DANGER_LABELS = {
    '': '\u2014',
    carrier: 'porteur arme',
    ram: 'etoile / bill',
    shot: 'carapace en vol'
};
// Alerte entendue la plus pressante (voir `hear` cote serveur).
const AI_ALERT_LABELS = {
    '': '',
    ram: 'etoile / bill',
    red: 'rouge sur lui',
    blue: 'bleue'
};

function aiLabel(table, labels, index) {
    const key = table[index];
    if (key === undefined) return labels[table[0]] || '\u2014';
    return labels[key] !== undefined ? labels[key] : key;
}

let aiHudEl = null;
let aiHudValue = -1;

function aiRow(key, value, tone) {
    const cls = tone || 'ai-val';
    return `<div class="ai-row"><span class="ai-key">${key}</span>` +
           `<span class="${cls}">${value}</span></div>`;
}

function updateAiHud() {
    if (!aiHudEl) {
        aiHudEl = document.getElementById('race-ai-hud');
        if (!aiHudEl) return;
    }

    const kart = (GAME_CONFIG.debugMode && focusedKartId !== null)
        ? worldState.kartsById[focusedKartId] : null;

    if (!kart) {
        if (aiHudValue !== -1) {
            aiHudValue = -1;
            aiHudEl.classList.remove('is-on');
            aiHudEl.innerHTML = '';
        }
        return;
    }

    const v = kart.ai || 0;

    // DOM modifie seulement si l'etat change.
    if (v === aiHudValue) return;
    aiHudValue = v;

    const tables = WORLD.ai || OFFLINE_WORLD.ai;
    const state = aiLabel(tables.states, AI_STATE_LABELS, v & 15);
    const danger = aiLabel(tables.dangers, AI_DANGER_LABELS, (v >> 4) & 3);
    const back = (v >> 6) & 1;
    const brake = (v >> 7) & 1;
    const shield = (v >> 8) & 1;
    const twoReds = (v >> 9) & 1;
    const itemAhead = (v >> 10) & 1;
    const pipeAhead = (v >> 11) & 1;
    const carrierAhead = (v >> 12) & 1;
    const heardIndex = (v >> 13) & 3;
    const heard = aiLabel(tables.alerts || [''], AI_ALERT_LABELS, heardIndex);
    const blueOnMe = (v >> 15) & 1;
    const cover = (v >> 16) & 1;
    const watch = (v >> 17) & 1;

    const look = (back ? 'DERRIERE' : 'devant') + (watch ? '  \u00B7  suit du regard' : '');

    const rearParts = [];
    if ((v >> 4) & 3) rearParts.push(danger + (twoReds ? '  \u00B7  deux rouges' : ''));
    if (heardIndex) rearParts.push('entend : ' + heard + (blueOnMe ? ' (sur lui)' : ''));
    const rear = rearParts.length ? rearParts.join('  \u00B7  ') : '\u2014';

    // « porteur » : kart devant, dans l'axe, avec un objet a lacher derriere lui.
    const front = [];
    if (pipeAhead) front.push('tuyau');
    if (itemAhead) front.push('objet');
    if (carrierAhead) front.push('porteur');

    const doing = [state];
    if (brake) doing.push('frein');
    if (shield) doing.push('bouclier');
    if (cover) doing.push('garde son objet');

    aiHudEl.innerHTML =
        aiRow('regard', look, back ? 'ai-warn' : 'ai-val') +
        aiRow('derriere', rear, rearParts.length ? 'ai-hot' : 'ai-off') +
        aiRow('devant', front.length ? front.join('  \u00B7  ') : '\u2014',
              front.length ? 'ai-warn' : 'ai-off') +
        aiRow('decision', doing.join('  \u00B7  '), 'ai-val');

    aiHudEl.classList.add('is-on');
}

function setFocus(kartId) {
    focusedKartId = kartId;
    lastFocusCameraX = null;
    aiHudValue = -1;
    resetFocusHud();
    updateFocusMarks();
    requestVision();
}

// Demande le releve de vision du kart suivi (mode debug seulement). A renvoyer
// apres chaque `hello` : une reconnexion repart d'une fiche vierge.
function requestVision() {
    if (!GAME_CONFIG.debugMode) return;
    bannerNet.send({ t: 'watch', id: focusedKartId });
    if (focusedKartId === null) worldState.vision = null;
}

function updateFocusMarks() {
    const cameraBtn = leaderboardState.cameraEl;
    if (cameraBtn) {
        cameraBtn.classList.toggle('is-focused', focusedKartId === null);
        // Camera jaune : realisation automatique active.
        cameraBtn.classList.toggle('is-auto', raceDirector.auto);
        cameraBtn.title = raceDirector.auto
            ? 'Realisation automatique'
            : 'Revenir a la realisation automatique';
    }

    for (const id in ppEls) {
        ppEls[id].classList.toggle('is-focused', String(focusedKartId) === id);
    }
}

function onLeaderboardClick(event) {
    const target = event.target.closest('.leaderboard-vote, .leaderboard-pause, .leaderboard-fullscreen, .leaderboard-camera, [data-kart-id]');
    if (!target) return;

    if (target.classList.contains('leaderboard-fullscreen')) {
        toggleBannerFullscreen();
        return;
    }

    if (target.classList.contains('leaderboard-vote')) {
        toggleVote();
        return;
    }

    if (target.classList.contains('leaderboard-pause')) {
        togglePause();
        return;
    }

    // Le bouton camera remet la realisation automatique sans jamais la couper
    // (vue fixe : bannerDebug.realise(false)).
    if (target.classList.contains('leaderboard-camera')) {
        if (raceDirector.auto) return;
        raceDirector.setAuto(true);
        setFocus(null);
        return;
    }

    // Cliquer un joueur passe en focus manuel.
    raceDirector.setAuto(false);
    setFocus(Number(target.dataset.kartId));
}
