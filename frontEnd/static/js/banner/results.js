// Fin de course : classement final, puis tableau du grand prix.

let resultsEl = null;
let resultsShown = -1;
let gpEl = null;
let gpShown = '';
// Animation du tableau : arrivee, transfert des gains vers le cumul, puis
// remise en ordre sur le general. null hors animation.
let gpAnim = null;

// Durees de l'animation du tableau (voir la transition de .race-gp-row), sous
// resultsDelayMs.
const GP_COUNT_DELAY_MS = 2200;
const GP_COUNT_DURATION_MS = 2600;
const GP_REORDER_DELAY_MS = 350;

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

// Reconstruit entierement depuis `finishOrder`.
function renderResults() {
    if (!resultsEl) resultsEl = document.getElementById('race-results');
    if (!resultsEl) return;

    // Affiche pendant les arrivees, efface quand le tableau prend le relais.
    const order = worldState.finishOrder || [];
    const visible = order.length > 0 && worldState.phase !== 'results';

    resultsEl.classList.toggle('is-visible', visible);
    if (!visible) {
        resultsShown = 0;
        resultsEl.innerHTML = '';
        return;
    }

    if (resultsShown === order.length) return;
    resultsShown = order.length;

    resultsEl.innerHTML = '';
    order.forEach((kartId, index) => {
        const kart = worldState.kartsById[kartId];
        if (!kart) return;

        const entry = document.createElement('div');
        entry.className = 'race-result';

        const rank = document.createElement('span');
        rank.className = 'race-result-rank';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
        img.alt = kart.charName;

        entry.appendChild(rank);
        entry.appendChild(img);
        resultsEl.appendChild(entry);
    });
}

// Tableau du grand prix, reconstruit depuis le snapshot ; l'animation est
// jouee par stepGrandPrixAnimation.
function renderGrandPrix(gameNow) {
    if (!gpEl) gpEl = document.getElementById('race-gp');
    if (!gpEl) return;

    const gp = worldState.gp;
    const visible = !!gp && worldState.phase === 'results';

    gpEl.classList.toggle('is-visible', visible);
    gpEl.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (!visible) {
        gpShown = '';
        gpAnim = null;
        gpEl.innerHTML = '';
        return;
    }

    const round = gp[0];
    const racePoints = gp[1] || [];
    const totalPoints = gp[2] || [];

    // Reconstruit seulement si le contenu change.
    const stamp = round + '|' + racePoints.join(',') + '|' + totalPoints.join(',');
    if (gpShown === stamp) return;
    gpShown = stamp;

    const total = (WORLD && WORLD.gpRaces) || round;
    const isFinal = round >= total;

    gpEl.innerHTML = '';
    gpEl.classList.toggle('is-final', isFinal);

    const title = document.createElement('div');
    title.className = 'race-gp-title';
    title.textContent = isFinal ? 'CLASSEMENT FINAL' : `COURSE ${round} / ${total}`;
    gpEl.appendChild(title);

    const rows = document.createElement('div');
    rows.className = 'race-gp-rows';

    // Premiere image : ordre d'arrivee de la course.
    const arrivalOrder = worldState.finishOrder.length
        ? worldState.finishOrder
        : worldState.karts.map(kart => kart.id);

    const entries = arrivalOrder
        .map(id => worldState.kartsById[id])
        .filter(Boolean);

    const animRows = [];

    entries.forEach((kart, index) => {
        const gained = racePoints[kart.id] || 0;
        const target = totalPoints[kart.id] || 0;
        // Le cumul part de sa valeur d'avant la course.
        const base = target - gained;

        const row = document.createElement('div');
        row.className = 'race-gp-row';

        const rank = document.createElement('span');
        rank.className = 'race-gp-rank';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
        img.alt = kart.charName;

        const name = document.createElement('span');
        name.className = 'race-gp-name';
        name.textContent = kart.charName;

        const gainedEl = document.createElement('span');
        gainedEl.className = 'race-gp-gained';
        gainedEl.textContent = gained > 0 ? `+${gained}` : '';

        const scoreEl = document.createElement('span');
        scoreEl.className = 'race-gp-total';
        scoreEl.textContent = base;

        row.appendChild(rank);
        row.appendChild(img);
        row.appendChild(name);
        row.appendChild(gainedEl);
        row.appendChild(scoreEl);
        rows.appendChild(row);

        animRows.push({
            id: kart.id, row, rankEl: rank, gainedEl, scoreEl,
            base, target, gained, finishIndex: index
        });
    });

    gpEl.appendChild(rows);

    gpAnim = {
        rowsEl: rows,
        rows: animRows,
        startAt: gameNow,
        phase: 'count',
        reorderAt: 0
    };
}

// Passage de l'ordre d'arrivee au general, anime (technique FLIP).
function settleGrandPrixReorder(anim) {
    const before = new Map();
    anim.rows.forEach(entry => before.set(entry.id, entry.row.getBoundingClientRect()));

    const standings = anim.rows.slice().sort((a, b) => {
        const diff = b.target - a.target;
        // A egalite, la course qui vient de finir departage.
        return diff !== 0 ? diff : a.finishIndex - b.finishIndex;
    });

    standings.forEach((entry, index) => {
        anim.rowsEl.appendChild(entry.row);
        entry.rankEl.textContent = index + 1;
    });

    standings.forEach(entry => {
        const after = entry.row.getBoundingClientRect();
        const dy = before.get(entry.id).top - after.top;
        if (!dy) return;

        entry.row.style.transition = 'none';
        entry.row.style.transform = `translateY(${dy}px)`;
        // Force le reflow pour que la transition se joue.
        entry.row.getBoundingClientRect();
        entry.row.style.transition = '';
        entry.row.style.transform = '';
    });

    anim.rows = standings;
}

// Animation image par image, independante du rythme des snapshots (10 Hz).
function stepGrandPrixAnimation(gameNow) {
    const anim = gpAnim;
    if (!anim || anim.phase === 'done') return;

    const elapsed = gameNow - anim.startAt;

    if (anim.phase === 'count') {
        if (elapsed < GP_COUNT_DELAY_MS) return;

        const t = Math.min(1, (elapsed - GP_COUNT_DELAY_MS) / GP_COUNT_DURATION_MS);
        const eased = easeOutCubic(t);
        anim.rows.forEach(entry => {
            // Le gain se vide au rythme ou le total se remplit.
            const filled = Math.round(lerp(entry.base, entry.target, eased));
            entry.scoreEl.textContent = filled;

            const remaining = entry.target - filled;
            entry.gainedEl.textContent = remaining > 0 ? `+${remaining}` : '';
        });

        if (t >= 1) {
            anim.rows.forEach(entry => entry.row.classList.add('is-settled'));
            anim.phase = 'settled';
            anim.reorderAt = gameNow + GP_REORDER_DELAY_MS;
        }
        return;
    }

    if (anim.phase === 'settled' && gameNow >= anim.reorderAt) {
        settleGrandPrixReorder(anim);
        anim.phase = 'done';
    }
}
