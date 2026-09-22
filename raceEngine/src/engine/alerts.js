// L'OUIE : ce qu'un kart sait arriver SANS l'avoir vu.
//
// Le moteur a une regle, et tout le pilotage en depend : un kart ne reagit qu'a
// ce qu'il voit, et il ne voit qu'un cote a la fois. L'ouie en est la seule
// exception, et elle est bornee par construction — elle dit QUOI arrive et SI
// C'EST POUR LUI, jamais OU. La position reste l'affaire de la vue : c'est ce qui
// fait que l'alerte complete le pilotage au lieu de le remplacer.
//
//   ram    une etoile ou un bill dans le dos, a portee. Ca s'ENTEND : ca fait
//          tourner la tete (`updateGlance`), et ce qu'il verra ensuite passe par
//          le balayage ordinaire.
//   red    une rouge le VISE. Se retourner ne servirait a rien, elle suit : il
//          se couvre, et tient sa couverture (`updateShield`).
//   blue   une bleue arrive et il est en tete — ou elle l'a deja choisi. Il se
//          protege s'il le peut, sinon il cede la tete (`updateBlue`).
//
// Rien ici ne pilote : `hear` pose des constats dans `kart.alert`, la vue, le
// plan et le bouclier en decident.

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { isContactActive, isRamming } from './bodies.js';
import { getRacingLeader } from './standings.js';

// Une etoile ou un bill arrive derriere, et ca S'ENTEND.
//
// Toute la surveillance soutenue demande d'avoir DEJA vu le danger, et on ne voit
// derriere qu'en s'etant retourne. Pour une carapace, la manquer est une vraie
// faute de pilote. Pour une carrosserie lancee, non : elle ne reste dans la
// portee arriere que trois secondes, quand un kart du peloton ne se retourne
// qu'une fois toutes les onze — le plateau se faisait faucher sans qu'un seul ait
// regarde.
//
// Meme limite que `seeHomingThroughCover` : ca fait tourner la tete, rien de
// plus. Ce qu'il verra ensuite passe par le balayage ordinaire.
//
// Le bruit dit aussi s'il SE RAPPROCHE, et a peu pres quand il sera la : c'est
// le temps avant contact du plus pressant, releve dans `alert.ramTtc` —
// l'infini s'il est la sans gagner de terrain. Il ne dit toujours pas OU.
function ramNoise(cfg, state, kart) {
    const alert = kart.alert;
    alert.ram = false;
    alert.ramTtc = Infinity;
    alert.ramId = -1;
    if (isRamming(kart)) return;

    const karts = state.karts;
    for (let i = 0; i < karts.length; i++) {
        const other = karts[i];
        if (other.id === kart.id) continue;
        if (!isRamming(other) || !isContactActive(other)) continue;

        // Derriere, et a portee de regard. Au-dela le bruit existe mais il n'y a
        // rien a voir : se retourner ne servirait qu'a etre aveugle devant.
        const dx = getShortestDistance(cfg, other.worldX, kart.worldX);
        if (dx >= 0 || -dx > cfg.vision.range.back) continue;
        alert.ram = true;

        // Jusqu'au CONTACT, comme la vue le mesure (cf. `perceive`).
        const rel = other.absoluteVelocity - kart.absoluteVelocity;
        if (rel <= 0) continue;
        const reach = other.isBill ? cfg.bill.hitbox.x : cfg.hitboxes.kartVsKart.x;
        const gap = -dx - reach;
        const ttc = (gap > 0) ? (gap / rel) * 1000 : 0;
        if (ttc < alert.ramTtc) {
            alert.ramTtc = ttc;
            alert.ramId = other.id;
        }
    }
}

// Le reflexe, le meme que pour tout le reste (cf. `judgeThreat`) : entendre
// n'est pas avoir deja reagi.
function reaction(cfg, rng) {
    const ai = cfg.ai;
    return ai.reactionBaseMs * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);
}

