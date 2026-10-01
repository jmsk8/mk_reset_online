// Moteur de course autoritatif du banner : une seule course, regardee par tous
// les navigateurs, qui ne font qu'afficher.
//
//   node src/server.js                  service normal (HTTP + WebSocket)
//   node src/server.js --duration 600   soak de 10 minutes, course forcee, puis bilan
//   node src/server.js --always-on      simule meme sans spectateur
//   node src/server.js --quiet          pas de rapport periodique
//
// La course demarre a la premiere connexion et s'arrete 30 s apres le depart
// du dernier spectateur.

import http from 'node:http';
import { WebSocketServer } from 'ws';

import * as protocol from './protocol.js';
import * as track from './track.js';
import * as PH from './engine/index.js';
import CFG from './config/index.js';

// Circuits de tracks/ (monte dans le conteneur), relus a chaque redemarrage a
// chaud (`make restart-race`).
const TRACKS_DIR = track.resolveTracksDir(import.meta.dirname);

let TRACKS;
try {
    TRACKS = track.loadTracks(TRACKS_DIR, CFG);
} catch (err) {
    // Dessin faux : message d'erreur et arret avant d'ecouter.
    console.error(`[circuits] ${err.message}`);
    console.error('[circuits] `make race-tracks` verifie les dessins sans rien demarrer.');
    process.exit(1);
}

function announceTracks() {
    console.log(`[circuits] ${TRACKS.length} charge(s) depuis ${TRACKS_DIR} : `
        + TRACKS.map(t => `${t.name} (${t.columns} col, ${t.pipes.length} pipes)`).join(', '));
}

// Relecture du dossier ; en cas d'erreur, on garde les circuits courants.
function reloadTracks() {
    try {
        TRACKS = track.loadTracks(TRACKS_DIR, CFG);
        announceTracks();
    } catch (err) {
        console.error(`[circuits] relecture refusee, on garde les precedents — ${err.message}`);
    }
}

// ── Parametres ──────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const WS_PATH = process.env.WS_PATH || '/ws/race';

const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const DT_MS = DT * 1000;

// Simulation a 30 Hz, diffusion a 10 Hz (le client interpole).
const SEND_HZ = 10;
const TICKS_PER_SEND = Math.round(TICK_HZ / SEND_HZ);

// Pas de rattrapage maximum par tick (au-dela, le retard est abandonne).
const MAX_CATCHUP_STEPS = 5;

// Delai de grace avant l'arret de la course quand plus personne ne regarde.
const IDLE_GRACE_MS = 30000;

// Taille maximale d'un message entrant (le client n'envoie que quelques dizaines
// d'octets).
const MAX_PAYLOAD = 512;

// Un onglet cache cesse de compter comme spectateur apres ce delai (identique a
// HIDDEN_DISCONNECT_MS dans frontEnd/static/js/banner/net.js).
const HIDDEN_GRACE_MS = 60000;

// Identifiant de navigateur envoye par `hi` ; sinon la connexion compte seule.
const NAV_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Sonde applicative : une connexion qui ne repond plus au ping est fermee.
const HEARTBEAT_MS = 30000;

const REPORT_INTERVAL_MS = 5000;

// Delai sans progression apres lequel un kart en course est considere bloque.
const STUCK_TIMEOUT_MS = 10000;

const args = process.argv.slice(2);
function argValue(name) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const DURATION_S = Number(argValue('--duration')) || 0;
const QUIET = args.includes('--quiet');
const ALWAYS_ON = args.includes('--always-on') || DURATION_S > 0 || process.env.ALWAYS_ON === '1';

// Origines autorisees a ouvrir le flux (vide = toutes, a eviter en production).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const rng = Math.random;

// ── Course ──────────────────────────────────────────────────────────────────

let race = null;
let idleTimer = null;
let totalRaces = 0;

// Grille de la course suivante, vainqueur en pole ; null = tirage au sort.
let lastFinishOrder = null;

