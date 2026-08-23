'use strict';

// Le « test de l'arrivant ».
//
// Un spectateur qui se connecte en pleine course doit pouvoir reconstruire une
// scene complete et juste a partir du seul `hello` — il n'a vu passer aucun
// evenement. Cet outil le verifie mecaniquement :
//
//   1. une premiere connexion tient la course ouverte (sans elle, le service
//      s'arrete faute de public) et laisse la course avancer ;
//   2. une seconde connexion arrive apres coup et fait l'inventaire de ce
//      qu'elle recoit, champ par champ.
//
//   node tools/spectate.js                  arrivee au bout de 5 s
//   node tools/spectate.js --after 180      arrivee au bout de 3 minutes
//   node tools/spectate.js --url ws://...   autre serveur
//
// Les points marques MANQUE sont ceux qui feraient afficher une scene fausse.

const WebSocket = require('ws');

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const URL = argValue('--url', 'ws://localhost:3000/ws/race');
const AFTER_S = Number(argValue('--after', '5'));
const WATCH_S = Number(argValue('--watch', '4'));

const FLAG_GRID = 1;
const FLAG_HIT = 2;
const FLAG_STOPPED = 4;
const FLAG_STAR = 8;
const FLAG_FINISHED = 16;

let holder = null;
let holderMessages = 0;

function line(ok, label, detail) {
    console.log(`  ${ok ? 'ok    ' : 'MANQUE'}  ${label}${detail ? ' — ' + detail : ''}`);
}

function audit(hello) {
    console.log(`\n── ce que recoit un arrivant apres ${AFTER_S} s ──\n`);

    const world = hello.world || {};
    const snap = hello.snapshot || {};
    const karts = snap.k || [];

    console.log(`protocole ${hello.protocol}, t0 il y a ${((Date.now() - hello.t0) / 1000).toFixed(1)} s, ` +
                `snapshot date de ${snap.ts}`);
    console.log(`monde : ${world.width} unites, arrivee a ${world.finishLineX}, soleil a ${world.sunX}, ` +
                `route ${world.roadMinY}..${world.roadMaxY}, ${world.roadPPS} px/s, ${world.laps} tours`);
    console.log(`course : phase ${snap.ph}, tour ${snap.lp}/${world.laps}, ` +
                `panneau ${snap.sg ? snap.sg.join('/') : 'aucun'}\n`);

    const running = karts.filter(k => !(k[4] & FLAG_GRID));
    const held = karts.filter(k => k[6] !== null);
    const starred = karts.filter(k => k[4] & FLAG_STAR);
    const stopped = karts.filter(k => k[4] & FLAG_STOPPED);
    const hit = karts.filter(k => k[4] & FLAG_HIT);
    const boxes = snap.b || [];
    const takenBoxes = boxes.filter(b => b === 0);
    const items = snap.i || [];

    // Les six points du §7 : chacun correspond a une lacune du protocole
    // initial, qui aurait fait afficher une scene fausse a un arrivant.
    line(hello.karts && hello.karts.length > 0,
         'identite des karts', hello.karts ? hello.karts.map(k => k.char).join(', ') : '');
    line(hello.boxes && hello.boxes.length > 0,
         'position des item-boxes', hello.boxes ? `${hello.boxes.length} boites` : '');
    line(karts.length > 0 && karts.every(k => typeof k[5] === 'number' && k[5] > 0),
         'classement reconstituable', `rangs ${karts.map(k => k[5]).sort((a, b) => a - b).join('')}`);
    line(typeof snap.ph === 'string' && typeof snap.lp === 'number',
         'phase et tour', `${snap.ph}, tour ${snap.lp}`);
    line(Array.isArray(snap.fo),
         'ordre d arrivee', snap.fo && snap.fo.length
            ? snap.fo.map((id, i) => `${i + 1}.${(hello.karts.find(k => k.id === id) || {}).char}`).join(' ')
            : 'personne n est encore arrive');
    line(held.every(k => typeof k[7] === 'string'),
         'type de l objet tenu', held.length ? held.map(k => `${k[0]}:${k[7]}(${k[8]})`).join(' ') : 'aucun kart ne tient d objet pour l instant');
    line(karts.every(k => typeof k[4] === 'number'),
         'etats (grille/hit/stopped/etoile/arrive)',
         `${running.length} lances, ${hit.length} percutes, ${stopped.length} figes, ` +
         `${starred.length} sous etoile, ${karts.filter(k => k[4] & FLAG_FINISHED).length} arrives`);
    line(boxes.length > 0,
         'etat des item-boxes', `${takenBoxes.length}/${boxes.length} deja consommees`);
    line(typeof snap.cx === 'number' && typeof snap.bx === 'number',
         'cameras', `route ${snap.cx}, fond ${snap.bx}`);
    line(items.every(it => typeof it[1] === 'string' && typeof it[4] === 'number'),
         'objets libres', items.length ? items.map(it => `${it[1]}#${it[4]}`).join(' ') : 'aucun en vol');

    const missing = [];
    if (!held.length) missing.push('aucun kart ne tenait d objet : relance avec --after plus grand pour couvrir ce cas');
    if (!takenBoxes.length) missing.push('aucune boite consommee : idem');
    if (missing.length) console.log('\nnon couvert par ce tirage :\n  - ' + missing.join('\n  - '));
}

