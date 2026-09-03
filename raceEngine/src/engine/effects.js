// Ce qui ARRIVE a un kart : l'eclair, l'etoile, le Bill, l'ecrasement,
// le souffle de la carapace bleue. Toutes ces fonctions ecrivent dans l'etat
// d'un kart et n'en lisent presque rien : ce sont des consequences.

import { getShortestDistance } from './geometry.js';
import { isRamming } from './bodies.js';
import { getDistanceToLeader, getRacingLeader } from './standings.js';

// Un kart depossede de ce qu'il tenait. Une orbite compte autant d'elements
// DOM que d'orbes cote client : chacun a besoin de son evenement, sinon les
// survivants resteraient a tourner autour d'un kart qui n'a plus rien.
function loseHeldItem(kart, events) {
    const held = kart.heldItem;
    if (!held) return;

    if (held.holdPosition === 'orbit') {
        for (let i = 0; i < held.orbs.length; i++) {
            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.orbs[i].id });
        }
    } else {
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
    }

    kart.heldItem = null;
    kart.trailTime = 0;
}

// Combien de temps un kart reste rapetisse : maximum pour le premier, minimum
// pour qui est deja largue. C'est ce qui fait de l'eclair une arme de fond de
// grille.
//
// Deux lectures de la meme question, melangees par `rankWeight` : LA DISTANCE dit
// l'ecart reel mais met a egalite deux karts au coude a coude ; LE RANG est
// grossier mais tranche toujours.
//
// Les deux tombent d'accord aux extremes, donc `shrinkMsMax` et `shrinkMsMin`
// restent les bornes exactes quel que soit `rankWeight` — ce reglage ne change
// pas ce que l'eclair coute, seulement comment le cout se repartit au milieu.
function shrinkDuration(cfg, state, kart) {
    const spec = cfg.lightning;

    const dist = Math.min(getDistanceToLeader(state, kart), spec.shrinkFalloffDistance);
    const distRatio = spec.shrinkFalloffDistance > 0 ? dist / spec.shrinkFalloffDistance : 0;

    // Rapporte au nombre de places a prendre : le pas d'un rang vaut la
    // meme chose a huit qu'a quatre. Une course a un seul kart n'a pas de
    // rang qui veuille dire quoi que ce soit — elle retombe sur la distance.
    const places = state.rankedCount - 1;
    const rankRatio = places > 0 ? (kart.rank - 1) / places : 0;

    const w = spec.shrinkRankWeight;
    const mix = distRatio * (1 - w) + rankRatio * w;

    return spec.shrinkMsMax + (spec.shrinkMsMin - spec.shrinkMsMax) * mix;
}

// La foudre tombe sur toute la piste d'un coup : tete-a-queue, rapetissement,
// vitesse divisee et mains vides.
function strikeAll(cfg, state, now, events) {
    const storm = state.storm;

    for (let i = 0; i < state.karts.length; i++) {
        const kart = state.karts[i];
        if (kart.id === storm.shooterId) continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;
        if (kart.finished) continue;
        // Etoile et bill sont les seules protections, et elles sont totales.
        if (isRamming(kart)) continue;

        kart.shrinkEndTime = now + shrinkDuration(cfg, state, kart);
        // Pose des maintenant, et pas seulement a la prochaine passe de
        // vitesse : celle-ci ne tourne que pour les karts 'running', or ils
        // partent tous en tete-a-queue juste en dessous. Sans ca ils
        // tourneraient a taille normale avant de rapetisser d'un coup.
        kart.isShrunk = true;

        // Un champignon en cours ne survit pas a la foudre : le laisser
        // courir reviendrait a rendre l'eclair invisible sur ce kart-la.
        kart.boostEndTime = 0;

        // Avant le tete-a-queue : sinon spinOutKart reprogrammerait le tir
        // d'un objet que le kart n'a deja plus.
        loseHeldItem(kart, events);

        // Un kart deja en toupie n'en repart pas pour un tour : il encaisse
        // le rapetissement, pas un second malus par-dessus le premier.
        if (kart.state === 'running') spinOutKart(cfg, now, kart, events);

        events.push({ type: 'lightningHit', kartId: kart.id });
    }
}

// L'orage est dans l'etat, pas dans un evenement : un spectateur qui arrive
// le ciel deja noir doit le voir noir, et le voir se lever au bon moment.
function updateStorm(cfg, state, now, events) {
    const storm = state.storm;
    if (!storm) return;

    if (!storm.struck && now >= storm.strikeAt) {
        storm.struck = true;
        strikeAll(cfg, state, now, events);
    }

    if (now >= storm.until) state.storm = null;
}

