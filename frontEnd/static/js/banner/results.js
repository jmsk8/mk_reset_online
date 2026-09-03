// La fin d'une course : le classement final, puis le tableau du grand prix.

let resultsEl = null;
let resultsShown = -1;
let gpEl = null;
// Empreinte du tableau affiche, pour ne le reconstruire qu'a un vrai changement.
let gpShown = '';
// Anime le tableau du grand prix en trois temps : arrivee de la course, gains
// qui montent dans le cumul, puis remise en ordre sur le general. `null` hors
// animation en cours.
let gpAnim = null;

// Pause de lecture avant que les scores ne bougent, duree du compteur qui
// fait monter le cumul, pause avant le remaniement, puis duree du glissement
// vers l'ordre general (voir aussi la transition CSS de .race-gp-row). Le
// tout tient sous resultsDelayMs, avec de la marge pour admirer le resultat
// une fois les lignes rangees.
const GP_COUNT_DELAY_MS = 2200;
const GP_COUNT_DURATION_MS = 2600;
const GP_REORDER_DELAY_MS = 350;

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

// Reconstruit entierement depuis `finishOrder` : un spectateur qui arrive en
// plein classement le voit en entier, sans avoir assiste aux arrivees.
function renderResults() {
    if (!resultsEl) resultsEl = document.getElementById('race-results');
    if (!resultsEl) return;

    // Il accompagne les arrivees, puis s'efface : le tableau des scores prend
    // le relais et les deux ensemble surchargeraient la scene.
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

// Tableau des scores du grand prix, reconstruit entierement depuis le snapshot :
// un spectateur qui se connecte pendant le tableau le voit rempli. Poser le
// tableau ne fait que la premiere image ; le passage au cumul puis au classement
// general est anime par `stepGrandPrixAnimation`, a chaque frame.
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

    // Le tableau ne bouge plus une fois pose : on ne le reconstruit que si son
    // contenu a change, sinon chaque frame recreerait huit images.
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

    // Premiere image du tableau : l'ordre d'arrivee de la course qui vient de
    // finir, pas encore le general. Un spectateur qui se connecte pendant
    // l'animation retombe sur ses pieds : il manque juste le compteur.
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
        // Le cumul affiche part d'avant cette course : c'est lui qui monte
        // jusqu'au total pendant que le tableau est a l'ecran.
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

// Bascule les lignes de l'ordre d'arrivee vers le general, en rejouant le
// deplacement plutot qu'en le faisant apparaitre d'un coup (technique FLIP :
// position relevee avant le reordonnancement, puis rejouee depuis la ou
// chaque ligne se trouvait).
function settleGrandPrixReorder(anim) {
    const before = new Map();
    anim.rows.forEach(entry => before.set(entry.id, entry.row.getBoundingClientRect()));

    const standings = anim.rows.slice().sort((a, b) => {
        const diff = b.target - a.target;
        // A egalite de points, la course qui vient de finir departage.
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
        // Force le reflow : sans lui le navigateur fusionnerait les deux
        // changements de style et sauterait la transition.
        entry.row.getBoundingClientRect();
        entry.row.style.transition = '';
        entry.row.style.transform = '';
    });

    anim.rows = standings;
}

// Fait vivre le tableau du grand prix image par image, independamment de
// l'arrivee des snapshots serveur (10 Hz) : un compteur ou un glissement
// cales sur ce rythme saccaderait.
function stepGrandPrixAnimation(gameNow) {
    const anim = gpAnim;
    if (!anim || anim.phase === 'done') return;

    const elapsed = gameNow - anim.startAt;

    if (anim.phase === 'count') {
        if (elapsed < GP_COUNT_DELAY_MS) return;

        const t = Math.min(1, (elapsed - GP_COUNT_DELAY_MS) / GP_COUNT_DURATION_MS);
        const eased = easeOutCubic(t);
        anim.rows.forEach(entry => {
            // Le total se remplit et le gain se vide au meme rythme : c'est le
            // meme point qui se deplace de l'un vers l'autre, un transfert.
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