// Grand prix en cours : { round, points } ; null = nouveau bloc.
let grandPrix = null;

function startRace() {
    const now = Date.now();

    // Un circuit par manche, dans l'ordre des fichiers ; il fait partie de la
    // config, complete avant la construction du monde.
    const round = (grandPrix && grandPrix.round) || 1;
    const circuit = track.forRound(TRACKS, round);
    const cfg = track.applyTrack(CFG, circuit);

    for (const warning of circuit.warnings) {
        console.warn(`[circuits] ${circuit.source} — ${warning}`);
    }

    race = {
        // Horloge de simulation, par pas fixes (date des snapshots).
        simTime: now,
        t0: now,

        // Config de cette course, circuit compris.
        cfg: cfg,
        track: circuit,

        state: PH.createWorldState(cfg, rng, now, lastFinishOrder, grandPrix),

        accumulator: 0,
        lastRealTime: now,
        ticks: 0,
        droppedSteps: 0,
        maxStepMs: 0,
        sinceBroadcast: 0,
        pendingEvents: [],

        lastProgress: new Map(),
        problems: 0,

        loop: null
    };

    race.loop = setInterval(tick, DT_MS);
    totalRaces++;
    console.log(
        `[course] grand prix ${race.state.gpRound}/${CFG.grandPrix.races}` +
        ` sur ${circuit.name} (${cfg.world.width} px)` +
        ` — grille : ${race.state.karts.map(k => k.charName).join(', ')}`
    );
}

function stopRace() {
    if (!race) return;
    clearInterval(race.loop);
    console.log(`[course] arret apres ${formatClock(race.simTime - race.t0)} (plus aucun spectateur)`);
    race = null;
}

// Nouvelle course, annoncee par un `hello` a tous les spectateurs.
function beginNewRace() {
    if (race) {
        clearInterval(race.loop);
        race = null;
    }

    if (clients.size === 0 && !ALWAYS_ON) {
        console.log('[course] plus aucun spectateur : la prochaine connexion relancera.');
        return;
    }

    // Les voix ne survivent pas a la course.
    clearVotes();
    startRace();
    for (const [ws] of clients) {
        if (ws.readyState === ws.OPEN) sendHello(ws);
    }
}

// Redemarrage a chaud (`make restart-race`) : grand prix efface, grille tiree
// au sort, circuits relus.
function restartRace() {
    console.log('[course] redemarrage demande — grand prix remis a zero.');
    reloadTracks();
    grandPrix = null;
    lastFinishOrder = null;
    beginNewRace();
}

function ensureRunning() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (!race) startRace();
}

function scheduleIdleStop() {
    if (ALWAYS_ON || idleTimer || !race) return;
    idleTimer = setTimeout(() => {
        idleTimer = null;
        if (clients.size === 0) stopRace();
    }, IDLE_GRACE_MS);
}

// Classement a la console a la fin de chaque course : manche, puis general.
function logStandings(ev) {
    const board = Object.entries(ev.gpPoints)
        .sort((a, b) => b[1] - a[1])
        .map(([name, points]) => `${name} ${points}`)
        .join('  ');

    const label = ev.gpComplete
        ? `grand prix termine (${CFG.grandPrix.races} courses)`
        : `manche ${ev.gpRound}/${CFG.grandPrix.races}`;

    console.log(`[course] ${label} — general : ${board}`);
}

