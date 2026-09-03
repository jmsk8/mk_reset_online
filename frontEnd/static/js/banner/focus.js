// Le kart suivi : son cartouche, son releve de decision, sa selection.
//
// Tout ce que le spectateur obtient en cliquant sur une bulle du classement.

// Le cartouche du kart suivi : tour et vitesse, seulement quand la camera suit
// quelqu'un — c'est une lecture de son tableau de bord.
//
// Les deux se DEDUISENT de `totalDistance`, seule chose transmise. La vitesse
// parce que ce qui interesse un spectateur n'est pas la consigne du moteur mais
// le terrain reellement couvert : un kart bloque, en tete-a-queue ou en train de
// reculer roule a ce que dit sa position. Rien n'est donc a ajouter au protocole.
let focusHudEl = null;
let focusHudPrevDistance = null;
let focusHudSpeed = 0;
let focusHudText = '';

// Constante de temps du lissage, en ms. La distance est interpolee entre deux
// snapshots : la derivee brute saute a chaque arrivee de paquet, et un compteur
// qui clignote est illisible. Assez court pour qu'un champignon se voie tout de
// suite, assez long pour ne pas trembler.
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

    // Le premier passage n'a pas de pas precedent : il pose le repere et
    // n'affiche pas encore de vitesse, plutot que d'en inventer une.
    if (focusHudPrevDistance === null) {
        focusHudPrevDistance = kart.totalDistance;
        focusHudEl.classList.add('is-on');
    } else if (frameMs > 0) {
        const moved = kart.totalDistance - focusHudPrevDistance;
        focusHudPrevDistance = kart.totalDistance;

        // Un recul contre un tuyau rendrait une vitesse negative : le compteur
        // affiche l'allure, pas le sens de la marche.
        const raw = Math.max(0, (moved * 1000) / frameMs);
        const k = frameMs / FOCUS_HUD_SMOOTH_MS;
        focusHudSpeed += (raw - focusHudSpeed) * (k > 1 ? 1 : k);
    }

    const lap = Math.min(WORLD.laps || 1, Math.floor(kart.totalDistance / WORLD.width) + 1);
    const text = `TOUR ${lap}/${WORLD.laps || 1} \u00B7 ${Math.round(focusHudSpeed)} px/s`;

    // Le DOM n'est touche que quand le texte change vraiment : a 60 images par
    // seconde, la vitesse arrondie ne bouge pas a chaque frame.
    if (text !== focusHudText) {
        focusHudText = text;
        focusHudEl.textContent = text;
    }
}

// Le releve de decision, sous la banniere, en mode debug : ce que le kart suivi
// VOIT et ce qu'il en FAIT. Quatre lignes, pas une de plus — un tableau de bord
// qu'on ne lit pas d'un coup d'oeil ne sert a rien pendant une course.
//
// Tout vient du seul entier `kart.ai` du snapshot : le client ne DEDUIT rien, il
// traduit. Les libelles sont indexes par CLE et non par rang, l'ordre des indices
// arrivant du serveur dans `WORLD.ai` — une cle inconnue s'affiche telle quelle.
const AI_STATE_LABELS = {
    cruising: 'roule',
    pipe: 'contourne un tuyau',
    dodging: 'esquive',
    safety: 'se range',
    giveWay: 'laisse passer',
    aiming: 'vise'
};
const AI_DANGER_LABELS = {
    '': '\u2014',
    carrier: 'porteur arme',
    ram: 'etoile / bill',
    shot: 'carapace en vol'
};

// Traduit un indice en libelle, en passant par la cle que le serveur a nommee.
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

    // Le DOM n'est touche que quand l'etat change vraiment. A dix snapshots par
    // seconde et soixante images, le releve est identique la plupart du temps.
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

    // Le regard d'abord, parce qu'il conditionne tout le reste : ce qui n'est
    // pas regarde n'est pas vu, et donc pas traite.
    const look = back ? 'DERRIERE' : 'devant';

    const rear = ((v >> 4) & 3)
        ? danger + (twoReds ? '  \u00B7  deux rouges' : '')
        : '\u2014';

    // « porteur » n'est pas un objet en vol : c'est un kart devant, dans l'axe,
    // qui tient de quoi finir derriere lui. C'est le seul danger que le releve
    // taisait, et donc le seul qu'on ne pouvait pas voir manquer.
    const front = [];
    if (pipeAhead) front.push('tuyau');
    if (itemAhead) front.push('objet');
    if (carrierAhead) front.push('porteur');

    const doing = [state];
    if (brake) doing.push('frein');
    if (shield) doing.push('bouclier');

    aiHudEl.innerHTML =
        aiRow('regard', look, back ? 'ai-warn' : 'ai-val') +
        aiRow('derriere', rear, ((v >> 4) & 3) ? 'ai-hot' : 'ai-off') +
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

// Le releve de vision du kart suivi. Il ne se demande qu'en mode debug, et il
// coute au service une seconde serialisation par snapshot : hors debug, ce
// message ne part jamais et le spectateur reste sur le flux commun.
//
// A renvoyer apres chaque `hello` : le service ne garde rien d'une connexion a
// l'autre, et une course neuve renumerote... non, les identifiants tiennent —
// mais une reconnexion, elle, repart d'une fiche vierge.
function requestVision() {
    if (!GAME_CONFIG.debugMode) return;
    bannerNet.send({ t: 'watch', id: focusedKartId });
    if (focusedKartId === null) worldState.vision = null;
}

function updateFocusMarks() {
    const cameraBtn = leaderboardState.cameraEl;
    if (cameraBtn) {
        cameraBtn.classList.toggle('is-focused', focusedKartId === null);
        // La camera jaune dit que la realisation tourne, y compris pendant
        // qu'elle est posee sur un kart : sans ce reperage, un spectateur ne
        // peut pas savoir si la vue bougera toute seule.
        cameraBtn.classList.toggle('is-auto', raceDirector.auto);
        cameraBtn.title = raceDirector.auto
            ? 'Realisation automatique — cliquer pour rester sur la vue d\'ensemble'
            : 'Vue d\'ensemble — cliquer pour la realisation automatique';
    }

    for (const id in ppEls) {
        ppEls[id].classList.toggle('is-focused', String(focusedKartId) === id);
    }
}

function onLeaderboardClick(event) {
    const target = event.target.closest('.leaderboard-vote, .leaderboard-pause, .leaderboard-camera, [data-kart-id]');
    if (!target) return;

    if (target.classList.contains('leaderboard-vote')) {
        toggleVote();
        return;
    }

    if (target.classList.contains('leaderboard-pause')) {
        togglePause();
        return;
    }

    // Le bouton camera bascule la realisation automatique. Son etat de repos —
    // la vue d'ensemble — est exactement celui que la realisation occupe entre
    // deux plans : couper l'automatique, c'est donc s'y arreter.
    if (target.classList.contains('leaderboard-camera')) {
        raceDirector.setAuto(!raceDirector.auto);
        setFocus(null);
        return;
    }

    // Cliquer un joueur passe en focus manuel : a partir de la, c'est le
    // spectateur qui realise, et la camera ne bougera plus sans lui.
    raceDirector.setAuto(false);
    setFocus(Number(target.dataset.kartId));
}
