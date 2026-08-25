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

    // Retire avec un sursis : l'objet reste affiche le temps qu'on voie le choc,
    // sans plus rien pouvoir heurter.
    function spendItem(cfg, item, now) {
        if (item.spent) return;
        item.spent = true;
        item.deadAt = now + cfg.delays.itemLingerMs;
    }

    function getShortestDistance(cfg, fromX, toX) {
        const w = cfg.world.width;
        let diff = fromX - toX;
        if (diff < -w * 0.5) diff += w;
        if (diff > w * 0.5) diff -= w;
        return diff;
    }

    // Distance laterale qu'un kart couvre en `ms` millisecondes, en partant a
    // l'arret. Le lissage lui interdit d'atteindre sa vitesse d'esquive d'un
    // coup : sur une reaction courte, la moitie du trajet part dans la montee
    // en regime. L'ignorer ferait croire a un poids lourd qu'il coupe devant
    // n'importe quoi. `tau` est la constante de temps du filtre applique plus
    // bas a `vy`, maniabilite comprise — elle pese donc deux fois, sur le
    // regime atteint comme sur le temps mis a l'atteindre.
    function lateralReach(cfg, handling, intensity, ms) {
        const t = ms / 1000;
        const tau = 1 / (cfg.physics.smoothingFactor * handling);
        return intensity * (t - tau * (1 - Math.exp(-t / tau)));
    }

    // Probabilite qu'un kart ne voie pas venir la menace.
    //
    // Elle ne vaut plein tarif que pour une esquive tout juste jouable. Un
    // objet aperçu de loin sur une route libre, lui, ne se rate pas : le kart
    // qui foncerait dedans sans un geste ne passerait pas pour distrait, mais
    // pour casse. La difficulte se mesure en distance — ce que le kart peut
    // couvrir avant l'impact, rapporte a ce qu'il doit couvrir pour degager —
    // et le tirage s'efface a mesure que cette marge grandit.
    function missChance(cfg, kart, threatY, spareMs) {
        const ai = cfg.ai;
        const handling = kart.stats.handling;
        const base = ai.dodgeMissChance / handling;

        // Il passe deja assez a cote pour que la hitbox le manque : rater cette
        // menace-la ne lui coute rien.
        const need = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin
            - Math.abs(threatY - kart.yPercent);
        if (need <= 0) return 0;
        if (spareMs <= 0) return base;

        // Capacite type et non celle du coup a jouer : l'intensite reelle n'est
        // tiree qu'au moment de s'ecarter, une fois le reflexe passe.
        const intensity = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * handling;
        const ease = lateralReach(cfg, handling, intensity, spareMs) / need;

        if (ease <= 1) return base;
        if (ease >= ai.dodgeEasyRatio) return 0;
        return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
    }

    // Cote d'esquive et intensite, arretes une fois pour toutes a la premiere
    // reaction a une menace donnee — un kart qui rechoisirait a chaque tick
    // hesiterait sur place au lieu de s'ecarter.
    //
    // Le cote naturel est celui qui eloigne de l'objet. Quand le bord de piste
    // le condamne, le kart ne renonce pas pour autant : il jauge la traversee
    // par l'autre cote, devant l'objet. Il lui faut alors la place ET le temps,
    // et il n'estime le second qu'a vue (cf. ai.crossJudgeError) : la traversee
    // ratee fait partie du jeu. Sans issue des deux cotes, il ne reste que le
    // frein.
    function planDodge(cfg, rng, kart, threatId, threatY, ttc) {
        const ai = cfg.ai;
        const handling = kart.stats.handling;
        const margin = cfg.road.edgeSafetyMargin;

        kart.dodgePlanId = threatId;
        kart.dodgeIntensity = randomRange(rng,
            ai.dodgeIntensityMin * handling,
            ai.dodgeIntensityMax * handling
        );

        const naturalDir = (threatY > kart.yPercent) ? -1 : 1;

        // Ecart au-dela duquel l'objet ne touche plus, et ecart actuel : la
        // detection ouvre plus large que la hitbox, un kart peut donc etre
        // alerte alors qu'il passe deja a cote.
        const clear = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin;
        const gap = Math.abs(threatY - kart.yPercent);

        const roomNatural = (naturalDir > 0)
            ? (cfg.road.maxY - margin) - kart.yPercent
            : kart.yPercent - (cfg.road.minY + margin);

        if (roomNatural >= Math.max(0, clear - gap)) {
            kart.dodgeDir = naturalDir;
            kart.dodgeStuck = false;
            kart.dodgeCrossing = false;
            return;
        }

        // Traverser coute l'ecart entier, plus le degagement de l'autre cote.
        const crossDir = -naturalDir;
        const crossNeed = gap + clear;
        const roomCross = (crossDir > 0)
            ? (cfg.road.maxY - margin) - kart.yPercent
            : kart.yPercent - (cfg.road.minY + margin);

        const err = ai.crossJudgeError / handling;
        const judged = lateralReach(cfg, handling, kart.dodgeIntensity, ttc)
            * randomRange(rng, 1 - err, 1 + err);

        if (gap < clear && roomCross >= crossNeed && judged >= crossNeed) {
            kart.dodgeDir = crossDir;
            kart.dodgeStuck = false;
            kart.dodgeCrossing = true;
            return;
        }

        // Colle au bord : il pousse quand meme du cote naturel, ce qui lui
        // grappille le peu de place restante, et lache les gaz.
        kart.dodgeDir = naturalDir;
        kart.dodgeStuck = true;
        kart.dodgeCrossing = false;
    }

    function updateAI(cfg, state, rng, now, kart, deltaTime) {
        if (kart.state !== 'running') return;

        let dangerFound = false;
        let avoidDirection = 0;

        const handling = kart.stats.handling;
        const ai = cfg.ai;

        // Menace la plus urgente, mesuree en temps avant impact. Un objet qui
        // s'eloigne n'en est pas une — ce qui evite au passage qu'un kart fuie
        // la carapace qu'il vient de tirer.
        let threatId = 0;
        let threatY = 0;
        let threatTtc = Infinity;

        // Le lourd doit regarder plus loin que le vif pour disposer de la meme
        // marge de manoeuvre — voir ai.threatWindowMs.
        const threatWindow = ai.threatWindowMs / handling;

        const itemsLen = state.items.length;
        for (let i = 0; i < itemsLen; i++) {
            const item = state.items[i];
            if (item.isDead) continue;
            if (item.type !== 'banana' && item.type !== 'greenShell' && item.type !== 'redShell') continue;
            if (item.spent) continue;

            const dist = getShortestDistance(cfg, item.worldX, kart.worldX);
            if (dist <= 0 || dist > ai.threatMaxDistance) continue;
            if (Math.abs(item.y - kart.yPercent) >= cfg.road.laneTolerance) continue;

            const closing = kart.absoluteVelocity - item.vx;
            if (closing <= 0) continue;

            const ttc = (dist / closing) * 1000;
            if (ttc <= threatWindow && ttc < threatTtc) {
                threatId = item.id;
                threatY = item.y;
                threatTtc = ttc;
            }
        }

        // Objets traines par les autres karts. Ils avancent a la vitesse de leur
        // porteur : ils ne menacent donc que celui qui revient vraiment dessus.
        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id === kart.id || other.state !== 'running') continue;

            const held = other.heldItem;
            if (!held || held.holdPosition !== 'behind') continue;

            let hx = other.worldX + cfg.offsets.world.heldItemBehind;
            if (hx < 0) hx += cfg.world.width;
            if (hx >= cfg.world.width) hx -= cfg.world.width;

            const dist = getShortestDistance(cfg, hx, kart.worldX);
            if (dist <= 0 || dist > ai.trailThreatDistance) continue;
            if (Math.abs(other.yPercent - kart.yPercent) >= cfg.road.laneTolerance) continue;

            // Seul celui qui revient dessus est menace : derriere un porteur
            // plus rapide, l'objet s'eloigne.
            const closing = kart.absoluteVelocity - other.absoluteVelocity;
            if (closing <= 0) continue;

            // Meme etalon que les projectiles, pour departager les menaces.
            const ttc = (dist / Math.max(closing, 1)) * 1000;
            if (ttc < threatTtc) {
                threatId = held.id;
                threatY = other.yPercent;
                threatTtc = ttc;
            }
        }

        if (!threatId) {
            kart.threatItemId = 0;
            kart.dodgePlanId = 0;
        } else {
            // Decide a la premiere perception, une fois pour toutes.
            if (kart.threatItemId !== threatId) {
                kart.threatItemId = threatId;

                const reactMs = (ai.reactionBaseMs / handling)
                    * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);
                kart.threatReactAt = now + reactMs;

                // Ce qui restera une fois le reflexe passe : c'est ce temps-la,
                // et non le delai brut avant impact, qui dit si l'esquive etait
                // a sa portee.
                kart.threatIgnored = rng() < missChance(cfg, kart, threatY, threatTtc - reactMs);
            }

            if (!kart.threatIgnored && now >= kart.threatReactAt) {
                dangerFound = true;
                if (kart.dodgePlanId !== threatId) {
                    planDodge(cfg, rng, kart, threatId, threatY, threatTtc);
                }
                avoidDirection = kart.dodgeDir;

                // Le frein n'accompagne que les esquives qui ne sont pas
                // franches : acculle il n'a plus que lui, en traversee il
                // recule l'impact le temps de passer devant l'objet.
                if (kart.dodgeStuck || kart.dodgeCrossing) {
                    kart.brakeUntil = now + ai.edgeBrakeMs;
                }
            }
        }

        if (dangerFound) {
            if (kart.aiState !== 'dodging') {
                kart.aiState = 'dodging';
                kart.originalLaneY = kart.yPercent;
            }
            kart.targetVy = avoidDirection * kart.dodgeIntensity;
            kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
            return;
        }

        // Visee, dans le sens de tir choisi a la reception. Apres l'esquive —
        // se faire toucher en visant reste prioritaire — et avant le
        // depassement.
        if (isAiming(cfg, kart) && now > kart.throwTime - ai.aimLeadMs) {
            const dir = kart.shotDirection;
            let target = null;
            let targetDist = Infinity;

            for (let i = 0; i < state.karts.length; i++) {
                const other = state.karts[i];
                if (other.id === kart.id || other.state !== 'running') continue;

                const dist = getShortestDistance(cfg, other.worldX, kart.worldX) * dir;
                if (dist > 0 && dist < ai.aimScanDistance && dist < targetDist) {
                    targetDist = dist;
                    target = other;
                }
            }

            if (target) {
                const margin = cfg.road.edgeSafetyMargin;
                const desired = Math.min(cfg.road.maxY - margin,
                                         Math.max(cfg.road.minY + margin, target.yPercent + kart.aimError));
                const diff = desired - kart.yPercent;

                if (Math.abs(diff) > 0.5) {
                    const speed = ai.aimSpeed * handling;
                    kart.aiState = 'aiming';
                    kart.originalLaneY = kart.yPercent;
                    kart.targetVy = Math.max(-speed, Math.min(speed, diff * ai.aimSpeed));
                    kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
                    return;
                }
            }
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

    // Ecart au premier, mesure en distance restante : deux karts partis de
    // rangs differents n'ont pas la meme distance a couvrir, comparer leurs
    // compteurs bruts placerait la pole en dernier au premier virage.
    function remainingDistance(kart) {
        return kart.finishDistance - kart.totalDistance;
    }

    function getDistanceToLeader(state, kart) {
        const leader = state.cachedLeader;
        if (!leader || leader.id === kart.id) return 0;
        return remainingDistance(kart) - remainingDistance(leader);
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

    // La bleue ne passe pas par les paliers : elle a ses propres conditions.
    function rollBlueShell(cfg, state, rng, kart) {
        const spec = cfg.blueShell;
        if (!isItemEnabled(cfg, 'blueShell')) return false;
        if (kart.rank < spec.minRank || kart.rank > spec.maxRank) return false;

        const leader = getRacingLeader(state);
        if (!leader || leader.id === kart.id) return false;

        return state.blueShellChance > 0 && rng() < state.blueShellChance;
    }

    function rollItem(cfg, state, rng, now, kart) {
        const distToLeader = getDistanceToLeader(state, kart);

        if (rollBlueShell(cfg, state, rng, kart)) {
            state.blueShellChance /= cfg.blueShell.chanceDecay;
            return 'blueShell';
        }

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
        // Fenetre morte au depart : tant qu'elle dure, aucun rang n'y a droit,
        // les ecarts du premier bloc d'objets ne signifiant encore rien.
        const raceMs = now - state.startAt;
        let canGetStar = false;
        if (raceMs < itemDist.starMinRaceMs) {
            canGetStar = false;
        } else if (kart.rank === 1) {
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

    // Le mieux place parmi ceux qui courent encore : viser le tour d'honneur
    // d'un kart deja arrive n'aurait aucun sens.
    function getRacingLeader(state) {
        let best = null;
        for (let i = 0; i < state.karts.length; i++) {
            const kart = state.karts[i];
            if (kart.finished) continue;
            if (kart.state !== 'running' && kart.state !== 'hit') continue;
            if (!best || kart.rank < best.rank) best = kart;
        }
        return best;
    }

    // Tout objet simple arrive en main, y compris ceux qui peuvent ensuite etre
    // traines : en main, il n'a pas de hitbox, il ne protege de rien et ne
    // blesse personne.
    function getHoldPosition(cfg, itemType) {
        if (getOrbitSpec(cfg, itemType)) return 'orbit';
        return 'hands';
    }

    function isTrailable(cfg, itemType) {
        return (cfg.trailableItems || []).indexOf(itemType) !== -1;
    }

    // Une banane simplement lachee derriere soi ne se vise pas.
    function isAiming(cfg, kart) {
        const held = kart.heldItem;
        if (!held || held.holdPosition === 'orbit') return false;
        if (held.type === 'greenShell' || held.type === 'redShell') return true;
        return held.type === 'banana' && kart.lobbing;
    }

    // Decide de la vie de l'objet : sorti derriere le kart a un moment, ou garde
    // en main jusqu'au tir.
    // Le sens du tir est arrete des la reception : le kart doit savoir de quel
    // cote viser bien avant de lacher son objet.
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

        kart.aimError = randomRange(rng, -ai.aimErrorMax, ai.aimErrorMax) / kart.stats.handling;

        if (isTrailable(cfg, itemType) && rng() < ai.trailChance) {
            kart.trailTime = now + randomRange(rng, ai.trailDelayMin, ai.trailDelayMax);
            kart.throwTime = kart.trailTime + randomRange(rng, ai.trailHoldMin, ai.trailHoldMax);
            return;
        }

        kart.trailTime = 0;
        kart.throwTime = now + randomRange(rng, ai.holdItemMin, ai.holdItemMax);
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

        const itemType = rollItem(cfg, state, rng, now, kart);
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

        planItemUse(cfg, rng, state, now, kart, itemType);

        events.push({ type: 'spawnHeldItem', kartId: kart.id, itemId: itemId, itemType: itemType, holdPosition: holdPosition });
    }

    function rankChance(table, state, kart) {
        if (kart.rank === 1) return table.leader;
        if (kart.rank >= state.karts.length) return table.last;
        return table.pack;
    }

    // Le plus proche devant, en sautant ceux qui sont colles au tireur. Null si
    // tout le monde est trop proche : la rouge part alors sans cible.
    function findRedShellTarget(cfg, state, kart) {
        let best = null;
        let bestDist = Infinity;

        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id === kart.id) continue;
            if (other.state !== 'running' && other.state !== 'hit') continue;

            const dist = getShortestDistance(cfg, other.worldX, kart.worldX);
            if (dist < cfg.speeds.redShellMinTarget) continue;
            if (dist < bestDist) {
                bestDist = dist;
                best = other;
            }
        }

        return best;
    }

    function rollShellDirection(cfg, rng, state, kart, itemType) {
        const chances = cfg.ai.shellBackwardChance[itemType];
        if (!chances) return 1;

        return rng() < rankChance(chances, state, kart) ? -1 : 1;
    }

    // Met un objet en jeu depuis un kart : trajectoire et cible dependent du
    // type, pas de la facon dont il etait porte. Partagee par l'activation d'un
    // objet simple et par le largage d'un objet en orbite, pour qu'une carapace
    // tiree depuis un triple se comporte exactement comme une carapace simple.
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
            // Tete chercheuse vers l'avant seulement : tiree en arriere, elle
            // part tout droit. Sans cible des le depart, la boucle de suivi ne
            // s'y interesse jamais, pas meme pour lui en trouver une.
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

            // Vol en cloche. `hop` est la hauteur de l'arc, en pixels de rendu.
            // `rising` couvre la montee, pendant laquelle l'objet survole tout
            // le monde et n'a pas de hitbox ; il retombe a false au sommet.
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
            kart.trailTime = 0;
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
            direction = kart.shotDirection;
            startX = kart.worldX + (direction > 0 ? cfg.offsets.world.shellSpawn
                                                  : cfg.offsets.world.heldItemBehind);
        } else if (held.type === 'banana' && kart.lobbing) {
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

        // Position reelle en course = distance restante jusqu'a la ligne, et
        // non distance parcourue : la grille etant en quinconce, les huit karts
        // n'ont pas la meme distance a couvrir.
        //
        // Un kart arrive garde ensuite sa place quoi qu'il fasse : il roule au
        // ralenti, et un poursuivant encore en course pourrait le depasser en
        // distance sans lui avoir repris sa position.
        activeKarts.sort((a, b) => {
            if (a.finished || b.finished) {
                if (a.finished && b.finished) return a.finishRank - b.finishRank;
                return a.finished ? -1 : 1;
            }
            return remainingDistance(a) - remainingDistance(b);
        });
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

    // Position de la camera face a la ligne. La camera designe le centre de la
    // vue, donc un ecart negatif place la ligne a droite du centre.
    function parkPosition(cfg, offset) {
        let x = cfg.world.finishLineX + offset;
        if (x < 0) x += cfg.world.width;
        if (x >= cfg.world.width) x -= cfg.world.width;
        return x;
    }

    // Distance a parcourir vers l'avant pour aller de `from` a `to`. La camera
    // ne recule jamais : le decor defilerait a l'envers.
    function forwardDistance(cfg, from, to) {
        let d = to - from;
        if (d < 0) d += cfg.world.width;
        return d;
    }

    function getLeader(state) {
        let leader = null;
        for (const kart of state.karts) {
            if (!leader || kart.totalDistance > leader.totalDistance) leader = kart;
        }
        return leader;
    }

    // Le coup d'envoi. Chaque kart tire son depart : turbo pour la grande
    // majorite, depart normal, ou cale d'une seconde.
    function launchKarts(cfg, state, rng, now, events) {
        const race = cfg.race;

        for (const kart of state.karts) {
            kart.state = 'running';

            const roll = rng();
            if (roll < race.startTurboChance) {
                kart.boostEndTime = now + race.turboBoostMs;
                kart.absoluteVelocity = kart.stats.topSpeed;
                kart.momentum = 1;
                events.push({ type: 'startBoost', kartId: kart.id, kind: 'turbo' });
            } else if (roll < race.startTurboChance + race.startNormalChance) {
                kart.absoluteVelocity = getInitialKartSpeed(rng, kart.stats);
                events.push({ type: 'startBoost', kartId: kart.id, kind: 'normal' });
            } else {
                kart.startStallUntil = now + race.failStallMs;
                kart.absoluteVelocity = 0;
                kart.momentum = 0;
                events.push({ type: 'startBoost', kartId: kart.id, kind: 'fail' });
            }
        }
    }

    function setSign(state, group, frame, now, duration) {
        state.sign = { group: group, frame: frame, until: now + duration };
    }

    // Enchainement des phases, et pilotage de la camera qui en decoule.
    function updateRace(cfg, state, rng, now, deltaTime, events) {
        const race = cfg.race;
        const leader = getLeader(state);

        if (state.phase === 'countdown') {
            // Un feu par seconde jusqu'au depart : les quatre images de
            // lakitu/start sont montrees dans l'ordre.
            const remaining = state.startAt - now;

            // Premiere image tenue le temps de l'attente, puis un feu par
            // intervalle. La quatrieme, le feu vert, n'apparait qu'au GO.
            const elapsed = state.countdownMs - remaining;
            const step = elapsed < race.countdownHoldMs
                ? 1
                : Math.min(3, 2 + Math.floor((elapsed - race.countdownHoldMs) / race.lightIntervalMs));
            if (!state.sign || state.sign.group !== 'start' || state.sign.frame !== step) {
                setSign(state, 'start', step, now, remaining + race.goSignMs);
            }

            if (now >= state.startAt) {
                state.phase = 'racing';
                // La quatrieme image est le feu vert : elle n'apparait qu'au
                // coup d'envoi, pas pendant le decompte.
                setSign(state, 'start', 4, now, race.goSignMs);
                launchKarts(cfg, state, rng, now, events);
                events.push({ type: 'raceStart' });
            }
            return;
        }

        if (state.phase === 'racing') {
            // Seul le dernier tour est signale.
            // `lapCount` compte les franchissements. Le premier cloture le
            // trajet depuis la grille, pas un tour : le tour affiche vaut donc
            // le nombre de franchissements, au minimum 1.
            const lap = Math.min(race.laps, Math.max(1, leader.lapCount));
            if (lap !== state.leaderLap) {
                state.leaderLap = lap;

                // Chaque tour entame rend la bleue un peu plus probable.
                state.blueShellChance = Math.min(
                    cfg.blueShell.chanceCap,
                    state.blueShellChance + cfg.blueShell.chancePerLap
                );
            }

            // Le panneau se declenche sur ce qu'il reste a parcourir au premier :
            // c'est la seule mesure qui dise vraiment « il lui reste un tour ».
            if (!state.finalSignShown && remainingDistance(leader) <= cfg.world.width) {
                state.finalSignShown = true;
                setSign(state, 'laps', 'final', now, race.finalSignMs);
            }

            if (remainingDistance(leader) <= race.cameraApproachDistance) {
                state.phase = 'finishing';
                state.cameraTarget = parkPosition(cfg, race.parkFinishOffset);

                // Pas de drapeau ici : la camera se gare deux tours avant la
                // fin et la ligne reste a l'ecran tout ce temps, sortir Lakitu
                // des maintenant le laisserait plante la une demi-course. C'est
                // la phase 'finishing' qui le sort a l'approche reelle.
                events.push({ type: 'raceFinishing' });
            }
            return;
        }

        if (state.phase === 'finishing') {
            // Le drapeau ne sort qu'a l'approche reelle de la ligne, pas des le
            // repositionnement de la camera. Une fois sorti il reste en main :
            // il accompagne chaque passage, pas seulement le premier.
            if (!state.flagShown && leader && remainingDistance(leader) <= race.flagDistance) {
                state.flagShown = true;
                setSign(state, 'finish', 1, now, race.maxRaceMs);
            }

            // Un kart bloque ne doit pas figer le service : passe un delai
            // large, on classe les retardataires dans l'ordre ou ils courent et
            // on enchaine.
            if (now > state.startAt + race.maxRaceMs) {
                for (const kart of state.karts) {
                    if (kart.finished) continue;
                    kart.finished = true;
                    kart.finishRank = state.finishOrder.length + 1;
                    state.finishOrder.push(kart.id);
                }
            }

            if (state.finishOrder.length === state.karts.length && !state.resultsAt) {
                state.resultsAt = now + race.resultsDelayMs;
                state.phase = 'results';
                events.push({ type: 'raceFinished' });
            }
            return;
        }

        if (state.phase === 'results' && now >= state.resultsAt) {
            // Le service en tire une course neuve : c'est lui qui detient
            // createWorldState et les connexions a prevenir.
            events.push({ type: 'raceOver', order: state.finishOrder.slice() });
            state.resultsAt = now + race.resultsDelayMs;
        }
    }

    // Recalculee a chaque pas : la camera vise l'instant ou le leader franchira
    // la ligne. Un leader percute en chemin change la donne, elle suit.
    function aimCameraSpeed(cfg, state) {
        const race = cfg.race;
        const leader = getLeader(state);
        if (!leader) return cfg.speeds.roadPPS;

        const distance = forwardDistance(cfg, state.cameraX, state.cameraTarget);
        const speed = Math.max(leader.absoluteVelocity, 1);
        const timeLeft = Math.max(0.4, remainingDistance(leader) / speed);

        return Math.min(
            cfg.speeds.roadPPS * race.cameraMaxCatchupRatio,
            Math.max(cfg.speeds.roadPPS * race.cameraMinSpeedRatio, distance / timeLeft)
        );
    }

    function updateCamera(cfg, state, deltaTime) {
        const width = cfg.world.width;

        if (state.phase === 'countdown') return;

        if (state.phase === 'racing') {
            state.cameraX += cfg.speeds.roadPPS * deltaTime;
        } else if (state.cameraTarget !== null && state.cameraTarget !== undefined) {
            state.cameraSpeed = aimCameraSpeed(cfg, state);

            // Approche de la position de parking, puis arret net.
            const remaining = forwardDistance(cfg, state.cameraX, state.cameraTarget);
            const advance = state.cameraSpeed * deltaTime;
            if (advance >= remaining) {
                state.cameraX = state.cameraTarget;
                state.cameraTarget = null;
            } else {
                state.cameraX += advance;
            }
        } else {
            return;
        }

        if (state.cameraX >= width) state.cameraX -= width;

        // Fond en parallaxe : moitié vitesse.
        state.bgCameraX = (state.bgCameraX || 0) + (state.phase === 'racing'
            ? cfg.speeds.roadPPS * deltaTime * 0.5
            : state.cameraSpeed * deltaTime * 0.5);
        if (state.bgCameraX >= width) state.bgCameraX -= width;
    }

    // Etoile et champignon sont les deux seules sorties.
    function blastKart(cfg, state, now, kart, events) {
        if (kart.state !== 'running') return;
        if (kart.isInvincible) return;
        if (kart.boostEndTime > now) return;

        kart.state = 'hit';
        kart.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
        events.push({ type: 'kartHit', kartId: kart.id });
        if (kart.heldItem) kart.throwTime = kart.hitEndTime + cfg.delays.throwDelayAfterHit;
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

    function stepPhysics(cfg, state, rng, now, deltaTime) {
        const events = [];

        updateRace(cfg, state, rng, now, deltaTime, events);
        updateCamera(cfg, state, deltaTime);

        if (state.sign && now > state.sign.until) state.sign = null;

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
                if (kart.finished) continue;

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

            if (kart.state === 'grid') continue;

            if (kart.state === 'running') {
                // Depart rate : le kart reste sur place, moteur noye.
                if (kart.startStallUntil > now) continue;

                // Un kart qui a fini ne ramasse plus rien : il rentre au ralenti.
                if (!kart.finished && kart.pendingItemGrantTime && now > kart.pendingItemGrantTime) {
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

                if (kart.finished) {
                    effectiveSpeed = Math.min(effectiveSpeed, kart.stats.topSpeed * cfg.race.finishedSpeedRatio);
                }

                if (now < kart.brakeUntil) {
                    effectiveSpeed *= cfg.ai.edgeBrakeFactor;
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
                    kart.lapCount++;
                    kart.hasPassedFinishLine = true;
                }

                if (!kart.finished && kart.totalDistance >= kart.finishDistance) {
                    kart.finished = true;
                    kart.finishRank = state.finishOrder.length + 1;
                    state.finishOrder.push(kart.id);

                    // Il ne se sert plus de ce qu'il tient : autant le lui
                    // retirer, sinon une banane trainerait derriere lui
                    // jusqu'au bout du tour d'honneur.
                    if (kart.heldItem) {
                        if (kart.heldItem.holdPosition === 'orbit') {
                            for (const orb of kart.heldItem.orbs) {
                                events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: orb.id });
                            }
                        } else {
                            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                        }
                        kart.heldItem = null;
                        kart.trailTime = 0;
                    }

                    events.push({ type: 'kartFinished', kartId: kart.id, rank: kart.finishRank });
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
                                kart.trailTime = 0;
                                break;
                            }
                            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: kart.heldItem.id });
                            kart.heldItem = null;
                            kart.trailTime = 0;

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

                // Passage de la main au trainage : c'est le seul moment ou la
                // hitbox de l'objet s'active.
                if (kart.heldItem && kart.trailTime && now > kart.trailTime
                    && kart.heldItem.holdPosition === 'hands') {
                    kart.heldItem.holdPosition = 'behind';
                    kart.trailTime = 0;
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

        // Rien ne casse une bleue, pas meme une autre bleue : elles sont hors de
        // cette passe, des deux cotes.
        for (let i = state.items.length - 1; i >= 0; i--) {
            const item = state.items[i];
            if (item.isDead || item.spent) continue;
            if (item.type === 'blueShell' || item.type === 'blueBlast') continue;

            for (let j = i - 1; j >= 0; j--) {
                const other = state.items[j];
                if (other.isDead || other.spent) continue;
                if (other.type === 'blueShell' || other.type === 'blueBlast') continue;
                const dx = Math.abs(getShortestDistance(cfg, item.worldX, other.worldX));
                const dy = Math.abs(item.y - other.y);
                if (dx < cfg.hitboxes.itemVsKart.x && dy < cfg.hitboxes.itemVsKart.y) {
                    spendItem(cfg, item, now);
                    spendItem(cfg, other, now);
                }
            }
        }

        for (let i = state.items.length - 1; i >= 0; i--) {
            const item = state.items[i];
            if (item.isDead) continue;

            if (item.type === 'blueShell') {
                updateBlueShell(cfg, state, now, item, deltaTime, events);
                if (now - item.lastAnimTime > cfg.itemAnim.blueShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.lastAnimTime = now;
                }
                continue;
            }

            if (item.type === 'blueBlast') {
                updateBlueBlast(cfg, state, now, item, events);
                continue;
            }

            // Vol en cloche. La montee est inoffensive, la banane ne redevient
            // dangereuse qu'a la redescente : le sommet de l'arc est atteint la
            // ou sin() culmine, soit progress^bananaLobRise == 0.5.
            if (item.flightUntil) {
                const total = cfg.speeds.bananaLobDurationMs;
                const progress = Math.min(1, 1 - (item.flightUntil - now) / total);

                item.worldX = item.flightFrom + (item.flightTo - item.flightFrom) * progress;
                if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
                item.hop = Math.sin(Math.PI * Math.pow(progress, cfg.speeds.bananaLobRise)) * cfg.speeds.bananaLobHeight;

                if (item.rising && progress >= Math.pow(0.5, 1 / cfg.speeds.bananaLobRise)) {
                    item.rising = false;
                }

                if (progress >= 1) {
                    item.flightUntil = 0;
                    item.hop = 0;
                    item.vx = 0;
                    item.rising = false;
                    // La duree de vie ne court qu'a l'atterrissage.
                    item.createdAt = now;
                }
            }

            if (item.type !== 'banana') {
                if (item.type === 'redShell' && item.targetKartId !== null) {
                    const target = state.kartsById[item.targetKartId];
                    if (target && (target.state === 'running' || target.state === 'hit')) {
                        const diffY = target.yPercent - item.y;
                        item.vy = diffY * cfg.speeds.redShellTrackingSpeed;
                    } else {
                        // Cible de repli cherchee dans le sens de deplacement.
                        const dir = item.vx >= 0 ? 1 : -1;
                        let newTarget = null;
                        let bestDist = Infinity;
                        for (let k = 0; k < kartsLen; k++) {
                            const candidate = state.karts[k];
                            if (candidate.id === item.shooterId) continue;
                            if (candidate.state !== 'running') continue;
                            const dist = getShortestDistance(cfg, candidate.worldX, item.worldX) * dir;
                            if (dist >= cfg.speeds.redShellMinTarget && dist < bestDist) {
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
                if (now - item.lastAnimTime > cfg.itemAnim.greenShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.lastAnimTime = now;
                }
            } else if (item.type === 'redShell') {
                if (now - item.lastAnimTime > cfg.itemAnim.redShell.animSpeed) {
                    item.currentFrame = (item.currentFrame % 3) + 1;
                    item.lastAnimTime = now;
                }
            }
            if (item.type === 'banana' && now - item.createdAt > cfg.delays.bananaLife) {
                item.isDead = true;
            }

            if (!item.armed) {
                const shooter = state.kartsById[item.shooterId];
                if (!shooter || Math.abs(getShortestDistance(cfg, item.worldX, shooter.worldX)) > cfg.itemArmDistance) {
                    item.armed = true;
                }
            }

            if (item.spent) continue;
            // Hitbox coupee sur toute la montee de la cloche.
            if (item.rising) continue;

            for (let k = 0; k < kartsLen; k++) {
                const kart = state.karts[k];
                if (item.type === 'banana' && kart.id === item.shooterId && !item.armed) continue;
                if ((item.type === 'greenShell' || item.type === 'redShell') && kart.id === item.shooterId) continue;
                if (kart.state !== 'running' && kart.state !== 'hit') continue;

                if (kart.isInvincible) {
                    const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                    const dky = Math.abs(item.y - kart.yPercent);
                    if (dk < cfg.hitboxes.itemVsKart.x && dky < cfg.hitboxes.itemVsKart.y) {
                        spendItem(cfg, item, now);
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
                         kart.trailTime = 0;
                         spendItem(cfg, item, now);
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
                            spendItem(cfg, item, now);
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
                    spendItem(cfg, item, now);
                    break;
                }
            }
        }

        let writeIdx = 0;
        for (let i = 0; i < state.items.length; i++) {
            const it = state.items[i];
            if (it.spent && now >= it.deadAt) it.isDead = true;
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

    function countdownDuration(race) {
        return race.countdownHoldMs + 2 * race.lightIntervalMs;
    }

    // `startOrder` est l'ordre d'arrivee de la course precedente : le vainqueur
    // repart en pole. Absent, la grille est tiree au sort.
    function createWorldState(cfg, rng, now, startOrder) {
        const roadHeight = cfg.road.maxY - cfg.road.minY;
        const race = cfg.race;
        const countdownMs = countdownDuration(race);

        const itemBoxes = [];
        for (let i = 0; i < cfg.world.itemBoxCount; i++) {
            itemBoxes.push({
                worldX: cfg.world.itemBoxX,
                y: cfg.road.minY + (i * (roadHeight / (cfg.world.itemBoxCount - 1))),
                active: true,
                reactivateTime: 0
            });
        }

        const roster = Object.keys(cfg.characterStats);
        const names = (startOrder && startOrder.length === roster.length)
            ? startOrder.slice()
            : shuffleArray(roster, rng);

        const karts = [];
        const kartsById = {};

        names.forEach((charName, index) => {
            const row = Math.floor(index / race.grid.lanes.length);
            const col = index % race.grid.lanes.length;

            const gapToLine = race.grid.backOffset + row * race.grid.rowGap + col * race.grid.colStagger;
            let worldX = cfg.world.finishLineX - gapToLine;
            if (worldX < 0) worldX += cfg.world.width;

            const depth = race.grid.lanes[col] + row * race.grid.laneSlope;
            const verticalPos = Math.min(cfg.road.maxY,
                                         Math.max(cfg.road.minY, cfg.road.minY + roadHeight * depth));
            const stats = cfg.characterStats[charName];

            const kart = {
                id: index,
                charName: charName,
                worldX: worldX,
                yPercent: verticalPos,
                totalDistance: 0,

                stats: stats,
                absoluteVelocity: 0,
                momentum: 0,
                momentumTarget: getNewMomentumTarget(rng, stats),
                nextMomentumChange: now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax),
                vy: 0,
                targetVy: 0,

                state: 'grid',
                rank: index + 1,

                aiState: 'cruising',
                originalLaneY: verticalPos,
                dodgeIntensity: 30,

                hitEndTime: 0,
                heldItem: null,
                throwTime: 0,
                pendingItemGrantTime: 0,

                boostEndTime: 0,
                starEndTime: 0,
                isInvincible: false,
                hitInvincibleUntil: 0,

                trailTime: 0,
                brakeUntil: 0,
                shotDirection: 1,
                lobbing: false,
                aimError: 0,
                threatItemId: 0,
                threatReactAt: 0,
                threatIgnored: false,
                dodgePlanId: 0,
                dodgeDir: 0,
                dodgeStuck: false,
                dodgeCrossing: false,
                nextWanderTime: now + randomRange(rng, 1000, 5000),
                wanderEndTime: 0,
                wanderVy: 0,

                lapCount: 0,
                hasPassedFinishLine: false,
                stopped: false,

                // Cinq tours pleins, plus le bout de piste qui separe la place
                // de grille de la ligne. Ce segment initial ne compte pas comme
                // un tour : il vaut moins d'une seconde.
                finishDistance: race.laps * cfg.world.width + gapToLine,
                finished: false,
                finishRank: 0,
                startStallUntil: 0,

                currentSpinFrame: 0
            };

            karts.push(kart);
            kartsById[index] = kart;
        });

        return {
            cameraX: parkPosition(cfg, race.parkStartOffset),
            bgCameraX: 0,
            karts: karts,
            kartsById: kartsById,
            items: [],
            itemBoxes: itemBoxes,
            cachedLeader: null,

            phase: 'countdown',
            countdownMs: countdownMs,
            startAt: now + countdownMs,
            resultsAt: 0,
            leaderLap: 1,
            finalSignShown: false,
            flagShown: false,
            finishOrder: [],
            cameraSpeed: cfg.speeds.roadPPS,
            // Panneau tenu par Lakitu : { group, frame, until }.
            sign: { group: 'start', frame: 1, until: now + countdownMs + race.goSignMs },

            nextItemId: 1,
            blueShellChance: 0,
            previousRanking: [],
            lastLeaderboardUpdate: 0
        };
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
        updateLeaderboard,
        createWorldState,
        stepPhysics
    };
});