function tick() {
    const now = Date.now();
    let elapsed = (now - race.lastRealTime) / 1000;
    race.lastRealTime = now;

    // Ecart absurde (veille, debogueur) ignore.
    if (elapsed > 1) elapsed = 1;
    race.accumulator += elapsed;

    let steps = 0;
    const startedAt = Date.now();

    let finishedOrder = null;
    let nextGrandPrix = null;

    while (race.accumulator >= DT && steps < MAX_CATCHUP_STEPS) {
        race.simTime += DT_MS;
        const events = PH.stepPhysics(race.cfg, race.state, rng, race.simTime, DT);

        for (const ev of events) {
            if (ev.type === 'raceOver') {
                finishedOrder = ev.order.map(id => race.state.kartsById[id].charName);

                // Bloc termine : nouveau grand prix ; sinon manche suivante.
                nextGrandPrix = ev.gpComplete
                    ? { round: 1, points: {} }
                    : { round: ev.gpRound + 1, points: ev.gpPoints };

                logStandings(ev);
            } else if (ev.type === 'kartFinished') {
                const kart = race.state.kartsById[ev.kartId];
                console.log(`[course] ${ev.rank}. ${kart.charName}`);
            }
        }

        const kept = protocol.filterEvents(events);
        if (kept.length) race.pendingEvents.push(...kept);
        race.accumulator -= DT;
        steps++;
        race.ticks++;
    }

    if (finishedOrder) {
        // Nouveau grand prix : grille au hasard.
        lastFinishOrder = (nextGrandPrix.round === 1) ? null : finishedOrder;
        grandPrix = nextGrandPrix;
        beginNewRace();
        return;
    }

    if (race.accumulator >= DT) {
        // Retard non rattrape : abandonne.
        race.droppedSteps += Math.floor(race.accumulator / DT);
        race.accumulator = 0;
    }

    const stepMs = Date.now() - startedAt;
    if (stepMs > race.maxStepMs) race.maxStepMs = stepMs;

    if (!checkIntegrity()) {
        console.error('[course] etat corrompu, arret du service.');
        shutdown(1);
        return;
    }

    race.sinceBroadcast += steps;
    if (race.sinceBroadcast >= TICKS_PER_SEND) {
        race.sinceBroadcast = 0;
        // L'expiration d'un onglet cache peut completer l'unanimite.
        if (checkVotes()) return;
        broadcast();
    }
}

// ── Diffusion ───────────────────────────────────────────────────────────────

// ws -> { nav, hidden, hiddenSince, alive, voted, watch }
const clients = new Map();

// ── Spectateurs ───────────────────────────────────────────────
// Un spectateur est un navigateur (`nav`, partage par ses onglets), garde le
// temps de la connexion seulement. Sans `nav`, la connexion compte seule.

function navKey(meta) {
    return meta.nav || meta;
}

function isWatching(meta, now) {
    return !meta.hidden || now - meta.hiddenSince < HIDDEN_GRACE_MS;
}

// ── Vote de redemarrage ────────────────────────────────────────────
// Une voix par navigateur ; a l'unanimite des spectateurs, la course repart de
// zero (grand prix compris).

// [voix, spectateurs] ; seules les voix des navigateurs qui regardent comptent.
function voteTally() {
    const now = Date.now();
    const watching = new Set();
    const voters = new Set();
    for (const meta of clients.values()) {
        const key = navKey(meta);
        if (isWatching(meta, now)) watching.add(key);
        if (meta.voted) voters.add(key);
    }
    let count = 0;
    for (const key of voters) if (watching.has(key)) count++;
    return [count, watching.size];
}

function navVoted(key) {
    for (const meta of clients.values()) {
        if (meta.voted && navKey(meta) === key) return true;
    }
    return false;
}

// Pose ou retire la voix d'un navigateur sur toutes ses connexions, et le leur dit.
function setNavVote(key, voted) {
    const message = JSON.stringify({ t: 'vote', v: voted });
    for (const [ws, meta] of clients) {
        if (navKey(meta) !== key) continue;
        meta.voted = voted;
        if (ws.readyState === ws.OPEN) ws.send(message);
    }
}

// Pas de message : chaque client efface sa voix au `hello` suivant.
function clearVotes() {
    for (const meta of clients.values()) meta.voted = false;
}

