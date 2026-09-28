// La connexion au service `race` : ouverture, reprise, messages recus.
//
// Le protocole est decrit cote serveur, dans raceEngine/src/protocol.js. Regle
// qui gouverne les deux cotes : le snapshot fait foi.

// Un onglet cache depuis ce delai rend sa connexion. nginx limite les flux
// simultanes par IP (`limit_conn ws_conn`), et un onglet oublie en arriere-plan
// tenait sa place indefiniment : un foyer avec quelques onglets ouverts
// suffisait a refuser la course a l'appareil suivant (27/09). Il comptait aussi
// comme spectateur, ce qui bloquait le vote de redemarrage, a l'unanimite.
// Declaree ici et non dans interpolate.js : pendant un deploiement, un
// navigateur peut garder l'ancien interpolate.js en cache avec le nouveau net.js.
const HIDDEN_DISCONNECT_MS = 60000;

// Le service compte les NAVIGATEURS, pas les connexions : deux onglets font un
// spectateur, et une voix au vote de redemarrage. Il lui faut pour ca un
// identifiant commun aux onglets, tire au hasard et garde dans le stockage
// local. Il ne designe personne, et le service ne le garde que le temps de la
// connexion (docs/banner/protocole.md). Mentionne dans la politique de
// confidentialite : c'est le seul usage du stockage local sur le site.
const NAV_STORAGE_KEY = 'mk-banner-nav';
const NAV_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// null si le stockage est refuse (navigation privee stricte, donnees du site
// bloquees) : chaque onglet compte alors pour un, comme avant.
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
    // Connexion rendue par un onglet reste cache trop longtemps : elle sera
    // rouverte a son retour, pas avant.
    suspended: false,
    suspendTimer: null,

    url() {
        // Jamais `wss://` en dur : en local le site est en clair, et l'erreur ne
        // se verrait qu'a l'execution.
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
            // Avant tout le reste : qui regarde, et si l'onglet est au premier
            // plan. `vis` ne part pas tant que la connexion s'ouvre, et un
            // onglet ouvert en arriere-plan passait donc pour visible.
            const hi = { t: 'hi', hidden: this.hidden };
            const nav = navigatorId();
            if (nav) hi.nav = nav;
            this.send(hi);
            // Trois mesures rapprochees : l'ecart d'horloge se stabilise en une
            // seconde au lieu d'attendre le premier ping periodique.
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

        // La voix de CE navigateur, posee ou retiree depuis n'importe lequel de
        // ses onglets : le bouton suit le service, seul a tenir le compte.
        if (msg.t === 'vote') {
            myVote = !!msg.v;
            renderVote();
            return;
        }

        if (msg.t === 'hello') {
            if (msg.protocol !== PROTOCOL_VERSION) {
                // Version incompatible : mieux vaut le decor seul qu'une scene
                // interpretee de travers.
                console.warn(`banner : protocole ${msg.protocol} non gere`);
                this.giveUp();
                return;
            }
            // Course neuve alors qu'une autre etait a l'ecran : le rideau tombe
            // d'abord, la scene n'est refaite qu'une fois qu'il est en bas.
            // Sinon la nouvelle grille apparait derriere un rideau a mi-hauteur.
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

            // Retour apres coupure : la scene est deja vide, rien a cacher.
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
            // Les evenements ne sont que des animations ponctuelles : les jouer
            // sur une scene figee ferait bouger le classement d'une course
            // arretee. Les rater est sans consequence — reconcileDom() rebatit
            // tout depuis l'etat a la reprise.
            if (msg.ev && !racePaused) for (const ev of msg.ev) applyEvent(ev);

            const cutoff = getGameTime() - BUFFER_KEEP_MS;
            while (this.buffer.length > 2 && this.buffer[0].ts < cutoff) this.buffer.shift();

            // Le rideau ne se leve qu'avec deux snapshots en main : avec un
            // seul, l'interpolation demarre a vide et la premiere seconde
            // saccade.
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
        // Le service ne garde pas trace du kart suivi d'une connexion a l'autre.
        // Sans ce rappel, la carte de debug se vidait apres chaque reconnexion
        // et apres chaque course neuve, sans que rien ne le dise.
        requestVision();
    },

    // Renvoie false si le lien est coupe : l'appelant garde alors son etat
    // inchange plutot que d'afficher une action qui n'est jamais partie.
    send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    },

    ping() {
        this.send({ t: 'ping', c: Date.now() });
    },

    // On garde la meilleure mesure plutot que la moyenne : un aller-retour
    // rapide est forcement moins deforme par les files d'attente qu'un lent.
    onPong(msg) {
        const now = Date.now();
        const rtt = now - msg.c;
        const offset = msg.s + rtt / 2 - now;

        this.rttSamples.push({ rtt: rtt, offset: offset, at: now });
        bannerLink.setPing(rtt);

        // Une mesure vieille de plusieurs minutes decrit peut-etre une horloge
        // qui n'existe plus : un appareil qui sort de veille resynchronise
        // souvent la sienne sur le reseau. La garder reviendrait a laisser son
        // faible aller-retour l'emporter indefiniment, et le rendu resterait
        // cale sur l'ancienne heure — une course coherente, mais decalee de
        // celle que tout le monde regarde.
        this.rttSamples = this.rttSamples
            .filter(sample => now - sample.at < CLOCK_SAMPLE_TTL_MS)
            .slice(-8);

        let best = this.rttSamples[0];
        for (const sample of this.rttSamples) if (sample.rtt < best.rtt) best = sample;

        targetClockOffset = best.offset;

        // Premiere mesure : on se cale d'un coup, il n'y a encore rien a
        // secouer. Les elements deja crees portent en revanche une phase
        // d'animation calee sur l'heure locale, donc fausse : c'est le seul
        // moment ou il faut les reprendre.
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
            // L'horloge locale a pu etre resynchronisee pendant la mise en
            // veille, et le tampon est de toute facon perime. On repart de zero
            // sur l'estimation : la prochaine mesure sera adoptee telle quelle
            // au lieu d'etre rejointe en douceur, puisqu'il ne s'agit pas d'une
            // derive mais d'un saut.
            this.rttSamples = [];
            clockCalibrated = false;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: 'vis', hidden: hidden }));
        }

        if (!hidden) {
            // Connexion rendue pendant l'absence : on la rouvre, et le `hello`
            // qui suit refait la scene comme a une premiere visite. Les trois
            // pings partent a l'ouverture (`connect`).
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

    // Rend la connexion d'un onglet cache (voir HIDDEN_DISCONNECT_MS). Rien n'est
    // relance ici : c'est le retour de l'onglet qui rouvre, dans setHidden().
    suspend() {
        this.suspendTimer = null;
        if (!this.hidden || this.suspended) return;
        this.suspended = true;

        // Y compris une reprise en attente : un onglet cache n'a pas a
        // reessayer en boucle une connexion que personne ne regarde.
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

        // Le serveur oublie la voix avec la connexion : le bouton ne doit pas
        // l'afficher encore au retour. Si un autre onglet de ce navigateur la
        // tient toujours, le service la renverra au `hi` de la reconnexion.
        myVote = false;

        // La scene sera refaite depuis le `hello` au retour. On la vide et on
        // baisse le rideau des maintenant, pendant que personne ne regarde : il
        // se relevera sur deux snapshots, comme a la premiere visite, au lieu de
        // montrer une course figee depuis le depart de l'onglet.
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

    // Abandon definitif : protocole incompatible. Reessayer ne servirait qu'a
    // tenir une connexion inutile ouverte.
    giveUp() {
        this.wasOffline = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
        bannerLink.setStatus('offline');
        bannerLink.open('stream');
        clearScene();
    },

    // Choisit les deux snapshots qui encadrent l'instant a afficher.
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

        // Hors tampon : soit le reseau a decroche et on affiche le dernier etat
        // connu, soit l'horloge est en retard et on affiche le plus ancien.
        const last = buffer[buffer.length - 1];
        if (renderTime > last.ts) return { a: last, b: null, t: 0 };
        return { a: buffer[0], b: null, t: 0 };
    }
};
