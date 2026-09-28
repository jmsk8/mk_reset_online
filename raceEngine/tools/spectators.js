// Le compte des spectateurs et le vote de redemarrage, contre un service en marche.
//
// Un spectateur est un NAVIGATEUR qui regarde, pas une connexion : deux onglets
// font un spectateur et une voix, un onglet cache cesse de compter apres un
// delai (server.js, « Spectateurs »). Cet outil le verifie de l'exterieur, par le
// seul protocole — il vaut donc pour les deux moteurs, JS et C++.
//
//   node tools/spectators.js                  scenarios courts (quelques secondes)
//   node tools/spectators.js --grace          plus l'expiration d'un onglet cache (~65 s)
//   node tools/spectators.js --url ws://...   autre serveur
//
// A lancer contre un service A SOI : le dernier scenario vote un redemarrage.
// Si quelqu'un d'autre regarde deja, l'outil s'arrete sans rien faire — sauf
// --force, et le redemarrage ne peut alors pas aboutir.

import WebSocket from 'ws';

const args = process.argv.slice(2);
function argValue(name, fallback) {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const URL = argValue('--url', 'ws://localhost:3000/ws/race');
const GRACE = args.includes('--grace');
const FORCE = args.includes('--force');

// Doit suivre HIDDEN_GRACE_MS (server.js, server.cpp).
const HIDDEN_GRACE_MS = 60000;

// Plus que l'intervalle entre deux snapshots (100 ms) : le temps qu'un geste se
// voie dans le compteur.
const SETTLE_MS = 400;

let failures = 0;

function check(ok, label, detail) {
    if (!ok) failures++;
    console.log(`  ${ok ? 'ok   ' : 'ECHEC'}  ${label}${detail !== undefined ? ' — ' + detail : ''}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let serial = 0;
function randomNav() {
    serial++;
    return `essai-${process.pid}-${serial}-${Math.random().toString(36).slice(2, 10)}`;
}

// Une connexion, et ce qu'elle a recu : le dernier compteur, sa voix, ses hello.
function open(hi) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(URL);
        const conn = { ws, vt: null, vote: null, hellos: [], t0: null };

        ws.on('message', data => {
            const msg = JSON.parse(data.toString());
            if (msg.t === 'hello') {
                conn.hellos.push(msg.t0);
                conn.t0 = msg.t0;
                conn.vt = msg.snapshot.vt;
            } else if (msg.t === 's') {
                conn.vt = msg.vt;
            } else if (msg.t === 'vote') {
                conn.vote = msg.v;
            }
        });
        ws.on('open', () => {
            if (hi) ws.send(JSON.stringify(Object.assign({ t: 'hi' }, hi)));
            resolve(conn);
        });
        ws.on('error', reject);
    });
}

function send(conn, msg) {
    conn.ws.send(JSON.stringify(msg));
}

async function closeAll(conns) {
    for (const c of conns) c.ws.close();
    await sleep(SETTLE_MS);
}

// L'observateur compte pour un : c'est par lui qu'on lit le compteur.
async function tally(observer) {
    await sleep(SETTLE_MS);
    return observer.vt || [0, 0];
}

async function main() {
    console.log(`service : ${URL}\n`);

    const observer = await open({ nav: randomNav() });
    const [, before] = await tally(observer);
    const base = before - 1;
    if (base > 0 && !FORCE) {
        console.log(`${base} autre(s) spectateur(s) deja connecte(s) : rien n'est lance.`);
        console.log('Cet outil vote un redemarrage ; lancez-le contre un service a vous (--force pour passer outre).');
        observer.ws.close();
        process.exit(2);
    }
    const expect = n => base + 1 + n;

    console.log('── un spectateur est un navigateur ──');
    {
        const nav = randomNav();
        const a = await open({ nav });
        const b = await open({ nav });
        const [, total] = await tally(observer);
        check(total === expect(1), 'deux onglets d\'un meme navigateur comptent pour un', `${total}`);
        await closeAll([a, b]);
    }
    {
        const a = await open({ nav: randomNav() });
        const b = await open({ nav: randomNav() });
        const [, total] = await tally(observer);
        check(total === expect(2), 'deux navigateurs comptent pour deux', `${total}`);
        await closeAll([a, b]);
    }
    {
        const a = await open(null);
        const b = await open(null);
        const [, total] = await tally(observer);
        check(total === expect(2), 'sans `hi` (ancien client), chaque connexion compte pour elle seule', `${total}`);
        await closeAll([a, b]);
    }
    {
        const a = await open({ nav: 'court!' });
        const b = await open({ nav: 'court!' });
        const [, total] = await tally(observer);
        check(total === expect(2), 'un identifiant invalide est ignore, pas partage', `${total}`);
        await closeAll([a, b]);
    }
    {
        const nav = randomNav();
        const a = await open({ nav });
        const b = await open({ nav });
        a.ws.close();
        const [, total] = await tally(observer);
        check(total === expect(1), 'un onglet ferme, l\'autre regarde toujours', `${total}`);
        await closeAll([b]);
    }

    console.log('\n── un onglet cache ──');
    {
        const a = await open({ nav: randomNav(), hidden: true });
        const [, total] = await tally(observer);
        check(total === expect(1), 'ouvert en arriere-plan, il compte encore pendant le delai', `${total}`);
        if (GRACE) {
            console.log(`  (attente de ${Math.round(HIDDEN_GRACE_MS / 1000) + 3} s)`);
            await sleep(HIDDEN_GRACE_MS + 3000);
            const [, after] = await tally(observer);
            check(after === expect(0), 'passe le delai, il ne compte plus', `${after}`);
            send(a, { t: 'vis', hidden: false });
            const [, back] = await tally(observer);
            check(back === expect(1), 'revenu au premier plan, il compte de nouveau', `${back}`);
        }
        await closeAll([a]);
    }

    console.log('\n── une voix par navigateur ──');
    {
        const nav = randomNav();
        const a1 = await open({ nav });
        const a2 = await open({ nav });
        const b = await open({ nav: randomNav() });

        send(a1, { t: 'vote' });
        let [votes, total] = await tally(observer);
        check(votes === 1 && total === expect(2), 'une voix posee depuis un onglet', `${votes}/${total}`);
        check(a1.vote === true && a2.vote === true, 'les deux onglets du navigateur en sont prevenus',
              `${a1.vote}, ${a2.vote}`);
        check(b.vote === null, 'l\'autre navigateur, non', `${b.vote}`);

        const a3 = await open({ nav });
        await sleep(SETTLE_MS);
        check(a3.vote === true, 'un onglet qui s\'ouvre ensuite recoit la voix de son navigateur', `${a3.vote}`);

        send(a2, { t: 'vote' });
        [votes, total] = await tally(observer);
        check(votes === 0, 'retiree depuis l\'AUTRE onglet, elle disparait', `${votes}/${total}`);
        check(a1.vote === false && a2.vote === false && a3.vote === false,
              'et tous les onglets le savent', `${a1.vote}, ${a2.vote}, ${a3.vote}`);

        await closeAll([a1, a2, a3, b]);
    }

    console.log('\n── l\'unanimite ──');
    {
        const nav = randomNav();
        const a1 = await open({ nav });
        const a2 = await open({ nav });
        const t0 = observer.t0;

        // L'observateur est un navigateur lui aussi : il vote pour completer.
        send(a1, { t: 'vote' });
        await sleep(SETTLE_MS);
        check(observer.t0 === t0, 'une voix sur deux navigateurs ne relance rien');

        send(observer, { t: 'vote' });
        await sleep(SETTLE_MS * 2);
        check(observer.t0 !== t0, 'les deux navigateurs d\'accord : la course repart',
              `t0 ${t0} -> ${observer.t0}`);
        const [votes] = await tally(observer);
        check(votes === 0, 'et le compteur de voix repart de zero', `${votes}`);

        await closeAll([a1, a2]);
    }

    observer.ws.close();
    console.log(failures ? `\n${failures} echec(s).` : '\nTout est conforme.');
    process.exit(failures ? 1 : 0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