// Verifie le quorum ; true si la course est repartie.
function checkVotes() {
    const [count, total] = voteTally();
    if (total === 0 || count < total) return false;

    console.log(`[course] redemarrage vote a l'unanimite (${total} spectateur(s)).`);
    restartRace();
    return true;
}

// Visibilite d'une connexion ; true si l'onglet revient au premier plan (il lui
// faut une scene complete).
function setHidden(meta, hidden) {
    const wasHidden = meta.hidden;
    meta.hidden = hidden;
    if (hidden && !wasHidden) meta.hiddenSince = Date.now();
    return wasHidden && !hidden;
}

function broadcast() {
    if (clients.size === 0) {
        race.pendingEvents.length = 0;
        return;
    }

    const snapshot = protocol.buildSnapshot(race.cfg, race.state, race.simTime, voteTally());
    if (race.pendingEvents.length) {
        snapshot.ev = race.pendingEvents;
        race.pendingEvents = [];
    }

    const payload = JSON.stringify(snapshot);

    // Releve de vision du kart suivi, pour les seules connexions qui l'ont
    // demande (serialise une fois par kart regarde).
    let watched = null;

    for (const [ws, meta] of clients) {
        // Onglet en arriere-plan : flux coupe.
        if (meta.hidden) continue;
        if (ws.readyState !== ws.OPEN) continue;

        if (meta.watch === null || meta.watch === undefined) {
            ws.send(payload);
            continue;
        }

        // Kart disparu : flux commun.
        const kart = race.state.karts.find(k => k.id === meta.watch);
        if (!kart) {
            ws.send(payload);
            continue;
        }

        // Vue reutilisee pour les spectateurs du meme kart.
        if (!watched || watched.id !== meta.watch) {
            watched = {
                id: meta.watch,
                text: JSON.stringify(
                    Object.assign({}, snapshot, { vw: protocol.visionTuple(kart) })
                )
            };
        }
        ws.send(watched.text);
    }
}

function sendHello(ws) {
    ws.send(JSON.stringify(
        protocol.buildHello(race.cfg, race.state, race.simTime, race.t0, voteTally())
    ));
}

// ── Transport ───────────────────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            ok: true,
            racing: !!race,
            track: race ? race.track.name : null,
            // Connexions et navigateurs spectateurs.
            clients: clients.size,
            spectators: voteTally()[1],
            ticks: race ? race.ticks : 0,
            races: totalRaces,
            uptime: Math.round(process.uptime()),
            // Moteur qui tourne reellement (`make engine` donne celui qui est choisi).
            engine: 'js'
        }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
});

// Compression deflate avec contexte conserve (fenetre de 4 Ko pour borner la
// memoire par connexion).
const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: {
        zlibDeflateOptions: { level: 6, memLevel: 7 },
        serverMaxWindowBits: 12,
        clientNoContextTakeover: true,
        concurrencyLimit: 10,
        threshold: 256
    }
});

function originAllowed(origin) {
    if (ALLOWED_ORIGINS.length === 0) return true;
    if (!origin) return true; // outils en ligne de commande, sondes
    return ALLOWED_ORIGINS.includes(origin);
}

