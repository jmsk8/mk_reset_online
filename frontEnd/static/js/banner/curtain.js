// Rideau de depart et pastille d'etat de la connexion.

// Le rideau se leve sur une scene complete : images decodees, `hello` recu et
// deux snapshots en tampon (ou certitude qu'il n'y aura pas de course).
const bannerLink = {
    curtainEl: null,
    statusEl: null,
    labelEl: null,
    msEl: null,
    leaderboardEl: null,

    // Derniere latence mesuree, null hors ligne.
    pingMs: null,

    // Les deux verrous de levee du rideau.
    gates: { assets: false, stream: false },
    loweredAt: 0,

    open(gate) {
        this.gates[gate] = true;
        if (!this.gates.assets || !this.gates.stream) return;

        // Duree minimale, sinon le rideau clignote entre deux courses.
        const shown = Date.now() - this.loweredAt;
        if (shown < CURTAIN_MIN_MS) {
            setTimeout(() => this.raiseCurtain(), CURTAIN_MIN_MS - shown);
            return;
        }

        this.raiseCurtain();
    },

    init() {
        this.curtainEl = document.getElementById('race-curtain');
        this.statusEl = document.getElementById('race-status');
        this.labelEl = this.statusEl ? this.statusEl.querySelector('.race-status-label') : null;
        this.msEl = this.statusEl ? this.statusEl.querySelector('.race-status-ms') : null;
        this.leaderboardEl = document.getElementById('race-leaderboard');
    },

    lowerCurtain() {
        this.loweredAt = Date.now();
        if (this.curtainEl) this.curtainEl.classList.add('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.add('is-veiled');
    },

    raiseCurtain() {
        if (this.curtainEl) this.curtainEl.classList.remove('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.remove('is-veiled');

        // Signal attendu par l'ecran de demarrage (index.html).
        document.dispatchEvent(new CustomEvent('race:ready'));
    },

    setStatus(state) {
        if (!this.statusEl) return;
        this.statusEl.classList.remove('is-connecting', 'is-online', 'is-offline');
        this.statusEl.classList.add(`is-${state}`);
        if (this.labelEl) {
            this.labelEl.textContent = state === 'online' ? 'online'
                                     : state === 'offline' ? 'offline'
                                     : 'connexion';
        }
        // La latence n'est affichee qu'en ligne.
        if (state !== 'online') this.pingMs = null;
        this.renderPing();
    },

    // Dernier aller-retour (bannerNet garde le meilleur pour l'horloge).
    setPing(ms) {
        this.pingMs = ms;
        if (this.statusEl && this.statusEl.classList.contains('is-online')) this.renderPing();
    },

    renderPing() {
        if (!this.msEl) return;
        this.msEl.textContent = this.pingMs === null ? '' : `${Math.round(this.pingMs)} ms`;
    }
};
