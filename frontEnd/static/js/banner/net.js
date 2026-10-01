// Connexion au service `race` : ouverture, reprise et messages recus (protocole
// decrit dans raceEngine/src/protocol.js).

// Un onglet cache depuis ce delai rend sa connexion (nginx limite les flux par
// IP, et un onglet cache compterait comme spectateur au vote). Declaree ici et
// non dans interpolate.js pour supporter un cache mixte pendant un deploiement.
const HIDDEN_DISCONNECT_MS = 60000;

// Identifiant aleatoire du navigateur, commun a ses onglets (stockage local),
// pour compter les spectateurs par navigateur. Seul usage du stockage local,
// mentionne dans la politique de confidentialite.
const NAV_STORAGE_KEY = 'mk-banner-nav';
const NAV_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// null si le stockage est refuse : chaque onglet compte alors pour un.
function navigatorId() {
    try {
        let id = localStorage.getItem(NAV_STORAGE_KEY);
        if (!NAV_PATTERN.test(id || '')) {
            const bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            id = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
            localStorage.setItem(NAV_STORAGE_KEY, id);
        }
        return id;
    } catch (err) {
        return null;
    }
}

const bannerNet = {
    ws: null,
    buffer: [],
    attempts: 0,
    hidden: false,
    ready: false,
    gotHello: false,
    wasOffline: false,
    pendingHello: null,
    rebuildTimer: null,
    reconnectTimer: null,
    pingTimer: null,
    rttSamples: [],
    // Connexion rendue par un onglet cache, rouverte a son retour.
    suspended: false,
    suspendTimer: null,

    url() {
    // Protocole selon la page (http en local).
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws/race`;
    },

    connect() {
        if (this.ws) return;

        if (this.attempts === 0) bannerLink.setStatus('connecting');

        let ws;
        try {
            ws = new WebSocket(this.url());
        } catch (err) {
            this.onDisconnected();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempts = 0;
            this.rttSamples = [];
            // Envoye avant tout : identifiant et visibilite de l'onglet.
            const hi = { t: 'hi', hidden: this.hidden };
            const nav = navigatorId();
            if (nav) hi.nav = nav;
            this.send(hi);
            // Trois mesures rapprochees pour stabiliser vite l'horloge.
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
            this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
        };

        ws.onmessage = event => this.onMessage(event.data);
        ws.onclose = () => this.onDisconnected();
        ws.onerror = () => { try { ws.close(); } catch (err) { /* deja fermee */ } };
    },

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            return;
        }

        if (msg.t === 'pong') {
            this.onPong(msg);
            return;
        }

        // Voix de ce navigateur, posee depuis n'importe lequel de ses onglets.
        if (msg.t === 'vote') {
            myVote = !!msg.v;
            renderVote();
            return;
        }

        if (msg.t === 'hello') {
            if (msg.protocol !== PROTOCOL_VERSION) {
                // Version incompatible : decor seul.
                console.warn(`banner : protocole ${msg.protocol} non gere`);
                this.giveUp();
                return;
            }
            // Course neuve : la scene est refaite une fois le rideau baisse.
            if (isNewRace(msg) && this.ready) {
                this.ready = false;
                this.gotHello = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();

                this.pendingHello = msg;
                clearTimeout(this.rebuildTimer);
                this.rebuildTimer = setTimeout(() => {
                    if (this.pendingHello) this.applyHello(this.pendingHello);
                }, CURTAIN_FALL_MS);
                return;
            }

            // Retour apres coupure : scene deja vide.
            if (this.wasOffline) {
                this.wasOffline = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();
            }

            this.applyHello(msg);
            return;
        }

        if (msg.t === 's' && this.gotHello) {
            this.buffer.push(msg);
            // Pas d'evenements pendant la pause (reconcileDom() rebatit tout a
            // la reprise).
            if (msg.ev && !racePaused) for (const ev of msg.ev) applyEvent(ev);

            const cutoff = getGameTime() - BUFFER_KEEP_MS;
            while (this.buffer.length > 2 && this.buffer[0].ts < cutoff) this.buffer.shift();

            // Le rideau se leve avec deux snapshots en tampon.
            if (!this.ready && this.buffer.length >= 2) {
                this.ready = true;
                bannerLink.setStatus('online');
                bannerLink.open('stream');
            }
        }
    },

    applyHello(msg) {
        this.pendingHello = null;
        this.buffer = [];
        this.gotHello = true;
        buildWorldFromHello(msg);
        this.buffer.push(msg.snapshot);
        // Le service oublie le kart suivi a chaque connexion.
        requestVision();
    },

    // Renvoie false si le lien est coupe.
    send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    },

    ping() {
        this.send({ t: 'ping', c: Date.now() });
    },

    // Garde la meilleure mesure (aller-retour le plus court).
    onPong(msg) {
        const now = Date.now();
        const rtt = now - msg.c;
        const offset = msg.s + rtt / 2 - now;

        this.rttSamples.push({ rtt: rtt, offset: offset, at: now });
        bannerLink.setPing(rtt);

        // Les mesures trop anciennes sont ecartees (horloge locale
        // resynchronisee apres une mise en veille).
        this.rttSamples = this.rttSamples
            .filter(sample => now - sample.at < CLOCK_SAMPLE_TTL_MS)
            .slice(-8);

        let best = this.rttSamples[0];
        for (const sample of this.rttSamples) if (sample.rtt < best.rtt) best = sample;

        targetClockOffset = best.offset;

        // Premiere mesure : calage immediat et realignement des animations.
        if (!clockCalibrated) {
            clockCalibrated = true;
            serverClockOffset = targetClockOffset;
            realignAnimations();
        }
    },

    setHidden(hidden) {
        this.hidden = hidden;
        this.buffer = [];

        if (hidden) {
            if (!this.suspendTimer && !this.suspended) {
                this.suspendTimer = setTimeout(() => this.suspend(), HIDDEN_DISCONNECT_MS);
            }
        } else if (this.suspendTimer) {
            clearTimeout(this.suspendTimer);
            this.suspendTimer = null;
        }

        if (!hidden) {
            // Retour de veille : mesures oubliees, la prochaine est adoptee
            // telle quelle.
            this.rttSamples = [];
            clockCalibrated = false;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: 'vis', hidden: hidden }));
        }

        if (!hidden) {
            // Connexion rendue pendant l'absence : on la rouvre.
            if (this.suspended) {
                this.suspended = false;
                this.attempts = 0;
                this.connect();
                return;
            }
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
        }
    },

    // Rend la connexion d'un onglet cache (rouverte dans setHidden()).
    suspend() {
        this.suspendTimer = null;
        if (!this.hidden || this.suspended) return;
        this.suspended = true;

        // Annule aussi une reprise en attente.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            const ws = this.ws;
            ws.onclose = null;
            ws.onerror = null;
            ws.onmessage = null;
            ws.close();
        }
        this.ws = null;
        this.ready = false;
        this.gotHello = false;
        this.buffer = [];
        this.pendingHello = null;
        clearTimeout(this.rebuildTimer);
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        // Le serveur oublie la voix avec la connexion.
        myVote = false;

        // Scene videe et rideau baisse : elle sera refaite depuis le `hello`.
        bannerLink.gates.stream = false;
        bannerLink.lowerCurtain();
        bannerLink.setStatus('connecting');
        clearScene();
    },

    onDisconnected() {
        this.ws = null;
        this.ready = false;
        this.gotHello = false;
        this.buffer = [];
        this.pendingHello = null;
        clearTimeout(this.rebuildTimer);

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        this.attempts++;
        if (this.attempts >= OFFLINE_AFTER_ATTEMPTS) {
            this.wasOffline = true;
            bannerLink.setStatus('offline');
            bannerLink.open('stream');
            clearScene();
        }

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.attempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    },

    // Abandon definitif (protocole incompatible).
    giveUp() {
        this.wasOffline = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
        bannerLink.setStatus('offline');
        bannerLink.open('stream');
        clearScene();
    },

    frameFor(renderTime) {
        const buffer = this.buffer;
        if (buffer.length === 0) return null;

        for (let i = buffer.length - 1; i > 0; i--) {
            const a = buffer[i - 1];
            const b = buffer[i];
            if (a.ts <= renderTime && renderTime <= b.ts) {
                const span = b.ts - a.ts;
                return { a: a, b: b, t: span > 0 ? (renderTime - a.ts) / span : 0 };
            }
        }

        // Hors tampon : dernier etat connu, ou plus ancien si l'horloge est en retard.
        const last = buffer[buffer.length - 1];
        if (renderTime > last.ts) return { a: last, b: null, t: 0 };
        return { a: buffer[0], b: null, t: 0 };
    }
};
