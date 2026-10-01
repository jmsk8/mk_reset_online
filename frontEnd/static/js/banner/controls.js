// Commandes du classement : le vote, et la pause (mode debug uniquement).

// Gel de la scene : la boucle continue mais ne lit plus le tampon ni ne peint ;
// les animations CSS sont arretees par la classe `is-paused`.
function togglePause() {
    racePaused = !racePaused;

    // A la reprise, on reconcilie avant de repeindre.
    if (!racePaused) domDirty = true;

    renderPause();
}

function renderPause() {
    const el = leaderboardState.pauseEl;
    if (!el) return;

    el.classList.toggle('is-paused', racePaused);
    el.title = racePaused ? 'Reprendre la course' : 'Figer la course';

    // Suspend les animations CSS (toupie, etoile, neige).
    const banner = document.getElementById('bannerSection');
    if (banner) banner.classList.toggle('is-paused', racePaused);
}

// Le serveur tient le decompte : on attend le snapshot qui l'enterine.
function toggleVote() {
    if (!bannerNet.send({ t: 'vote' })) return;
    myVote = !myVote;
    renderVote();
}

// Compteur du vote de redemarrage, reconstruit depuis le snapshot.
function renderVote() {
    const el = leaderboardState.voteEl;
    if (!el) return;

    const tally = worldState.vote || [0, 0];
    const count = tally[0] || 0;
    const total = tally[1] || 0;

    // Seul spectateur : pas de compteur.
    const label = el.querySelector('.leaderboard-vote-count');
    if (label) label.textContent = total > 1 ? `${count}/${total}` : '';

    el.classList.toggle('is-voted', myVote);
    el.title = myVote
        ? 'Annuler le vote de redemarrage'
        : 'Voter le redemarrage (grand prix remis a zero)';
}
