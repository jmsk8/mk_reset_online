// Le rideau de depart et la pastille d'etat de la connexion.
//
// Le rideau ne se leve que lorsque la scene est reellement affichable. Un
// bandeau masque est le seul echec vraiment visible : tout ici est ecrit pour
// qu'il se leve quoi qu'il arrive.

// Le rideau ne se leve que sur une scene complete : images decodees, `hello`
// recu, et deux snapshots en tampon — avec un seul, l'interpolation demarre a
// vide et la premiere seconde saccade.
//
// L'indicateur dit au spectateur ce qu'il regarde : une course en direct, ou le
// decor seul faute de connexion.
const bannerLink = {
    curtainEl: null,
    statusEl: null,
    labelEl: null,
    msEl: null,
    leaderboardEl: null,

    // Derniere latence mesuree, ou null quand il n'y a rien a montrer : hors
    // ligne, un chiffre fige decrirait un lien qui n'existe plus.
    pingMs: null,

    // Le rideau se leve quand les deux verrous sont ouverts : les images
    // decodees, et le flux en etat de fournir une scene — soit deux snapshots
    // en tampon, soit la certitude qu'il n'y aura pas de course.
    gates: { assets: false, stream: false },
    loweredAt: 0,

    open(gate) {
        this.gates[gate] = true;
        if (!this.gates.assets || !this.gates.stream) return;

        // Sans plancher, le rideau clignoterait entre deux courses.
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

        // L'ecran de demarrage (index.html) attend ce signal pour se dissiper :
        // la page se decouvre quand la scene est prete a etre regardee, pas
        // avant. Emis a chaque levee, mais il n'est ecoute qu'une fois.
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
        // La latence n'accompagne que l'etat en direct : elle survivrait sinon
        // a la coupure qu'elle est censee documenter.
        if (state !== 'online') this.pingMs = null;
        this.renderPing();
    },

    // Le dernier aller-retour, pas le meilleur : celui que garde bannerNet sert
    // a caler l'horloge, ou une mesure propre vaut mieux qu'une recente. Ici on
    // decrit le lien tel qu'il est maintenant, ralentissements compris.
    setPing(ms) {
        this.pingMs = ms;
        if (this.statusEl && this.statusEl.classList.contains('is-online')) this.renderPing();
    },

    renderPing() {
        if (!this.msEl) return;
        this.msEl.textContent = this.pingMs === null ? '' : `${Math.round(this.pingMs)} ms`;
    }
};
