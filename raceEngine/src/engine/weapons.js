// L'USAGE d'un objet : le prendre, le viser, le lancer, le trainer.
// Le tirage est dans `items.js`. Ici commence tout ce qui part vers un autre
// kart, y compris la decision de tirer et le choix de la cible.

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { isRamming, shrunkReachX, shrunkReachY } from './bodies.js';
import { getBillSpeed } from './stats.js';
import { getDistanceToLeader } from './standings.js';
import { getOrbitSpec, rollItem } from './items.js';
import { spinDuration } from './effects.js';

// Tout objet simple arrive en main, y compris ceux qui peuvent ensuite etre
// traines : en main, il n'a pas de hitbox — il ne protege de rien et ne blesse
// personne.
function getHoldPosition(cfg, itemType) {
    if (getOrbitSpec(cfg, itemType)) return 'orbit';
    return 'hands';
}

function isTrailable(cfg, itemType) {
    return (cfg.trailableItems || []).indexOf(itemType) !== -1;
}

// Le type qui MENACE, pour un objet tenu, et ce n'est pas toujours celui qu'on
// lit. Un triple annonce le type de son GROUPE : lu tel quel, aucun predicat de
// danger latent ne le reconnait, et l'orbite y retombait des deux cotes. Sans
// effet tant que les triples sont desactives — et c'est bien le probleme.
function heldThreatType(held) {
    if (!held) return '';
    return held.childType || held.type;
}

// Une banane simplement lachee derriere soi ne se vise pas.
function isAiming(cfg, kart) {
    const held = kart.heldItem;
    if (!held || held.holdPosition === 'orbit') return false;
    if (held.type === 'greenShell' || held.type === 'redShell') return true;
    return held.type === 'banana' && kart.lobbing;
}

// De quoi atteindre celui qu'on PRECEDE : ce qui peut partir vers l'avant. Ce
// n'est pas la question de `isAiming`, qui dit si un kart execute une visee — les
// deux se sont longtemps confondues, et l'orbite tombait dans l'ecart. Une banane
// ne compte pas, sauf lancee en cloche, ce qui est alors une visee.
function isArmedForward(cfg, kart) {
    const type = heldThreatType(kart.heldItem);
    if (!type) return false;
    if (type === 'greenShell' || type === 'redShell') return true;
    return type === 'banana' && kart.lobbing;
}

// Agressivite du kart, de 0 a 1. Le rang et l'ecart au premier se multiplient :
// etre dernier au milieu du peloton, ou deuxieme a une demi-piste, ne suffit pas.
// La racine remonte le resultat, sans quoi deux moities donneraient un quart.
//
// L'etape de course pondere le tout, et vaut 1 a l'arrivee : un dernier a quatre
// tours de la fin a le temps de voir venir.
function getAggression(cfg, state, kart) {
    const spec = cfg.ai.aggression;
    const total = state.karts.length;

    const rankTerm = (total > 1) ? (kart.rank - 1) / (total - 1) : 0;

    const dist = getDistanceToLeader(state, kart);
    const distTerm = (spec.distanceRef > 0)
        ? Math.min(Math.max(dist, 0), spec.distanceRef) / spec.distanceRef
        : 0;

    // Lue sur le premier : c'est lui qui decide du temps qu'il reste aux autres.
    const pace = state.cachedLeader || kart;
    const progress = (pace.finishDistance > 0)
        ? Math.min(Math.max(pace.totalDistance / pace.finishDistance, 0), 1)
        : 0;
    const raceTerm = spec.startRatio + (1 - spec.startRatio) * progress;

    return Math.sqrt(rankTerm * distTerm) * raceTerm;
}

// Ce par quoi multiplier une attente : 1 pour qui mene, hurryRatio pour qui
// n'a plus rien a perdre.
function hurryFactor(cfg, aggression) {
    return 1 - aggression * (1 - cfg.ai.aggression.hurryRatio);
}