// Le vol du bill. Deux choses par frame : compter ce qui vient d'etre double,
// et rendre la main quand la duree est epuisee.
function updateBill(cfg, state, now, kart, events) {
    if (!kart.isBill) return;
    const spec = cfg.bill;

    // Parcours a l'envers : on retire de la liste pendant qu'on la lit.
    for (let i = kart.billAhead.length - 1; i >= 0; i--) {
        const other = state.kartsById[kart.billAhead[i]];
        if (!other || kart.totalDistance > other.totalDistance) {
            kart.billAhead.splice(i, 1);
            // Plancher compte depuis le depart et non depuis maintenant : dix
            // depassements d'affilee ne peuvent pas couper le vol net.
            kart.billEndTime = Math.max(
                kart.billStartedAt + spec.minDurationMs,
                kart.billEndTime - spec.overtakeCostMs
            );
        }
    }

    if (now >= kart.billEndTime) {
        kart.isBill = false;
        kart.billAhead.length = 0;
        // Il a repris sa forme, il finit sur son elan.
        kart.billSlowUntil = now + spec.slowdownMs;
        events.push({ type: 'billOff', kartId: kart.id });
    }
}

// L'ecrasement : le petit est aplati, et c'est tout — aucune impulsion, aucune
// separation, aucun tete-a-queue.
//
// La duree PREVUE est `lightning.flatMs`, ecretee a la fin du rapetissement : on
// n'ecrase que ce qui est petit. Ce qui manquait est le PLANCHER — ecrase a deux
// dixiemes de la fin, le kart etait aplati deux dixiemes, c'est-a-dire pas du
// tout.
//
// Il reste donc ecrase `crushHoldMs` au minimum, et le rapetissement suit : on ne
// peut pas etre plat et de taille normale. Un kart qui allait regrossir attend,
// puis retrouve sa taille pleine d'un coup.
//
// Le calcul est refait tant que le contact dure, mais l'evenement ne part qu'a la
// premiere fois.
function crushKart(cfg, now, kart, events) {
    const spec = cfg.lightning;
    const wasFlat = now < kart.flatEndTime;

    const planned = Math.min(now + spec.flatMs, kart.shrinkEndTime);
    const floor = now + spec.crushHoldMs;

    kart.flatEndTime = (planned > floor) ? planned : floor;

    // Il ne regrossit pas pendant qu'il est plat. C'est la seule chose que
    // l'ecrasement impose desormais au rapetissement, et il ne l'impose
    // jamais dans l'autre sens : une date deja plus lointaine ne bouge pas.
    if (kart.shrinkEndTime < kart.flatEndTime) {
        kart.shrinkEndTime = kart.flatEndTime;
    }

    if (!wasFlat) events.push({ type: 'kartCrushed', kartId: kart.id });
}

// Duree d'un tete-a-queue. La MEME pour tout le monde, et c'est un choix : une
// toupie n'est plus du pilotage, rien la-dedans ne peut tourner mieux ou moins
// bien. Ce qu'un personnage a de propre se joue a la relance.
//
// L'indexer sur la masse a ete essaye et retire : `mass` ne depend que du poids,
// ce qui elargissait la fenetre du poids en croyant ouvrir celle du handling.
function spinDuration(cfg) {
    return cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
}

// Le tete-a-queue lui-meme, sans aucune condition : c'est a l'appelant de
// decider qui l'encaisse. Chaque source a ses propres immunites.
function spinOutKart(cfg, now, kart, events) {
    kart.state = 'hit';
    kart.hitEndTime = now + spinDuration(cfg);
    events.push({ type: 'kartHit', kartId: kart.id });
    if (kart.heldItem) kart.throwTime = kart.hitEndTime + cfg.delays.throwDelayAfterHit;
}

// Etoile et champignon sont les deux seules sorties.
function blastKart(cfg, state, now, kart, events) {
    if (kart.state !== 'running') return;
    if (isRamming(kart)) return;
    if (kart.boostEndTime > now) return;

    spinOutKart(cfg, now, kart, events);
}

// Un kart n'est touche que lorsque le front l'atteint, et une seule fois :
// l'etat 'hit' dure plus longtemps que le souffle.
function updateBlueBlast(cfg, state, now, item, events) {
    const spec = cfg.blueShell;
    const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.blastMs);
    // Le kart n'est pas un point : le front l'emporte des qu'il atteint sa
    // carrosserie, pas son centre. Sans ca un voisin colle a la cible voyait
    // le souffle s'arreter a une demi-longueur de kart de lui, et le
    // deplacement pendant les 300 ms du dome suffisait a l'en sortir.
    const body = cfg.hitboxes.itemVsKart;
    const reachX = spec.blastRadiusX * progress + body.x;
    const reachY = spec.blastRadiusY * progress + body.y;

    for (let k = 0; k < state.karts.length; k++) {
        const kart = state.karts[k];
        const dx = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
        const dy = Math.abs(kart.yPercent - item.y);
        if (dx > reachX || dy > reachY) continue;

        blastKart(cfg, state, now, kart, events);
    }

    if (progress >= 1) item.isDead = true;
}

