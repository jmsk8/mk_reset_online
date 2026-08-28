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

    function lerp(min, max, t) {
        return min + (max - min) * t;
    }

    function clamp(v, min, max) {
        return v < min ? min : (v > max ? max : v);
    }

    const derivedStatsCache = new WeakMap();

    function deriveCharacterStats(cfg) {
        const cached = derivedStatsCache.get(cfg);
        if (cached) return cached;

        const spec = cfg.kartStats;
        const span = (spec.maxPoints - spec.minPoints) || 1;
        const axes = ['weight', 'power', 'handling'];
        const table = {};

        for (const name of Object.keys(spec.characters)) {
            const raw = spec.characters[name];

            for (const axis of axes) {
                const v = raw[axis];
                if (typeof v !== 'number' || v < spec.minPoints || v > spec.maxPoints) {
                    throw new Error(`kartStats : ${name}.${axis} vaut ${v}, hors de `
                        + `[${spec.minPoints}, ${spec.maxPoints}]`);
                }
            }
            const total = raw.weight + raw.power + raw.handling;
            if (total !== spec.budget) {
                throw new Error(`kartStats : ${name} totalise ${total} points `
                    + `au lieu des ${spec.budget} du budget`);
            }

            const norm = {
                weight:   (raw.weight - spec.minPoints) / span,
                power:    (raw.power - spec.minPoints) / span,
                handling: (raw.handling - spec.minPoints) / span
            };

            const mass  = lerp(spec.mass.min, spec.mass.max, norm.weight);
            const force = lerp(spec.force.min, spec.force.max, norm.power);
            // L'axe handling est courbe, pas droit : cf. `gripCurve` en config.
            const grip  = lerp(spec.grip.min, spec.grip.max,
                               Math.pow(norm.handling, spec.gripCurve));

            const traction = spec.traction.base + spec.traction.gain * norm.weight;

            table[name] = {
                raw: raw,
                norm: norm,
                mass: mass,
                topSpeed: spec.speedBase + spec.speedPerPower * norm.power * traction,
                acceleration: clamp(force / Math.pow(mass, spec.massDragAccel),
                                    spec.accelClamp.min, spec.accelClamp.max),
                agility: clamp(grip / Math.pow(mass, spec.massDragAgility),
                               spec.agilityClamp.min, spec.agilityClamp.max)
            };
        }

        derivedStatsCache.set(cfg, table);
        return table;
    }

    function getNewMomentumTarget(rng, cfg, stats) {
        const floor = cfg.speeds.momentumFloor;
        const minMomentum = floor.base + floor.weightGain * stats.norm.weight;
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
        const table = deriveCharacterStats(cfg);
        const names = Object.keys(table);
        let best = 0;
        for (let i = 0; i < names.length; i++) {
            const top = table[names[i]].topSpeed;
            const boosts = cfg.speeds.boosts;
            const shroom = top * boosts.shroom.multiplier;
            const star = top * boosts.star.multiplier;
            if (shroom > best) best = shroom;
            if (star > best) best = star;
        }
        return best;
    }

    // Vitesse de croisiere du bill : le multiplicateur du porteur, releve au
    // plancher commun quand celui-ci est plus haut.
    function getBillSpeed(cfg, state, kart) {
        return Math.max(kart.stats.topSpeed * cfg.speeds.boosts.bill.multiplier,
                        state.billFloorSpeed);
    }

    // La pointe qu'un kart sous objet vise, et la vivacite avec laquelle il y
    // monte. Un seul modele pour les trois objets : cf. `speeds.boosts`.
    //
    // Rend null quand aucun n'est actif — c'est ce null, et lui seul, qui fait
    // basculer la vitesse entre le regime « elan » et le regime « objet ».
    //
    // Quand deux se cumulent, la pointe la plus haute gagne, avec sa propre
    // montee. Le bill est traite a part et prime sur tout : c'est un projectile,
    // rien ne le module — pas meme un champignon qu'il aurait garde.
    function getActiveBoost(cfg, state, kart, now) {
        const boosts = cfg.speeds.boosts;

        if (kart.isBill) {
            return { peak: getBillSpeed(cfg, state, kart), ramp: boosts.bill.ramp };
        }

        let best = null;
        if (kart.starEndTime > now) {
            best = { peak: kart.stats.topSpeed * boosts.star.multiplier, ramp: boosts.star.ramp };
        }
        if (kart.boostEndTime > now) {
            const peak = kart.stats.topSpeed * boosts.shroom.multiplier;
            if (!best || peak > best.peak) best = { peak: peak, ramp: boosts.shroom.ramp };
        }
        return best;
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

    // ── Pipes ───────────────────────────────────────────────────────────────
    //
    // Un pipe est une boite posee au sol : large le long de la piste, plate en
    // profondeur. Ses deux axes n'ont pas la meme unite — `worldX` est en pixels
    // de monde, `y` en profondeur de piste — et rien ici ne les convertit l'un
    // en l'autre. Le rebond n'en a pas besoin : il choisit sa face en comparant
    // des durees, et une duree se compare a une duree quel que soit l'axe.

    // Un rebond de plus au compteur d'une verte. Rend true si c'etait celui de
    // trop, la carapace etant alors detruite.
    //
    // Bords de piste et pipes comptent pareil. C'est aussi ce qui donne enfin
    // une duree de vie a une verte : jusqu'ici rien ne la tuait, et une
    // carapace qui ne touchait personne tournait indefiniment.
    function registerBounce(cfg, item, now) {
        if (item.type !== 'greenShell') return false;

        item.bounces++;
        if (item.bounces > cfg.pipe.maxShellBounces) {
            spendItem(cfg, item, now);
            return true;
        }
        return false;
    }

    // Rebond d'une carapace sur un pipe. Rend true si le contact a eu lieu.
    //
    // Le tuyau est rond a l'ecran, sa hitbox est une boite — comme toutes les
    // autres du moteur. Le rebond se fait donc face par face : la carapace
    // renverse la composante perpendiculaire a la face touchee et garde l'autre
    // intacte. Un tir de plein fouet repart d'ou il vient ; le meme tir qui
    // effleure le tuyau par le flanc ressort renvoye a travers la piste. L'angle
    // sort de la face touchee et de sa propre trajectoire, sans qu'aucune valeur
    // ne soit choisie a la main.
    //
    // La face touchee est celle qui vient d'etre franchie le plus recemment :
    // c'est par la que la carapace est entree, donc c'est elle qui renvoie.
    //
    // Ce choix se fait sur des **temps**, pas sur des profondeurs d'enfoncement.
    // Comparer les enfoncements reviendrait a mettre des pixels en face
    // d'unites de piste, et surtout : un tir de plein fouet, qui n'a aucune
    // vitesse verticale, se retrouverait classe en contact par le flanc — il n'y
    // aurait rien a renverser, et la carapace traverserait le tuyau sans le
    // voir. Le temps, lui, vaut l'infini sur un axe qu'elle ne franchit pas, et
    // designe donc toujours la bonne face.
    function bounceItemOffPipe(cfg, pipe, item) {
        const box = cfg.pipe.hitbox;
        const margin = 1 + cfg.pipe.escapeMargin;

        const dx = getShortestDistance(cfg, item.worldX, pipe.worldX);
        const dy = item.y - pipe.y;

        const sideX = dx >= 0 ? 1 : -1;
        const sideY = dy >= 0 ? 1 : -1;

        // Vitesse d'enfoncement sur chaque axe : positive quand elle rapproche
        // du centre du tuyau, negative quand la carapace en ressort deja.
        const intoX = -item.vx * sideX;
        const intoY = -item.vy * sideY;

        // Depuis combien de temps chaque face a ete franchie. L'infini marque un
        // axe qu'elle ne traverse pas : soit elle en ressort, soit elle etait
        // deja entre les deux faces avant le contact.
        const timeX = intoX > 0 ? (box.x - Math.abs(dx)) / intoX : Infinity;
        const timeY = intoY > 0 ? (box.y - Math.abs(dy)) / intoY : Infinity;

        // Elle ressort des deux cotes a la fois : la renvoyer la ferait rentrer.
        if (timeX === Infinity && timeY === Infinity) return false;

        // Un pipe colle au bord deborde de la piste : ressortir par ce flanc-la
        // poserait la carapace hors du bitume, ou le rebond de bord la
        // renverrait aussitot dans le tuyau. Elle repart alors par le bout.
        const depthOut = pipe.y + sideY * box.y * margin;
        const depthBlocked = depthOut > cfg.road.maxY || depthOut < cfg.road.minY;

        if (timeY < timeX && !depthBlocked) {
            // Flanc : c'est la profondeur qui se renverse.
            item.vy = -item.vy;
            item.y = depthOut;
            return true;
        }

        // Face de bout : c'est l'avance le long de la piste qui se renverse.
        // C'est aussi le repli quand le flanc ne donne pas sur la piste — et
        // s'il n'y a rien a renverser la non plus, le sous-pas suivant
        // retrouvera une geometrie franche.
        if (intoX <= 0) return false;

        item.vx = -item.vx;
        item.worldX = pipe.worldX + sideX * box.x * margin;
        if (item.worldX < 0) item.worldX += cfg.world.width;
        if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
        return true;
    }

    // Avance d'un projectile sur un pas de simulation, en sous-pas.
    //
    // Un seul pas de 33 ms ne suffit plus des que la profondeur bouge vite : a
    // 45 degres une verte avance de huit unites de profondeur par pas, pour une
    // hitbox de kart qui en fait cinq. Elle enjamberait ses victimes, et
    // traverserait un tuyau sans jamais le voir. Le sous-pas borne cette avance
    // a `maxSubStepY`, ce qui rend a la fois les impacts et les rebonds fiables.
    function advanceProjectile(cfg, state, item, deltaTime, now) {
        const spec = cfg.pipe;

        let steps = Math.ceil(Math.abs(item.vy * deltaTime) / spec.maxSubStepY);
        if (!(steps >= 1)) steps = 1;
        if (steps > spec.maxSubSteps) steps = spec.maxSubSteps;

        const dt = deltaTime / steps;
        const pipes = state.pipes;

        // Une banane ne bouge pas et la bleue vole : ni l'une ni l'autre ne
        // rencontre un tuyau.
        const meetsPipes = pipes.length > 0
            && (item.type === 'greenShell' || item.type === 'redShell');

        for (let s = 0; s < steps; s++) {
            item.worldX += item.vx * dt;
            item.y += item.vy * dt;

            if (item.y > cfg.road.maxY) {
                item.y = cfg.road.maxY;
                if (item.type !== 'redShell') {
                    item.vy = -item.vy;
                    if (registerBounce(cfg, item, now)) return;
                }
            } else if (item.y < cfg.road.minY) {
                item.y = cfg.road.minY;
                if (item.type !== 'redShell') {
                    item.vy = -item.vy;
                    if (registerBounce(cfg, item, now)) return;
                }
            }

            if (!meetsPipes) continue;

            for (let p = 0; p < pipes.length; p++) {
                const pipe = pipes[p];
                if (Math.abs(getShortestDistance(cfg, item.worldX, pipe.worldX)) >= spec.hitbox.x) continue;
                if (Math.abs(item.y - pipe.y) >= spec.hitbox.y) continue;

                // La rouge se brise dessus : elle n'a qu'une trajectoire, celle
                // de sa cible, et rien a faire d'un rebond.
                if (item.type === 'redShell') {
                    spendItem(cfg, item, now);
                    return;
                }

                if (bounceItemOffPipe(cfg, pipe, item)) {
                    // Renvoyee par un tuyau, elle redevient dangereuse pour
                    // celui qui l'a tiree : c'est lui qui l'a mise la.
                    item.pipeBounced = true;
                    if (registerBounce(cfg, item, now)) return;
                    break;
                }
            }
        }
    }

    // Le projectile a-t-il croise cette profondeur pendant le pas ?
    //
    // Comparer la seule position d'arrivee suffisait tant qu'une carapace
    // derivait a peine. Depuis qu'elle peut traverser la piste en trois pas, il
    // faut regarder le segment parcouru : sinon elle passe d'un cote a l'autre
    // d'un kart entre deux images, sans jamais avoir ete a sa hauteur.
    function crossedDepth(item, targetY, tolerance) {
        const from = item.prevY;
        const to = item.y;
        const lo = (from < to ? from : to) - tolerance;
        const hi = (from > to ? from : to) + tolerance;
        return targetY > lo && targetY < hi;
    }

    // De quel cote un kart plaque contre un tuyau doit s'ecarter. Le cote ou il
    // deborde deja, et s'il est pile en face, le cote le plus degage : un kart
    // pousse contre le tuyau resterait sinon plaque dessus.
    function pipeSlideDir(cfg, kart, pipe) {
        if (Math.abs(kart.yPercent - pipe.y) < 0.5) {
            return (cfg.road.maxY - kart.yPercent) >= (kart.yPercent - cfg.road.minY) ? 1 : -1;
        }
        return kart.yPercent >= pipe.y ? 1 : -1;
    }

    // Le kart contre le tuyau.
    //
    // Masse infinie : rien ne se transmet au pipe, tout est pour le kart. Il est
    // arrete net, recule un peu, puis repart de zero — c'est son acceleration
    // qui decide de ce que le choc lui aura coute, ce qui fait payer les lourds
    // plus cher que les vifs, sans qu'aucune penalite ne soit ecrite pour eux.
    //
    // Une etoile et un bill le traversent : rien ne les arrete. Le tuyau, lui,
    // encaisse — un sursaut, et il se remet en place. C'est le seul effet qu'un
    // kart puisse avoir sur lui, et il est purement visuel.
    //
    // Le sursis est retenu par tuyau et non globalement : un kart qui vient d'en
    // heurter un doit encore pouvoir se cogner au suivant, sans quoi deux pipes
    // cote a cote ne feraient qu'un seul mur franchissable.
    function collideKartWithPipes(cfg, state, kart, now, events) {
        kart.pipeBlocked = false;

        const pipes = state.pipes;
        if (!pipes.length) return;

        const reach = cfg.hitboxes.kartVsPipe;

        for (let p = 0; p < pipes.length; p++) {
            const pipe = pipes[p];
            if (Math.abs(getShortestDistance(cfg, kart.worldX, pipe.worldX)) >= reach.x) continue;
            if (Math.abs(kart.yPercent - pipe.y) >= reach.y) continue;

            // Une toupie ne se cogne pas : elle est deja hors de controle. Le
            // tuyau l'arrete et la fait glisser le long, un point c'est tout —
            // pas de nouveau choc, pas de recul, pas d'evenement.
            //
            // Lui rejouer le choc du kart en course rallongeait `bumpEndTime`
            // par a-coups tant que la toupie restait collee au tuyau, et le
            // rendu basculait entre la pose de choc et le tete-a-queue a chaque
            // fin de sursis : c'etait le clignotement du sprite. Le sursis par
            // tuyau ne protege de rien ici — il est saute a dessein, sans
            // quoi la toupie traverserait le tuyau qu'elle vient de toucher.
            if (kart.state === 'hit') {
                kart.pipeBlocked = true;
                kart.bumpVy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;
                return;
            }

            if (p === kart.lastPipeIndex && now < kart.pipeImmuneUntil) continue;

            kart.lastPipeIndex = p;
            kart.pipeImmuneUntil = now + cfg.pipe.immuneMs;

            if (isRamming(kart)) {
                events.push({ type: 'pipeShaken', pipeIndex: p, kartId: kart.id });
                return;
            }

            kart.bumpEndTime = now + cfg.pipe.bumpMs;
            kart.bumpRecoilLeft = cfg.pipe.recoilPx;
            kart.absoluteVelocity = 0;
            kart.momentum = 0;

            // Ecarte vers le cote le plus degage. Sans ca, un kart pousse par le
            // peloton resterait plaque contre le tuyau : le chien de garde du
            // service finirait par le signaler, sans pour autant le liberer.
            kart.vy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;

            // Le plan en cours ne vaut plus rien : il visait a passer, et le
            // kart est arrete contre le tuyau. Il rechoisira un couloir au
            // redemarrage, depuis la position ou la poussee laterale l'a mis.
            kart.aiState = 'cruising';
            kart.dodgePlanId = 0;
            kart.pipeTargetIndex = -1;

            events.push({ type: 'kartBumped', kartId: kart.id, pipeIndex: p });
            return;
        }
    }

    // -----------------------------------------------------------------------
    // Maniabilite
    //
    // Une seule regle, et tout le pilotage latera passe par elle : `agility`
    // dit COMBIEN un kart se decale, jamais EN COMBIEN DE TEMPS il s'y met.
    //
    // Le temps de reaction est commun a tout le plateau. Il a deux etages, et
    // aucun des deux ne regarde les stats :
    //   - le reflexe de l'IA, `ai.reactionBaseMs` tire au sort a chaque
    //     menace : c'est lui qui varie, et il varie pour tout le monde pareil ;
    //   - l'inertie du volant, `physics.steerResponse` : la vitesse a laquelle
    //     `vy` rejoint la consigne, identique d'un personnage a l'autre.
    //
    // Ce qui distingue les karts vient apres : a consigne egale, un kart
    // maniable vise un decalage plus grand. C'est la seule chose qu'`agility`
    // achete.
    //
    // Trois fonctions, et elles sont les seules a toucher `targetVy` et `vy` :
    //   - `steerSpeed(kart, base)`         : la consigne, a l'echelle du kart ;
    //   - `applySteering(cfg, kart, dt)`   : la reponse du volant, commune ;
    //   - `steerClamped(cfg, state, ...)`  : la meme, mais qui refuse d'envoyer
    //     le kart dans un obstacle (cf. sa propre note).
    // Ajouter une manoeuvre, c'est poser un `kart.targetVy = steerSpeed(...)`
    // puis appeler l'une des deux dernieres — `steerClamped` par defaut,
    // `applySteering` seulement si la manoeuvre juge la place elle-meme. Rien
    // d'autre ne doit ecrire dans `vy`.
    // -----------------------------------------------------------------------

    // Consigne laterale d'un kart pour une vitesse de reference donnee.
    function steerSpeed(kart, base) {
        return base * kart.stats.agility;
    }

    // Rapproche `vy` de `targetVy`. Le facteur est borne a 1 : sur une frame
    // longue — onglet en arriere-plan, machine qui peine — le lissage non borne
    // depassait la consigne et faisait osciller le kart. Avec la borne, une
    // frame lente se contente d'arriver pile sur la consigne.
    function applySteering(cfg, kart, deltaTime) {
        const k = cfg.physics.steerResponse * deltaTime;
        kart.vy += (kart.targetVy - kart.vy) * (k > 1 ? 1 : k);
    }

    // Distance laterale qu'un kart couvre en `ms` millisecondes, en partant a
    // l'arret. `tau` est la constante de temps de `applySteering` : sur une
    // reaction courte, une bonne part du trajet passe dans la montee en regime.
    // Elle ne depend pas du personnage — seule `intensity` en depend.
    function lateralReach(cfg, agility, intensity, ms) {
        const t = ms / 1000;
        const tau = 1 / cfg.physics.steerResponse;
        return intensity * (t - tau * (1 - Math.exp(-t / tau)));
    }

    // Agilite moyenne du plateau. Sert d'etalon partout ou il faut juger une
    // situation et non un personnage — elle suit automatiquement le plateau,
    // sans constante a retoucher quand les stats bougent.
    const referenceAgilityCache = new WeakMap();

    function referenceAgility(cfg) {
        const cached = referenceAgilityCache.get(cfg);
        if (cached !== undefined) return cached;

        const table = deriveCharacterStats(cfg);
        const names = Object.keys(table);
        let sum = 0;
        for (let i = 0; i < names.length; i++) sum += table[names[i]].agility;
        const mean = sum / names.length;

        referenceAgilityCache.set(cfg, mean);
        return mean;
    }

    // Probabilite qu'un kart ne voie pas venir la menace. La difficulte se
    // mesure en distance : ce qu'il peut couvrir avant l'impact, rapporte a ce
    // qu'il doit couvrir pour degager. Le tirage s'efface a mesure que cette
    // marge grandit.
    function missChance(cfg, kart, threatY, spareMs) {
        const ai = cfg.ai;
        const base = ai.dodgeMissChance;

        // Il passe deja assez a cote pour que la hitbox le manque.
        const need = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin
            - Math.abs(threatY - kart.yPercent);
        if (need <= 0) return 0;
        if (spareMs <= 0) return base;

        // Etalonne sur l'agilite de reference, pas sur celle du kart : ce
        // tirage dit s'il a VU venir la menace, et un kart maniable n'est pas
        // plus attentif qu'un autre. Savoir l'esquiver se joue apres, dans le
        // decalage lui-meme.
        const agility = referenceAgility(cfg);
        const intensity = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * agility;
        const ease = lateralReach(cfg, agility, intensity, spareMs) / need;

        if (ease <= 1) return base;
        if (ease >= ai.dodgeEasyRatio) return 0;
        return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
    }

    // Place libre d'un cote du kart, en profondeur de piste.
    //
    // Le bord de piste la borne, et ce qui est pose devant la borne de la meme
    // facon : un tuyau, un objet au sol, l'objet traine par un autre kart.
    // S'ecarter vers eux, c'est troquer la menace contre une autre — et vers un
    // tuyau, c'est le mauvais cote du marche. Un kart qui plonge sous une
    // carapace pour se planter dans le tuyau d'a cote donne exactement
    // l'impression d'une esquive qui vise mal, parce que c'en est une : le plan
    // ne regardait que les deux bords.
    //
    // Ne comptent que ceux qui sont encore devant — ou a hauteur — et assez
    // proches pour que l'ecart n'ait pas eu le temps de retomber quand le kart y
    // arrive (ai.dodgeGuardDistance). `skipId` est la menace elle-meme : elle
    // n'a pas a se fermer le passage.
    function sideRoom(cfg, state, kart, dir, skipId) {
        const ai = cfg.ai;
        const guard = ai.dodgeGuardDistance;
        const margin = cfg.road.edgeSafetyMargin;

        let limit = (dir > 0) ? (cfg.road.maxY - margin) : (cfg.road.minY + margin);

        // Face tournee vers le kart. Elle ne ferme le cote que si elle est
        // vraiment de ce cote-la : un obstacle que le kart chevauche deja est
        // derriere sa propre face, et refermer sur lui rendrait une place
        // negative pour un obstacle qu'aucun ecart ne peut plus eviter.
        function closeAt(y, halfDepth) {
            const face = y - dir * halfDepth;
            if (dir > 0 ? (face > kart.yPercent && face < limit)
                        : (face < kart.yPercent && face > limit)) {
                limit = face;
            }
        }

        const pipeReach = cfg.hitboxes.kartVsPipe;
        const pipes = state.pipes;
        for (let p = 0; p < pipes.length; p++) {
            const dx = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
            if (dx < -pipeReach.x || dx > guard) continue;
            closeAt(pipes[p].y, pipeReach.y);
        }

        const clear = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin;

        for (let i = 0; i < state.items.length; i++) {
            const item = state.items[i];
            if (item.id === skipId || item.isDead || item.spent) continue;
            if (cfg.trailableItems.indexOf(item.type) === -1) continue;

            const dx = getShortestDistance(cfg, item.worldX, kart.worldX);
            if (dx <= 0 || dx > guard) continue;
            closeAt(item.y, clear);
        }

        // Objets traines : ils suivent leur porteur, donc c'est sa hauteur a lui
        // qui ferme le cote, comme dans la detection de menace.
        for (let i = 0; i < state.karts.length; i++) {
            const other = state.karts[i];
            if (other.id === kart.id || other.state !== 'running') continue;

            const held = other.heldItem;
            if (!held || held.id === skipId || held.holdPosition !== 'behind') continue;

            const dx = getShortestDistance(cfg, other.worldX, kart.worldX);
            if (dx <= 0 || dx > guard) continue;
            closeAt(other.yPercent, clear);
        }

        return Math.max(0, dir * (limit - kart.yPercent));
    }

    // Dernier filtre avant le volant : une consigne laterale ne doit pas
    // envoyer le kart dans ce qu'il avait sous les yeux.
    //
    // Les manoeuvres de confort — visee, depassement, collecte, maraude, retour
    // au calme — ne connaissent pas les tuyaux, et n'ont pas a les connaitre :
    // chacune repond a sa propre question, et les rendre toutes prudentes
    // reviendrait a ecrire cinq fois le meme test. Sans ce filtre, un kart qui
    // venait d'enfiler proprement deux tuyaux se decalait pour doubler, ou
    // partait chercher une boite, et se plantait dans le second — le couloir
    // etait bon, c'est ce qui s'est passe ensuite qui ne l'etait pas.
    //
    // Le seuil est la course restante et non zero : s'arreter pile a la face du
    // tuyau demande de lever le pied avant de la toucher.
    //
    // Le contournement de tuyau et l'esquive n'y passent pas, et c'est voulu :
    // eux traversent sciemment, l'un pour rejoindre un couloir situe derriere le
    // tuyau, l'autre pour passer devant l'objet. Chacun a son propre jugement de
    // place — `choosePipeLane` et `planDodge`, tous deux batis sur `sideRoom`.
    function steerClamped(cfg, state, kart, deltaTime) {
        if (kart.targetVy) {
            const dir = kart.targetVy > 0 ? 1 : -1;
            const settle = Math.max(0, dir * kart.vy) / cfg.physics.steerResponse;
            if (sideRoom(cfg, state, kart, dir, 0) <= settle) kart.targetVy = 0;
        }
        applySteering(cfg, kart, deltaTime);
    }

    // Cote d'esquive et intensite, arretes une fois pour toutes a la premiere
    // reaction a une menace donnee.
    //
    // Le cote naturel est celui qui eloigne de l'objet. Quand il n'y a pas la
    // place — le bord de piste, ou ce qui est pose devant, cf. `sideRoom` — le
    // kart jauge la traversee par l'autre cote, devant l'objet : il lui faut la
    // place et le temps, et il n'estime le second qu'a vue (cf.
    // ai.crossJudgeError). Sans issue des deux cotes, il ne reste que le frein.
    function planDodge(cfg, state, rng, kart, threatId, threatY, ttc) {
        const ai = cfg.ai;
        const agility = kart.stats.agility;

        kart.dodgePlanId = threatId;
        kart.dodgeIntensity = randomRange(rng,
            steerSpeed(kart, ai.dodgeIntensityMin),
            steerSpeed(kart, ai.dodgeIntensityMax)
        );

        const naturalDir = (threatY > kart.yPercent) ? -1 : 1;

        // Ecart au-dela duquel l'objet ne touche plus, et ecart actuel : la
        // detection ouvre plus large que la hitbox.
        const clear = cfg.hitboxes.itemVsKart.y + ai.crossDodgeMargin;
        const gap = Math.abs(threatY - kart.yPercent);

        const roomNatural = sideRoom(cfg, state, kart, naturalDir, threatId);

        if (roomNatural >= Math.max(0, clear - gap)) {
            kart.dodgeDir = naturalDir;
            kart.dodgeStuck = false;
            kart.dodgeCrossing = false;
            return;
        }

        // Traverser coute l'ecart entier, plus le degagement de l'autre cote.
        const crossDir = -naturalDir;
        const crossNeed = gap + clear;
        const roomCross = sideRoom(cfg, state, kart, crossDir, threatId);

        const err = ai.crossJudgeError;
        const judged = lateralReach(cfg, agility, kart.dodgeIntensity, ttc)
            * randomRange(rng, 1 - err, 1 + err);

        if (gap < clear && roomCross >= crossNeed && judged >= crossNeed) {
            kart.dodgeDir = crossDir;
            kart.dodgeStuck = false;
            kart.dodgeCrossing = true;
            return;
        }

        // Aucun des deux cotes ne s'ouvre : il pousse quand meme du cote
        // naturel, pour grappiller le peu de place restante, et lache les gaz.
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

    // Boite visee : la plus proche de sa trajectoire. L'ecart se mesure en
    // profondeur et non en distance — un kart change de voie bien plus vite
    // qu'il ne rattrape du terrain, donc celle d'en face gagne d'office quand
    // elle est libre, meme un peu plus loin. Aucune de libre, il tente quand
    // meme la plus proche : le kart qui la lui bouche peut encore la manquer.
    //
    // Rien ici ne suppose un rideau de boites aligne sur une verticale : le
    // dessin du circuit les pose ou il veut, y compris seule ou en diagonale.
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

    // Couloir choisi pour passer un tuyau : le milieu du plus large passage
    // libre, non pas a la hauteur du tuyau vise, mais sur toute la sequence de
    // tuyaux qu'il ouvre.
    //
    // Les voisins comptent, et « voisin » se mesure en avant, pas seulement a
    // hauteur. Deux pipes dessines dans la meme colonne laissent un couloir
    // entre eux : viser le bord de l'un des deux mene droit dans l'autre. Mais
    // deux pipes decales de quelques colonnes posent le meme probleme, en pire :
    // le kart degage le premier, se retrouve pile dans la voie du second, et ne
    // le prend pour cible qu'une fois le premier derriere lui — il traverse
    // alors la piste en catastrophe, quand il y arrive. C'est ce que donnait une
    // fenetre limitee a deux fois la portee de collision, soit 127 px la ou une
    // manoeuvre en couvre plusieurs centaines.
    //
    // Le couloir s'enfile donc de proche en proche : on part du tuyau vise, on
    // ajoute le suivant, puis celui d'apres, tant qu'il reste un passage
    // praticable (pipe.minPassageY, le meme seuil qu'au chargement d'un
    // circuit). Le premier qui ferme la sequence arrete le compte, et le kart
    // garde le couloir qui traverse tout ce qui precede. Rien a regler : la
    // portee est celle de la vue, et c'est le trace qui dit ou s'arreter.
    //
    // Ce qui vient apres n'est pas perdu pour autant : le kart rejouera ce choix
    // des ce tuyau-la franchi, avec la piste degagee d'autant.
    //
    // Et un couloir ne compte que s'il est a portee. C'est la seconde moitie du
    // probleme, et la plus visible a l'ecran : le plus large passage est souvent
    // de l'autre cote de la piste, derriere le tuyau lui-meme. Le viser sans
    // regarder la distance restante, c'est s'engager dans une traversee qu'on ne
    // finit pas — le kart s'ecarte franchement, et se plante dans le tuyau qu'il
    // etait en train de doubler. Il ne retient donc que les couloirs dont il
    // atteint le bord avant d'arriver au tuyau, et se rabat sur le plus proche
    // quand aucun n'est tenable.
    //
    // Viser le milieu et non le bord donne au kart de la marge des deux cotes :
    // c'est ce qui lui permet d'encaisser une bousculade sans se retrouver dans
    // le tuyau.
    //
    // A largeur egale — le cas d'un tuyau pose au milieu, qui laisse autant de
    // place de chaque cote — c'est le couloir le plus proche du kart qui gagne.
    // Sans ce depart, les huit karts plongeraient tous du meme cote et s'y
    // bousculeraient, alors que la piste offre deux passages.
    function choosePipeLane(cfg, state, kart, pipe, ttc) {
        const pipes = state.pipes;
        const reach = cfg.hitboxes.kartVsPipe;
        const spec = cfg.pipe;
        const lo = cfg.road.minY + cfg.road.edgeSafetyMargin;
        const hi = cfg.road.maxY - cfg.road.edgeSafetyMargin;

        // Deux couloirs se valent quand leurs largeurs se tiennent dans cette
        // marge : au-dela, la place prime sur la proximite.
        const tie = spec.laneTieMargin;

        // Ecart lateral que le kart couvre d'ici le tuyau, a la vitesse de
        // rejointe du couloir. Le `laneTolerance` de marge paie l'optimisme du
        // calcul : la rejointe ralentit en fin de course (`laneSeekGain`), ce
        // que `lateralReach` ne modelise pas.
        const budget = lateralReach(cfg, kart.stats.agility,
            steerSpeed(kart, spec.laneSeekSpeed), ttc) - spec.laneTolerance;

        // Milieu du plus large passage que `blocked` laisse ouvert, et sa
        // largeur — c'est elle qui dit si le couloir est praticable. La liste
        // est triee par bord bas. `limit` borne l'ecart que le kart accepte pour
        // y entrer ; a l'infini, il prend le meilleur sans regarder la distance.
        function widestLane(blocked, limit) {
            let bestLane = (lo + hi) / 2;
            let bestWidth = -1;

            function consider(from, to) {
                const width = to - from;
                if (width <= 0) return;
                const lane = from + width / 2;

                // Ce qu'il faut couvrir pour entrer dans ce couloir. Nul s'il y
                // est deja : tenir sa ligne ne coute rien.
                const need = (kart.yPercent < from) ? from - kart.yPercent
                    : (kart.yPercent > to) ? kart.yPercent - to
                    : 0;
                if (need > limit) return;

                if (width > bestWidth + tie) {
                    bestWidth = width;
                    bestLane = lane;
                    return;
                }
                if (width > bestWidth - tie
                    && Math.abs(lane - kart.yPercent) < Math.abs(bestLane - kart.yPercent)) {
                    bestWidth = Math.max(bestWidth, width);
                    bestLane = lane;
                }
            }

            let cursor = lo;
            for (let i = 0; i < blocked.length; i++) {
                consider(cursor, blocked[i][0]);
                if (blocked[i][1] > cursor) cursor = blocked[i][1];
            }
            consider(cursor, hi);

            return { lane: Math.min(hi, Math.max(lo, bestLane)), width: bestWidth };
        }

        // Les tuyaux a enfiler, du plus proche au plus lointain, mesures depuis
        // le kart : il n'enfile que ce qu'il voit, et le tuyau vise est par
        // construction le premier qui barre sa route. Ceux poses a sa hauteur —
        // tuyaux d'une meme colonne — suivent immediatement.
        const ahead = [];
        for (let p = 0; p < pipes.length; p++) {
            const dx = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
            if (dx < -reach.x || dx > spec.seeDistance) continue;
            ahead.push({ dx: dx, y: pipes[p].y, pipe: pipes[p] });
        }
        ahead.sort((a, b) => a.dx - b.dx);

        // Le tuyau vise ouvre la liste quoi qu'il arrive : c'est celui qu'il
        // faut passer, les autres ne font que restreindre le choix. Sans ce
        // depart, un tuyau plus proche mais hors trajectoire pourrait arreter
        // l'enfilage avant meme qu'on ait pris en compte la cible.
        const target = [pipe.y - reach.y, pipe.y + reach.y];
        const blocked = [target];
        let chosen = widestLane(blocked, budget);

        for (let i = 0; i < ahead.length; i++) {
            if (ahead[i].pipe === pipe) continue;

            blocked.push([ahead[i].y - reach.y, ahead[i].y + reach.y]);
            blocked.sort((a, b) => a[0] - b[0]);

            const lane = widestLane(blocked, budget);
            // Celui-la ferme la sequence : on s'en tient a ce qui precede.
            if (lane.width < spec.minPassageY) break;
            chosen = lane;
        }

        // Rien a portee, faute de distance ou faute de place : il vise le
        // meilleur passage du seul tuyau qui le concerne encore, et grappille ce
        // qu'il peut d'ici la. Arriver contre le bord du tuyau vaut mieux que
        // rester sur sa ligne, et la poussee du choc l'en degagera.
        if (chosen.width < 0) chosen = widestLane([target], Infinity);

        return chosen.lane;
    }

    // Contournement d'un pipe. Rend true s'il commande la trajectoire.
    //
    // Un tuyau n'est pas une menace au sens de `planDodge`. Celui-ci est un
    // reflexe, taille pour un objet qui file et qu'on evite d'un ecart : on le
    // voit tard, on s'ecarte fort, c'est fini. Un mur se voit venir de loin, ne
    // bouge pas, et se negocie en trajectoire — on choisit un couloir et on le
    // tient.
    //
    // Les faire passer par la meme machinerie donnait exactement ce qu'on
    // voyait a l'ecran : le kart freinait (le frein d'esquive, inutile devant un
    // obstacle immobile), s'ecartait, se croyait tire d'affaire des qu'il
    // degageait la hitbox, se faisait ramener vers sa ligne d'origine — donc
    // vers le tuyau — par le retour au calme, et recommencait avec un nouveau
    // delai de reflexe. D'ou l'hesitation.
    //
    // Trois regles en sortent :
    //   - le tuyau vise le reste jusqu'a ce qu'il soit derriere, pas jusqu'a ce
    //     que la hitbox soit degagee ;
    //   - le couloir est choisi une seule fois, sinon le kart change d'avis a
    //     chaque pas puisque son ecart au tuyau evolue ;
    //   - la visee est proportionnelle a l'ecart restant, ce qui trace une
    //     diagonale franche qui s'aplatit en arrivant.
    //
    // Et aucun frein : ralentir devant un mur immobile ne fait que retarder le
    // moment de le contourner.
    function steerAroundPipes(cfg, state, kart, deltaTime) {
        const pipes = state.pipes;
        if (!pipes.length) return false;

        const reach = cfg.hitboxes.kartVsPipe;
        const spec = cfg.pipe;

        // Le tuyau vise le reste tant qu'il n'est pas franchi. C'est la regle
        // qui tient toute la manoeuvre : la lacher des que la hitbox est
        // degagee, c'est relacher le kart en plein travers.
        if (kart.pipeTargetIndex >= 0) {
            const held = pipes[kart.pipeTargetIndex];
            const dist = held ? getShortestDistance(cfg, held.worldX, kart.worldX) : 0;
            if (!held || dist < -reach.x || dist > spec.seeDistance) kart.pipeTargetIndex = -1;
        }

        if (kart.pipeTargetIndex < 0) {
            let index = -1;
            let nearest = Infinity;

            for (let p = 0; p < pipes.length; p++) {
                const dist = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
                if (dist <= 0 || dist > spec.seeDistance) continue;
                // Il ne barre pas la route : rien a contourner.
                if (Math.abs(pipes[p].y - kart.yPercent) >= reach.y) continue;
                if (dist < nearest) {
                    nearest = dist;
                    index = p;
                }
            }

            if (index < 0) return false;

            // Temps restant avant le tuyau : c'est lui qui dit quels couloirs
            // sont encore a portee. Un kart a l'arret — pousse, en tete-a-queue
            // — n'a pas de temps infini pour autant, il n'a simplement pas
            // encore reduit la distance.
            const ttc = (nearest / Math.max(kart.absoluteVelocity, 1)) * 1000;

            kart.pipeTargetIndex = index;
            kart.pipeLaneY = choosePipeLane(cfg, state, kart, pipes[index], ttc);
        }

        // Le kart compare le couloir a l'endroit ou il s'arreterait, et non a
        // celui ou il est.
        //
        // Le volant a 200 ms d'inertie (1 / steerResponse). Une consigne
        // proportionnelle au seul ecart courant commande donc encore du
        // braquage quand le couloir est deja sous les roues : le systeme
        // (`diff'' + steerResponse * diff' + steerResponse * laneSeekGain *
        // diff = 0`) est sous-amorti a ces reglages, et le kart depasse sa cible
        // d'environ deux unites et demie. Sur un passage etroit — six unites,
        // soit trois de chaque cote — ce depassement le fait ressortir par
        // l'autre bord, dans le tuyau meme qu'il contournait. C'est exactement
        // ce qu'on voyait : un ecart franc, puis un choc du cote oppose.
        //
        // Retrancher la course restante — `vy / steerResponse`, ce que le kart
        // parcourt encore s'il relache tout — change les modes du systeme en
        // `-steerResponse` et `-laneSeekGain`, tous deux reels : la reponse
        // devient aperiodique. Plus aucun depassement, et sans ralentir la
        // manoeuvre puisque les deux constantes de temps restent celles des
        // reglages.
        const settleY = kart.yPercent + kart.vy / cfg.physics.steerResponse;
        const diff = kart.pipeLaneY - settleY;

        if (Math.abs(diff) <= spec.laneTolerance) {
            // Couloir tenu : il ne corrige plus, sinon il tremble autour.
            kart.targetVy = 0;
        } else {
            const speed = steerSpeed(kart, spec.laneSeekSpeed);
            const seek = steerSpeed(kart, diff * spec.laneSeekGain);
            kart.targetVy = Math.max(-speed, Math.min(speed, seek));
        }

        // `originalLaneY` suit le couloir, et non la ligne d'avant la manoeuvre :
        // c'est lui que le retour au calme rejoint une fois le tuyau passe. Le
        // laisser en arriere y ramenerait le kart, c'est-a-dire dans le tuyau.
        kart.aiState = 'pipe';
        kart.originalLaneY = kart.pipeLaneY;

        applySteering(cfg, kart, deltaTime);
        return true;
    }

    function updateAI(cfg, state, rng, now, kart, deltaTime) {
        if (kart.state !== 'running') return;

        let dangerFound = false;
        let avoidDirection = 0;

        const ai = cfg.ai;

        // Un bill ne se pilote pas : il rejoint le milieu de la piste et n'en
        // bouge plus. Ni esquive, ni depassement, ni derive — il ne voit rien, et
        // de toute facon rien ne peut le toucher. Un pipe fait exception : il ne
        // l'arreterait pas — il le traverse comme une etoile — mais un
        // projectile qui laboure le decor en ligne droite n'a rien d'un vol. On
        // lui rend donc juste assez de pilotage pour le contourner, et rien de
        // plus : c'est la seule chose qu'un bill regarde encore.
        if (kart.isBill) {
            const mid = billAimDepth(cfg, state, kart);
            const diff = mid - kart.yPercent;
            const speed = cfg.bill.centerSpeed;
            kart.targetVy = Math.abs(diff) < 0.2 ? 0 : (diff > 0 ? speed : -speed);
            applySteering(cfg, kart, deltaTime);
            return;
        }

        // Menace la plus urgente, mesuree en temps avant impact. Un objet qui
        // s'eloigne n'en est pas une — ce qui evite au passage qu'un kart fuie
        // la carapace qu'il vient de tirer.
        let threatId = 0;
        let threatY = 0;
        let threatTtc = Infinity;

        const threatWindow = ai.threatWindowMs;

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

                const reactMs = ai.reactionBaseMs
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
                    planDodge(cfg, state, rng, kart, threatId, threatY, threatTtc);
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
            applySteering(cfg, kart, deltaTime);
            return;
        }

        // Le tuyau passe avant la visee, le depassement et la maraude : c'est le
        // seul obstacle certain de la piste, les autres ne sont que des
        // occasions. Il passe apres l'esquive d'un objet en revanche — une
        // carapace coute deux secondes, un choc six dixiemes — et ce n'est pas
        // un probleme : le couloir reste memorise pendant l'ecart, si bien que
        // le kart y revient de lui-meme des que la carapace est passee.
        if (steerAroundPipes(cfg, state, kart, deltaTime)) return;

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
                    const speed = steerSpeed(kart, ai.aimSpeed);
                    kart.aiState = 'aiming';
                    kart.originalLaneY = kart.yPercent;
                    kart.targetVy = Math.max(-speed, Math.min(speed, diff * ai.aimSpeed));
                    steerClamped(cfg, state, kart, deltaTime);
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
                kart.targetVy = dir * steerSpeed(kart, cfg.ai.overtakeSideSpeed);
                break;
            }
        }

        if (overtakeFound) {
            kart.originalLaneY = kart.yPercent;
            steerClamped(cfg, state, kart, deltaTime);
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
                    ? (diffY > 0 ? 1 : -1) * steerSpeed(kart, cfg.ai.boxSeekIntensity)
                    : 0;
            }
        }

        if (boxTargetFound) {
            steerClamped(cfg, state, kart, deltaTime);
            return;
        }

        if (now > kart.nextWanderTime) {
            kart.nextWanderTime = now + randomRange(rng, cfg.ai.wanderIntervalMin, cfg.ai.wanderIntervalMax);
            kart.wanderEndTime = now + randomRange(rng, cfg.ai.wanderDurationMin, cfg.ai.wanderDurationMax);
            let dir = (rng() > 0.5) ? 1 : -1;
            if (kart.yPercent > cfg.road.maxY - cfg.road.wanderMargin) dir = -1;
            if (kart.yPercent < cfg.road.minY + cfg.road.wanderMargin) dir = 1;
            kart.wanderVy = dir * steerSpeed(kart, cfg.ai.wanderSpeed);
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
                    kart.targetVy = (diff > 0 ? 1 : -1) * steerSpeed(kart, cfg.speeds.returnLane);
                }
            } else {
                kart.targetVy = 0;
                kart.aiState = 'cruising';
            }
        }

        steerClamped(cfg, state, kart, deltaTime);
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

            // Profondeur au pas precedent : les impacts se testent sur le
            // segment parcouru, pas sur la seule position d'arrivee.
            prevY: startY,
            // Rebonds encaisses, bords de piste et pipes confondus. Au-dela de
            // `pipe.maxShellBounces` la carapace se detruit — c'est sa seule
            // duree de vie.
            bounces: 0,
            // Passe a true au premier tuyau touche. Une verte epargne son
            // lanceur, mais plus une fois qu'un pipe la lui a renvoyee.
            pipeBounced: false,

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
            kart.momentum = 1.0;

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
    // ── Contact entre karts ─────────────────────────────────────────────────
    //
    // Une passe a part, jouee apres que TOUS les karts ont bouge. C'est la
    // premiere chose a comprendre ici : le contact etait autrefois resolu au
    // milieu de la boucle de deplacement, ce qui voulait dire qu'un kart etait
    // pousse contre un adversaire qui n'avait pas encore avance de son propre
    // pas. Le resultat dependait de l'ordre du tableau. Ici, tout le monde a
    // deja sa position du tick avant que la premiere paire soit regardee.
    //
    // Un contact repond a trois questions, dans cet ordre.
    //
    //   PAR OU ?    La boite d'une paire est tres allongee (60 x 5). L'axe du
    //               choc est celui ou le chevauchement est le plus faible une
    //               fois RAPPORTE A LA BOITE : 2 de chevauchement sur 5 en
    //               profondeur est plus profond que 20 sur 60 en longueur.
    //               C'est ce rapport, et rien d'autre, qui separe le coup
    //               d'epaule du tamponnement — autrement dit l'angle du choc.
    //
    //   A QUELLE VITESSE ? L'impulsion vaut la vitesse de rapprochement le long
    //               de cette normale. Se faire effleurer et se faire emboutir
    //               ne peuvent pas rendre le meme choc, ce qui etait pourtant
    //               le cas avec l'ancienne constante unique.
    //
    //   QUI CEDE ?  La masse, et de deux facons. Elle repartit l'impulsion, et
    //               elle decide de la part de braquage que chacun perd. Ce
    //               second point est celui qui fait qu'un lourd force le
    //               passage : le leger qui tente d'esquiver a travers lui perd
    //               l'essentiel de son volant tant que le contact dure.
    //
    // Les chocs vivent dans `bumpVy` et `bumpVx`, deux canaux tenus a l'ecart
    // de `vy` et de la vitesse moteur. Ce n'est pas un detail : un choc ecrit
    // dans `vy` etait ramene vers la consigne de l'IA par `applySteering` en
    // 200 ms, soit avant meme que les deux karts se soient decolles.

    // Demi-emprise d'un kart. La boite d'une paire est la somme des deux, d'ou
    // ce detour : aujourd'hui tous les karts ont la meme et la somme redonne
    // exactement `hitboxes.kartVsKart`, mais c'est ici que passera une
    // carrosserie plus large pour les lourds, sans toucher au reste.
    function kartHalfExtents(cfg, kart) {
        const box = cfg.hitboxes.kartVsKart;
        return { x: box.x * 0.5, y: box.y * 0.5 };
    }

    // Masse vue par un contact — et elle n'est pas la masse du kart.
    //
    // L'axe poids ne rend que 0.72 a 1.25 de masse, soit un rapport de 1.45
    // entre le plus lourd et le plus leger. Reparti tel quel, ca donnait un
    // choc presque equitable la ou le joueur attend qu'un poids lourd fasse
    // valoir son poids. `massBias` reouvre cet ecart sans toucher a la masse
    // elle-meme, qui sert aussi a l'acceleration et a la maniabilite : ce qui
    // se regle ici ne se paie que dans les contacts.
    //
    // Meme forme que `massDragAccel` et `massDragAgility` : un exposant, donc
    // un pivot autour de la masse 1 — les lourds gagnent exactement ce que les
    // legers perdent, et un plateau de masses egales reste a 50/50 quel que
    // soit le reglage.
    //
    // Le facteur de tete-a-queue reste un multiplicateur pose par-dessus, et
    // non un terme de l'exposant : un kart en toupie ne pilote plus, il traverse
    // la piste en travers sans rien pour se rattraper. Il fait obstacle plutot
    // qu'il ne se laisse pousser, et ca vaut pareil pour un leger et un lourd.
    function contactMass(cfg, kart) {
        const c = cfg.physics.contact;
        const m = Math.pow(kart.stats.mass, c.massBias);
        return kart.state === 'hit' ? m * c.spinMassFactor : m;
    }

    // Une toupie n'est plus un fantome : elle bouscule et se fait bousculer
    // comme n'importe qui. Seul l'etat 'grid' — et un kart pas encore lance —
    // reste hors de la passe.
    function isContactActive(kart) {
        return kart.state === 'running' || kart.state === 'hit';
    }

    // ── Le bord de piste ────────────────────────────────────────────────────
    //
    // Un mur glissant, et les trois mots comptent.
    //
    //   MUR : on ne le traverse pas. La position est ramenee au bord, comme
    //   avant.
    //
    //   GLISSANT : on n'y rebondit pas et on n'y est pas arrete. Le kart garde
    //   son cap et repart quand il veut — c'est toute la difference avec le
    //   tuyau, qui stoppe net, fait reculer et pose une pose de choc.
    //
    //   FROTTEMENT : y rester coute de la vitesse. Le mur tire le moteur vers
    //   `topSpeed * speedFactor` tant que le kart est plaque contre lui.
    //
    // Le declencheur n'est pas un choc mais une PRESENCE : etre au bord suffit.
    // C'est ce qui couvre d'un seul coup les deux cas — se faire pousser contre
    // le mur, et devoir s'y coller pour esquiver — sans rien avoir a memoriser
    // ni a distinguer. Des que le kart braque vers l'interieur, `yPercent`
    // decolle du bord au pas suivant et le frottement s'arrete de lui-meme.
    //
    // Seule la composante SORTANTE du mouvement lateral est annulee. L'annuler
    // dans les deux sens collerait pour de bon au mur un kart qui essaie d'en
    // partir : au bord exact, son braquage de retour serait efface avant d'avoir
    // servi.
    //
    // Les objets ne passent pas par ici. Carapaces et bananes gardent leur
    // rebond a eux (`bounceItemOffPipe` et le clamp de `updateItem`) : le mur
    // n'est glissant que pour les karts.
    function clampKartToRoad(cfg, kart, deltaTime) {
        const road = cfg.road;
        let atWall = false;

        if (kart.yPercent >= road.maxY) {
            kart.yPercent = road.maxY;
            if (kart.vy > 0) kart.vy = 0;
            if (kart.bumpVy > 0) kart.bumpVy = 0;
            atWall = true;
        } else if (kart.yPercent <= road.minY) {
            kart.yPercent = road.minY;
            if (kart.vy < 0) kart.vy = 0;
            if (kart.bumpVy < 0) kart.bumpVy = 0;
            atWall = true;
        }

        if (!atWall) return;

        // Meme forme que `applySteering` et que la separation des contacts : un
        // taux en 1/s, borne a 1 pour qu'une frame longue arrive pile sur le
        // plancher au lieu de le depasser.
        const wall = cfg.physics.wall;
        const floor = kart.stats.topSpeed * wall.speedFactor;
        if (kart.absoluteVelocity > floor) {
            const k = wall.grip * deltaTime;
            kart.absoluteVelocity += (floor - kart.absoluteVelocity) * (k > 1 ? 1 : k);
        }
    }

    // Combien de profondeur il reste a ce kart dans la direction `n` avant le
    // bord de piste. Sert au sandwich : un kart plaque contre le bord ne peut
    // pas reculer davantage, sa part de separation doit passer a l'autre.
    function roomToward(cfg, kart, n) {
        return n > 0 ? cfg.road.maxY - kart.yPercent : kart.yPercent - cfg.road.minY;
    }

    // Deplace un kart le long de la piste en gardant position et progression
    // cousues l'une a l'autre, exactement comme le fait la boucle de
    // deplacement. Le compteur de tours en fait partie : une separation
    // longitudinale ne vaut que quelques pixels, mais rien n'interdit qu'elle
    // tombe pile sur la ligne d'arrivee.
    function shiftKartAlongTrack(cfg, kart, dist) {
        if (!dist) return;
        const prevWorldX = kart.worldX;
        kart.totalDistance += dist;
        kart.worldX += dist;
        if (kart.worldX >= cfg.world.width) kart.worldX -= cfg.world.width;
        if (kart.worldX < 0) kart.worldX += cfg.world.width;

        const finishX = cfg.world.finishLineX;
        if (dist >= 0) {
            if (prevWorldX < finishX && kart.worldX >= finishX) {
                kart.lapCount++;
                kart.hasPassedFinishLine = true;
            }
        } else if (prevWorldX >= finishX && kart.worldX < finishX) {
            kart.lapCount--;
        }
    }

    // Un intouchable fait toupiller ce qu'il percute. Deux gardes, et elles
    // comptent toutes les deux : on ne relance pas un tete-a-queue deja en
    // cours — la passe se rejoue a chaque tick tant que le contact dure, et
    // sans cette garde la victime tournerait indefiniment — et on respecte le
    // sursis d'apres-choc.
    function spinOnContact(cfg, now, kart, events) {
        if (kart.state !== 'running') return;
        if (kart.hitInvincibleUntil > now) return;
        spinOutKart(cfg, now, kart, events);
    }

    // Resolution d'une paire. `withImpulse` n'est vrai qu'a la premiere passe :
    // les suivantes ne font que finir de decoller les positions. Appliquer
    // l'impulsion a chaque passe la compterait deux fois.
    function resolveKartPair(cfg, now, deltaTime, a, b, withImpulse, events) {
        const c = cfg.physics.contact;

        let boxX, boxY;
        if (a.isBill || b.isBill) {
            // Le bill balaie plus large qu'une carrosserie : il traverse la
            // piste en trombe, il ne se faufile pas.
            boxX = cfg.bill.hitbox.x;
            boxY = cfg.bill.hitbox.y;
        } else {
            const halfA = kartHalfExtents(cfg, a);
            const halfB = kartHalfExtents(cfg, b);
            boxX = halfA.x + halfB.x;
            boxY = halfA.y + halfB.y;
        }

        // `dx` est signe : positif quand `a` est devant `b`. `dy` de meme,
        // positif quand `a` est du cote des grandes profondeurs.
        const dx = getShortestDistance(cfg, a.worldX, b.worldX);
        const penX = boxX - Math.abs(dx);
        if (penX <= 0) return;
        const dy = a.yPercent - b.yPercent;
        const penY = boxY - Math.abs(dy);
        if (penY <= 0) return;

        // Deux intouchables ne se blessent pas : c'est ce qui met l'etoile hors
        // d'atteinte du bill, et l'inverse.
        const bothRam = isRamming(a) && isRamming(b);
        if (!bothRam) {
            if (isRamming(a)) spinOnContact(cfg, now, b, events);
            else if (isRamming(b)) spinOnContact(cfg, now, a, events);
        }

        // Deux bills font exception au « sans rien » : ils tiennent tous les
        // deux le milieu de la piste, s'y traverser serait le seul endroit du
        // jeu ou deux karts s'ignorent. Ils se bousculent donc, attenues et
        // sans degats. Deux autres intouchables, eux, se traversent.
        const billOnBill = a.isBill && b.isBill;
        if (bothRam && !billOnBill) return;
        const scale = billOnBill ? cfg.bill.pushFactor : 1;

        const mA = contactMass(cfg, a);
        const mB = contactMass(cfg, b);
        const total = mA + mB;
        // Part du choc encaissee par chacun : c'est la masse D'EN FACE qui la
        // fixe. Le lourd bouge peu, le leger part.
        //
        // Ces deux parts sont le seul endroit ou le poids se fait sentir dans un
        // contact, mais elles servent aux TROIS effets d'un choc : l'ejection,
        // le refus de braquage, et la separation des carrosseries. Regler
        // `massBias` les deplace donc ensemble — un lourd est repousse moins
        // loin, garde plus de volant et cede moins de terrain, d'un seul coup.
        const shareA = mB / total;
        const shareB = mA / total;

        // Fraction du chevauchement resorbee sur ce pas, bornee a 1 comme le
        // lissage du volant : une image longue se contente d'arriver pile a la
        // separation, elle ne la depasse pas.
        const k = c.separationRate * deltaTime;
        const sep = k > 1 ? 1 : k;

        // ── La normale du choc ──────────────────────────────────────────────
        //
        // Les deux axes n'ont ni la meme unite ni la meme echelle : 60 pixels de
        // long contre 5 de profondeur. Les comparer directement n'a aucun sens.
        // On passe donc en ESPACE NORMALISE — chaque ecart rapporte a sa boite —
        // ou le contact redevient rond, et ou une direction se calcule.
        //
        // C'est ce qui donne l'angle. Un tamponnement pile dans l'axe rend une
        // normale horizontale ; le meme tamponnement avec un demi-kart de
        // decalage en profondeur rend une diagonale, et le kart percute part en
        // biais — vers le bas si celui qui arrive etait plus haut que lui. Le
        // choix d'axe unique d'avant ne pouvait pas exprimer ca : il rangeait ce
        // contact dans « tamponnement » et poussait tout droit.
        let ux = dx / boxX;
        let uy = dy / boxY;
        let len = Math.sqrt(ux * ux + uy * uy);
        if (len < 1e-6) {
            // Superposition parfaite. Arrive pour de vrai — deux karts clampes
            // au meme endroit du bord de piste — et se tranche sur
            // l'identifiant, pour que la passe reste reproductible.
            ux = 0;
            uy = a.id < b.id ? 1 : -1;
            len = 1;
        }
        // Unitaire, pointe de `b` vers `a`.
        const nx = ux / len;
        const ny = uy / len;

        if (withImpulse) {
            // Vitesse de rapprochement, un axe a la fois et dans son unite :
            // l'elan reel du tick pour la longueur, volant et choc en cours
            // confondus pour la profondeur.
            const sgnX = nx >= 0 ? 1 : -1;
            const sgnY = ny >= 0 ? 1 : -1;
            const closeX = (b.contactSpeed - a.contactSpeed) * sgnX;
            const closeY = ((b.vy + b.bumpVy) - (a.vy + a.bumpVy)) * sgnY;

            // Rapprochement le long de la normale, ramene en boites par seconde
            // — la seule facon de melanger les deux axes sans comparer des
            // pixels a de la profondeur.
            const approach = (closeX / boxX) * Math.abs(nx)
                           + (closeY / boxY) * Math.abs(ny);

            // LA porte du modele : une impulsion ne part que s'ils se
            // rapprochent ENCORE. Deux karts qui se touchent en s'ecartant
            // deja n'ont plus rien a se dire — les repousser a chaque tick est
            // exactement ce qui les collait l'un a l'autre.
            if (approach > 0) {
                let force = c.ejectBase + approach * c.restitution;
                if (force > c.maxEject) force = c.maxEject;
                force *= scale;

                // Un seul coup, reparti sur les deux axes par la normale : la
                // diagonale sort d'elle-meme du rapport `nx`/`ny`.
                const jx = force * nx * c.ejectX;
                const jy = force * ny * c.ejectY;
                a.bumpVx = clamp(a.bumpVx + jx * shareA, -c.maxBumpX, c.maxBumpX);
                a.bumpVy = clamp(a.bumpVy + jy * shareA, -c.maxBumpY, c.maxBumpY);
                b.bumpVx = clamp(b.bumpVx - jx * shareB, -c.maxBumpX, c.maxBumpX);
                b.bumpVy = clamp(b.bumpVy - jy * shareB, -c.maxBumpY, c.maxBumpY);
            }

            // Refus de braquage, lui applique a chaque tick du contact et non au
            // seul rapprochement : ce n'est pas une poussee mais un appui qui se
            // derobe. Chacun perd la part de son volant qui pousse dans l'autre,
            // en proportion de la masse d'en face — c'est ici, et nulle part
            // ailleurs, qu'un lourd force le passage sur un leger.
            //
            // Dose par `ny` : un tamponnement pur ne prend le volant de
            // personne, il n'y a pas de flanc a disputer.
            const denyReach = Math.abs(ny) * scale;
            const intoA = -a.vy * sgnY;
            if (intoA > 0) a.vy += intoA * c.steerDeny * shareA * denyReach * sgnY;
            const intoB = b.vy * sgnY;
            if (intoB > 0) b.vy -= intoB * c.steerDeny * shareB * denyReach * sgnY;
        }

        // ── Separation ──────────────────────────────────────────────────────
        //
        // Le filet de securite, pas le moteur du choc : l'ejection fait le
        // travail, ceci empeche seulement deux carrosseries de rester l'une dans
        // l'autre. Le chevauchement se corrige le long de la meme normale, donc
        // en diagonale lui aussi.
        const corrX = Math.max(penX - c.slopX, 0) * sep * Math.abs(nx);
        const corrY = Math.max(penY - c.slopY, 0) * sep * Math.abs(ny);

        // Le sandwich contre le bord se traite ici : un kart sans place devant
        // lui rend sa part a l'autre, sinon la paire reste collee au bord
        // jusqu'a ce que l'IA la decolle.
        const dirY = ny >= 0 ? 1 : -1;
        let corrAy = corrY * shareA;
        let corrBy = corrY * shareB;
        const roomA = Math.max(0, roomToward(cfg, a, dirY));
        const roomB = Math.max(0, roomToward(cfg, b, -dirY));
        if (corrAy > roomA) { corrBy += corrAy - roomA; corrAy = roomA; }
        if (corrBy > roomB) { corrAy = Math.min(corrAy + (corrBy - roomB), roomA); corrBy = roomB; }
        a.yPercent += corrAy * dirY;
        b.yPercent -= corrBy * dirY;

        const dirX = nx >= 0 ? 1 : -1;
        shiftKartAlongTrack(cfg, a, corrX * shareA * dirX);
        shiftKartAlongTrack(cfg, b, -corrX * shareB * dirX);
    }

    // Passe complete : plusieurs relaxations sur toutes les paires, puis remise
    // en ordre. Une seule passe laisse un paquet de trois karts en
    // chevauchement, celui du milieu etant repousse par l'un dans l'autre.
    //
    // La remise en ordre finale n'est pas optionnelle : un contact peut pousser
    // un kart hors de la piste ou dans un tuyau, et ces deux verdicts ont ete
    // rendus plus tot dans le tick, sur une position qui n'est plus la sienne.
    function resolveKartContacts(cfg, state, now, deltaTime, events) {
        const c = cfg.physics.contact;
        const kartsLen = state.karts.length;

        for (let pass = 0; pass < c.iterations; pass++) {
            const withImpulse = pass === 0;
            for (let i = 0; i < kartsLen; i++) {
                const a = state.karts[i];
                if (!isContactActive(a)) continue;
                for (let j = i + 1; j < kartsLen; j++) {
                    const b = state.karts[j];
                    if (!isContactActive(b)) continue;
                    resolveKartPair(cfg, now, deltaTime, a, b, withImpulse, events);
                }
            }
        }

        for (let i = 0; i < kartsLen; i++) {
            const kart = state.karts[i];
            if (!isContactActive(kart)) continue;

            // Un kart que la passe de contacts vient de plaquer contre le bord
            // y frotte comme s'il s'y etait mis lui-meme : c'est le cas « pousse
            // contre le mur », et il n'a pas a etre traite a part.
            clampKartToRoad(cfg, kart, deltaTime);

            // Le sursis par tuyau de `collideKartWithPipes` rend ce second
            // passage sans danger : le tuyau deja encaisse dans le tick est
            // saute, seul un tuyau ou la poussee vient de mettre le kart peut
            // encore le cogner.
            collideKartWithPipes(cfg, state, kart, now, events);
        }
    }

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

            // Double la date en booleen, comme l'etoile et l'eclair : le
            // protocole n'a pas d'horloge, le drapeau se lit tel quel dans le
            // snapshot. Pose ici et pas dans la branche 'running' : un kart
            // percute pendant son choc garderait sinon un drapeau fige jusqu'a
            // son retour en course.
            kart.bumped = now < kart.bumpEndTime;

            // Les deux canaux de choc s'amortissent seuls, avant d'etre
            // consommes par le deplacement. Ils valent pour les deux etats : une
            // toupie encaisse un choc et le porte, elle aussi.
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

                // Deux regimes, et un seul les separe : `boost`. Sous objet, la
                // vitesse vise la pointe de l'objet et rien d'autre ; hors objet,
                // elle suit l'elan du kart. Le bill compte comme un objet — sans
                // ca son elan interne retomberait pendant le vol, et il sortirait
                // de sa transformation au ralenti au lieu de finir sur sa lancee.
                const boost = getActiveBoost(cfg, state, kart, now);

                if (boost) {
                    // La montee, et c'est tout ce qui se passe sous objet. Le
                    // taux est celui d'une relance normale, multiplie par la
                    // vivacite de l'objet : le kart le plus vif y monte donc un
                    // peu plus vite, mais tous finissent sur leur propre pointe.
                    //
                    // Le `else` ramene d'un coup quand la pointe visee baisse —
                    // un champignon qui s'eteint pendant une etoile, un bill qui
                    // rend la main. Le regime « elan » n'a de toute facon pas le
                    // droit de tenir une vitesse au-dessus de `topSpeed`.
                    const rampRate = cfg.speeds.accelerationRate * kart.stats.acceleration * boost.ramp;
                    if (kart.absoluteVelocity < boost.peak) {
                        kart.absoluteVelocity = Math.min(boost.peak,
                            kart.absoluteVelocity + rampRate * deltaTime);
                    } else {
                        kart.absoluteVelocity = boost.peak;
                    }

                    kart.momentum = 1.0;
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                } else {
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

                // Freiner au bord et rentrer au ralenti apres l'arrivee sont deux
                // decisions de pilotage, et un objet n'est pas du pilotage : il
                // ne se module pas. L'etoile et le bill y echappaient deja, le
                // champignon les rejoint — c'est la seule facon que les trois
                // rendent bien le multiplicateur qu'on leur donne.
                if (!boost) {
                    if (kart.finished) {
                        effectiveSpeed = Math.min(effectiveSpeed,
                            kart.stats.topSpeed * cfg.race.finishedSpeedRatio);
                    }
                    if (now < kart.brakeUntil) {
                        effectiveSpeed *= cfg.ai.edgeBrakeFactor;
                    }
                }

                // L'invincibilite ne dit plus rien de la vitesse : elle ne suit
                // que la date de l'etoile.
                if (kart.starEndTime > now) {
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

                // La descente de fin de vol. Elle ne peut pas passer par
                // `absoluteVelocity` : le kart n'est plus sous objet, et le
                // regime « elan » le ramenerait a `topSpeed` d'un coup. Elle
                // ramene donc la vitesse a celle du kart en `slowdownMs`, sans
                // jamais le freiner en dessous — d'ou le Math.max.
                const billSpeed = getBillSpeed(cfg, state, kart);
                if (!kart.isBill && kart.billSlowUntil > now) {
                    const left = (kart.billSlowUntil - now) / cfg.bill.slowdownMs;
                    effectiveSpeed = Math.max(
                        effectiveSpeed,
                        kart.stats.topSpeed + (billSpeed - kart.stats.topSpeed) * left
                    );
                }

                // Le choc longitudinal s'ajoute a la vitesse moteur, borne a
                // l'arret : emboutir coute son elan au kart de derriere, ca ne
                // le fait pas repartir en marche arriere.
                const shovedSpeed = effectiveSpeed + kart.bumpVx;
                let moveDist = (shovedSpeed > 0 ? shovedSpeed : 0) * deltaTime;

                // Choc contre un pipe : arret net, puis contrecoup. Le recul
                // entame `totalDistance` autant que l'avance — position et
                // progression restent ainsi cousues l'une a l'autre. Les
                // dissocier ferait franchir la ligne d'arrivee a un kart encore
                // en amont a l'ecran, la distance parcourue etant seule a
                // decider de la fin de course.
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

                // Apres le deplacement et le recadrage sur la piste : le tuyau
                // se juge sur la position ou le kart vient d'arriver.
                //
                // Les contacts entre karts, eux, ne sont PAS ici : ils se
                // resolvent dans `resolveKartContacts`, une fois que tout le
                // monde a bouge. Les traiter dans cette boucle poussait un kart
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

                // Un tuyau arrete aussi une toupie : elle glisse, mais pas a
                // travers le decor. `pipeBlocked` porte ce contact — il dure
                // tant que les deux se touchent, la ou `bumpEndTime` compte un
                // choc unique reserve aux karts en course.
                //
                // Une toupie glisse sur son erre, et elle encaisse : le choc
                // longitudinal s'ajoute a cette erre, borne a l'arret comme pour
                // un kart en course. Se faire tamponner pendant son tete-a-queue
                // pousse donc vraiment, au lieu de ne rien faire.
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

                // Le choc lateral la deplace aussi. Sans ces trois lignes, une
                // toupie encaissait une poussee en profondeur sans jamais s'y
                // deplacer : elle restait plantee dans le kart qui la percutait.
                kart.yPercent += kart.bumpVy * deltaTime;
                // Le frottement ne mord pas sur une toupie : sa glissade ne
                // passe pas par le moteur mais par `hitSpeed`, et elle est deja
                // en train de s'arreter toute seule.
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
                    kart.momentum = 0.2;
                    kart.momentumTarget = randomRange(rng, 0.6, 1.0);
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
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

            // Profondeur d'ou l'objet part sur ce pas. Les impacts se testent
            // sur le segment parcouru et non sur la seule position d'arrivee :
            // une verte renvoyee par un tuyau traverse la piste en trois pas et
            // passerait sinon d'un cote a l'autre d'un kart sans le toucher.
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
                // renvoie. Elle ne revient pas par hasard : c'est lui qui a
                // choisi de tirer dans cette direction, et le mur etait visible.
                if (item.type === 'greenShell' && kart.id === item.shooterId && !item.pipeBounced) continue;
                if (kart.state !== 'running' && kart.state !== 'hit') continue;

                if (isRamming(kart)) {
                    const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                    if (dk < cfg.hitboxes.itemVsKart.x
                        && crossedDepth(item, kart.yPercent, cfg.hitboxes.itemVsKart.y)) {
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

                const dk = Math.abs(getShortestDistance(cfg, item.worldX, kart.worldX));
                if (dk < cfg.hitboxes.itemVsKart.x
                    && crossedDepth(item, kart.yPercent, cfg.hitboxes.itemVsKart.y)) {
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

        // Le circuit vient du dessin, pose sur la config par
        // raceEngine/track.js. Sans lui il n'y a pas de monde a construire :
        // autant le dire ici plutot que de faire tourner une course sur un tour
        // de largeur NaN, ou personne ne croise jamais de boite.
        const drawnBoxes = cfg.world.itemBoxes;
        if (!cfg.world.width || !drawnBoxes || !drawnBoxes.length) {
            throw new Error('cfg.world sans circuit : appeler track.applyTrack(cfg, circuit) '
                + 'avant createWorldState. Les circuits se dessinent dans tracks/.');
        }

        const itemBoxes = drawnBoxes.map(box => ({
            worldX: box.x,
            y: box.y,
            active: true,
            reactivateTime: 0
        }));

        // Les pipes ne connaissent aucun etat : ni actifs, ni repris, ni
        // detruits. Ils sont recopies ici quand meme, pour que tout le contenu
        // du monde se lise au meme endroit que le reste — et parce qu'un jour
        // l'un d'eux voudra peut-etre bouger.
        const pipes = (cfg.world.pipes || []).map(pipe => ({
            worldX: pipe.x,
            y: pipe.y
        }));

        const statsTable = deriveCharacterStats(cfg);
        const roster = Object.keys(statsTable);
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
            const stats = statsTable[charName];

            const kart = {
                id: index,
                charName: charName,
                worldX: worldX,
                yPercent: verticalPos,
                totalDistance: 0,

                stats: stats,
                absoluteVelocity: 0,
                momentum: 0,
                momentumTarget: getNewMomentumTarget(rng, cfg, stats),
                nextMomentumChange: now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax),
                vy: 0,
                targetVy: 0,

                // Canaux de choc, tenus a l'ecart du pilotage et du moteur.
                // `bumpVy` est en profondeur/s, `bumpVx` en pixels/s. Les deux
                // s'ajoutent au deplacement puis s'amortissent seuls : ecrire un
                // choc dans `vy` le faisait effacer par `applySteering` avant que
                // les karts se soient decolles.
                bumpVy: 0,
                bumpVx: 0,

                // Vitesse le long de la piste sur le tick ecoule, en pixels/s.
                // Relevee a la fin du deplacement et lue par la passe de contact,
                // qui a besoin d'une vitesse de rapprochement reelle — recul de
                // pipe et tete-a-queue compris — et non de la consigne moteur.
                contactSpeed: 0,

                state: 'grid',
                rank: index + 1,

                aiState: 'cruising',
                originalLaneY: verticalPos,
                dodgeIntensity: 30,

                hitEndTime: 0,

                // Choc contre un pipe. `bumpEndTime` porte l'arret net,
                // `bumpRecoilLeft` ce qu'il reste a reculer. Le sursis est
                // retenu par tuyau : un kart qui vient d'en heurter un doit
                // pouvoir se cogner au suivant.
                bumpEndTime: 0,
                bumpRecoilLeft: 0,
                bumped: false,
                // Contact en cours avec un tuyau pendant un tete-a-queue : la
                // toupie est bloquee tant qu'il tient, sans que ce soit un choc.
                pipeBlocked: false,
                pipeImmuneUntil: 0,
                lastPipeIndex: -1,

                // Tuyau en cours de contournement, et couloir choisi pour le
                // passer. L'index tient jusqu'a ce que le tuyau soit derriere :
                // c'est ce qui donne une trajectoire au lieu d'une suite
                // d'ecarts.
                pipeTargetIndex: -1,
                pipeLaneY: 0,

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
            pipes: pipes,
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
        deriveCharacterStats,
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