// Decide de la vie de l'objet : sorti derriere le kart, ou garde en main jusqu'au
// tir. Le sens du tir est arrete des la reception.
function planItemUse(cfg, rng, state, now, kart, itemType) {
    const ai = cfg.ai;

    kart.shotDirection = 1;
    kart.lobbing = false;

    if (itemType === 'greenShell' || itemType === 'redShell') {
        kart.shotDirection = rollShellDirection(cfg, rng, state, kart, itemType);
    } else if (itemType === 'banana') {
        kart.lobbing = rng() < rankChance(ai.bananaLobChance, state, kart);
        kart.shotDirection = kart.lobbing ? 1 : -1;
    }

    // Le premier defend : rien ne part devant lui, la banane est posee et non
    // lobee. La place au moment du plan est retenue — doubl e avant de lancer, ce
    // plan ne vaudra plus rien (cf. `getShotDirection`).
    kart.shotAsLeader = (kart.rank === 1);
    if (kart.shotAsLeader) {
        kart.lobbing = false;
        kart.shotDirection = -1;
    }

    kart.aimError = randomRange(rng, -ai.aimErrorMax, ai.aimErrorMax);

    const aggression = getAggression(cfg, state, kart);
    const hurry = hurryFactor(cfg, aggression);
    const trailChance = rankChance(ai.trailChance, state, kart)
        * (1 - aggression * (1 - ai.aggression.trailRatio));

    if (isTrailable(cfg, itemType) && rng() < trailChance) {
        const holdFactor = rankChance(ai.trailHoldFactor, state, kart);
        kart.trailTime = now + randomRange(rng, ai.trailDelayMin, ai.trailDelayMax) * hurry;
        kart.throwTime = kart.trailTime
            + randomRange(rng, ai.trailHoldMin, ai.trailHoldMax) * hurry * holdFactor;
        return;
    }

    kart.trailTime = 0;
    kart.throwTime = now + randomRange(rng, ai.holdItemMin, ai.holdItemMax) * hurry;
}

// Orbite elliptique autour du kart, en coordonnees monde donc identique sur tous
// les appareils. Qu'une banane passe devant ou derriere ne regarde que le rendu,
// qui joue la-dessus sur le z-index : ici la position rendue est la position
// reelle.
function getOrbitItemPosition(cfg, kart, orb, orbitAngle) {
    const orbit = cfg.orbit;
    const angle = orbitAngle + orb.phase;

    let worldX = kart.worldX + Math.cos(angle) * orbit.radiusX;
    if (worldX < 0) worldX += cfg.world.width;
    if (worldX >= cfg.world.width) worldX -= cfg.world.width;

    return { worldX: worldX, y: kart.yPercent + Math.sin(angle) * orbit.radiusY };
}

// Retire un objet sans toucher aux phases des autres : leur position angulaire ne
// depend que de `orbitAngle` et de leur propre phase, figee a l'attribution.
//
// N'emet volontairement aucun evenement : un objet detruit doit voir son element
// DOM supprime, un objet largue doit le garder pour que l'item lance le
// reutilise.
function removeOrbitItem(kart, index) {
    const held = kart.heldItem;
    const orb = held.orbs[index];
    held.orbs.splice(index, 1);
    if (held.orbs.length === 0) kart.heldItem = null;
    return orb;
}

function destroyOrbitItem(kart, index, events) {
    const kartId = kart.id;
    const orb = removeOrbitItem(kart, index);
    events.push({ type: 'removeHeldItem', kartId: kartId, itemId: orb.id });
    return orb;
}

function giveKartItem(cfg, state, rng, now, kart, events) {
    if (kart.heldItem) return;

    const itemType = rollItem(cfg, state, rng, now, kart);
    if (!itemType) return;

    kart.lastItem = itemType;

    const holdPosition = getHoldPosition(cfg, itemType);
    const spec = getOrbitSpec(cfg, itemType);

    if (spec) {
        const orbit = cfg.orbit;
        const orbs = [];
        for (let i = 0; i < orbit.count; i++) {
            // Phase figee une fois pour toutes : c'est ce qui garantit que la
            // rotation des survivants ne bouge pas quand l'un disparait.
            orbs.push({ id: state.nextItemId++, phase: (i * 2 * Math.PI) / orbit.count });
        }

        // id de groupe distinct des orbes : aucun element DOM ne lui
        // correspond, donc les acces generiques a itemEls[heldItem.id] cote
        // rendu restent des no-op et l'orbite passe par son propre bloc.
        kart.heldItem = {
            id: state.nextItemId++,
            type: itemType,
            childType: spec.child,
            holdPosition: holdPosition,
            orbitAngle: 0,
            orbs: orbs
        };

        for (let i = 0; i < orbs.length; i++) {
            events.push({
                type: 'spawnHeldItem',
                kartId: kart.id,
                itemId: orbs[i].id,
                itemType: spec.child,
                holdPosition: holdPosition
            });
        }

        kart.throwTime = now + randomRange(rng, cfg.ai.holdItemMin, cfg.ai.holdItemMax)
            * hurryFactor(cfg, getAggression(cfg, state, kart));
        return;
    }

    const itemId = state.nextItemId++;
    // Pas d'offset visuel ici : le client le derive de holdPosition au rendu.
    kart.heldItem = {
        id: itemId,
        type: itemType,
        holdPosition: holdPosition
    };

    planItemUse(cfg, rng, state, now, kart, itemType);

    events.push({ type: 'spawnHeldItem', kartId: kart.id, itemId: itemId, itemType: itemType, holdPosition: holdPosition });
}

