// Le classement lateral : les vignettes, leur ordre, leurs animations.

function initLeaderboard() {
    leaderboardState.container = document.getElementById('race-leaderboard');
    if (!leaderboardState.container) return;

    leaderboardState.container.innerHTML = '';
    leaderboardState.slots = [];

    if (!leaderboardState.bound) {
        leaderboardState.bound = true;
        leaderboardState.container.addEventListener('click', onLeaderboardClick);
    }

    const camera = document.createElement('div');
    camera.className = 'leaderboard-pp leaderboard-camera visible';
    camera.title = 'Vue par defaut';
    camera.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>' +
        '<path d="M15 11.2l5-2.7v7l-5-2.7z"/></svg>';
    leaderboardState.container.appendChild(camera);
    leaderboardState.cameraEl = camera;

    // Pause, entre la camera et le vote. Elle porte ses deux icones d'un coup,
    // barres et triangle : c'est le CSS qui montre celle de l'etat courant, ce
    // qui evite de reconstruire du balisage a chaque clic.
    const pause = document.createElement('div');
    pause.className = 'leaderboard-pp leaderboard-pause visible';
    pause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<g class="ico-pause"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></g>' +
        '<g class="ico-play"><path d="M9 5l10 7-10 7z"/></g></svg>';
    leaderboardState.container.appendChild(pause);
    leaderboardState.pauseEl = pause;

    // Vote de redemarrage, tout a gauche. Le compteur est pose par
    // renderVote() : ici on ne construit que la coquille.
    const vote = document.createElement('div');
    vote.className = 'leaderboard-pp leaderboard-vote visible';
    vote.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>' +
        '<span class="leaderboard-vote-count"></span>';
    leaderboardState.container.appendChild(vote);
    leaderboardState.voteEl = vote;

    updateFocusMarks();
    renderPause();
    renderVote();

    const totalKarts = GAME_CONFIG.resources.characters.length;
    for (let i = 0; i < totalKarts; i++) {
        const slot = document.createElement('div');
        slot.className = 'leaderboard-slot';
        slot.dataset.slotIndex = i;
        leaderboardState.container.appendChild(slot);
        leaderboardState.slots.push(slot);
    }
}

function ensurePPEl(kart) {
    if (!leaderboardState.container) return null;
    if (ppEls[kart.id]) return ppEls[kart.id];

    const ppDiv = document.createElement('div');
    ppDiv.className = 'leaderboard-pp';
    ppDiv.dataset.kartId = kart.id;

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
    img.alt = kart.charName;
    // ppStarRainbow, 0,4 s.
    alignAnimationPhase(img, 400);
    ppDiv.appendChild(img);

    ppEls[kart.id] = ppDiv;

    leaderboardState.container.appendChild(ppDiv);

    setTimeout(() => {
        ppDiv.classList.add('visible');
    }, 50);

    return ppDiv;
}

function applyLeaderboardPosition(kartId, newPosition, prevPosition) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('overtaking', 'dropping');

    if (prevPosition !== -1 && prevPosition !== newPosition) {
        if (newPosition < prevPosition) {
            ppElement.classList.add('overtaking');
        } else {
            ppElement.classList.add('dropping');
        }

        ppAnimating[kartId] = true;
        setTimeout(() => {
            ppElement.classList.remove('overtaking', 'dropping');
            ppAnimating[kartId] = false;
            positionPPInSlot(kartId, newPosition);
        }, 400);
    } else {
        positionPPInSlot(kartId, newPosition);
    }
}

function positionPPInSlot(kartId, slotIndex) {
    const ppElement = ppEls[kartId];
    if (!ppElement || slotIndex >= leaderboardState.slots.length) return;

    const slotWidth = cachedIsMobile ? 32 : 46;
    const totalSlots = leaderboardState.slots.length;
    const reversedIndex = (totalSlots - 1) - slotIndex;
    const xPos = reversedIndex * slotWidth;

    ppElement.style.top = '0px';
    ppElement.style.left = `${xPos}px`;
    ppSlots[kartId] = slotIndex;
}

function triggerPPHitAnimation(kartId) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('hit');
    void ppElement.offsetWidth;
    ppElement.classList.add('hit');

    setTimeout(() => {
        ppElement.classList.remove('hit');
    }, 600);
}
