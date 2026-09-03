// Un pas de simulation : l'ordre dans lequel le monde avance.
// Cette fonction n'invente rien — elle appelle, dans un ordre qui compte, ce que
// les autres modules savent faire. La lire, c'est lire la course.

import { randomRange } from './math.js';
import { crossedDepth, getShortestDistance } from './geometry.js';
import { steerCost } from './steering.js';
import { isRamming, shrunkReachX, shrunkReachY } from './bodies.js';
import { getActiveBoost, getBillSpeed, getMomentumSpeed, getNewMomentumTarget } from './stats.js';
import { updateLeaderboard } from './standings.js';
import { updateCamera } from './camera.js';
import { spendItem } from './items.js';
import { spinDuration, updateBill, updateBlueBlast, updateBlueShell, updateStorm } from './effects.js';
import { activateItem, destroyOrbitItem, getOrbitItemPosition, giveKartItem, redShellTargetScore, updateOrbitItems } from './weapons.js';
import { advanceProjectile, collideKartWithPipes } from './pipes.js';
import { clampKartToRoad, resolveKartContacts } from './road.js';
import { updateRace } from './race.js';
import { updateAI } from './ai.js';

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

        const kartsLen0 = state.karts.length;
        for (let k = 0; k < kartsLen0; k++) {
            const kart = state.karts[k];
            if (kart.state !== 'running' && kart.state !== 'hit') continue;
            if (kart.finished) continue;

            const dist = getShortestDistance(cfg, box.worldX, kart.worldX);
            const dy = Math.abs(box.y - kart.yPercent);
            if (Math.abs(dist) >= cfg.hitboxes.itemBox.x) continue;
            if (dy >= cfg.hitboxes.itemBox.y) continue;

            // Le passage se date en premier et sans condition : la zone se
            // traverse qu'il y reste un cube ou non. C'est l'endroit qui rend
            // prudent, pas le butin — celui qui suit vient peut-etre d'y prendre
            // de quoi tirer. C'est aussi pour ce releve que la boucle ne saute
            // plus les cubes eteints.
            kart.boxPassedAt = now;

            if (!box.active) continue;

            box.active = false;
            box.reactivateTime = now + cfg.delays.boxRespawn;
            if (!kart.heldItem) {
                kart.pendingItemGrantTime = now + cfg.delays.itemGrant;
            }
        }
    }

    const kartsLen = state.karts.length;

    for (let i = 0; i < kartsLen; i++) {
        const kart = state.karts[i];

        if (kart.state === 'grid') continue;

        // Double la date en booleen : le protocole n'a pas d'horloge, le drapeau
        // se lit tel quel dans le snapshot. Hors de la branche 'running', sinon
        // un kart percute pendant son choc le garderait fige.
        kart.bumped = now < kart.bumpEndTime;

        // Meme raison et meme place que le precedent.
        kart.isFlat = now < kart.flatEndTime;

        // Ce que les objets de vitesse rendent au volant : sans ce gain, un kart
        // lance perdrait de l'appui (`steer.pace`) et prendre un champignon
        // reviendrait a se rendre pataud au moment ou l'on double.
        //
        // Pose ici une fois par tick, comme les drapeaux ci-dessus : c'est ce qui
        // permet a `steerCap` de ne lire qu'un kart, sans horloge, et donc de
        // valoir pareil pour le pilotage et pour les planificateurs.
        kart.steerBoost = (now < kart.boostEndTime || now < kart.starEndTime)
            ? cfg.physics.steer.boostGain : 1;

        // Les deux canaux de choc s'amortissent seuls, avant d'etre consommes par
        // le deplacement. Ils valent pour les deux etats : une toupie encaisse
        // aussi.
        const bumpDecay = cfg.physics.contact.decay * deltaTime;
        const bumpKeep = bumpDecay > 1 ? 0 : 1 - bumpDecay;
        kart.bumpVy *= bumpKeep;
        kart.bumpVx *= bumpKeep;

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

            // Deux regimes, et `boost` seul les separe : sous objet la vitesse
            // vise la pointe de l'objet, hors objet elle suit l'elan du kart. Le
            // bill compte comme un objet, sans quoi il sortirait de sa
            // transformation au ralenti.
            const boost = getActiveBoost(cfg, state, kart, now);

            if (boost) {
                // La montee, et c'est tout ce qui se passe sous objet : le taux
                // d'une relance normale multiplie par la vivacite de l'objet. Le
                // `else` ramene d'un coup quand la pointe visee baisse — un
                // champignon qui s'eteint pendant une etoile, un bill qui rend la
                // main.
                const rampRate = cfg.speeds.accelerationRate * kart.stats.acceleration * boost.ramp;
                if (kart.absoluteVelocity < boost.peak) {
                    kart.absoluteVelocity = Math.min(boost.peak,
                        kart.absoluteVelocity + rampRate * deltaTime);
                } else {
                    kart.absoluteVelocity = boost.peak;
                }

                // L'elan est SUSPENDU, pas efface : l'objet porte le kart, et le
                // rythme qu'il avait avant l'attend a la sortie.
                //
                // Force a 1.0, il donnait a tout objet une seconde prime que
                // personne n'avait decidee — le kart ressortait a 100 % de sa
                // pointe pour le temps d'un tirage entier, soit pres de la moitie
                // de ce que rendait le champignon.
                //
                // La mise de cote se fait au premier tick et vaut pour toute la
                // chaine : deux objets qui se recouvrent ne font qu'une
                // suspension. Le compte a rebours est gele avec elle, sinon la
                // sortie tomberait sur une horloge qui a tourne dans le vide.
                if (kart.preBoostMomentum < 0) {
                    kart.preBoostMomentum = kart.momentum;
                    kart.preBoostDriftLeft = Math.max(0, kart.nextMomentumChange - now);
                }
            } else {
                // Fin de suspension : l'elan reprend la ou il en etait, pour le
                // temps qu'il lui restait. Pose avant la lecture de l'horloge,
                // pour qu'un compte a rebours arrive a terme pendant l'objet tire
                // des le premier tick libre.
                if (kart.preBoostMomentum >= 0) {
                    kart.momentum = kart.preBoostMomentum;
                    kart.nextMomentumChange = now + kart.preBoostDriftLeft;
                    kart.preBoostMomentum = -1;
                }

                if (now > kart.nextMomentumChange) {
                    kart.momentumTarget = getNewMomentumTarget(rng, cfg, kart.stats);
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

            // La pointe sous objet est deja dans `absoluteVelocity` : il ne
            // reste ici que ce qui peut la rogner.
            let effectiveSpeed = kart.absoluteVelocity;

            // Freiner au bord et rentrer au ralenti sont des decisions de
            // pilotage, et un objet n'est pas du pilotage : il ne se module pas.
            // C'est la seule facon que les trois rendent bien le multiplicateur
            // qu'on leur donne.
            if (!boost) {
                if (kart.finished) {
                    effectiveSpeed = Math.min(effectiveSpeed,
                        kart.stats.topSpeed * cfg.race.finishedSpeedRatio);
                }
                // Le frein porte sa propre severite : lever le pied pour laisser
                // passer une rouge n'est pas freiner devant un mur.
                // `edgeBrakeFactor` reste le defaut.
                if (now < kart.brakeUntil) {
                    effectiveSpeed *= kart.brakeFactor || cfg.ai.edgeBrakeFactor;
                }

                // Ce que braquer coute en vitesse. Une seule ligne, parce qu'une
                // seule fonction en decide (`steerCost`).
                //
                // Ici et pas ailleurs : le cout disparait a l'instant ou le kart
                // cesse de tourner, et il ne se compose pas avec `acceleration` —
                // rogner `targetSpeed` ferait payer la reprise une seconde fois
                // par une stat que la masse taxe deja. Sous objet, rien : un
                // champignon doit rendre le multiplicateur qu'on lui donne.
                //
                // Propriete acquise gratuitement : `steer` met la consigne a zero
                // des que la cible est tenue, donc le cout ne tombe que pendant
                // les TRANSITIONS. La ligne optimale devient « choisir tot, et
                // tenir ».
                //
                // Le compteur est pose ICI et nulle part ailleurs — seul endroit
                // qui connaisse les conditions du tick. C'est une observation,
                // aucune decision ne le lit.
                const cornerMult = steerCost(cfg, kart);
                kart.cornerLostPx += effectiveSpeed * (1 - cornerMult) * deltaTime;
                effectiveSpeed *= cornerMult;
            }

            // L'invincibilite ne dit plus rien de la vitesse : elle ne suit
            // que la date de l'etoile.
            if (kart.starEndTime > now) {
                kart.isInvincible = true;
            } else if (kart.isInvincible) {
                kart.isInvincible = false;
                events.push({ type: 'starOff', kartId: kart.id });
            }

            // Applique en dernier et sur le resultat de tout le reste : un kart
            // rapetisse est lent quoi qu'il tienne.
            if (kart.shrinkEndTime > now) {
                effectiveSpeed *= cfg.lightning.speedFactor;
                kart.isShrunk = true;
            } else if (kart.isShrunk) {
                kart.isShrunk = false;
                events.push({ type: 'shrinkOff', kartId: kart.id });
            }

            // Apres le rapetissement et multiplie par-dessus : les deux malus se
            // cumulent. Un kart aplati traine, il ne s'arrete pas — c'est la
            // difference avec le tete-a-queue.
            if (kart.isFlat) {
                effectiveSpeed *= cfg.lightning.flatSpeedFactor;
            }

            // La descente de fin de vol. Elle ne peut pas passer par
            // `absoluteVelocity` : le kart n'est plus sous objet, et le regime «
            // elan » le ramenerait a `topSpeed` d'un coup. Jamais en dessous de
            // la vitesse du kart, d'ou le `Math.max`.
            const billSpeed = getBillSpeed(cfg, state, kart);
            if (!kart.isBill && kart.billSlowUntil > now) {
                const left = (kart.billSlowUntil - now) / cfg.bill.slowdownMs;
                effectiveSpeed = Math.max(
                    effectiveSpeed,
                    kart.stats.topSpeed + (billSpeed - kart.stats.topSpeed) * left
                );
            }

            // Le choc longitudinal s'ajoute a la vitesse moteur, borne a l'arret
            // : emboutir coute son elan au kart de derriere, ca ne le fait pas
            // repartir en arriere.
            const shovedSpeed = effectiveSpeed + kart.bumpVx;
            let moveDist = (shovedSpeed > 0 ? shovedSpeed : 0) * deltaTime;

            // Choc contre un tuyau : arret net, puis contrecoup. Le recul entame
            // `totalDistance` autant que l'avance — position et progression
            // restent cousues, sans quoi un kart franchirait la ligne en etant
            // encore en amont a l'ecran.
            if (now < kart.bumpEndTime) {
                moveDist = 0;
                if (kart.bumpRecoilLeft > 0) {
                    const back = Math.min(
                        kart.bumpRecoilLeft,
                        (cfg.pipe.recoilPx * 1000 / cfg.pipe.recoilMs) * deltaTime
                    );
                    kart.bumpRecoilLeft -= back;
                    moveDist = -back;
                }
            }

            kart.totalDistance += moveDist;

            kart.contactSpeed = deltaTime > 0 ? moveDist / deltaTime : 0;

            const prevWorldX = kart.worldX;
            kart.worldX += moveDist;
            kart.yPercent += (kart.vy + kart.bumpVy) * deltaTime;

            const finishX = cfg.world.finishLineX;
            if (moveDist >= 0) {
                if (prevWorldX < finishX && kart.worldX >= finishX) {
                    kart.lapCount++;
                    kart.hasPassedFinishLine = true;
                }
            } else if (prevWorldX >= finishX && kart.worldX < finishX) {
                // Repousse a travers la ligne : le compteur se defait. Sans
                // ce miroir, le tour serait compte une seconde fois a la
                // prochaine traversee.
                kart.lapCount--;
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

            clampKartToRoad(cfg, kart, deltaTime);

            // Apres le deplacement et le recadrage : le tuyau se juge sur la
            // position ou le kart vient d'arriver.
            //
            // Les contacts entre karts, eux, sont dans `resolveKartContacts`, une
            // fois que tout le monde a bouge — les traiter ici poussait un kart
            // contre un adversaire qui n'avait pas encore fait son pas.
            collideKartWithPipes(cfg, state, kart, now, events);

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

                    // `dx` porte la carrosserie de la victime, donc son
                    // rapetissement. `dy` non : ce 8 n'est pas une somme de corps
                    // mais une tolerance de profondeur posee ici.
                    if (dx < shrunkReachX(cfg, cfg.hitboxes.itemVsKart, victim, now)
                        && dy < hitThresholdY) {
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
                        victim.hitEndTime = now + spinDuration(cfg);
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
            const totalHitTime = spinDuration(cfg);
            const hitStart = kart.hitEndTime - totalHitTime;
            const elapsed = now - hitStart;
            const decelDuration = totalHitTime * cfg.delays.hitDecelDuration
                / (cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration);

            // Un tuyau arrete aussi une toupie : elle glisse, mais pas a travers
            // le decor. `pipeBlocked` porte ce contact tant que les deux se
            // touchent, la ou `bumpEndTime` compte un choc unique reserve aux
            // karts en course.
            //
            // Une toupie glisse sur son erre et encaisse : le choc longitudinal
            // s'y ajoute, borne a l'arret. Se faire tamponner pendant son
            // tete-a-queue pousse donc vraiment.
            let hitSpeed = 0;
            if (elapsed < decelDuration && now >= kart.bumpEndTime && !kart.pipeBlocked) {
                const decelProgress = elapsed / decelDuration;
                const hitSpeedFactor = 0.3 * Math.max(0, 1.0 - decelProgress * decelProgress);
                hitSpeed = cfg.speeds.roadPPS * hitSpeedFactor;
                kart.stopped = false;
            } else {
                kart.stopped = true;
            }

            const shovedHitSpeed = hitSpeed + kart.bumpVx;
            const hitMove = (shovedHitSpeed > 0 ? shovedHitSpeed : 0) * deltaTime;
            kart.contactSpeed = deltaTime > 0 ? hitMove / deltaTime : 0;
            kart.worldX += hitMove;
            kart.totalDistance += hitMove;

            // Le choc lateral la deplace aussi. Sans ces trois lignes, une toupie
            // encaissait une poussee en profondeur sans jamais s'y deplacer :
            // elle restait plantee dans le kart qui la percutait.
            kart.yPercent += kart.bumpVy * deltaTime;
            // Le frottement ne mord pas sur une toupie : sa glissade passe par
            // `hitSpeed` et non par le moteur, et elle s'arrete deja toute seule.
            clampKartToRoad(cfg, kart, deltaTime);

            if (kart.worldX >= cfg.world.width) {
                kart.worldX -= cfg.world.width;
            }
            // Le pendant du precedent : depuis qu'un tamponnement peut
            // ralentir une toupie sous zero, elle peut reculer a travers
            // l'origine du monde.
            if (kart.worldX < 0) {
                kart.worldX += cfg.world.width;
            }

            collideKartWithPipes(cfg, state, kart, now, events);
            if (now > kart.hitEndTime) {
                kart.state = 'running';
                kart.stopped = false;
                kart.absoluteVelocity = 0;

                // Et le lateral avec : `vy` n'etait pas integre pendant le
                // tete-a-queue mais pas remis a zero non plus, si bien que le
                // kart repartait en biais avec la vitesse laterale d'avant le
                // choc. Un incident remet l'elan a zero ; il n'y a aucune raison
                // qu'il garde une direction.
                kart.vy = 0;
                kart.targetVy = 0;

                kart.momentum = 0.2;
                kart.momentumTarget = randomRange(rng, 0.6, 1.0);
                kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                // Comme pour le tuyau : le tete-a-queue refait l'elan de zero, il
                // n'y a plus rien a rendre a la fin d'un objet qui aurait
                // survecu.
                kart.preBoostMomentum = -1;
                kart.hitInvincibleUntil = now + cfg.delays.invincibilityAfterHit;
            }
        }
    }

    // Tout le monde a bouge : les carrosseries peuvent enfin se parler.
    resolveKartContacts(cfg, state, now, deltaTime, events);

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

        // Profondeur d'ou l'objet part sur ce pas. Les impacts se testent sur le
        // segment parcouru : une verte renvoyee par un tuyau traverse la piste en
        // trois pas et passerait sinon d'un cote a l'autre d'un kart sans le
        // toucher.
        item.prevY = item.y;

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

        // Vol en cloche. La montee est inoffensive : la banane ne redevient
        // dangereuse qu'a la redescente, le sommet etant atteint la ou sin()
        // culmine.
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

            // Bords de piste et pipes sont traites la, par sous-pas : c'est
            // le seul endroit ou une carapace change de trajectoire.
            advanceProjectile(cfg, state, item, deltaTime, now);
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
            if (item.type === 'redShell' && kart.id === item.shooterId) continue;
            // Une verte epargne son lanceur — jusqu'a ce qu'un tuyau la lui
            // renvoie. Elle ne revient pas par hasard : c'est lui qui a choisi de
            // tirer de ce cote, et le mur etait visible.
            if (item.type === 'greenShell' && kart.id === item.shooterId && !item.pipeBounced) continue;
            if (kart.state !== 'running' && kart.state !== 'hit') continue;

            if (isRamming(kart)) {
                const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                if (dk < shrunkReachX(cfg, cfg.hitboxes.itemVsKart, kart, now)
                    && crossedDepth(item, kart.yPercent,
                                    shrunkReachY(cfg, cfg.hitboxes.itemVsKart, kart, now))) {
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
                if (dh < cfg.hitboxes.itemVsKart.x
                    && crossedDepth(item, kart.yPercent, cfg.hitboxes.itemVsKart.y)) {
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
                    if (dh < cfg.hitboxes.itemVsKart.x
                        && crossedDepth(item, pos.y, cfg.hitboxes.itemVsKart.y)) {
                        destroyOrbitItem(kart, b, events);
                        spendItem(cfg, item, now);
                        hitHeldItem = true;
                        break;
                    }
                }
            }

            if (hitHeldItem) break;

            // Le contact qui BLESSE, et le seul de cette boucle a mettre en jeu
            // une carrosserie : les deux tests plus haut opposent l'objet a un
            // autre objet.
            const body = cfg.hitboxes.itemVsKart;
            const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
            if (dk < shrunkReachX(cfg, body, kart, now)
                && crossedDepth(item, kart.yPercent, shrunkReachY(cfg, body, kart, now))) {
                if (kart.state === 'running' && kart.hitInvincibleUntil <= now) {
                    kart.state = 'hit';
                    kart.hitEndTime = now + spinDuration(cfg);
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

export {
    stepPhysics,
};