function rankChance(table, state, kart) {
    if (kart.rank === 1) return table.leader;
    if (kart.rank >= state.karts.length) return table.last;
    return table.pack;
}

// Note d'un candidat pour la rouge, en distance equivalente : la plus basse
// gagne. Au-dela de `redShellComfortTarget` un kart vaut son ecart brut ; en
// dessous il reste eligible mais recule d'autant plus qu'il est colle au tireur.
//
// C'est une pente et non un seuil : avec un simple plancher, un kart a un pixel
// sous la barre etait ecarte comme un kart au pare-chocs, et la rouge allait
// viser derriere lui. Le plancher qui subsiste est celui que la physique impose —
// l'objet ne s'arme qu'a `itemArmDistance`, et traverse tout sans effet avant.
//
// Rend Infinity pour un candidat inatteignable, les karts derriere le tireur
// compris.
function redShellTargetScore(cfg, dist) {
    const floor = cfg.speeds.redShellMinTarget;
    if (dist < floor) return Infinity;

    const comfort = cfg.speeds.redShellComfortTarget;
    if (dist >= comfort) return dist;

    // Au carre : la penalite reste negligeable au bord du confort et ne mord que
    // sur les cibles au contact. Lineaire, elle ferait l'inverse en decalant tout
    // le monde.
    const shortfall = (comfort - dist) / (comfort - floor);
    return dist + cfg.speeds.redShellClosePenalty * shortfall * shortfall;
}

// Le meilleur candidat devant. Null seulement si tout le monde est sous le
// plancher d'armement : la rouge part alors sans cible.
function findRedShellTarget(cfg, state, kart) {
    let best = null;
    let bestScore = Infinity;

    for (let i = 0; i < state.karts.length; i++) {
        const other = state.karts[i];
        if (other.id === kart.id) continue;
        if (other.state !== 'running' && other.state !== 'hit') continue;

        const dist = getShortestDistance(cfg, other.worldX, kart.worldX);
        const score = redShellTargetScore(cfg, dist);
        if (score < bestScore) {
            bestScore = score;
            best = other;
        }
    }

    return best;
}

// Sens de tir effectif : le plan arrete a la reception, corrige des deux
// changements de place qui l'invalident. Le premier ne lance jamais devant lui ;
// un kart qui tenait la tete et s'est fait doubler n'a plus de raison de tirer
// derriere. Les deux regles sont ici et non dans le tirage, pour suivre la place
// reelle au moment du lancer.
function getShotDirection(state, kart) {
    if (kart.rank === 1) return -1;
    if (kart.shotAsLeader) return 1;
    return kart.shotDirection;
}

function rollShellDirection(cfg, rng, state, kart, itemType) {
    const chances = cfg.ai.shellBackwardChance[itemType];
    if (!chances) return 1;

    return rng() < rankChance(chances, state, kart) ? -1 : 1;
}