// Une rouge le VISE. Il le sait sans se retourner — dans le jeu d'origine, c'est
// l'alarme — et se retourner n'y changerait rien : elle suit. Ce qui reste a
// decider est ce qu'il oppose, et c'est `updateShield` qui le fait.
//
// La plus proche qui le vise, jugee une fois : reflexe et inattention tires a
// la premiere ecoute, comme une menace vue. `alert.red` n'est vrai qu'une fois
// le reflexe passe, et jamais pour celle qu'il a laissee passer.
function hearRed(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.red;
    alert.red = false;
    if (!spec.enabled) {
        alert.redId = 0;
        return;
    }

    let best = null;
    let bestGap = Infinity;
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== 'redShell' || item.isDead || item.spent) continue;
        if (item.targetKartId !== kart.id) continue;

        // Dans le dos et a portee d'oreille. Une rouge qui l'a deja depasse ne
        // le vise plus que sur le papier.
        const gap = -getShortestDistance(cfg, item.worldX, kart.worldX);
        if (gap < 0 || gap > cfg.vision.range.back) continue;
        if (gap < bestGap) {
            bestGap = gap;
            best = item;
        }
    }

    if (!best) {
        alert.redId = 0;
        return;
    }

    if (best.id !== alert.redId) {
        alert.redId = best.id;
        alert.redReactAt = now + reaction(cfg, rng);
        alert.redIgnored = rng() < spec.miss;
    }
    alert.red = !alert.redIgnored && now >= alert.redReactAt;
}

// Ce qui rend intouchable au souffle d'une bleue : le champignon le temps de sa
// poussee, l'etoile le temps de son invincibilite (cf. `blastKart`).
function holdsCover(kart) {
    const held = kart.heldItem;
    return !!held && (held.type === 'shroom' || held.type === 'star');
}

function blueAlive(state, id) {
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].id === id) return !items[i].isDead;
    }
    return false;
}

// La bleue. Deux temps, et c'est ce qui decide de tout (cf. `updateBlueShell`) :
//
//   AVANT LE VERROU, elle file droit sans cible et choisira le PREMIER a
//   `blueShell.lockDistance`. Celui qui est en tete l'entend venir, avec une
//   idee du temps qui reste — le son qui grossit — fausse d'une part tiree une
//   fois. C'est le seul moment ou il peut encore ne pas etre la cible : cesser
//   d'etre premier.
//
//   APRES, le verrou est definitif. Elle tourne autour de lui, s'arrete
//   au-dessus, pique : il la VOIT, c'est sur lui. Plus rien ne le sauve qu'un
//   objet qui rend intouchable au bon moment.
//
// Personne d'autre ne l'entend comme une alerte : elle ne concerne que le
// premier, puis sa cible.
function hearBlue(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.blue;
    alert.blue = false;
    alert.blueOnMe = false;
    alert.blueEta = Infinity;
    alert.bluePhase = '';
    alert.blueLook = false;
    if (!spec.enabled) {
        alert.blueId = 0;
        return;
    }

    const leader = getRacingLeader(state) === kart;
    let blue = null;
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== 'blueShell' || item.isDead) continue;
        if (item.targetKartId === kart.id) {
            blue = item;
            break;
        }
        if (item.targetKartId === null && leader && !blue) blue = item;
    }

    if (!blue) {
        alert.blueId = 0;
        return;
    }

    if (blue.id !== alert.blueId) {
        alert.blueId = blue.id;
        alert.blueReactAt = now + reaction(cfg, rng);
        alert.blueIgnored = rng() < spec.miss;
        alert.blueBias = 1 + randomRange(rng, -spec.etaError, spec.etaError);
        alert.blueYield = rng() < spec.yieldChance;
        alert.blueStartled = false;
        alert.blueFireAt = 0;
    }
    if (alert.blueIgnored || now < alert.blueReactAt) return;

    alert.blue = true;
    alert.blueOnMe = blue.targetKartId === kart.id;

    if (alert.blueOnMe) {
        alert.bluePhase = blue.phase;
        return;
    }

    // Ce qu'il croit qu'il reste avant qu'elle choisisse : l'ecart a couvrir
    // jusqu'a la distance de verrou, a la vitesse ou elle le rattrape — ou
    // l'expiration de sa croisiere, si elle tombe avant.
    const b = cfg.blueShell;
    let gap = getShortestDistance(cfg, kart.worldX, blue.worldX);
    if (gap < 0) gap += cfg.world.width;
    const closing = b.speed - kart.absoluteVelocity;
    let eta = (closing > 0) ? (Math.max(0, gap - b.lockDistance) / closing) * 1000 : Infinity;
    const expire = blue.createdAt + b.maxCruiseMs - now;
    if (expire < eta) eta = (expire > 0) ? expire : 0;
    alert.blueEta = eta * alert.blueBias;

    // Il faut VOIR qui le suit pour savoir s'il peut lui ceder la place : il se
    // retourne. Rien a regarder s'il tient de quoi se proteger, ou s'il a deja
    // decide.
    alert.blueLook = !holdsCover(kart) && alert.blueMode === '';
    if (alert.blueLook && !alert.blueStartled) {
        alert.blueStartled = true;
        alert.startle = true;
    }
}