httpServer.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];

    if (pathname !== WS_PATH) {
        socket.destroy();
        return;
    }

    if (!originAllowed(req.headers.origin)) {
        console.warn(`[ws] origine refusee : ${req.headers.origin}`);
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
    ensureRunning();

    clients.set(ws, {
        nav: null, hidden: false, hiddenSince: 0, alive: true, voted: false, watch: null
    });
    sendHello(ws);

    ws.on('message', data => {
        // Messages acceptes : `ping`, `hi`, `vis`, `watch`, `vote` ; le reste est ignore.
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch (err) {
            return;
        }
        if (!msg || typeof msg !== 'object') return;

        const meta = clients.get(ws);
        if (!meta) return;

        if (msg.t === 'ping') {
            ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
            return;
        }

        // Premier message : identifiant du navigateur et visibilite.
        if (msg.t === 'hi') {
            // Une seule fois par connexion.
            if (!meta.nav && typeof msg.nav === 'string' && NAV_PATTERN.test(msg.nav)) {
                meta.nav = msg.nav;
                // Un nouvel onglet d'un navigateur qui a vote porte sa voix.
                if (navVoted(meta.nav)) {
                    meta.voted = true;
                    ws.send(JSON.stringify({ t: 'vote', v: true }));
                }
            }
            if (setHidden(meta, !!msg.hidden) && race) sendHello(ws);
            // Deux connexions devenues un navigateur : le quorum a baisse.
            checkVotes();
            return;
        }

        if (msg.t === 'vote') {
            const key = navKey(meta);
            setNavVote(key, !navVoted(key));
            checkVotes();
            return;
        }

        // Releve de vision d'un kart pour la carte de debug ; `id` absent rend la
        // connexion au flux commun.
        if (msg.t === 'watch') {
            // null ou absent (et non Number(), qui donnerait le kart 0).
            if (msg.id === null || msg.id === undefined) {
                meta.watch = null;
                return;
            }
            const id = Number(msg.id);
            meta.watch = Number.isInteger(id) ? id : null;
            return;
        }

        if (msg.t === 'vis') {
            // Retour au premier plan : scene complete.
            if (setHidden(meta, !!msg.hidden) && race) sendHello(ws);
        }
    });

    ws.on('pong', () => {
        const meta = clients.get(ws);
        if (meta) meta.alive = true;
    });

    ws.on('close', () => {
        clients.delete(ws);
        checkVotes();
        scheduleIdleStop();
    });

    ws.on('error', () => {
        clients.delete(ws);
        checkVotes();
        scheduleIdleStop();
    });
});

// Sonde des connexions mortes sans signal TCP (reseau mobile, proxy).
const heartbeat = setInterval(() => {
    for (const [ws, meta] of clients) {
        if (!meta.alive) {
            ws.terminate();
            clients.delete(ws);
            continue;
        }
        meta.alive = false;
        ws.ping();
    }
    if (clients.size === 0) scheduleIdleStop();
}, HEARTBEAT_MS);

// ── Surveillance ────────────────────────────────────────────────────────────

function isBroken(value) {
    return typeof value !== 'number' || !isFinite(value);
}

// Signale le premier NaN, avec de quoi remonter a sa source.
function checkIntegrity() {
    if (!race) return true;

    for (const kart of race.state.karts) {
        const bad = ['worldX', 'yPercent', 'totalDistance', 'absoluteVelocity', 'vy']
            .filter(f => isBroken(kart[f]));
        if (bad.length) {
            race.problems++;
            console.error(`[ALERTE] kart ${kart.id} (${kart.charName}) : ${bad.map(f => `${f}=${kart[f]}`).join(', ')}`);
            return false;
        }
    }

    for (const item of race.state.items) {
        const bad = ['worldX', 'y', 'vx', 'vy'].filter(f => isBroken(item[f]));
        if (bad.length) {
            race.problems++;
            console.error(`[ALERTE] objet ${item.id} (${item.type}) : ${bad.map(f => `${f}=${item[f]}`).join(', ')}`);
            return false;
        }
    }

    return true;
}

// Signale un kart immobile trop longtemps (bloque, ou etat 'hit' sans fin).
function checkStuck() {
    if (!race) return;
    const now = Date.now();

    if (race.state.phase === 'countdown') return;

    for (const kart of race.state.karts) {
        if (kart.state === 'grid' || kart.finished) continue;

        const seen = race.lastProgress.get(kart.id);
        if (!seen || kart.totalDistance > seen.totalDistance + 1) {
            race.lastProgress.set(kart.id, { totalDistance: kart.totalDistance, at: now });
            continue;
        }

        if (now - seen.at > STUCK_TIMEOUT_MS) {
            race.problems++;
            console.error(`[ALERTE] kart ${kart.id} (${kart.charName}) immobile depuis ${Math.round((now - seen.at) / 1000)} s ` +
                          `(state=${kart.state}, stopped=${kart.stopped}, velocity=${kart.absoluteVelocity.toFixed(1)})`);
            race.lastProgress.set(kart.id, { totalDistance: kart.totalDistance, at: now });
        }
    }
}