// Met un objet en jeu depuis un kart : trajectoire et cible dependent du type,
// pas de la facon dont il etait porte. Partagee par l'activation et par le
// largage d'orbite, pour qu'une carapace tiree d'un triple se comporte comme une
// simple.
function spawnLaunchedItem(cfg, state, rng, now, kart, itemType, itemId, startX, startY, events, direction) {
    const dir = direction === -1 ? -1 : 1;
    let vx = 0;
    let vy = 0;
    let targetKartId = null;

    if (itemType === 'greenShell') {
        vx = cfg.speeds.projectileSpeed * dir;
        vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
    } else if (itemType === 'redShell') {
        vx = cfg.speeds.redShellSpeed * dir;
        // Tete chercheuse vers l'avant seulement : tiree en arriere, elle part
        // tout droit. Sans cible au depart, la boucle de suivi ne s'y interesse
        // jamais.
        const target = dir > 0 ? findRedShellTarget(cfg, state, kart) : null;
        if (target) {
            targetKartId = target.id;
        } else {
            vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
        }
    }

    let worldX = startX;
    if (worldX < 0) worldX += cfg.world.width;
    if (worldX >= cfg.world.width) worldX -= cfg.world.width;

    state.items.push({
        id: itemId,
        type: itemType,
        worldX: worldX,
        y: startY,
        vx: vx,
        vy: vy,
        shooterId: kart.id,
        targetKartId: targetKartId,
        createdAt: now,
        currentFrame: 1,
        lastAnimTime: 0,
        isDead: false,

        // Profondeur au pas precedent : les impacts se testent sur le
        // segment parcouru, pas sur la seule position d'arrivee.
        prevY: startY,
        // Rebonds encaisses, bords et tuyaux confondus. Au-dela de
        // `pipe.maxShellBounces` la carapace se detruit — c'est sa seule duree de
        // vie.
        bounces: 0,
        // Passe a true au premier tuyau touche. Une verte epargne son
        // lanceur, mais plus une fois qu'un pipe la lui a renvoyee.
        pipeBounced: false,

        // Vol en cloche. `hop` est la hauteur de l'arc en px de rendu ; `rising`
        // couvre la montee, pendant laquelle l'objet survole tout le monde et n'a
        // pas de hitbox.
        flightUntil: 0,
        flightFrom: 0,
        flightTo: 0,
        hop: 0,
        rising: false,

        // Un objet ne peut toucher son lanceur qu'une fois eloigne de lui.
        armed: false,
        spent: false,
        deadAt: 0
    });

    events.push({ type: 'launchItem', kartId: kart.id, itemId: itemId });
}