// Ce qu'il fait de la bleue qu'il entend. SE PROTEGER passe avant tout frein :
// le champignon ou l'etoile en main rendent le souffle inoffensif, et ceder la
// tete couterait une seconde pour rien.
//
//   L'ETOILE se sort des que la bleue l'a choisi, apres le reflexe : elle dure
//   bien plus que ce qu'il reste avant le souffle.
//
//   LE CHAMPIGNON est le geste difficile. Il ne rend intouchable que le temps de
//   sa poussee, et il faut qu'elle couvre l'explosion ET le dome qui s'etend
//   derriere — donc le sortir ni trop tot ni apres. Le signal est l'instant ou
//   elle cesse de tourner et s'arrete au-dessus de lui ; le kart reagit, et
//   hesite une part tiree au sort (`hesitateMs`). Reagir a la chute elle-meme
//   serait toujours trop tard : elle ne dure que `blueShell.crashMs`.
//
// Sinon, s'il a le reflexe et que quelqu'un le suit d'assez pres, il CEDE LA
// TETE : il leve le pied juste assez tot pour se faire doubler avant le verrou,
// puis reste en retrait le temps de sortir du souffle — celui qui le double le
// prendra, et le dome s'etend loin derriere sa cible.
function updateBlue(cfg, rng, state, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts.blue;

    // ── Se proteger ──────────────────────────────────────────────────────
    // Une rouge qui le vise passe avant : l'objet part contre elle (cf.
    // `updateShield`), et une etoile qui part tot couvre aussi la bleue.
    const held = kart.heldItem;
    if (alert.blue && holdsCover(kart) && !alert.red) {
        if (alert.blueMode !== 'cover') {
            alert.blueMode = 'cover';
            alert.savedThrowTime = kart.throwTime;
        }
        if (alert.blueOnMe && !alert.blueFireAt) {
            if (held.type === 'star') {
                alert.blueFireAt = now + reaction(cfg, rng);
            } else if (alert.bluePhase === 'hover') {
                alert.blueFireAt = now + reaction(cfg, rng) + rng() * spec.hesitateMs;
            }
        }

        // Il le GARDE jusque-la, quel que soit le plan qu'il en avait.
        kart.throwTime = alert.blueFireAt || (now + cfg.vision.pressureMemoryMs);
        return;
    }
    if (alert.blueMode === 'cover') {
        // Plus rien a couvrir : la bleue a choisi quelqu'un d'autre, a explose,
        // ou l'objet vient de servir. Le plan d'origine reprend.
        alert.blueMode = '';
        if (held && alert.savedThrowTime > kart.throwTime) kart.throwTime = alert.savedThrowTime;
    }

    // ── Ceder la tete ────────────────────────────────────────────────────
    const give = Math.max(1, kart.absoluteVelocity * (1 - spec.brakeFactor));

    if (alert.blueMode === 'yield') {
        // Choisi malgre tout, ou plus rien a eviter : le frein ne sert plus.
        if (alert.blueOnMe || !blueAlive(state, alert.yieldBlueId) || now > alert.yieldUntil) {
            alert.blueMode = '';
        } else if (getRacingLeader(state) !== kart) {
            // Double : c'est l'autre qu'elle choisira. Reste a ne pas etre sous
            // le souffle quand il tombera sur lui.
            alert.blueMode = 'hang';
            alert.hangUntil = now + (spec.clearPx / give) * 1000;
        }
        return;
    }
    if (alert.blueMode === 'hang') {
        if (!blueAlive(state, alert.yieldBlueId) || now > alert.hangUntil) alert.blueMode = '';
        return;
    }

    // Une tentative par bleue : ratee, elle ne se rejoue pas en boucle jusqu'au
    // verrou.
    if (!alert.blue || alert.blueOnMe || !alert.blueYield || holdsCover(kart)) return;
    if (alert.yieldTriedId === alert.blueId) return;

    // Quelqu'un d'assez pres, VU, et qui ne recule pas — un kart qui freine
    // lui-meme ne prendra pas la tete.
    const sight = kart.sight;
    if (sight.rearKartDist < 0 || sight.rearKartDist > spec.yieldRange) return;
    if (sight.rearKartRel < -spec.closeTol) return;

    // Juste assez tot : le temps de se faire doubler a ce frein, plus une
    // marge. Plus tot, c'est du temps perdu pour rien ; l'echeance n'etant
    // qu'une impression, la marge couvre son erreur.
    //
    // Et pas trop tard : s'il n'a plus le temps de se faire doubler, il ne
    // tente rien. Un frein qui echoue ne lui coute pas que du temps — il ramene
    // celui qui le suit dans le souffle qui va tomber sur lui. Au banc, un
    // suiveur a 300 px y passait de 60 a 72 % de touches.
    const need = ((sight.rearKartDist + spec.passPx) / give) * 1000;
    if (alert.blueEta > need + spec.slackMs) return;
    if (alert.blueEta < need - spec.slackMs) return;

    alert.blueMode = 'yield';
    alert.yieldBlueId = alert.blueId;
    alert.yieldTriedId = alert.blueId;
    alert.yieldUntil = now + spec.maxYieldMs;
}