function formatClock(ms) {
    const total = Math.floor(ms / 1000);
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function report() {
    if (!race) {
        console.log(`[repos] aucune course (connexions : ${clients.size})`);
        return;
    }

    // Copie : ne pas modifier l'ordre des karts de la simulation.
    const board = race.state.karts.slice()
        .sort((a, b) => a.rank - b.rank)
        .map(k => `${k.rank}.${k.charName}${k.finished ? '!' : (k.heldItem ? '*' : '')}`)
        .join(' ');

    const rss = Math.round(process.memoryUsage().rss / 1048576);
    console.log(
        `[t+${formatClock(race.simTime - race.t0)}] ${race.state.phase} tour ${race.state.leaderLap}/${CFG.race.laps} — ${board}\n` +
        `           ticks=${race.ticks} objets=${race.state.items.length} arrives=${race.state.finishOrder.length} ` +
        `nextItemId=${race.state.nextItemId} connexions=${clients.size} spectateurs=${voteTally()[1]} ` +
        `rss=${rss}Mo pas_max=${race.maxStepMs}ms rejetes=${race.droppedSteps}`
    );

    race.maxStepMs = 0;
}

function shutdown(code) {
    const problems = race ? race.problems : 0;

    if (race) {
        console.log(
            `\n── bilan ──\n` +
            `duree simulee   : ${formatClock(race.simTime - race.t0)}\n` +
            `pas simules     : ${race.ticks} (attendu ~${Math.round((race.simTime - race.t0) / DT_MS)})\n` +
            `pas rejetes     : ${race.droppedSteps}\n` +
            `objets en vol   : ${race.state.items.length}\n` +
            `ids d'objets    : ${race.state.nextItemId}\n` +
            `connexions      : ${clients.size}\n` +
            `memoire (rss)   : ${Math.round(process.memoryUsage().rss / 1048576)} Mo\n` +
            `anomalies       : ${problems}`
        );
        clearInterval(race.loop);
    }

    clearInterval(heartbeat);
    clearInterval(watchdog);
    if (reporter) clearInterval(reporter);
    httpServer.close();

    process.exit(code !== undefined ? code : (problems > 0 ? 1 : 0));
}

// ── Demarrage ───────────────────────────────────────────────────────────────

const watchdog = setInterval(checkStuck, 1000);
const reporter = QUIET ? null : setInterval(report, REPORT_INTERVAL_MS);

httpServer.listen(PORT, () => {
    console.log(`Moteur de course : ${TICK_HZ} Hz simules, ${SEND_HZ} Hz diffuses.`);
    console.log(`HTTP  : http://0.0.0.0:${PORT}/healthz`);
    console.log(`WS    : ws://0.0.0.0:${PORT}${WS_PATH}`);
    console.log(`Origines : ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'toutes (ALLOWED_ORIGINS vide)'}`);
    console.log(ALWAYS_ON
        ? 'Mode : simulation permanente.'
        : 'Mode : course a la demande (depart a la premiere connexion, arret 30 s apres la derniere).');
    announceTracks();

    if (ALWAYS_ON) startRace();
});

if (DURATION_S > 0) {
    setTimeout(() => {
        report();
        shutdown();
    }, DURATION_S * 1000);
}

// Redemarrage a chaud sans arreter le conteneur (`make restart-race`).
process.on('SIGHUP', () => {
    console.log('[course] SIGHUP recu.');
    restartRace();
});

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