function activateItem(cfg, state, rng, now, kart, events) {
    const held = kart.heldItem;
    if (!held) return;

    // Un seul objet quitte l'orbite par activation : le kart garde son
    // bouclier reduit et rearme un largage tant qu'il lui en reste.
    if (held.holdPosition === 'orbit') {
        const orb = held.orbs[0];
        const child = held.childType;
        const pos = getOrbitItemPosition(cfg, kart, orb, held.orbitAngle);
        removeOrbitItem(kart, 0);

        let startX, startY;
        let dir = 1;
        if (child === 'banana') {
            // Un piege est simplement lache : on part de la position d'orbite
            // courante, sans saut visuel. Le rayon vertical deborde la route
            // quand le kart longe un bord, et la boucle items ne reclampe jamais
            // les bananes : on le fait ici.
            startX = pos.worldX;
            startY = Math.min(Math.max(pos.y, cfg.road.minY), cfg.road.maxY);
        } else {
            // Une carapace est tiree vers l'avant, comme depuis la main : la
            // faire partir de l'arriere de l'orbite la ferait traverser son
            // propre kart.
            dir = getShotDirection(state, kart);
            startX = kart.worldX + (dir > 0 ? cfg.offsets.world.shellSpawn
                                            : cfg.offsets.world.heldItemBehind);
            startY = kart.yPercent;
        }

        // L'objet reprend son id : son element DOM est reutilise tel quel par
        // le rendu des items en jeu.
        spawnLaunchedItem(cfg, state, rng, now, kart, child, orb.id, startX, startY, events, dir);

        if (kart.heldItem) {
            kart.throwTime = now + randomRange(rng, cfg.orbit.dropIntervalMin, cfg.orbit.dropIntervalMax)
                * hurryFactor(cfg, getAggression(cfg, state, kart));
        }
        return;
    }

    // L'eclair ne part pas vers quelqu'un : il declenche un orage, et c'est
    // l'orage qui frappe. Ciel noir, eclairs et malus tombent ensemble a
    // `strikeAt`.
    if (held.type === 'lightning') {
        const spec = cfg.lightning;

        state.storm = {
            shooterId: kart.id,
            startedAt: now,
            strikeAt: now + spec.strikeAt,
            until: now + spec.totalMs,
            struck: false
        };

        events.push({ type: 'lightningCast', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    // Le bill ne se lance pas : le kart devient le projectile. Meme famille que
    // l'etoile — un etat du kart, avec sa date de fin.
    if (held.type === 'bill') {
        const spec = cfg.bill;

        kart.isBill = true;
        kart.billStartedAt = now;
        kart.billEndTime = now + spec.durationMs;
        kart.billSlowUntil = 0;
        // Meme regle que l'etoile : on ne peut pas etre intouchable et
        // ecrase en meme temps. Le bill l'obtenait avant en primant sur le
        // rapetissement dans le calcul de vitesse ; il l'efface maintenant,
        // ce qui rend aussi sa taille au sprite au lieu de le laisser voler
        // en miniature.
        kart.shrinkEndTime = 0;
        // Ceux qui sont devant a l'instant du declenchement. Chacun rattrape
        // se retire de la liste et raccourcit le vol : la liste est donc a la
        // fois le compteur et la memoire de qui reste a doubler.
        kart.billAhead = [];
        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id !== kart.id && other.totalDistance > kart.totalDistance) {
                kart.billAhead.push(other.id);
            }
        }

        // La transformation efface le rapetissement, comme l'etoile : on ne
        // part pas en trombe en etant ecrase.
        kart.shrinkEndTime = 0;
        kart.absoluteVelocity = getBillSpeed(cfg, state, kart);

        events.push({ type: 'billOn', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    if (held.type === 'shroom') {
        // Rien n'est pose sur la vitesse : elle part d'ou le kart en est et
        // monte. La poser a `topSpeed` ici escamotait toute la premiere
        // moitie de la montee, et un champignon pris a l'arret rendait
        // autant qu'un champignon pris a pleine allure.
        kart.boostEndTime = now + cfg.speeds.boosts.shroom.durationMs;
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    if (held.type === 'star') {
        kart.starEndTime = now + cfg.speeds.boosts.star.durationMs;
        kart.isInvincible = true;
        // On ne peut pas etre invincible et ecrase en meme temps : l'etoile
        // rend sa taille au kart, comme elle le protege de la foudre a venir.
        kart.shrinkEndTime = 0;
        events.push({ type: 'starOn', kartId: kart.id });
        events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    // Une banane est lachee derriere le kart, qu'elle ait ete trainee ou
    // tenue en main : sinon elle apparaitrait sous lui.
    // La bleue part droit devant, au-dessus de la piste, vers le premier.
    if (held.type === 'blueShell') {
        const spec = cfg.blueShell;

        state.items.push({
            id: held.id,
            type: 'blueShell',
            worldX: kart.worldX,
            y: (cfg.road.minY + cfg.road.maxY) / 2,
            vx: spec.speed,
            vy: 0,
            shooterId: kart.id,
            targetKartId: null,
            createdAt: now,
            currentFrame: 1,
            lastAnimTime: 0,
            isDead: false,
            flightUntil: 0,
            flightFrom: 0,
            flightTo: 0,
            hop: spec.cruiseHop,
            armed: true,
            phase: 'cruise',
            phaseUntil: 0
        });

        events.push({ type: 'launchItem', kartId: kart.id, itemId: held.id });
        kart.heldItem = null;
        kart.trailTime = 0;
        return;
    }

    let direction = 1;
    let startX = kart.worldX + cfg.offsets.world.heldItemBehind;

    let lobbed = false;

    if (held.type === 'greenShell' || held.type === 'redShell') {
        direction = getShotDirection(state, kart);
        startX = kart.worldX + (direction > 0 ? cfg.offsets.world.shellSpawn
                                              : cfg.offsets.world.heldItemBehind);
    } else if (held.type === 'banana' && kart.lobbing && kart.rank !== 1) {
        lobbed = true;
        startX = kart.worldX + cfg.offsets.world.shellSpawn;
    }

    spawnLaunchedItem(cfg, state, rng, now, kart, held.type, held.id, startX, kart.yPercent, events, direction);

    if (lobbed) {
        const item = state.items[state.items.length - 1];
        item.flightFrom = item.worldX;
        item.flightTo = item.worldX + cfg.speeds.bananaLobDistance;
        item.flightUntil = now + cfg.speeds.bananaLobDurationMs;
        // Sans hitbox tant qu'elle monte : elle part de la main du lanceur et
        // passe au-dessus de ce qui le precede immediatement.
        item.rising = true;
        // Renseignee pour l'IA seulement : le deplacement vient du vol.
        item.vx = cfg.speeds.bananaLobDistance / (cfg.speeds.bananaLobDurationMs / 1000);
    }
    kart.heldItem = null;
    kart.trailTime = 0;
}

// Passe dediee, executee pour tous les karts y compris ceux en 'hit' : le
// bouclier continue de tourner pendant un tete-a-queue. Seules les
// collisions sont suspendues tant que le porteur n'est pas 'running', pour
// rester aligne sur le traitement de l'objet traine derriere.
function updateOrbitItems(cfg, state, now, deltaTime, events) {
    const TWO_PI = Math.PI * 2;
    const kartsLen = state.karts.length;

    for (let i = 0; i < kartsLen; i++) {
        const kart = state.karts[i];
        const held = kart.heldItem;
        if (!held || held.holdPosition !== 'orbit') continue;
        if (kart.state !== 'running' && kart.state !== 'hit') continue;

        held.orbitAngle += cfg.orbit.orbitSpeed * deltaTime;
        if (held.orbitAngle >= TWO_PI) held.orbitAngle -= TWO_PI;

        if (kart.state !== 'running') continue;

        // Les trois orbes sont testes sur toute l'orbite, y compris la
        // moitie qui passe derriere le sprite du kart : un objet occulte
        // est un objet cache, pas un objet absent. Ne pas filtrer sur la
        // profondeur ici, ce serait rendre le bouclier troue a l'arriere.
        //
        // Parcours a rebours : removeOrbitItem() fait un splice, et un orbe
        // consomme ne doit pas decaler ceux pas encore testes.
        for (let b = held.orbs.length - 1; b >= 0; b--) {
            const orb = held.orbs[b];
            const pos = getOrbitItemPosition(cfg, kart, orb, held.orbitAngle);
            let consumed = false;

            for (let j = 0; j < kartsLen; j++) {
                const victim = state.karts[j];
                if (victim.id === kart.id || victim.state !== 'running') continue;
                if (victim.hitInvincibleUntil > now) continue;

                const dx = Math.abs(getShortestDistance(cfg, pos.worldX, victim.worldX));
                const dy = Math.abs(pos.y - victim.yPercent);
                const orbit = cfg.hitboxes.orbitItemVsKart;
                if (dx >= shrunkReachX(cfg, orbit, victim, now)
                    || dy >= shrunkReachY(cfg, orbit, victim, now)) continue;

                // Une etoile ou un bill encaisse l'objet sans etre ralenti,
                // mais le consomme quand meme : le bouclier s'use au contact.
                if (!isRamming(victim)) {
                    victim.state = 'hit';
                    victim.hitEndTime = now + spinDuration(cfg);
                    events.push({ type: 'kartHit', kartId: victim.id });
                    if (victim.heldItem) victim.throwTime = victim.hitEndTime + cfg.delays.throwDelayAfterHit;
                }
                consumed = true;
                break;
            }

            if (consumed) {
                destroyOrbitItem(kart, b, events);
                if (!kart.heldItem) break;
            }
        }
    }
}

// Profondeur visee par un bill : le milieu de la piste, ou le premier
// degagement si un tuyau s'y trouve.
//
// Il ne regarde que le tuyau qui bouche vraiment sa voie, et choisit le cote
// le plus proche de lui : un bill ne manoeuvre pas, il devie.
function billAimDepth(cfg, state, kart) {
    const mid = (cfg.road.minY + cfg.road.maxY) / 2;
    const pipes = state.pipes;
    if (!pipes.length) return mid;

    const clear = cfg.hitboxes.kartVsPipe.y + cfg.bill.pipeClearance;

    let blocking = null;
    let bestDist = Infinity;

    for (let p = 0; p < pipes.length; p++) {
        const pipe = pipes[p];
        const dist = getShortestDistance(cfg, pipe.worldX, kart.worldX);
        if (dist <= 0 || dist > cfg.pipe.seeDistance) continue;
        if (Math.abs(pipe.y - mid) >= clear) continue;
        if (dist < bestDist) {
            bestDist = dist;
            blocking = pipe;
        }
    }

    if (!blocking) return mid;

    const above = blocking.y + clear;
    const below = blocking.y - clear;
    const canAbove = above <= cfg.road.maxY;
    const canBelow = below >= cfg.road.minY;

    if (canAbove && canBelow) {
        return Math.abs(above - kart.yPercent) <= Math.abs(below - kart.yPercent) ? above : below;
    }
    if (canAbove) return above;
    if (canBelow) return below;

    // Aucun cote ne tient. Le chargement des circuits l'interdit, mais si
    // cela arrivait le bill traverserait plutot que de se figer devant.
    return mid;
}

export {
    activateItem,
    billAimDepth,
    destroyOrbitItem,
    getHoldPosition,
    getOrbitItemPosition,
    getShotDirection,
    giveKartItem,
    heldThreatType,
    isAiming,
    isArmedForward,
    isTrailable,
    rankChance,
    redShellTargetScore,
    removeOrbitItem,
    spawnLaunchedItem,
    updateOrbitItems,
};