// Ce que le kart entend a ce pas. Appele avant l'attention : c'est elle qui s'en
// sert la premiere.
function hear(cfg, state, rng, now, kart) {
    const alert = kart.alert;
    const spec = cfg.vision.alerts;
    const plan = kart.plan;

    hearRed(cfg, rng, state, now, kart);
    hearBlue(cfg, rng, state, now, kart);
    ramNoise(cfg, state, kart);

    // LE SURSAUT, puis LE SUIVI DU REGARD.
    //
    // Le bruit relevait deja la chance de se retourner, mais sans rien dire du
    // MOMENT : le coup d'oeil tombait n'importe quand dans les trois ou quatre
    // secondes d'approche, et l'esquive ne se decide qu'en voyant la menace
    // entrer dans sa fenetre, reflexe compris. Regarder trop tot ne sert a rien
    // — la tete revient devant, et le coup d'oeil suivant tombe trop tard. Un
    // sursaut cale sur le DEBUT du bruit faisait exactement ca, et le banc l'a
    // dit : plus de touches contre l'etoile, pas moins.
    //
    // Ce qui compte est de regarder QUAND IL ARRIVE, et de ne plus lacher du
    // regard tant que l'esquive n'est pas decidee. Des qu'elle l'est, la tete
    // peut revenir devant : le plan survit a la perte de vue.
    const decided = plan.kind === 'spin' && plan.threatId === -1 - alert.ramId;
    alert.watch = spec.ram.enabled && alert.ramTtc <= spec.ram.leadMs && !decided;

    if (alert.ram) {
        if (now - alert.ramAt > spec.ram.quietMs) alert.ramStartled = false;
        alert.ramAt = now;
    }
    if (alert.watch && !alert.ramStartled) {
        alert.startle = true;
        alert.ramStartled = true;
    }
}

export {
    hear,
    updateBlue,
};
