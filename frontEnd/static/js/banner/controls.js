// Les deux seules commandes offertes au spectateur : la pause et le vote.

// Gel de la scene. On ne coupe pas la boucle d'animation — elle continue de
// tourner pour repartir au clic suivant — on cesse de lire le tampon et de
// peindre. Les animations CSS sont arretees par la classe `is-paused`.
//
// Le tampon reseau se purge tout seul : son seuil suit l'horloge, qui ne s'arrete
// pas.
function togglePause() {
    racePaused = !racePaused;

    // A la reprise, la scene saute de toute la duree du gel : c'est un
    // changement de structure comme un autre, et il faut reconcilier avant de
    // repeindre. Sans ca, les karts arrives ou repartis pendant la pause ne
    // seraient pris en compte qu'au prochain snapshot.
    if (!racePaused) domDirty = true;

    renderPause();
}

function renderPause() {
    const el = leaderboardState.pauseEl;
    if (!el) return;

    el.classList.toggle('is-paused', racePaused);
    el.title = racePaused ? 'Reprendre la course' : 'Figer la course';

    // Le rendu JS s'arrete en ne peignant plus, mais les animations CSS — la
    // toupie, le halo d'etoile, la neige — tournent toutes seules et
    // continueraient sur une scene arretee. Seul le navigateur peut les
    // suspendre, et c'est cette classe qui le lui demande.
    const banner = document.getElementById('bannerSection');
    if (banner) banner.classList.toggle('is-paused', racePaused);
}

// Le serveur tient le decompte : on ne fait qu'annoncer un changement d'avis et
// attendre le snapshot qui l'enterine. Basculer le compteur localement le
// ferait osciller a chaque envoi refuse.
function toggleVote() {
    if (!bannerNet.send({ t: 'vote' })) return;
    myVote = !myVote;
    renderVote();
}

// Compteur du vote de redemarrage. Reconstruit depuis le snapshot, comme tout
// le reste : un arrivant voit le vote en cours et non un compteur a zero.
function renderVote() {
    const el = leaderboardState.voteEl;
    if (!el) return;

    const tally = worldState.vote || [0, 0];
    const count = tally[0] || 0;
    const total = tally[1] || 0;

    // Seul spectateur : le bouton relance a lui tout seul, un compteur « 0/1 »
    // n'apprendrait rien.
    const label = el.querySelector('.leaderboard-vote-count');
    if (label) label.textContent = total > 1 ? `${count}/${total}` : '';

    el.classList.toggle('is-voted', myVote);
    el.title = myVote
        ? 'Annuler le vote de redemarrage'
        : 'Voter le redemarrage (grand prix remis a zero)';
}
