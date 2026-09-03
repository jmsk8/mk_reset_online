// Moteur de course autoritatif du banner SMK.
//
// Une seule course tourne ici, et c'est elle que tous les navigateurs
// regardent : les clients ne simulent rien, ils affichent. L'architecture
// complete est dans docs/banner/architecture.md.
//
//   node src/server.js                  service normal (HTTP + WebSocket)
//   node src/server.js --duration 600   soak de 10 minutes, course forcee, puis bilan
//   node src/server.js --always-on      simule meme sans spectateur
//   node src/server.js --quiet          pas de rapport periodique
//
// Cycle de vie : la course demarre a la premiere connexion et s'arrete 30 s
// apres le depart du dernier spectateur. Personne devant l'ecran, aucun CPU
// consomme. Le delai de grace evite qu'un simple F5 ne reparte de zero.

import http from 'node:http';
import { WebSocketServer } from 'ws';

import * as protocol from './protocol.js';
import * as track from './track.js';
import * as PH from './engine/index.js';
import CFG from './config/index.js';

// Les circuits sont des dessins, pas du code : ils vivent dans tracks/, monte
// en lecture seule dans le conteneur — le moteur, lui, y est copie. Charges une
// fois au demarrage, puis relus a chaque redemarrage a chaud : dessiner un
// circuit et faire `make restart-race` suffit a le voir tourner, sans
// reconstruire l'image.
const TRACKS_DIR = track.resolveTracksDir(import.meta.dirname);

let TRACKS;
try {
    TRACKS = track.loadTracks(TRACKS_DIR, CFG);
} catch (err) {
    // Un dessin faux est une erreur d'auteur, pas un plantage : le message dit
    // quoi corriger, la pile d'appels ne dirait rien de plus. Et l'arret a lieu
    // ici, avant meme d'ecouter — plutot qu'au depart d'une course, ou le
    // conteneur relancerait le service en boucle a chaque spectateur.
    console.error(`[circuits] ${err.message}`);
    console.error('[circuits] `make race-tracks` verifie les dessins sans rien demarrer.');
    process.exit(1);
}

function announceTracks() {
    console.log(`[circuits] ${TRACKS.length} charge(s) depuis ${TRACKS_DIR} : `
        + TRACKS.map(t => `${t.name} (${t.columns} col, ${t.pipes.length} pipes)`).join(', '));
}

// Relecture du dossier. Un dessin faux ne doit pas emporter le service : on
// garde ceux qui tournaient et on dit ou regarder.
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

// La simulation tourne a 30 Hz, la diffusion a 10 : le client interpole entre
// deux snapshots, il n'a pas besoin de tous les pas. Diffuser plus vite double
// la bande passante par spectateur sans rien changer a ce qu'il voit.
const SEND_HZ = 10;
const TICKS_PER_SEND = Math.round(TICK_HZ / SEND_HZ);

// Plafond de rattrapage : sans lui, une pause GC ou un gel de l'hote declenche
// une spirale ou chaque tick rejoue le retard accumule, ce qui sature le CPU —
// d'autant plus avec la limite a 0.25 cpu prevue pour ce service. Au-dela, on
// abandonne le retard : mieux vaut une course qui saute que l'hote a genoux.
const MAX_CATCHUP_STEPS = 5;

// Delai de grace avant l'arret de la course quand plus personne ne regarde.
const IDLE_GRACE_MS = 30000;

// Taille maximale d'un message entrant. Le client n'envoie que `ping`, `vis`,
// `vote` et `watch`, quelques dizaines d'octets : ce qui depasse est une
// tentative.
const MAX_PAYLOAD = 512;

// Sonde applicative : une connexion qui ne repond plus au ping est fermee.
const HEARTBEAT_MS = 30000;

const REPORT_INTERVAL_MS = 5000;

// Un kart en course dont la distance ne bouge pas pendant ce delai est
// considere comme bloque. Large : un kart percute reste immobile le temps du
// malus (hitDecelDuration + hitPauseDuration = 2 s).
const STUCK_TIMEOUT_MS = 10000;

const args = process.argv.slice(2);
function argValue(name) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
}
const DURATION_S = Number(argValue('--duration')) || 0;
const QUIET = args.includes('--quiet');
const ALWAYS_ON = args.includes('--always-on') || DURATION_S > 0 || process.env.ALWAYS_ON === '1';

// Origines autorisees a ouvrir le flux. Vide = tout le monde, ce qui convient
// en local mais jamais en production : sans ce controle, n'importe quel site
// peut ouvrir une connexion permanente sur ce service (§6.12).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

const rng = Math.random;

// ── Course ──────────────────────────────────────────────────────────────────

let race = null;
let idleTimer = null;
let totalRaces = 0;

