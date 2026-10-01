// Demarrage du banner. Charge en dernier : seul fichier qui execute du code au
// chargement.

// Au retour sur l'onglet, on repart comme un nouvel arrivant (tampon vide,
// horloge recalee, nouveau `hello`).
function handleVisibilityChange() {
    if (document.hidden) {
        if (animationId) cancelAnimationFrame(animationId);
        animationId = null;
        bannerNet.setHidden(true);
        return;
    }

    bannerNet.setHidden(false);

    if (!animationId) animationId = requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Outils de developpement (console) :
//   bannerDev.wipeDom()    efface le DOM du banner (reconstruit depuis le snapshot)
//   bannerDev.offline()    coupe la connexion
//   bannerDev.reconnect()  relance la connexion
//   bannerDev.curtain(b)   baisse (true) ou leve (false) le rideau
//   bannerDev.status(s)    force l'indicateur : connecting | online | offline
//   bannerDev.clock()      ecart d'horloge estime avec le serveur
//   bannerDev.realise(b)   active ou coupe la realisation automatique
//   bannerDev.plateau()    notes de la realisation, pour regler DIRECTOR_WEIGHTS
// ---------------------------------------------------------------------------
const bannerDev = {
    wipeDom() {
        if (cachedContainer) cachedContainer.innerHTML = '';
        if (leaderboardState.container) leaderboardState.container.innerHTML = '';

        boxEls.length = 0;
        pipeEls.length = 0;
        for (const id in kartEls) delete kartEls[id];
        for (const id in itemEls) delete itemEls[id];
        for (const id in ppEls) delete ppEls[id];
        for (const id in ppSlots) delete ppSlots[id];
        for (const id in ppAnimating) delete ppAnimating[id];

        initLeaderboard();
        domDirty = true;
        return 'DOM efface : la frame suivante doit tout reconstruire';
    },

    offline() {
        bannerNet.giveUp();
        return 'connexion coupee : decor seul, pastille rouge';
    },

    realise(on) {
        raceDirector.setAuto(on !== false);
        return raceDirector.auto ? 'realisation automatique' : 'camera manuelle';
    },

    plateau() {
        const gameNow = getGameTime();
        const scan = directorScan(gameNow);
        return worldState.karts
            .map(kart => ({
                kart: kart.charName,
                note: Math.round(directorScore(kart, scan, gameNow)),
                plan: kart.id === focusedKartId ? '<< a l\'ecran' : ''
            }))
            .sort((a, b) => b.note - a.note);
    },

    reconnect() {
        bannerNet.attempts = 0;
        bannerNet.connect();
        return 'reconnexion demandee';
    },

    curtain(down) {
        if (down) bannerLink.lowerCurtain(); else bannerLink.raiseCurtain();
        return down ? 'rideau baisse' : 'rideau leve';
    },

    status(state) {
        bannerLink.setStatus(state);
        return `etat affiche : ${state}`;
    },

    stats() {
        return {
            fps: perf.fps,
            frames: perf.frames,
            gel: perf.stalls,
            part_gelee: `${((perf.stalls / (perf.frames || 1)) * 100).toFixed(1)} %`,
            tampon: bannerNet.buffer.length,
            retard_de_rendu: `${RENDER_DELAY_MS} ms`
        };
    },

    clock() {
        const last = bannerNet.buffer[bannerNet.buffer.length - 1];
        const renderTime = getGameTime() - RENDER_DELAY_MS;

        return {
            ecart: `${Math.round(serverClockOffset)} ms`,
            cible: `${Math.round(targetClockOffset)} ms`,
            derive: `${Math.round(targetClockOffset - serverClockOffset)} ms`,
            mesures: bannerNet.rttSamples.map(s => `${s.rtt} ms`),
            tampon: bannerNet.buffer.length,
            // Doit valoir environ -RENDER_DELAY_MS.
            retard: last ? `${Math.round(renderTime - last.ts)} ms` : 'aucun snapshot'
        };
    }
};

window.bannerDev = bannerDev;

// Delai apres lequel le verrou des assets s'ouvre meme s'il en manque.
const ASSETS_TIMEOUT_MS = 2500;

// Le rideau se leve quoi qu'il arrive.
const CURTAIN_FAILSAFE_MS = 5000;

document.addEventListener('DOMContentLoaded', () => {
    bannerLink.init();
    bannerLink.lowerCurtain();
    bannerLink.setStatus('connecting');

    Promise.race([
        preloadImages(),
        new Promise(resolve => setTimeout(resolve, ASSETS_TIMEOUT_MS))
    ]).then(() => bannerLink.open('assets'));

    setTimeout(() => bannerLink.raiseCurtain(), CURTAIN_FAILSAFE_MS);

    initScene();
    initFullscreen();
    const _bannerEl = document.getElementById('bannerSection');
    if (!_bannerEl || _bannerEl.dataset.season === 'winter') initSnow();

    // Connexion lancee en parallele du chargement des images.
    bannerNet.connect();
    // Page ouverte en arriere-plan : pas de visibilitychange a attendre.
    if (document.hidden) bannerNet.setHidden(true);

    animate(0);

    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
