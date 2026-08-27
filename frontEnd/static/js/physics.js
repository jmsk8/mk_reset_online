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

    // Meilleure pointe qu'un objet autre que le bill permet d'atteindre, tous
    // personnages confondus.
    function fastestBoostedSpeed(cfg) {
        const names = Object.keys(cfg.characterStats);
        let best = 0;
        for (let i = 0; i < names.length; i++) {
            const top = cfg.characterStats[names[i]].topSpeed;
            const shroom = top + cfg.speeds.shroomBoost;
            const star = top * cfg.speeds.starSpeedMultiplier;
            if (shroom > best) best = shroom;
            if (star > best) best = star;
        }
        return best;
    }

    // Vitesse de croisiere du bill : le multiplicateur du porteur, releve au
    // plancher commun quand celui-ci est plus haut.
    function getBillSpeed(cfg, state, kart) {
        return Math.max(kart.stats.topSpeed * cfg.bill.speedMultiplier, state.billFloorSpeed);
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
    // l'arret. `tau` est la constante de temps du lissage applique plus bas a
    // `vy` : sur une reaction courte, une bonne part du trajet passe dans la
    // montee en regime.
    function lateralReach(cfg, handling, intensity, ms) {
        const t = ms / 1000;
        const tau = 1 / (cfg.physics.smoothingFactor * handling);
        return intensity * (t - tau * (1 - Math.exp(-t / tau)));
    }

    // Probabilite qu'un kart ne voie pas venir la menace. La difficulte se
    // mesure en distance : ce qu'il peut couvrir avant l'impact, rapporte a ce
    // qu'il doit couvrir pour degager. Le tirage s'efface a mesure que cette
    // marge grandit.
    function missChance(cfg, kart, threatY, spareMs) {
        const ai = cfg.ai;
        const handling = kart.stats.handling;
        const base = ai.dodgeMissChance / handling;

        // Il passe deja assez a cote pour que la hitbox le manque.
        const need = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin
            - Math.abs(threatY - kart.yPercent);
        if (need <= 0) return 0;
        if (spareMs <= 0) return base;

        // Capacite type : l'intensite reelle n'est tiree qu'au moment de
        // s'ecarter.
        const intensity = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * handling;
        const ease = lateralReach(cfg, handling, intensity, spareMs) / need;

        if (ease <= 1) return base;
        if (ease >= ai.dodgeEasyRatio) return 0;
        return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
    }

    // Cote d'esquive et intensite, arretes une fois pour toutes a la premiere
    // reaction a une menace donnee.
    //
    // Le cote naturel est celui qui eloigne de l'objet. Quand le bord de piste
    // le condamne, le kart jauge la traversee par l'autre cote, devant l'objet :
    // il lui faut la place et le temps, et il n'estime le second qu'a vue (cf.
    // ai.crossJudgeError). Sans issue des deux cotes, il ne reste que le frein.
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
        // detection ouvre plus large que la hitbox.
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

        // Colle au bord : il pousse quand meme du cote naturel, pour grappiller
        // le peu de place restante, et lache les gaz.
        kart.dodgeDir = naturalDir;
        kart.dodgeStuck = true;
        kart.dodgeCrossing = false;
    }

    // Un kart devant, dans la voie de la boite, la prendra le premier : de son
    // point de vue elle est deja partie. Meme condition d'etat que la collecte,
    // une toupie ramasse aussi bien qu'un kart lance.
    function isBoxContested(cfg, state, kart, box, boxDist) {
        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id === kart.id) continue;
            if (other.state !== 'running' && other.state !== 'hit') continue;
            if (other.finished) continue;

            const d = getShortestDistance(cfg, other.worldX, kart.worldX);
            if (d <= 0 || d > boxDist) continue;
            if (Math.abs(other.yPercent - box.y) < cfg.hitboxes.itemBox.y) return true;
        }
        return false;
    }

    // Boite visee : la plus proche de sa trajectoire. Elles sont toutes sur la
    // meme verticale, l'ecart se mesure donc en profondeur, et celle d'en face
    // gagne d'office quand elle est libre. Aucune de libre, il tente quand meme
    // la plus proche : le kart qui la lui bouche peut encore la manquer.
    function findTargetBox(cfg, state, kart) {
        let free = null;
        let freeDiff = Infinity;
        let fallback = null;
        let fallbackDiff = Infinity;

        for (let i = 0; i < state.itemBoxes.length; i++) {
            const box = state.itemBoxes[i];
            if (!box.active) continue;

            const dist = getShortestDistance(cfg, box.worldX, kart.worldX);
            if (dist <= 0 || dist > cfg.ai.boxDetectionRange) continue;

            const diff = Math.abs(box.y - kart.yPercent);
            if (diff < fallbackDiff) {
                fallbackDiff = diff;
                fallback = box;
            }

            if (diff < freeDiff && !isBoxContested(cfg, state, kart, box, dist)) {
                freeDiff = diff;
                free = box;
            }
        }

        return free || fallback;
    }

    function updateAI(cfg, state, rng, now, kart, deltaTime) {
        if (kart.state !== 'running') return;

        let dangerFound = false;
        let avoidDirection = 0;

        const handling = kart.stats.handling;
        const ai = cfg.ai;

        // Un bill ne se pilote pas : il rejoint le milieu de la piste et n'en
        // bouge plus. Ni esquive, ni depassement, ni derive — il ne voit rien, et
        // de toute facon rien ne peut le toucher.
        if (kart.isBill) {
            const mid = (cfg.road.minY + cfg.road.maxY) / 2;
            const diff = mid - kart.yPercent;
            const speed = cfg.bill.centerSpeed;
            kart.targetVy = Math.abs(diff) < 0.2 ? 0 : (diff > 0 ? speed : -speed);
            kart.vy += (kart.targetVy - kart.vy) * cfg.physics.smoothingFactor * handling * deltaTime;
            return;
        }

        // Menace la plus urgente, mesuree en temps avant impact. Un objet qui
        // s'eloigne n'en est pas une — ce qui evite au passage qu'un kart fuie
        // la carapace qu'il vient de tirer.
        let threatId = 0;
        let threatY = 0;
        let threatTtc = Infinity;

        // Le lourd regarde plus loin que le vif — voir ai.threatWindowMs.
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

                // Ce qui restera une fois le reflexe passe, et non le delai
                // brut avant impact : c'est lui qui dit si l'esquive etait a
                // sa portee.
                kart.threatIgnored = rng() < missChance(cfg, kart, threatY, threatTtc - reactMs);
            }

            if (!kart.threatIgnored && now >= kart.threatReactAt) {
                dangerFound = true;
                if (kart.dodgePlanId !== threatId) {
                    planDodge(cfg, rng, kart, threatId, threatY, threatTtc);
                }
                avoidDirection = kart.dodgeDir;

                // Le frein n'accompagne que les esquives qui ne sont pas
                // franches : acculle il n'a plus que lui, en traversee il recule
                // l'impact le temps de passer devant l'objet.
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
            const dir = getShotDirection(state, kart);
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
            const box = findTargetBox(cfg, state, kart);
            if (box) {
                const diffY = box.y - kart.yPercent;
                boxTargetFound = true;

                // Deja dans l'axe : il tient sa ligne. Le laisser repartir en
                // maraude le ferait deriver hors de la boite qu'il vise.
                kart.targetVy = (Math.abs(diffY) > cfg.ai.boxAlignTolerance)
                    ? ((diffY > 0) ? cfg.ai.boxSeekIntensity : -cfg.ai.boxSeekIntensity) * handling
                    : 0;
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

    // Etoile et bill sont le meme etat vu de la physique : intouchable, et
    // blessant au contact. Toutes les collisions posent cette question-la, jamais
    // « a-t-il une etoile » — sans quoi chaque nouvel objet de ce genre obligerait
    // a repasser sur les huit sites de collision.
    function isRamming(kart) {
        return kart.isInvincible || kart.isBill;
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

    // Distribution des objets : modele documente en tete de `itemDistribution`
    // dans physics-config.js. Ce qui suit n'en est que l'evaluation, aucun
    // objet n'est nomme ici.

    function clamp01(value) {
        return value < 0 ? 0 : (value > 1 ? 1 : value);
    }

    // Monte de 0 en `from` a 1 en `to`, plate au-dela des deux bornes.
    function ramp(value, from, to) {
        if (to === from) return value < from ? 0 : 1;
        return clamp01((value - from) / (to - from));
    }

    // Un descripteur illisible vaut 1 plutot que de faire disparaitre l'objet.
    function curveFactor(seg, x) {
        if (seg.rise) {
            const floor = seg.floor || 0;
            return floor + (1 - floor) * ramp(x, seg.rise[0], seg.rise[1]);
        }
        if (seg.fall) {
            const depth = (seg.depth === undefined) ? 1 : seg.depth;
            return 1 - depth * ramp(x, seg.fall[0], seg.fall[1]);
        }
        if (seg.bell !== undefined) {
            return Math.max(0, 1 - Math.abs(x - seg.bell) / seg.width);
        }
        return 1;
    }

    // Produit des facteurs d'une courbe ; absente, elle vaut 1.
    function curve(segments, x) {
        if (!segments) return 1;
        let value = 1;
        for (let i = 0; i < segments.length; i++) value *= curveFactor(segments[i], x);
        return value > 0 ? value : 0;
    }

    // Le dernier encore en course. Pendant de getRacingLeader : ensemble ils
    // donnent l'etalement du peloton.
    function getRacingTail(state) {
        let worst = null;
        for (let i = 0; i < state.karts.length; i++) {
            const kart = state.karts[i];
            if (kart.finished) continue;
            if (kart.state !== 'running' && kart.state !== 'hit') continue;
            if (!worst || kart.rank > worst.rank) worst = kart;
        }
        return worst;
    }

    // Avancement du premier, 0 au depart a 1 a l'arrivee : mesure d'etape
    // commune a tous les karts.
    function getRaceStage(state) {
        const leader = state.cachedLeader;
        if (!leader || !leader.finishDistance) return 0;
        return clamp01(leader.totalDistance / leader.finishDistance);
    }

    // Les mesures dont depend toute la distribution, calculees a la demande.
    function computeItemAxes(cfg, state, kart) {
        const spec = cfg.itemDistribution;
        const count = state.karts.length;

        const p = count > 1 ? clamp01((kart.rank - 1) / (count - 1)) : 0;
        const d = clamp01(getDistanceToLeader(state, kart) / spec.distanceRef);
        const s = getRaceStage(state);

        const ahead = getKartByRank(state, kart.rank - 1);
        const gapAhead = ahead ? remainingDistance(kart) - remainingDistance(ahead) : 0;
        const g = clamp01(gapAhead / spec.gapRef);

        const tail = getRacingTail(state);
        const spread = tail ? getDistanceToLeader(state, tail) : 0;
        const i = spec.spreadShare * clamp01(spread / spec.spreadRef)
            + (1 - spec.spreadShare) * g;

        const pressure = (spec.rankShare * p + (1 - spec.rankShare) * d)
            * (spec.stageBoost.base + spec.stageBoost.gain * s)
            * (spec.packBoost.base + spec.packBoost.gain * i);

        return { p: p, d: d, s: s, g: g, i: i, pressure: pressure };
    }

    // Rang minimal exige ; `lastRanks` se compte depuis la fin de grille et
    // l'emporte s'il est plus restrictif.
    function minRankFor(profile, kartCount) {
        let min = profile.minRank || 1;
        if (profile.lastRanks) min = Math.max(min, kartCount - profile.lastRanks + 1);
        return min;
    }

    // Decote : chaque exemplaire distribue divise le poids du suivant, pour
    // tout le monde, resorbee tour apres tour. La bleue suit la meme regle via
    // son propre bloc de config.
    function decaySpecFor(cfg, itemType) {
        if (itemType === 'blueShell') return cfg.blueShell;
        const profile = cfg.itemDistribution.items[itemType];
        return (profile && profile.decay) ? profile : null;
    }

    // 1 tant qu'aucun exemplaire n'a ete distribue.
    function itemDecayOf(state, itemType) {
        const value = state.itemDecay[itemType];
        return (value === undefined) ? 1 : value;
    }

    function applyItemDecay(cfg, state, itemType) {
        const spec = decaySpecFor(cfg, itemType);
        if (!spec) return;
        state.itemDecay[itemType] = itemDecayOf(state, itemType) * spec.decay;
    }

    // A chaque tour entame par le premier.
    function regenItemDecay(cfg, state) {
        for (const itemType in state.itemDecay) {
            const spec = decaySpecFor(cfg, itemType);
            if (!spec || !spec.regenPerLap) continue;
            state.itemDecay[itemType] = Math.min(1, state.itemDecay[itemType] + spec.regenPerLap);
        }
    }

    // Reflux de fin de course.
    //
    // Les objets rares se concentrent naturellement sur le dernier tour : c'est
    // la que les ecarts sont les plus grands, donc la pression aussi, et pour la
    // bleue l'echappee du premier. Le systeme fonctionne, mais le resultat n'est
    // pas souhaitable — une bleue ou un eclair quasi certains au dernier tour
    // tuent le suspense, puisque ce qui est acquis n'a plus d'enjeu.
    //
    // Ce terme ne corrige pas la pression : il s'applique par-dessus, et
    // seulement sur la fin. Un objet qui ne declare pas `lateFade` n'est pas
    // concerne. Applique aussi bien aux objets puissants qu'aux tactiques, la
    // bleue le lisant de son propre bloc de config.
    function lateFadeFactor(spec, stage) {
        const fade = spec && spec.lateFade;
        if (!fade) return 1;
        return 1 - fade.depth * ramp(stage, fade.from, fade.to);
    }

    // Un seul exemplaire en circulation ; un orage en cours compte pour l'eclair.
    function isSingletonFree(state, itemType) {
        if (itemType === 'lightning' && state.storm) return false;
        for (let i = 0; i < state.karts.length; i++) {
            const held = state.karts[i].heldItem;
            if (held && held.type === itemType) return false;
        }
        return true;
    }

    // Poids d'un objet pour ce kart, dans cette situation. Zero se lit « pas
    // lui, pas ici, pas maintenant » : desactive, verrouille, ou courbe eteinte.
    function itemWeight(cfg, state, kart, itemType, profile, axes) {
        if (!isItemEnabled(cfg, itemType)) return 0;
        if (profile.minStage && axes.s < profile.minStage) return 0;
        if (profile.minDist && axes.d < profile.minDist) return 0;
        if (kart.rank < minRankFor(profile, state.karts.length)) return 0;
        if (profile.unique && !isSingletonFree(state, itemType)) return 0;

        let weight = profile.base;

        if (profile.power) {
            // Les objets puissants ne lisent que la pression.
            weight *= ramp(axes.pressure, profile.power.open, profile.power.full);
        } else {
            weight *= curve(profile.rank, axes.p);
            weight *= curve(profile.dist, axes.d);
            weight *= curve(profile.stage, axes.s);
            weight *= curve(profile.gap, axes.g);
        }

        if (profile.packBonus) weight *= 1 + profile.packBonus * (1 - axes.i);
        weight *= lateFadeFactor(profile, axes.s);
        if (kart.lastItem === itemType) weight *= cfg.itemDistribution.repeatPenalty;
        weight *= itemDecayOf(state, itemType);

        return weight > 0 ? weight : 0;
    }

    // Tirage a part, joue avant les poids : declenche par l'echappee du
    // premier, pas par le retard du tireur.
    function rollBlueShell(cfg, state, rng, now, kart) {
        const spec = cfg.blueShell;
        if (!isItemEnabled(cfg, 'blueShell')) return false;
        if (now - state.blueShellLastAt < spec.cooldownMs) return false;

        // Un rang absent de la table n'en recoit jamais.
        const rankWeight = spec.rankWeights[kart.rank] || 0;
        if (rankWeight <= 0) return false;

        const leader = state.cachedLeader;
        if (!leader || leader.id === kart.id) return false;

        const second = getKartByRank(state, 2);
        const lead = second ? remainingDistance(second) - remainingDistance(leader) : 0;
        const escape = clamp01(lead / spec.leadRef);

        const stage = getRaceStage(state);
        const chance = spec.baseChance
            * ramp(stage, spec.stageWindow.from, spec.stageWindow.to)
            * lateFadeFactor(spec, stage)
            * (spec.leadFloor + spec.leadGain * escape)
            * rankWeight
            * itemDecayOf(state, 'blueShell');

        return chance > 0 && rng() < chance;
    }

    function rollItem(cfg, state, rng, now, kart) {
        if (rollBlueShell(cfg, state, rng, now, kart)) {
            applyItemDecay(cfg, state, 'blueShell');
            state.blueShellLastAt = now;
            return 'blueShell';
        }

        const profiles = cfg.itemDistribution.items;
        const axes = computeItemAxes(cfg, state, kart);

        // Seuls les poids non nuls entrent dans le tirage : un objet verrouille
        // ne peut donc pas etre choisi par un rng() rendant exactement 0.
        const pool = [];
        let total = 0;
        for (const itemType in profiles) {
            const weight = itemWeight(cfg, state, kart, itemType, profiles[itemType], axes);
            if (weight <= 0) continue;
            pool.push({ type: itemType, weight: weight });
            total += weight;
        }

        // Tout peut etre verrouille au meme instant : dans ce cas le kart repart
        // sans objet plutot que d'en recevoir un que la config interdit.
        if (total <= 0) return null;

        let roll = rng() * total;
        let chosen = pool[pool.length - 1].type;
        for (let i = 0; i < pool.length; i++) {
            roll -= pool[i].weight;
            if (roll <= 0) { chosen = pool[i].type; break; }
        }

        applyItemDecay(cfg, state, chosen);
        return chosen;
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

    // Agressivite du kart, de 0 a 1. Le rang et l'ecart au premier se
    // multiplient : etre dernier au milieu du peloton, ou deuxieme a une demi
    // piste, ne suffit pas — il faut les deux pour n'avoir plus rien a perdre.
    // La racine remonte le resultat, sans quoi deux moities donneraient un
    // quart et personne ne serait jamais agressif.
    //
    // L'etape de course pondere le tout : un dernier a quatre tours de la fin a
    // le temps de voir venir, le meme dans le dernier tour n'a plus que ses
    // objets. Le facteur vaut 1 a l'arrivee, jamais plus : la fin de course
    // retrouve exactement l'agressivite d'avant ce terme, le debut est calme.
    function getAggression(cfg, state, kart) {
        const spec = cfg.ai.aggression;
        const total = state.karts.length;

        const rankTerm = (total > 1) ? (kart.rank - 1) / (total - 1) : 0;

        const dist = getDistanceToLeader(state, kart);
        const distTerm = (spec.distanceRef > 0)
            ? Math.min(Math.max(dist, 0), spec.distanceRef) / spec.distanceRef
            : 0;

        // Lue sur le premier : c'est lui qui decide du temps qu'il reste aux
        // autres, pas le retard de celui qui le subit.
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

        // Le premier defend : rien ne part devant lui, la banane est posee et
        // non lobee. Son attaque, c'est la verte ou la banane laissee derriere.
        // La place au moment du plan est retenue : si le kart se fait doubler
        // avant de lancer, ce plan ne vaudra plus rien (voir getShotDirection).
        kart.shotAsLeader = (kart.rank === 1);
        if (kart.shotAsLeader) {
            kart.lobbing = false;
            kart.shotDirection = -1;
        }

        kart.aimError = randomRange(rng, -ai.aimErrorMax, ai.aimErrorMax) / kart.stats.handling;

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

    // Note d'un candidat pour la rouge, exprimee en distance equivalente : la
    // plus basse gagne. Au-dela de `redShellComfortTarget`, un kart vaut son
    // ecart brut, comme avant. En dessous il reste eligible, mais recule dans le
    // classement d'autant plus qu'il est colle au tireur.
    //
    // C'est une pente et non un seuil, et c'est tout l'objet de la fonction. Avec
    // le simple plancher d'avant, un kart a un pixel sous la barre etait ecarte
    // exactement comme un kart au pare-chocs : la rouge allait viser derriere lui
    // — ou partait sans cible du tout quand il etait seul devant — en laissant
    // filer une proie qu'elle pouvait parfaitement toucher. C'est le « saute un
    // ennemi en face » qu'on observait.
    //
    // Le plancher qui subsiste est le seul que la physique impose : l'objet ne
    // s'arme qu'a `itemArmDistance` du tireur (voir la boucle d'armement dans
    // stepPhysics) et traverse tout sans effet avant ca. Viser plus pres que
    // cette distance n'est pas « difficile », c'est litteralement sans effet.
    //
    // Rend Infinity pour un candidat inatteignable, ce qui l'exclut de fait —
    // les karts derriere le tireur compris, leur `dist` etant negative.
    function redShellTargetScore(cfg, dist) {
        const floor = cfg.speeds.redShellMinTarget;
        if (dist < floor) return Infinity;

        const comfort = cfg.speeds.redShellComfortTarget;
        if (dist >= comfort) return dist;

        // Au carre : la penalite reste negligeable au bord du confort et ne mord
        // vraiment que sur les cibles au contact. Une penalite lineaire ferait
        // exactement l'inverse de ce qu'on cherche, en decalant tout le monde.
        const shortfall = (comfort - dist) / (comfort - floor);
        return dist + cfg.speeds.redShellClosePenalty * shortfall * shortfall;
    }

    // Le meilleur candidat devant, au sens de la note ci-dessus. Null seulement
    // si personne n'est atteignable, c'est-a-dire si tout le monde est sous le
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
    // changements de place qui l'invalident.
    //
    // Le premier ne lance jamais devant lui — personne a viser de ce cote, et
    // une carapace partie vers l'avant depuis la tete ne peut que revenir sur un
    // retardataire au tour suivant. A l'inverse, un kart qui tenait la tete a la
    // reception et s'est fait doubler depuis n'a plus aucune raison de tirer
    // derriere : son plan valait pour une place qu'il n'occupe plus, il vise
    // devant comme n'importe quel poursuivant.
    //
    // Les deux regles sont ici et non dans le tirage, pour qu'elles suivent la
    // place reelle au moment du lancer.
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
            let dir = 1;
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
                // son propre kart. Le premier tire derriere, elle part donc de
                // l'arriere.
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
        // l'orage qui frappe. Ciel noir, eclairs et malus tombent ensemble, a
        // `strikeAt` — la date reste un cran de reglage, mais elle vaut zero.
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

        // Le bill ne se lance pas : le kart devient le projectile. Meme famille
        // que l'etoile — un etat du kart, avec sa date de fin.
        if (held.type === 'bill') {
            const spec = cfg.bill;

            kart.isBill = true;
            kart.billStartedAt = now;
            kart.billEndTime = now + spec.durationMs;
            kart.billSlowUntil = 0;
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
            kart.momentum = 1.0;

            events.push({ type: 'billOn', kartId: kart.id });
            events.push({ type: 'removeHeldItem', kartId: kart.id, itemId: held.id });
            kart.heldItem = null;
            kart.trailTime = 0;
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
            // On ne peut pas etre invincible et ecrase en meme temps : l'etoile
            // rend sa taille au kart, comme elle le protege de la foudre a venir.
            kart.shrinkEndTime = 0;
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
                    if (dx >= cfg.hitboxes.orbitItemVsKart.x || dy >= cfg.hitboxes.orbitItemVsKart.y) continue;

                    // Une etoile ou un bill encaisse l'objet sans etre ralenti,
                    // mais le consomme quand meme : le bouclier s'use au contact.
                    if (!isRamming(victim)) {
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

    // Classement reel, recalcule a chaque pas. Il porte `rank` et
    // `cachedLeader`, dont dependent la distribution d'objets, l'agressivite et
    // toutes les regles de place de l'IA — un rang vieux d'une demi-seconde
    // ferait planifier un objet avec la place precedente, et le premier tirer
    // vers l'avant juste apres avoir pris la tete. Trier huit karts ne coute
    // rien ; c'est l'animation de depassement, plus bas, qui doit etre cadencee.
    function updateRanks(state) {
        const karts = state.karts;
        const kartsLen = karts.length;

        const activeKarts = [];
        for (let i = 0; i < kartsLen; i++) {
            const k = karts[i];
            if (k.state === 'running' || k.state === 'hit') activeKarts.push(k);
        }
        if (activeKarts.length === 0) return null;

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
        for (let i = 0; i < activeKarts.length; i++) activeKarts[i].rank = i + 1;

        return activeKarts;
    }

    // Les evenements de depassement, eux, restent cadences : chacun declenche
    // une animation de glissement cote client, qui ne peut pas rejouer trente
    // fois par seconde. `previousRanking` n'avance qu'avec eux, pour que le
    // client voie bien le trajet complet d'une place a l'autre.
    function updateLeaderboard(state, now, events) {
        const activeKarts = updateRanks(state);
        if (!activeKarts) return;

        if (now - state.lastLeaderboardUpdate < 500) return;
        state.lastLeaderboardUpdate = now;

        const newRanking = [];
        const prevRanking = state.previousRanking;

        for (let i = 0; i < activeKarts.length; i++) {
            const kart = activeKarts[i];
            newRanking.push(kart.id);

            events.push({
                type: 'leaderboardPosition',
                kartId: kart.id,
                newPosition: i,
                prevPosition: prevRanking.indexOf(kart.id)
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

    // Points du grand prix, attribues une fois la course close. `racePoints`
    // ne vaut que pour la course qui vient de finir, `gpPoints` cumule depuis le
    // debut du bloc. Les deux sont indexes par personnage et non par kart : les
    // identifiants sont refaits a chaque course, les personnages non.
    function awardRacePoints(cfg, state) {
        const table = cfg.grandPrix.points;

        for (let i = 0; i < state.finishOrder.length; i++) {
            const kart = state.kartsById[state.finishOrder[i]];
            const points = (i < table.length) ? table[i] : 0;
            state.racePoints[kart.charName] = points;
            state.gpPoints[kart.charName] = (state.gpPoints[kart.charName] || 0) + points;
        }
    }

    // Enchainement des phases, et pilotage de la camera qui en decoule.
    function updateRace(cfg, state, rng, now, deltaTime, events) {
        const race = cfg.race;
        const leader = getLeader(state);

        // Tour du premier. `lapCount` compte les franchissements ; le premier
        // cloture le trajet depuis la grille et non un tour, d'ou le plancher a 1.
        //
        // Suivi hors de la machine a phases, et c'est essentiel : la camera passe
        // en approche deux tours avant la fin, si bien que tenir ce compteur dans
        // la seule phase 'racing' le figeait a 3 pour les deux derniers tours de
        // chaque course. Avec lui les decotes d'objets, qui ne se resorbaient
        // alors plus jamais — une bleue lancee au troisieme tour restait a demi
        // probabilite jusqu'a l'arrivee.
        if (state.phase === 'racing' || state.phase === 'finishing') {
            const lap = Math.min(race.laps, Math.max(1, leader.lapCount));
            if (lap !== state.leaderLap) {
                state.leaderLap = lap;
                regenItemDecay(cfg, state);
            }
        }

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

            // Deux facons de clore la course : le quota d'arrivees est atteint,
            // ou le delai large est depasse — un kart bloque ne doit pas figer
            // le service. Dans les deux cas les retardataires sont classes dans
            // l'ordre ou ils roulent.
            const quotaReached = state.finishOrder.length >= race.stopAtFinisher;
            const timedOut = now > state.startAt + race.maxRaceMs;

            if ((quotaReached || timedOut) && !state.resultsAt) {
                const stragglers = state.karts.filter(kart => !kart.finished)
                    .sort((a, b) => a.rank - b.rank);
                for (const kart of stragglers) {
                    kart.finished = true;
                    kart.finishRank = state.finishOrder.length + 1;
                    state.finishOrder.push(kart.id);
                }

                awardRacePoints(cfg, state);

                // La derniere course du bloc porte le classement general : on
                // laisse le temps de le lire.
                const isFinalRace = state.gpRound >= cfg.grandPrix.races;
                state.resultsAt = now + (isFinalRace ? race.finalResultsDelayMs : race.resultsDelayMs);
                state.phase = 'results';
                events.push({ type: 'raceFinished' });
            }
            return;
        }

        if (state.phase === 'results' && now >= state.resultsAt) {
            // Le service en tire une course neuve : c'est lui qui detient
            // createWorldState et les connexions a prevenir. `gpComplete` lui
            // dit s'il repart sur un bloc neuf — scores remis a zero et grille
            // tiree au sort — ou sur la course suivante du bloc en cours.
            events.push({
                type: 'raceOver',
                order: state.finishOrder.slice(),
                gpRound: state.gpRound,
                gpComplete: state.gpRound >= cfg.grandPrix.races,
                gpPoints: Object.assign({}, state.gpPoints)
            });
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

    // Duree du rapetissement : maximale pour le premier, minimale pour qui est
    // deja largue, lineaire entre les deux. C'est ce qui fait de l'eclair une
    // arme de fond de grille — il coute cher a ceux qui ont quelque chose a
    // perdre, et presque rien a celui qui l'a lance.
    function shrinkDuration(cfg, state, kart) {
        const spec = cfg.lightning;
        const dist = Math.min(getDistanceToLeader(state, kart), spec.shrinkFalloffDistance);
        const ratio = spec.shrinkFalloffDistance > 0 ? dist / spec.shrinkFalloffDistance : 0;
        return spec.shrinkMsMax + (spec.shrinkMsMin - spec.shrinkMsMax) * ratio;
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

    // Le tete-a-queue lui-meme, sans aucune condition : c'est a l'appelant de
    // decider qui l'encaisse. Chaque source a ses propres immunites.
    function spinOutKart(cfg, now, kart, events) {
        kart.state = 'hit';
        kart.hitEndTime = now + cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration;
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

    function stepPhysics(cfg, state, rng, now, deltaTime) {
        const events = [];

        updateRace(cfg, state, rng, now, deltaTime, events);
        updateStorm(cfg, state, now, events);
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
                updateBill(cfg, state, now, kart, events);

                // Le bill compte comme un boost : sans ca son elan interne
                // retomberait pendant le vol, et il sortirait de sa transformation
                // au ralenti au lieu de finir sur sa lancee.
                const isBoosted = kart.boostEndTime > now || kart.starEndTime > now || kart.isBill;

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

                // Applique en dernier, et sur le resultat de tout le reste : un
                // kart rapetisse est lent quoi qu'il tienne. Le drapeau double la
                // date parce que le protocole n'a pas d'horloge — il se lit tel
                // quel dans le snapshot, comme celui de l'etoile.
                if (kart.shrinkEndTime > now) {
                    effectiveSpeed *= cfg.lightning.speedFactor;
                    kart.isShrunk = true;
                } else if (kart.isShrunk) {
                    kart.isShrunk = false;
                    events.push({ type: 'shrinkOff', kartId: kart.id });
                }

                // Le bill passe en dernier et prime sur tout : rien ne ralentit un
                // projectile. La descente qui suit ramene la vitesse a celle du
                // kart, sans jamais le freiner en dessous — d'ou le Math.max.
                const billSpeed = getBillSpeed(cfg, state, kart);
                if (kart.isBill) {
                    effectiveSpeed = billSpeed;
                } else if (kart.billSlowUntil > now) {
                    const left = (kart.billSlowUntil - now) / cfg.bill.slowdownMs;
                    effectiveSpeed = Math.max(
                        effectiveSpeed,
                        kart.stats.topSpeed + (billSpeed - kart.stats.topSpeed) * left
                    );
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
                    // Le bill balaie plus large qu'un contact de carrosserie : il
                    // traverse la piste en trombe, il ne se faufile pas.
                    const box = (kart.isBill || other.isBill) ? cfg.bill.hitbox : cfg.hitboxes.kartVsKart;
                    if (dx < box.x && dy < box.y) {
                         // Deux intouchables ne se blessent pas : c'est ce qui met
                         // l'etoile hors d'atteinte du bill, et l'inverse.
                         //
                         // Deux bills font exception au « sans rien » : ils tiennent
                         // tous les deux le milieu de la piste, s'y traverser serait
                         // le seul endroit du jeu ou deux karts s'ignorent. Ils se
                         // bousculent donc, en tombant dans le bloc de poussee plus
                         // bas, mais attenue et sans degats.
                         const billOnBill = kart.isBill && other.isBill;

                         if (isRamming(kart) && isRamming(other) && !billOnBill) continue;

                         if (!billOnBill && isRamming(kart)) {
                             if (other.hitInvincibleUntil > now) continue;
                             spinOutKart(cfg, now, other, events);
                             continue;
                         }
                         if (!billOnBill && isRamming(other)) {
                             if (kart.hitInvincibleUntil > now) continue;
                             spinOutKart(cfg, now, kart, events);
                             continue;
                         }

                         const pushScale = billOnBill ? cfg.bill.pushFactor : 1;
                         const myWeight = kart.stats.weight;
                         const otherWeight = other.stats.weight;
                         const totalWeight = myWeight + otherWeight;
                         const myRatio = otherWeight / totalWeight;
                         const otherRatio = myWeight / totalWeight;
                         const pushForce = cfg.physics.pushForce * pushScale;
                         const myBounceY = cfg.physics.collisionBounceY * myRatio * pushScale;
                         const otherBounceY = cfg.physics.collisionBounceY * otherRatio * pushScale;
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
                            if (isRamming(victim)) {
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
                        let bestScore = Infinity;
                        for (let k = 0; k < kartsLen; k++) {
                            const candidate = state.karts[k];
                            if (candidate.id === item.shooterId) continue;
                            if (candidate.state !== 'running') continue;
                            const dist = getShortestDistance(cfg, candidate.worldX, item.worldX) * dir;
                            const score = redShellTargetScore(cfg, dist);
                            if (score < bestScore) {
                                bestScore = score;
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

                if (isRamming(kart)) {
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
    // repart en pole. Absent, la grille est tiree au sort — c'est le cas au
    // premier tour d'un nouveau grand prix.
    //
    // `grandPrix` reporte le bloc en cours : { round, points }, ou `round`
    // compte a partir de 1 et `points` cumule les scores par personnage. Absent,
    // la course ouvre un bloc neuf.
    function createWorldState(cfg, rng, now, startOrder, grandPrix) {
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

                // Rapetissement par l'eclair. La date pilote la simulation, le
                // booleen part dans le snapshot.
                shrinkEndTime: 0,
                isShrunk: false,

                // Bill Ball. `billAhead` retient qui reste a doubler : la vider
                // est ce qui raccourcit le vol.
                isBill: false,
                billStartedAt: 0,
                billEndTime: 0,
                billSlowUntil: 0,
                billAhead: [],

                trailTime: 0,
                brakeUntil: 0,
                shotDirection: 1,
                // Le plan de tir a-t-il ete fait en tete ? Il ne vaut plus rien
                // si le kart s'est fait doubler depuis.
                shotAsLeader: false,
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

                currentSpinFrame: 0,

                // Dernier objet recu, lu par le tirage suivant pour freiner
                // deux fois de suite le meme.
                lastItem: null
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

            // Grand prix. `gpRound` est le numero de cette course dans le bloc,
            // `gpPoints` le cumul par personnage a l'entree, `racePoints` ce que
            // cette course rapporte — vide tant qu'elle n'est pas close.
            gpRound: (grandPrix && grandPrix.round) || 1,
            gpPoints: Object.assign({}, (grandPrix && grandPrix.points) || null),
            racePoints: {},
            cameraSpeed: cfg.speeds.roadPPS,
            // Panneau tenu par Lakitu : { group, frame, until }.
            sign: { group: 'start', frame: 1, until: now + countdownMs + race.goSignMs },

            nextItemId: 1,
            // Decotes en cours, par type d'objet : absent vaut 1, c'est-a-dire
            // intact. Un type n'y entre qu'une fois sorti au moins une fois.
            itemDecay: {},
            // Garde-fou de delai propre a la bleue, arme des le depart pour ne
            // rien bloquer au premier tour.
            blueShellLastAt: now - cfg.blueShell.cooldownMs,
            // Plancher de vitesse du bill : ne depend que de la config.
            billFloorSpeed: fastestBoostedSpeed(cfg) * cfg.bill.minLeadRatio,
            // Orage en cours, ou null. Un seul a la fois.
            storm: null,
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
        computeItemAxes,
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
