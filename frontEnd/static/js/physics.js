(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BannerPhysics = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function shuffleArray(array, rng) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = (rng() * (i + 1)) | 0;
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    function randomRange(rng, min, max) {
        return rng() * (max - min) + min;
    }

    function getNewMomentumTarget(rng, stats) {
        const weightFactor = Math.min(stats.weight / 1.4, 1.0);
        const minMomentum = 0.55 - weightFactor * 0.15;
        return randomRange(rng, minMomentum, 1.0);
    }

    function getMomentumSpeed(cfg, stats, momentum) {
        const minRatio = cfg.speeds.momentumMinRatio;
        return stats.topSpeed * (minRatio + (1.0 - minRatio) * momentum);
    }

    function getInitialKartSpeed(rng, stats) {
        const variation = randomRange(rng, 0.85, 0.95);
        return stats.topSpeed * variation;
    }

    function getShortestDistance(cfg, fromX, toX) {
        const w = cfg.world.width;
        let diff = fromX - toX;
        if (diff < -w * 0.5) diff += w;
        if (diff > w * 0.5) diff -= w;
        return diff;
    }

    function updateAI(cfg, state, rng, now, kart, deltaTime) {
        if (kart.state !== 'running') return;

        let dangerFound = false;
        let avoidDirection = 0;

        const handling = kart.stats.handling;
        const itemsLen = state.items.length;
        for (let i = 0; i < itemsLen; i++) {
            const item = state.items[i];
            if (item.isDead) continue;

            const isBanana = (item.type === 'banana');
            const isShell = (item.type === 'greenShell' || item.type === 'redShell');
            if (!isBanana && !isShell) continue;

            let dist = getShortestDistance(cfg, item.worldX, kart.worldX);
            const detectionRange = cfg.ai.detectionRange * (isShell ? 1.5 : 1.0);

            if (dist > 0 && dist < detectionRange) {
                 if (Math.abs(item.y - kart.yPercent) < cfg.road.laneTolerance) {
                    dangerFound = true;
                    let naturalDir = (item.y > kart.yPercent) ? -1 : 1;
                    if (naturalDir === 1) avoidDirection = (kart.yPercent > cfg.road.maxY - cfg.road.edgeSafetyMargin) ? -1 : 1;
                    else avoidDirection = (kart.yPercent < cfg.road.minY + cfg.road.edgeSafetyMargin) ? 1 : -1;
                    break;
                }
            }
        }

        if (dangerFound) {
            if (kart.aiState !== 'dodging') {
                kart.aiState = 'dodging';
                kart.originalLaneY = kart.yPercent;
                kart.dodgeIntensity = randomRange(rng,
                    cfg.ai.dodgeIntensityMin * handling,
                    cfg.ai.dodgeIntensityMax * handling
                );
            }
            kart.targetVy = avoidDirection * kart.dodgeIntensity;
            kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
            return;
        }

        let overtakeFound = false;
        const kartsLen = state.karts.length;
        for (let i = 0; i < kartsLen; i++) {
            const other = state.karts[i];
            if (other.id === kart.id || other.state !== 'running') continue;

            let dist = getShortestDistance(cfg, other.worldX, kart.worldX);
            const distY = Math.abs(other.yPercent - kart.yPercent);

            if (dist > 0 && dist < cfg.ai.overtakeDetectionRange && distY < cfg.ai.overtakeMinDistance) {
                overtakeFound = true;
                let dir = (kart.yPercent > other.yPercent) ? 1 : -1;
                if (kart.yPercent > cfg.road.maxY - cfg.road.overtakeMargin) dir = -1;
                if (kart.yPercent < cfg.road.minY + cfg.road.overtakeMargin) dir = 1;
                kart.targetVy = dir * cfg.ai.overtakeSideSpeed * handling;
                break;
            }
        }

        if (overtakeFound) {
            kart.originalLaneY = kart.yPercent;
            kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
            return;
        }

        let boxTargetFound = false;
        if (!kart.heldItem) {
            const boxesLen = state.itemBoxes.length;
            for (let i = 0; i < boxesLen; i++) {
                const box = state.itemBoxes[i];
                if (!box.active) continue;
                let dist = getShortestDistance(cfg, box.worldX, kart.worldX);
                if (dist > 0 && dist < cfg.ai.boxDetectionRange) {
                    const diffY = box.y - kart.yPercent;
                    if (Math.abs(diffY) > 2) {
                        kart.targetVy = ((diffY > 0) ? cfg.ai.boxSeekIntensity : -cfg.ai.boxSeekIntensity) * handling;
                        boxTargetFound = true;
                        break;
                    }
                }
            }
        }

        if (boxTargetFound) {
            kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
            return;
        }

        if (now > kart.nextWanderTime) {
            kart.nextWanderTime = now + randomRange(rng, cfg.ai.wanderIntervalMin, cfg.ai.wanderIntervalMax);
            kart.wanderEndTime = now + randomRange(rng, cfg.ai.wanderDurationMin, cfg.ai.wanderDurationMax);
            let dir = (rng() > 0.5) ? 1 : -1;
            if (kart.yPercent > cfg.road.maxY - cfg.road.wanderMargin) dir = -1;
            if (kart.yPercent < cfg.road.minY + cfg.road.wanderMargin) dir = 1;
            kart.wanderVy = dir * cfg.ai.wanderSpeed * handling;
        }

        if (now < kart.wanderEndTime) {
            kart.targetVy = kart.wanderVy;
            kart.originalLaneY = kart.yPercent;
        } else {
            if (kart.aiState === 'dodging') {
                const diff = kart.originalLaneY - kart.yPercent;
                if (Math.abs(diff) < 1) {
                    kart.targetVy = 0;
                    kart.yPercent = kart.originalLaneY;
                    kart.aiState = 'cruising';
                } else {
                    kart.targetVy = (diff > 0 ? 1 : -1) * cfg.speeds.returnLane * handling;
                }
            } else {
                kart.targetVy = 0;
                kart.aiState = 'cruising';
            }
        }

        kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
    }

    function getDistanceToLeader(state, kart) {
        const leader = state.cachedLeader;
        if (!leader || leader.id === kart.id) return 0;
        return leader.totalDistance - kart.totalDistance;
    }

    // Interrupteur global : un type present dans cfg.disabledItems ne sort
    // jamais d'une boite, son poids etant force a 0 dans tous les paliers.
    function isItemEnabled(cfg, itemType) {
        const disabled = cfg.disabledItems;
        return !disabled || disabled.indexOf(itemType) === -1;
    }

    // Renvoie la description d'orbite d'un type triple, ou null si l'objet n'en
    // est pas un. `child` est l'objet reellement largue a chaque activation.
    function getOrbitSpec(cfg, itemType) {
        const specs = cfg.orbitItems;
        return (specs && specs[itemType]) ? specs[itemType] : null;
    }

    function rollItem(cfg, state, rng, kart) {
        const distToLeader = getDistanceToLeader(state, kart);
        const itemDist = cfg.itemDistribution;
        const tiers = itemDist.tiers;

        let tier;
        if (kart.rank === 1) {
            tier = itemDist.leaderTier;
        } else {
            tier = tiers.find(t => distToLeader <= t.maxDistance) || tiers[tiers.length - 1];
        }

        const totalKarts = state.karts.length;
        const isLastTwo = kart.rank >= totalKarts - 1;
        let canGetStar = false;
        if (kart.rank === 1) {
            canGetStar = false;
        } else if (kart.rank <= 3) {
            canGetStar = distToLeader >= itemDist.starMinDistTop;
        } else if (isLastTwo) {
            canGetStar = true;
        } else {
            canGetStar = distToLeader >= itemDist.starMinDistMid;
        }

        const weights = {};
        for (const key in tier.weights) {
            let w = tier.weights[key];
            if (key === 'star' && !canGetStar) w = 0;
            if (!isItemEnabled(cfg, key)) w = 0;
            weights[key] = w;
        }

        const total = Object.values(weights).reduce((s, w) => s + w, 0);
        // Tout le palier peut etre desactive : dans ce cas le kart repart sans
        // objet plutot que d'en recevoir un que la config interdit.
        if (total <= 0) return null;

        let roll = rng() * total;
        let last = null;
        for (const [itemType, weight] of Object.entries(weights)) {
            // Les poids nuls sont sautes, sinon un rng() rendant exactement 0
            // selectionnerait la premiere cle meme interdite.
            if (weight <= 0) continue;
            last = itemType;
            roll -= weight;
            if (roll <= 0) return itemType;
        }
        return last;
    }

    function getKartByRank(state, rank) {
        return state.karts.find(k => k.rank === rank && (k.state === 'running' || k.state === 'hit')) || null;
    }

    // Offset monde de l'objet traîné, identique sur tous les appareils. Un objet
    // tenu en main n'est jamais une entité de collision, donc pas d'offset ici.
    function getHeldItemWorldOffset(cfg, holdPosition) {
        return holdPosition === 'behind' ? cfg.offsets.world.heldItemBehind : 0;
    }

    function getHoldPosition(cfg, itemType) {
        if (itemType === 'shroom' || itemType === 'star') return 'hands';
        if (getOrbitSpec(cfg, itemType)) return 'orbit';
        return 'behind';
    }

    // Orbite elliptique autour du kart, en coordonnees monde donc identique sur
    // tous les appareils : cos donne l'ecart horizontal en px, sin l'ecart de
    // profondeur en pourcentage de route.
    //
    // Le fait qu'une banane passe devant ou derriere le kart ne regarde que le
    // rendu, qui joue la-dessus sur le z-index : ici la position rendue est la
    // position reelle, sur toute l'orbite.
    function getOrbitItemPosition(cfg, kart, orb, orbitAngle) {
        const orbit = cfg.orbit;
        const angle = orbitAngle + orb.phase;

        let worldX = kart.worldX + Math.cos(angle) * orbit.radiusX;
        if (worldX < 0) worldX += cfg.world.width;
        if (worldX >= cfg.world.width) worldX -= cfg.world.width;

        return { worldX: worldX, y: kart.yPercent + Math.sin(angle) * orbit.radiusY };
    }

    // Retire un objet sans toucher aux phases des autres : leur position
    // angulaire ne depend que de orbitAngle et de leur propre phase, figee a
    // l'attribution. La rotation restante est donc strictement la meme qu'avant
    // le retrait, qu'il vienne d'un largage ou d'une destruction.
    //
    // N'emet volontairement aucun evenement : un objet detruit doit voir son
    // element DOM supprime, un objet largue doit au contraire le garder pour que
    // l'item lance le reutilise. C'est a l'appelant de trancher.
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

        const itemType = rollItem(cfg, state, rng, kart);
        if (!itemType) return;

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

            kart.throwTime = now + randomRange(rng, cfg.ai.holdItemMin, cfg.ai.holdItemMax);
            return;
        }

        const itemId = state.nextItemId++;
        // Pas d'offset visuel ici : le client le derive de holdPosition au rendu.
        kart.heldItem = {
            id: itemId,
            type: itemType,
            holdPosition: holdPosition
        };

        kart.throwTime = now + randomRange(rng, cfg.ai.holdItemMin, cfg.ai.holdItemMax);

        events.push({ type: 'spawnHeldItem', kartId: kart.id, itemId: itemId, itemType: itemType, holdPosition: holdPosition });
    }

    // Met un objet en jeu depuis un kart : trajectoire et cible dependent du
    // type, pas de la facon dont il etait porte. Partagee par l'activation d'un
    // objet simple et par le largage d'un objet en orbite, pour qu'une carapace
    // tiree depuis un triple se comporte exactement comme une carapace simple.
    function spawnLaunchedItem(cfg, state, rng, now, kart, itemType, itemId, startX, startY, events) {
        let vx = 0;
        let vy = 0;
        let targetKartId = null;

        if (itemType === 'greenShell') {
            vx = cfg.speeds.projectileSpeed;
            vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
        } else if (itemType === 'redShell') {
            vx = cfg.speeds.redShellSpeed;
            const target = getKartByRank(state, kart.rank - 1);
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
            isDead: false
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
            if (child === 'banana') {
                // Un piege est simplement lache : on part de la position d'orbite
                // courante, donc sans saut visuel. Le rayon vertical deborde la
                // route quand le kart longe un bord et la boucle items ne
                // reclampe jamais les bananes (elles ne bougent pas) : on le fait
                // ici, au largage.
                startX = pos.worldX;
                startY = Math.min(Math.max(pos.y, cfg.road.minY), cfg.road.maxY);
            } else {
                // Une carapace est tiree vers l'avant, comme depuis la main :
                // la faire partir de l'arriere de l'orbite la ferait traverser
                // son propre kart.
                startX = kart.worldX + cfg.offsets.world.shellSpawn;
                startY = kart.yPercent;
            }

            // L'objet reprend son id : son element DOM est reutilise tel quel par
            // le rendu des items en jeu.
            spawnLaunchedItem(cfg, state, rng, now, kart, child, orb.id, startX, startY, events);

            if (kart.heldItem) {
                kart.throwTime = now + randomRange(rng, cfg.orbit.dropIntervalMin, cfg.orbit.dropIntervalMax);
            }
            return;
        }

        if (held.type === 'shroom') {
            kart.boostEndTime = now + cfg.speeds.shroomDuration;
            kart.absoluteVelocity = kart.stats.topSpeed;
            kart.momentum = 1.0;
            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
            kart.heldItem = null;
            return;
        }

        if (held.type === 'star') {
            kart.starEndTime = now + cfg.speeds.starDuration;
            kart.isInvincible = true;
            kart.absoluteVelocity = kart.stats.topSpeed;
            kart.momentum = 1.0;
            events.push({ type: 'starOn', kartId: kart.id });
            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
            kart.heldItem = null;
            return;
        }

        let startX = kart.worldX + getHeldItemWorldOffset(cfg, held.holdPosition);
        if (held.type === 'greenShell' || held.type === 'redShell') {
            startX = kart.worldX + cfg.offsets.world.shellSpawn;
        }

        spawnLaunchedItem(cfg, state, rng, now, kart, held.type, held.id, startX, kart.yPercent, events);
        kart.heldItem = null;
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
                    if (dx >= cfg.hitboxes.orbitItemVsKart.x || dy >= cfg.hitboxes.orbitItemVsKart.y) continue;

                    // Une etoile encaisse l'objet sans etre ralentie, mais le
                    // consomme quand meme : le bouclier s'use au contact.
                    if (!victim.isInvincible) {
                        victim.state = 'hit';
                        victim.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
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

    function handleSpawns(cfg, state, rng, now, events) {
        if (now > state.nextSpawnTime) {
            const pendingKart = state.karts.find(k => k.state === 'pending');
            if (pendingKart) {
                pendingKart.state = 'running';
                pendingKart.absoluteVelocity = getInitialKartSpeed(rng, pendingKart.stats);
                events.push({ type: 'kartSpawned', kartId: pendingKart.id });
                const delay = randomRange(rng, cfg.delays.spawnMin, cfg.delays.spawnMax);
                state.nextSpawnTime = now + delay;
            }
        }
    }

    function updateLeaderboard(state, now, events) {
        if (now - state.lastLeaderboardUpdate < 500) return;
        state.lastLeaderboardUpdate = now;

        const karts = state.karts;
        const kartsLen = karts.length;

        const activeKarts = [];
        for (let i = 0; i < kartsLen; i++) {
            const k = karts[i];
            if (k.state === 'running' || k.state === 'hit') activeKarts.push(k);
        }
        if (activeKarts.length === 0) return;

        activeKarts.sort((a, b) => b.totalDistance - a.totalDistance);
        state.cachedLeader = activeKarts[0];

        const newRanking = [];
        const prevRanking = state.previousRanking;

        for (let i = 0; i < activeKarts.length; i++) {
            const kart = activeKarts[i];
            const newPosition = i;
            kart.rank = newPosition + 1;
            newRanking.push(kart.id);

            const prevPosition = prevRanking.indexOf(kart.id);
            events.push({
                type: 'leaderboardPosition',
                kartId: kart.id,
                newPosition: newPosition,
                prevPosition: prevPosition
            });
        }

        state.previousRanking = newRanking;
    }

    function stepPhysics(cfg, state, rng, now, deltaTime) {
        const events = [];

        handleSpawns(cfg, state, rng, now, events);

        state.cameraX += cfg.speeds.roadPPS * deltaTime;
        if (state.cameraX >= cfg.world.width) {
            state.cameraX -= cfg.world.width;
        }

        // Fond en parallaxe : moitié vitesse, boucle indépendamment de cameraX.
        state.bgCameraX = (state.bgCameraX || 0) + cfg.speeds.roadPPS * deltaTime * 0.5;
        if (state.bgCameraX >= cfg.world.width) {
            state.bgCameraX -= cfg.world.width;
        }

        const boxesLen = state.itemBoxes.length;
        for (let i = 0; i < boxesLen; i++) {
            const box = state.itemBoxes[i];
            if (!box.active && now > box.reactivateTime) {
                box.active = true;
            }
            if (!box.active) continue;

            const kartsLen0 = state.karts.length;
            for (let k = 0; k < kartsLen0; k++) {
                const kart = state.karts[k];
                if (kart.state !== 'running' && kart.state !== 'hit') continue;

                const dist = getShortestDistance(cfg, box.worldX, kart.worldX);
                const dy = Math.abs(box.y - kart.yPercent);
                if (Math.abs(dist) < cfg.hitboxes.itemBox.x && dy < cfg.hitboxes.itemBox.y) {
                    box.active = false;
                    box.reactivateTime = now + cfg.delays.boxRespawn;
                    if (!kart.heldItem) {
                        kart.pendingItemGrantTime = now + cfg.delays.itemGrant;
                    }
                }
            }
        }

        const kartsLen = state.karts.length;

        for (let i = 0; i < kartsLen; i++) {
            const kart = state.karts[i];

            if (kart.state === 'pending') continue;

            if (kart.state === 'running') {
                if (kart.pendingItemGrantTime && now > kart.pendingItemGrantTime) {
                    giveKartItem(cfg, state, rng, now, kart, events);
                    kart.pendingItemGrantTime = 0;
                }

                updateAI(cfg, state, rng, now, kart, deltaTime);

                const isBoosted = kart.boostEndTime > now || kart.starEndTime > now;

                if (isBoosted) {
                    kart.absoluteVelocity = kart.stats.topSpeed;
                    kart.momentum = 1.0;
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                } else {
                    if (now > kart.nextMomentumChange) {
                        kart.momentumTarget = getNewMomentumTarget(rng, kart.stats);
                        kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                    }
                    const mChangeSpeed = cfg.speeds.momentumChangeSpeed;
                    if (kart.momentum < kart.momentumTarget) {
                        kart.momentum = Math.min(kart.momentumTarget, kart.momentum + mChangeSpeed * deltaTime);
                    } else {
                        kart.momentum = Math.max(kart.momentumTarget, kart.momentum - mChangeSpeed * deltaTime);
                    }

                    const targetSpeed = getMomentumSpeed(cfg, kart.stats, kart.momentum);
                    const accRate = cfg.speeds.accelerationRate * kart.stats.acceleration;
                    if (kart.absoluteVelocity < targetSpeed) {
                        kart.absoluteVelocity = Math.min(targetSpeed, kart.absoluteVelocity + accRate * deltaTime);
                    } else if (kart.absoluteVelocity > targetSpeed) {
                        kart.absoluteVelocity = Math.max(targetSpeed, kart.absoluteVelocity - accRate * 0.25 * deltaTime);
                    }
                    if (kart.absoluteVelocity > kart.stats.topSpeed) {
                        kart.absoluteVelocity = kart.stats.topSpeed;
                    }
                }

                let effectiveSpeed = kart.absoluteVelocity;
                if (kart.boostEndTime > now) {
                    effectiveSpeed = kart.stats.topSpeed + cfg.speeds.shroomBoost;
                }

                if (kart.starEndTime > now) {
                    effectiveSpeed = Math.max(effectiveSpeed, kart.stats.topSpeed * cfg.speeds.starSpeedMultiplier);
                    kart.isInvincible = true;
                } else if (kart.isInvincible) {
                    kart.isInvincible = false;
                    events.push({ type: 'starOff', kartId: kart.id });
                }

                const moveDist = effectiveSpeed * deltaTime;
                kart.totalDistance += moveDist;

                const prevWorldX = kart.worldX;
                kart.worldX += moveDist;
                kart.yPercent += kart.vy * deltaTime;

                const finishX = cfg.world.finishLineX;
                if (prevWorldX < finishX && kart.worldX >= finishX) {
                    if (kart.hasPassedFinishLine) {
                        kart.lapCount++;
                    } else {
                        kart.hasPassedFinishLine = true;
                    }
                }

                if (kart.worldX >= cfg.world.width) {
                    kart.worldX -= cfg.world.width;
                }
                if (kart.worldX < 0) {
                    kart.worldX += cfg.world.width;
                }

                if (kart.yPercent > cfg.road.maxY) { kart.yPercent = cfg.road.maxY; kart.vy = 0; }
                if (kart.yPercent < cfg.road.minY) { kart.yPercent = cfg.road.minY; kart.vy = 0; }

                for (let j = i + 1; j < kartsLen; j++) {
                    const other = state.karts[j];
                    if (other.state !== 'running') continue;
                    const dx = Math.abs(getShortestDistance(cfg, other.worldX, kart.worldX));
                    const dy = Math.abs(other.yPercent - kart.yPercent);
                    if (dx < cfg.hitboxes.kartVsKart.x && dy < cfg.hitboxes.kartVsKart.y) {
                         if (kart.isInvincible && other.isInvincible) continue;
                         if (kart.isInvincible) {
                             if (other.hitInvincibleUntil > now) continue;
                             other.state = 'hit';
                             other.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
                             events.push({ type: 'kartHit', kartId: other.id });
                             if (other.heldItem) other.throwTime = other.hitEndTime + cfg.delays.throwDelayAfterHit;
                             continue;
                         }
                         if (other.isInvincible) {
                             if (kart.hitInvincibleUntil > now) continue;
                             kart.state = 'hit';
                             kart.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
                             events.push({ type: 'kartHit', kartId: kart.id });
                             if (kart.heldItem) kart.throwTime = kart.hitEndTime + cfg.delays.throwDelayAfterHit;
                             continue;
                         }
                         const myWeight = kart.stats.weight;
                         const otherWeight = other.stats.weight;
                         const totalWeight = myWeight + otherWeight;
                         const myRatio = otherWeight / totalWeight;
                         const otherRatio = myWeight / totalWeight;
                         const pushForce = cfg.physics.pushForce;
                         const myBounceY = cfg.physics.collisionBounceY * myRatio;
                         const otherBounceY = cfg.physics.collisionBounceY * otherRatio;
                         if (kart.yPercent > other.yPercent) {
                             kart.yPercent += pushForce * myRatio; kart.vy = myBounceY;
                             other.yPercent -= pushForce * otherRatio; other.vy = -otherBounceY;
                         } else {
                             kart.yPercent -= pushForce * myRatio; kart.vy = -myBounceY;
                             other.yPercent += pushForce * otherRatio; other.vy = otherBounceY;
                         }
                    }
                }

                if (kart.heldItem && kart.state === 'running' && kart.heldItem.holdPosition === 'behind') {
                    let itemWorldX = kart.worldX + cfg.offsets.world.heldItemBehind;
                    if (itemWorldX < 0) itemWorldX += cfg.world.width;
                    if (itemWorldX >= cfg.world.width) itemWorldX -= cfg.world.width;

                    const itemY = kart.yPercent;

                    for (let j = 0; j < kartsLen; j++) {
                        const victim = state.karts[j];
                        if (victim.id === kart.id || victim.state !== 'running') continue;
                        if (victim.hitInvincibleUntil > now) continue;

                        const dx = Math.abs(getShortestDistance(cfg, itemWorldX, victim.worldX));
                        const dy = Math.abs(itemY - victim.yPercent);

                        const hitThresholdY = 8;

                        if (dx < cfg.hitboxes.itemVsKart.x && dy < hitThresholdY) {
                            if (victim.isInvincible) {
                                events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                                kart.heldItem = null;
                                break;
                            }
                            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                            kart.heldItem = null;

                            victim.state = 'hit';
                            victim.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
                            events.push({ type: 'kartHit', kartId: victim.id });
                            if (victim.heldItem) {
                                victim.throwTime = victim.hitEndTime + cfg.delays.throwDelayAfterHit;
                            }
                            break;
                        }
                    }
                }

                if (kart.heldItem && now > kart.throwTime) activateItem(cfg, state, rng, now, kart, events);

            } else if (kart.state === 'hit') {
                const totalHitTime = cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
                const hitStart = kart.hitEndTime - totalHitTime;
                const elapsed = now - hitStart;
                const decelDuration = cfg.delays.hitDecelDuration;

                if (elapsed < decelDuration) {
                    const decelProgress = elapsed / decelDuration;
                    const hitSpeedFactor = 0.3 * Math.max(0, 1.0 - decelProgress * decelProgress);
                    const moveDist = cfg.speeds.roadPPS * hitSpeedFactor * deltaTime;
                    kart.worldX += moveDist;
                    kart.totalDistance += moveDist;
                    kart.stopped = false;
                } else {
                    kart.stopped = true;
                }

                if (kart.worldX >= cfg.world.width) {
                    kart.worldX -= cfg.world.width;
                }
                if (now > kart.hitEndTime) {
                    kart.state = 'running';
                    kart.stopped = false;
                    kart.absoluteVelocity = 0;
                    kart.momentum = 0.2;
                    kart.momentumTarget = randomRange(rng, 0.6, 1.0);
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                    kart.hitInvincibleUntil = now + cfg.delays.invincibilityAfterHit;
                }
            }
        }

        updateOrbitItems(cfg, state, now, deltaTime, events);

        for (let i = state.items.length - 1; i >= 0; i--) {
            const item = state.items[i];
            if (item.isDead) continue;

            for (let j = i - 1; j >= 0; j--) {
                const other = state.items[j];
                if (other.isDead) continue;
                const dx = Math.abs(getShortestDistance(cfg, item.worldX, other.worldX));
                const dy = Math.abs(item.y - other.y);
                if (dx < cfg.hitboxes.itemVsKart.x && dy < cfg.hitboxes.itemVsKart.y) {
                    item.isDead = true;
                    other.isDead = true;
                }
            }
        }

        for (let i = state.items.length - 1; i >= 0; i--) {
            const item = state.items[i];
            if (item.isDead) continue;

            if (item.type !== 'banana') {
                if (item.type === 'redShell' && item.targetKartId !== null) {
                    const target = state.kartsById[item.targetKartId];
                    if (target && (target.state === 'running' || target.state === 'hit')) {
                        const diffY = target.yPercent - item.y;
                        item.vy = diffY * cfg.speeds.redShellTrackingSpeed;
                    } else {
                        let newTarget = null;
                        let bestDist = Infinity;
                        for (let k = 0; k < kartsLen; k++) {
                            const candidate = state.karts[k];
                            if (candidate.id === item.shooterId) continue;
                            if (candidate.state !== 'running') continue;
                            const dist = getShortestDistance(cfg, candidate.worldX, item.worldX);
                            if (dist > 0 && dist < bestDist) {
                                bestDist = dist;
                                newTarget = candidate;
                            }
                        }
                        if (newTarget) {
                            item.targetKartId = newTarget.id;
                        } else {
                            item.targetKartId = null;
                            item.vy = randomRange(rng, -cfg.speeds.shellVertical, cfg.speeds.shellVertical);
                        }
                    }
                }

                item.worldX += item.vx * deltaTime;
                item.y += item.vy * deltaTime;

                if (item.y > cfg.road.maxY) {
                    item.y = cfg.road.maxY;
                    if (item.type !== 'redShell') item.vy = -item.vy;
                } else if (item.y < cfg.road.minY) {
                    item.y = cfg.road.minY;
                    if (item.type !== 'redShell') item.vy = -item.vy;
                }
            }

            if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
            if (item.worldX < 0) item.worldX += cfg.world.width;

            if (item.type === 'greenShell') {
                if (now - item.lastAnimTime > cfg.visuals.greenShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.lastAnimTime = now;
                }
            } else if (item.type === 'redShell') {
                if (now - item.lastAnimTime > cfg.visuals.redShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.lastAnimTime = now;
                }
            }
            if (item.type === 'banana' && now - item.createdAt > cfg.delays.bananaLife) {
                item.isDead = true;
            }

            for (let k = 0; k < kartsLen; k++) {
                const kart = state.karts[k];
                if (item.type === 'banana' && kart.id === item.shooterId && now - item.createdAt < cfg.delays.invincibilityOwnItem) continue;
                if ((item.type === 'greenShell' || item.type === 'redShell') && kart.id === item.shooterId) continue;
                if (kart.state !== 'running' && kart.state !== 'hit') continue;

                if (kart.isInvincible) {
                    const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                    const dky = Math.abs(item.y - kart.yPercent);
                    if (dk < cfg.hitboxes.itemVsKart.x && dky < cfg.hitboxes.itemVsKart.y) {
                        item.isDead = true;
                        break;
                    }
                    continue;
                }

                let hitHeldItem = false;
                if (kart.heldItem && kart.heldItem.holdPosition === 'behind') {
                    let hX = kart.worldX + cfg.offsets.world.heldItemBehind;
                    if (hX < 0) hX += cfg.world.width;
                    if (hX >= cfg.world.width) hX -= cfg.world.width;

                    const dh = Math.abs(getShortestDistance(cfg, item.worldX, hX));
                    const dhy = Math.abs(item.y - kart.yPercent);

                    if (dh < cfg.hitboxes.itemVsKart.x && dhy < cfg.hitboxes.itemVsKart.y) {
                         events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                         kart.heldItem = null;
                         item.isDead = true;
                         hitHeldItem = true;
                    }
                } else if (kart.heldItem && kart.heldItem.holdPosition === 'orbit') {
                    // Le bouclier encaisse le projectile : un seul orbe part, les
                    // autres gardent leur phase et continuent de tourner.
                    const held = kart.heldItem;
                    for (let b = held.orbs.length - 1; b >= 0; b--) {
                        const pos = getOrbitItemPosition(cfg, kart, held.orbs[b], held.orbitAngle);
                        const dh = Math.abs(getShortestDistance(cfg, item.worldX, pos.worldX));
                        const dhy = Math.abs(item.y - pos.y);

                        if (dh < cfg.hitboxes.itemVsKart.x && dhy < cfg.hitboxes.itemVsKart.y) {
                            destroyOrbitItem(kart, b, events);
                            item.isDead = true;
                            hitHeldItem = true;
                            break;
                        }
                    }
                }

                if (hitHeldItem) break;

                const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                const dky = Math.abs(item.y - kart.yPercent);

                if (dk < cfg.hitboxes.itemVsKart.x && dky < cfg.hitboxes.itemVsKart.y) {
                    if (kart.state === 'running' && kart.hitInvincibleUntil <= now) {
                        kart.state = 'hit';
                        kart.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
                        events.push({ type: 'kartHit', kartId: kart.id });
                        if (kart.heldItem) kart.throwTime = kart.hitEndTime + cfg.delays.throwDelayAfterHit;
                    }
                    item.isDead = true;
                    break;
                }
            }
        }

        let writeIdx = 0;
        for (let i = 0; i < state.items.length; i++) {
            const it = state.items[i];
            if (it.isDead) {
                events.push({ type: 'killItem', itemId: it.id });
            } else {
                state.items[writeIdx++] = it;
            }
        }
        state.items.length = writeIdx;

        updateLeaderboard(state, now, events);

        return events;
    }

    return {
        shuffleArray,
        randomRange,
        getNewMomentumTarget,
        getMomentumSpeed,
        getInitialKartSpeed,
        getShortestDistance,
        getDistanceToLeader,
        updateAI,
        rollItem,
        getKartByRank,
        getHeldItemWorldOffset,
        getHoldPosition,
        isItemEnabled,
        getOrbitSpec,
        getOrbitItemPosition,
        removeOrbitItem,
        destroyOrbitItem,
        updateOrbitItems,
        giveKartItem,
        spawnLaunchedItem,
        activateItem,
        handleSpawns,
        updateLeaderboard,
        stepPhysics
    };
});