// Grille de la course suivante, vainqueur en pole. A null, elle est tiree au
// sort : c'est ce qui ouvre chaque grand prix. Conserve y compris quand le
// service se met au repos faute de spectateurs.
let lastFinishOrder = null;

// Grand prix en cours : { round, points }. Il court sur plusieurs courses, donc
// il vit ici et non dans l'etat du monde, refait a chaque depart. A null, la
// prochaine course ouvre un bloc neuf.
let grandPrix = null;

function startRace() {
    const now = Date.now();

    // Une manche, un circuit : le grand prix parcourt le dossier dans l'ordre
    // des noms de fichiers. Le choix se fait ici et pas plus bas parce que le
    // circuit est dans la config — la longueur du tour, la ligne et les boites
    // en font partie — et que la config doit etre complete avant que le monde
    // ne soit construit.
    const round = (grandPrix && grandPrix.round) || 1;
    const circuit = track.forRound(TRACKS, round);
    const cfg = track.applyTrack(CFG, circuit);

    for (const warning of circuit.warnings) {
        console.warn(`[circuits] ${circuit.source} — ${warning}`);
    }

    race = {
        // Horloge de simulation : elle n'avance que par pas fixes, jamais par
        // le temps reel. C'est elle qui date les snapshots.
        simTime: now,
        t0: now,

        // La config de cette course-ci, circuit compris. Toute la course s'y
        // refere : `CFG` seule ne decrit aucun tour, et deux manches d'un meme
        // grand prix ne tournent pas sur la meme piste.
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

// Sans le `hello`, les spectateurs garderaient les identites et la grille de la
// course precedente.
function beginNewRace() {
    if (race) {
        clearInterval(race.loop);
        race = null;
    }

    if (clients.size === 0 && !ALWAYS_ON) {
        console.log('[course] plus aucun spectateur : la prochaine connexion relancera.');
        return;
    }

    startRace();
    for (const [ws] of clients) {
        if (ws.readyState === ws.OPEN) sendHello(ws);
    }
}

// Redemarrage a chaud demande de l'exterieur (`make restart-race`). Il repart
// de zero et pas seulement d'une course neuve : grand prix efface, scores
// remis a zero, grille tiree au sort. C'est ce qu'on attend d'un redemarrage —
// reprendre le bloc en cours a la troisieme manche n'aurait aucun sens.
function restartRace() {
    console.log('[course] redemarrage demande — grand prix remis a zero.');
    // Le dossier est relu au passage : c'est ce qui fait d'un circuit un
    // dessin qu'on retouche, et non un fichier qui demande un rebuild.
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

// Classement lu a la console a la fin de chaque course : la manche qui vient de
// finir, puis le general du bloc.
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

    // Un ecart absurde (mise en veille de la machine, debogueur) ne doit pas
    // entrer dans l'accumulateur.
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

                // Bloc termine : scores remis a zero et grille tiree au sort au
                // depart suivant. Sinon on reporte le cumul et on avance d'une
                // manche.
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
        // Un grand prix neuf repart d'une grille au hasard : `lastFinishOrder` a
        // null fait tirer createWorldState.
        lastFinishOrder = (nextGrandPrix.round === 1) ? null : finishedOrder;
        grandPrix = nextGrandPrix;
        beginNewRace();
        return;
    }

    if (race.accumulator >= DT) {
        // Retard non rattrape : on le jette plutot que de le trainer.
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
        broadcast();
    }
}

// ── Diffusion ───────────────────────────────────────────────────────────────

const clients = new Map(); // ws -> { hidden, alive }

// ── Vote de redemarrage ─────────────────────────────────────────────────────
//
// Chaque spectateur peut poser une voix, et la retirer. Quand ils l'ont tous
// posee, la course repart de zero — grand prix compris. L'unanimite plutot
// qu'une majorite : a deux spectateurs, une majorite laisserait l'un des deux
// relancer seul la course de l'autre.

function voteTally() {
    let count = 0;
    for (const meta of clients.values()) if (meta.voted) count++;
    return [count, clients.size];
}

function clearVotes() {
    for (const meta of clients.values()) meta.voted = false;
}

// Une voix de plus, ou un spectateur de moins : les deux completent le quorum,
// d'ou l'appel aussi bien a la fermeture d'une connexion qu'au vote.
function checkVotes() {
    const [count, total] = voteTally();
    if (total === 0 || count < total) return;

    console.log(`[course] redemarrage vote a l'unanimite (${total} spectateur(s)).`);
    // Avant le redemarrage : le `hello` qui suit doit annoncer un compteur
    // remis a zero, sinon les boutons resteraient allumes sur la course neuve.
    clearVotes();
    restartRace();
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

    // Le releve de vision du kart suivi, pour les seules connexions qui l'ont
    // demande : il pese cent fois l'entier de decision et ne concerne qu'un kart.
    // D'ou cette seconde serialisation, et son prix bien delimite — une par
    // spectateur qui regarde, zero quand personne ne regarde.
    let watched = null;

    for (const [ws, meta] of clients) {
        // Onglet en arriere-plan : le client a demande qu'on lui coupe le flux.
        // La course continue sans lui, il redemandera l'etat en revenant.
        if (meta.hidden) continue;
        if (ws.readyState !== ws.OPEN) continue;

        if (meta.watch === null || meta.watch === undefined) {
            ws.send(payload);
            continue;
        }

        // Le kart demande a pu disparaitre entre deux courses : on retombe alors
        // sur le flux commun plutot que d'inventer une vue vide.
        const kart = race.state.karts.find(k => k.id === meta.watch);
        if (!kart) {
            ws.send(payload);
            continue;
        }

        // Un seul spectateur par kart, le plus souvent : la vue se serialise une
        // fois et se reutilise pour les suivants qui regardent le meme.
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
            clients: clients.size,
            ticks: race ? race.ticks : 0,
            races: totalRaces,
            uptime: Math.round(process.uptime())
        }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found\n');
});