function watch(ws) {
    console.log(`\n── flux (${WATCH_S} s) ──\n`);

    let snapshots = 0;
    let bytes = 0;
    let events = 0;
    let rtt = null;
    const started = Date.now();

    // `bytes` compte le JSON une fois decompresse. Ce qui traverse vraiment le
    // reseau se lit sur la socket : c'est le seul chiffre qui compte pour un
    // spectateur en 4G.
    const socket = ws._socket;
    const wireStart = socket ? socket.bytesRead : null;

    ws.on('message', data => {
        const raw = data.toString();
        const msg = JSON.parse(raw);

        if (msg.t === 'pong') {
            rtt = Date.now() - msg.c;
            return;
        }
        if (msg.t !== 's') return;

        snapshots++;
        bytes += raw.length;
        if (msg.ev) events += msg.ev.length;
    });

    ws.send(JSON.stringify({ t: 'ping', c: Date.now() }));

    setTimeout(() => {
        const seconds = (Date.now() - started) / 1000;
        const wire = socket ? socket.bytesRead - wireStart : null;

        console.log(`  ${snapshots} snapshots en ${seconds.toFixed(1)} s = ${(snapshots / seconds).toFixed(1)} Hz`);
        console.log(`  ${Math.round(bytes / snapshots)} octets par snapshot avant compression, ` +
                    `${(bytes / seconds / 1024).toFixed(1)} Ko/s`);
        if (wire !== null) {
            console.log(`  ${Math.round(wire / snapshots)} octets sur le reseau, ` +
                        `${(wire / seconds / 1024).toFixed(1)} Ko/s reels ` +
                        `(${Math.round(100 - (wire / bytes) * 100)} % de gain, ${(wire / seconds * 3600 / 1048576).toFixed(0)} Mo/h)`);
        }
        console.log(`  ${events} evenements recus`);
        console.log(`  aller-retour : ${rtt === null ? 'pas de pong' : rtt + ' ms'}`);

        // Onglet cache : le flux doit se taire, puis reprendre par un `hello`
        // complet — un client qui revient est un arrivant comme un autre.
        console.log('\n── mise en arriere-plan ──\n');
        let afterHidden = 0;
        let helloBack = false;

        // Un snapshot peut etre deja parti quand la demande arrive au serveur :
        // a 10 Hz, la fenetre fait 100 ms. Seul ce qui arrive nettement apres
        // compte comme un flux non coupe.
        const GRACE_MS = 300;
        let hiddenAt = 0;

        ws.removeAllListeners('message');
        ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'hello') helloBack = true;
            else if (msg.t === 's' && Date.now() - hiddenAt > GRACE_MS) afterHidden++;
        });

        hiddenAt = Date.now();
        ws.send(JSON.stringify({ t: 'vis', hidden: true }));

        setTimeout(() => {
            console.log(`  ${afterHidden === 0 ? 'ok    ' : 'ECHEC '}  flux coupe (${afterHidden} snapshots recus en 2 s, hors les 300 ms de battement)`);
            afterHidden = 0;
            hiddenAt = 0;
            ws.send(JSON.stringify({ t: 'vis', hidden: false }));

            setTimeout(() => {
                console.log(`  ${helloBack ? 'ok    ' : 'ECHEC '}  hello complet au retour`);
                console.log(`  ${afterHidden > 0 ? 'ok    ' : 'ECHEC '}  flux repris (${afterHidden} snapshots)`);
                ws.close();
                if (holder) holder.close();
                console.log(`\nla connexion qui tenait la course a recu ${holderMessages} messages.\n`);
                process.exit(0);
            }, 1500);
        }, 2000);
    }, WATCH_S * 1000);
}

console.log(`Connexion de maintien sur ${URL} ...`);
holder = new WebSocket(URL);

holder.on('open', () => {
    console.log(`ok. La course tourne, arrivee du spectateur dans ${AFTER_S} s.`);

    setTimeout(() => {
        const ws = new WebSocket(URL);
        ws.once('message', data => {
            const hello = JSON.parse(data.toString());
            if (hello.t !== 'hello') {
                console.error('premier message inattendu :', hello.t);
                process.exit(1);
            }
            audit(hello);
            watch(ws);
        });
        ws.on('error', err => {
            console.error('erreur du spectateur :', err.message);
            process.exit(1);
        });
    }, AFTER_S * 1000);
});

holder.on('message', () => { holderMessages++; });

holder.on('error', err => {
    console.error(`impossible de se connecter a ${URL} : ${err.message}`);
    process.exit(1);
});