// Le souffle est une entite a part entiere, pas un evenement : un spectateur
// qui arrive pendant l'explosion doit la voir.
function spawnBlueBlast(cfg, state, now, source, events) {
    const spec = cfg.blueShell;

    // La cible est touchee a l'instant meme de l'impact : le dome s'etend a
    // 200 unites par seconde quand elle en parcourt 500, il ne la
    // rattraperait jamais. Le front ne sert qu'a emporter les voisins.
    const target = source.targetKartId === null ? null : state.kartsById[source.targetKartId];
    if (target) blastKart(cfg, state, now, target, events);

    state.items.push({
        id: state.nextItemId++,
        type: 'blueBlast',
        worldX: source.worldX,
        y: source.y,
        vx: 0,
        vy: 0,
        shooterId: source.shooterId,
        targetKartId: null,
        createdAt: now,
        currentFrame: 1,
        lastAnimTime: 0,
        isDead: false,
        flightUntil: 0,
        flightFrom: 0,
        flightTo: 0,
        hop: 0,
        armed: true,
        spent: false,
        deadAt: 0,
        phase: 'blast',
        phaseUntil: now + spec.blastMs
    });
}

// Elle part tout droit, sans cible, et ne se verrouille qu'a l'approche du
// premier. Le verrou ne bouge plus ensuite.
function updateBlueShell(cfg, state, now, item, deltaTime, events) {
    const spec = cfg.blueShell;
    const target = item.targetKartId === null ? null : state.kartsById[item.targetKartId];

    if (item.phase === 'cruise') {
        item.worldX += spec.speed * deltaTime;
        item.hop = spec.cruiseHop;

        if (!target) {
            const leader = getRacingLeader(state);
            const expired = now - item.createdAt > spec.maxCruiseMs;

            if (!leader) {
                if (expired) {
                    spawnBlueBlast(cfg, state, now, item, events);
                    item.isDead = true;
                    return;
                }
            } else {
                const gap = getShortestDistance(cfg, leader.worldX, item.worldX);
                if ((gap > 0 && gap < spec.lockDistance) || expired) {
                    item.targetKartId = leader.id;
                }
            }
        } else {
            const gap = getShortestDistance(cfg, target.worldX, item.worldX);
            if (gap < spec.catchDistance && gap > -spec.catchDistance) {
                item.phase = 'orbit';
                item.phaseUntil = now + spec.orbitMs;
            }
        }

        if (item.worldX < 0) item.worldX += cfg.world.width;
        if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
        return;
    }

    // Une fois accrochee, elle suit son kart. S'il disparait de la course,
    // elle explose sur sa derniere position connue.
    if (!target || (target.state !== 'running' && target.state !== 'hit')) {
        spawnBlueBlast(cfg, state, now, item, events);
        item.isDead = true;
        return;
    }

    if (item.phase === 'orbit') {
        const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.orbitMs);
        const angle = progress * spec.orbitTurns * 2 * Math.PI;

        item.worldX = target.worldX + Math.cos(angle) * spec.orbitRadiusX;
        item.y = target.yPercent + Math.sin(angle) * spec.orbitRadiusY;
        item.hop = spec.orbitHop;

        if (progress >= 1) {
            item.phase = 'hover';
            item.phaseUntil = now + spec.hoverMs;
        }
    } else if (item.phase === 'hover') {
        item.worldX = target.worldX + spec.hoverLead;
        item.y = target.yPercent;
        item.hop = spec.orbitHop;

        if (now >= item.phaseUntil) {
            item.phase = 'crash';
            item.phaseUntil = now + spec.crashMs;
        }
    } else if (item.phase === 'crash') {
        const progress = Math.min(1, 1 - (item.phaseUntil - now) / spec.crashMs);
        // Elle continue d'avancer pendant qu'elle tombe, depuis la position
        // de surplomb.
        item.worldX = target.worldX + spec.hoverLead + (spec.crashLead - spec.hoverLead) * progress;
        item.y = target.yPercent;
        // Chute acceleree : elle decroche a peine, puis s'abat.
        item.hop = spec.orbitHop * (1 - progress * progress);

        if (progress >= 1) {
            spawnBlueBlast(cfg, state, now, item, events);
            item.isDead = true;
            return;
        }
    }

    if (item.worldX < 0) item.worldX += cfg.world.width;
    if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
}

export {
    crushKart,
    spinDuration,
    spinOutKart,
    updateBill,
    updateBlueBlast,
    updateBlueShell,
    updateStorm,
};