// Deux snapshots consecutifs se ressemblent enormement : c'est le cas ideal pour
// deflate, a condition de garder le contexte de compression d'un message a
// l'autre. La fenetre est reduite a 4 Ko : elle couvre l'historique utile a des
// messages de quelques centaines d'octets tout en bornant la memoire par
// connexion, qui compte avec la limite a 128 Mo du conteneur.
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

    clients.set(ws, { hidden: false, alive: true, voted: false, watch: null });
    sendHello(ws);

    ws.on('message', data => {
        // Le service repond a `ping`, note `vis` et `watch`, compte `vote`. Tout
        // le reste est ignore en silence : c'est un flux de lecture, il n'existe
        // aucune raison legitime de lui envoyer autre chose.
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

        if (msg.t === 'vote') {
            meta.voted = !meta.voted;
            checkVotes();
            return;
        }

        // Le releve de vision d'UN kart, pour la carte de debug ; `id` absent
        // rend la connexion au flux commun. Seule demande qui fasse travailler le
        // service pour un spectateur, d'ou sa forme : un identifiant, rien qui
        // touche a la course. Un client qui ment sur `id` obtient au pire la vue
        // d'un autre kart.
        if (msg.t === 'watch') {
            // `null` explicite : le client rend la connexion au flux commun.
            // A ne surtout pas passer par `Number`, qui rend 0 — soit le kart
            // 0, donc l'inverse exact de ce qui est demande.
            if (msg.id === null || msg.id === undefined) {
                meta.watch = null;
                return;
            }
            const id = Number(msg.id);
            meta.watch = Number.isInteger(id) ? id : null;
            return;
        }

        if (msg.t === 'vis') {
            const wasHidden = meta.hidden;
            meta.hidden = !!msg.hidden;
            // Au retour d'un onglet, le client a besoin d'une scene complete :
            // il a rate tout ce qui s'est passe, exactement comme un arrivant.
            if (wasHidden && !meta.hidden && race) sendHello(ws);
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

// Une connexion peut mourir sans que la pile TCP le signale (reseau mobile,
// proxy qui disparait). Sans cette sonde, le service accumulerait des
// spectateurs fantomes — et ne s'arreterait donc jamais faute de public.
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

// Un NaN n'apparait jamais seul : il se propage a tout ce qu'il touche, et une
// course qui en contient un est perdue. On le signale des la premiere
// occurrence, avec de quoi remonter a sa source.
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

// Un kart immobile trop longtemps est soit coince contre une bordure, soit
// victime d'un etat 'hit' qui ne se termine jamais. Les deux passeraient
// inapercus sur un rapport de distances qui, globalement, continue de monter.
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
        console.log(`[repos] aucune course (spectateurs : ${clients.size})`);
        return;
    }

    // Copie : trier le tableau du monde changerait l'ordre d'iteration de la
    // simulation.
    const board = race.state.karts.slice()
        .sort((a, b) => a.rank - b.rank)
        .map(k => `${k.rank}.${k.charName}${k.finished ? '!' : (k.heldItem ? '*' : '')}`)
        .join(' ');

    const rss = Math.round(process.memoryUsage().rss / 1048576);
    console.log(
        `[t+${formatClock(race.simTime - race.t0)}] ${race.state.phase} tour ${race.state.leaderLap}/${CFG.race.laps} — ${board}\n` +
        `           ticks=${race.ticks} objets=${race.state.items.length} arrives=${race.state.finishOrder.length} ` +
        `nextItemId=${race.state.nextItemId} spectateurs=${clients.size} ` +
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
            `spectateurs     : ${clients.size}\n` +
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

// Redemarrage a chaud, sans arreter le conteneur : `make restart-race`.
process.on('SIGHUP', () => {
    console.log('[course] SIGHUP recu.');
    restartRace();
});

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
