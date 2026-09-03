// Le demarrage du banner.
//
// Charge en DERNIER : c'est le seul fichier qui execute quelque chose au
// chargement plutot que de se contenter de declarer. Tous les autres peuvent se
// lire dans n'importe quel ordre, celui-ci suppose qu'ils sont tous la.

// La course continue sans nous. Il n'y a donc rien a « reprendre » : au retour,
// on jette le tampon devenu faux, on recale l'horloge, et le serveur renvoie un
// `hello` complet — un onglet qui revient est un arrivant comme un autre.
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
// Outils de developpement — a retirer a la fin de la migration.
//
//   bannerDev.wipeDom()    efface tout le DOM du banner. La frame suivante doit
//                          le reconstruire a partir du seul snapshot courant :
//                          c'est le test de l'arrivant, joue en direct.
//   bannerDev.offline()    coupe la connexion pour de bon (mode degrade).
//   bannerDev.reconnect()  relance la connexion.
//   bannerDev.curtain(b)   baisse (true) ou leve (false) le rideau.
//   bannerDev.status(s)    force l'indicateur : connecting | online | offline.
//   bannerDev.clock()      ecart d'horloge estime avec le serveur.
//   bannerDev.realise(b)   allume (true) ou coupe (false) la realisation.
//   bannerDev.plateau()    les notes de la realisation, du plus filmable au
//                          moins : c'est avec ce classement qu'on regle
//                          DIRECTOR_WEIGHTS en regardant la course.
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
            // Ecart entre l'instant affiche et le dernier etat recu. Doit valoir
            // a peu pres -RENDER_DELAY_MS : franchement positif, le client rend
            // un futur qu'il n'a pas ; tres negatif, il rend un passe.
            retard: last ? `${Math.round(renderTime - last.ts)} ms` : 'aucun snapshot'
        };
    }
};

window.bannerDev = bannerDev;

// Au-dela de ce delai on ouvre le verrou des assets meme s'il en manque : mieux
// vaut un sprite qui arrive en retard qu'un banner masque.
const ASSETS_TIMEOUT_MS = 2500;

// Filet de securite : quoi qu'il arrive — serveur muet, images bloquees — le
// rideau se leve. Un bandeau cache est le seul echec vraiment visible.
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
    const _bannerEl = document.getElementById('bannerSection');
    if (!_bannerEl || _bannerEl.dataset.season === 'winter') initSnow();

    // La connexion part tout de suite, en parallele du chargement des images :
    // c'est elle qui met le plus de temps a fournir une scene affichable.
    bannerNet.connect();

    animate(0);

    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
