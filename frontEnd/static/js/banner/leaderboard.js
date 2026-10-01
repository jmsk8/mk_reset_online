// Classement lateral : vignettes, ordre et animations.

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

    // Pause (mode debug) : les deux icones sont presentes, le CSS montre la bonne.
    leaderboardState.pauseEl = null;
    if (GAME_CONFIG.debugMode) {
        const pause = document.createElement('div');
        pause.className = 'leaderboard-pp leaderboard-pause visible';
        pause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
            '<g class="ico-pause"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></g>' +
            '<g class="ico-play"><path d="M9 5l10 7-10 7z"/></g></svg>';
        leaderboardState.container.appendChild(pause);
        leaderboardState.pauseEl = pause;
    }

    // Vote de redemarrage (compteur pose par renderVote()).
    const vote = document.createElement('div');
    vote.className = 'leaderboard-pp leaderboard-vote visible';
    vote.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>' +
        '<span class="leaderboard-vote-count"></span>';
    leaderboardState.container.appendChild(vote);
    leaderboardState.voteEl = vote;

    // Plein ecran, montre sur ecran tactile seulement.
    const fullscreen = document.createElement('div');
    fullscreen.className = 'leaderboard-pp leaderboard-fullscreen visible';
    fullscreen.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<g class="ico-enter"><path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z"/></g>' +
        '<g class="ico-exit"><path d="M8 4h2v6H4V8h4zM14 4h2v4h4v2h-6zM4 14h6v6H8v-4H4zM14 14h6v2h-4v4h-2z"/></g></svg>';
    leaderboardState.container.appendChild(fullscreen);
    leaderboardState.fullscreenEl = fullscreen;

    updateFocusMarks();
    renderPause();
    renderVote();
    renderFullscreenButton();

    setLeaderboardSlots(worldState.karts.length);
}

// Une case par kart en course (roster.perRace). Ne refait rien si le nombre
// n'a pas change.
function setLeaderboardSlots(count) {
    if (!leaderboardState.container) return;
    if (leaderboardState.slots.length === count) return;

    for (const slot of leaderboardState.slots) slot.remove();
    leaderboardState.slots = [];
    for (let i = 0; i < count; i++) {
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
