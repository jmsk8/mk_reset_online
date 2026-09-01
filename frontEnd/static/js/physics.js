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


            table[name] = {
                raw: raw,
                norm: norm,
                mass: mass,
                // Pointe additive : chaque axe apporte ses px/s, et les apporte
                // seul. La forme multiplicative d'avant faisait dependre le
                // rendement du poids de la puissance du kart, si bien qu'un
                // point lache sur la puissance devaluait les deux autres axes en
                // meme temps — il n'y avait plus de triangle, juste un axe fort.
                topSpeed: spec.speedBase
                    + spec.speedPerWeight * norm.weight
                    + spec.speedPerPower * norm.power,
                acceleration: clamp(force / Math.pow(mass, spec.massDragAccel),
                                    spec.accelClamp.min, spec.accelClamp.max),
                agility: clamp(grip / Math.pow(mass, spec.massDragAgility),
                               spec.agilityClamp.min, spec.agilityClamp.max),

                // Ce qui tient un kart quand il tourne, et donc ce que braquer
                // lui coute en vitesse (cf. `steerCost`).
                //
                // Meme forme que ses deux voisines — les trois axes bruts, le
                // poids au denominateur — et c'est le point : elle a ses PROPRES
                // exposants, et ne se deduit d'aucune autre stat.
                //
                // Elle a d'abord ete batie sur `agility`, qui portait deja le
                // poids et le handling dans le bon sens. C'etait plus court, mais
                // ca laissait `massDragAgility` gouverner deux choses a la fois :
                // la vitesse a laquelle un lourd tourne, ET ce que tourner lui
                // coute. Impossible alors de regler l'une sans deplacer l'autre.
                //
                // Aux valeurs livrees — `cornerMassDrag` egal a
                // `massDragAgility`, les deux gains a 1 — elle rend exactement
                // ce que rendait `agility * force`. Le decouplage ne change rien
                // tant qu'on ne s'en sert pas ; il rend seulement les deux
                // reglages independants.
                cornering: Math.pow(grip, spec.cornerGripGain)
                    * Math.pow(force, spec.cornerPowerGain)
                    / Math.pow(mass, spec.cornerMassDrag)
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
    // Un pipe est un DISQUE pose au sol : large le long de la piste, plat en
    // profondeur, et le seul corps rond du moteur — tous les autres sont des
    // boites. Ses deux axes n'ont pas la meme unite — `worldX` est en pixels de
    // monde, `y` en profondeur de piste — et rien ici ne les convertit l'un en
    // l'autre.
    //
    // La rondeur se lit donc dans un ESPACE NORMALISE : chaque ecart divise par
    // le demi-axe correspondant. Le tuyau y devient le cercle unite, les deux
    // unites du monde disparaissent, et c'est le seul repere ou un angle veut
    // dire quelque chose pour lui. C'est ce qui remplace l'ancienne comparaison
    // de durees : elle existait pour ne pas avoir a mettre des pixels en face
    // d'unites de piste, et normaliser regle le meme probleme une bonne fois.
    //
    // A l'ecran ca donne bien un rond, et sans rien convertir : `pipe.hitbox`
    // porte deja l'aplatissement de la perspective (3.33 : 1, le meme que le
    // kart), si bien que le disque au sol se dessine comme le sprite se voit.

    // Cet ecart tombe-t-il dans l'emprise ronde `box` ?
    function insidePipe(box, dx, dy) {
        const u = dx / box.x;
        const v = dy / box.y;
        return u * u + v * v < 1;
    }

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
    // Un corps rond n'a pas de faces : il a une NORMALE, differente en chaque
    // point. Elle se lit directement sur la position dans l'espace normalise
    // (cf. l'en-tete de section), et elle sert a deux choses : poser le point de
    // sortie sur l'arc, et dire ce que la carapace doit renverser.
    //
    // ── Pourquoi un seul axe se renverse ─────────────────────────────────
    //
    // La reflexion complete — renverser la part normale de la vitesse, garder la
    // tangentielle — est la reponse geometrique, et elle est fausse ICI. Les
    // deux axes du monde ne portent pas la meme echelle de vitesse : une verte
    // file a 880 px/s le long de la piste pour 1.5 unite/s de derive en
    // profondeur (`speeds.projectileSpeed` contre `speeds.shellVertical`), un
    // rapport que rien ne rapproche de celui des demi-axes du tuyau. Reflechir
    // pour de bon echange les deux budgets a 12 : 1 — un tir effleurant
    // ressortait a 70 unites/s en profondeur et traversait la piste en un tiers
    // de seconde, quand une verte met plusieurs secondes a changer de voie. Elle
    // enjambait au passage `maxSubStepY`, donc les karts.
    //
    // Le rond decide donc de l'ANGLE du renvoi, pas de la vitesse : chaque axe
    // garde la sienne, comme au rebond sur un bord de piste.
    //
    // L'axe renverse est celui qui porte le plus l'ENTREE dans le tuyau, mesuree
    // sur la normale. Ca remplace l'ancienne comparaison de durees, et pour la
    // raison meme qui la justifiait : un tir de plein fouet n'a aucune vitesse en
    // profondeur, et le classer en contact de flanc reviendrait a renverser un
    // zero — la carapace traverserait le tuyau sans le voir. La normale, elle,
    // vaut zero sur un axe que la carapace ne franchit pas.
    //
    // Ce qui change vraiment par rapport aux quatre faces d'avant, c'est OU
    // passe la bascule entre bout et flanc : elle suit maintenant l'arc, la ou
    // deux coins la faisaient sauter d'un coup.
    function bounceItemOffPipe(cfg, pipe, item) {
        const box = cfg.pipe.hitbox;
        const margin = 1 + cfg.pipe.escapeMargin;

        const dx = getShortestDistance(cfg, item.worldX, pipe.worldX);
        const dy = item.y - pipe.y;

        // La normale au point touche : dans l'espace normalise, c'est la
        // position elle-meme, ramenee a l'unite.
        let nu = dx / box.x;
        let nv = dy / box.y;
        let norm = Math.sqrt(nu * nu + nv * nv);

        // Pile au centre, aucune normale ne se calcule. On la prend alors sur la
        // trajectoire, ce qui renvoie la carapace d'ou elle vient. Le cas
        // demande d'entrer par le point exact et ne se verra jamais — mais une
        // division par zero ne se laisse pas au hasard.
        if (norm < 1e-6) {
            nu = -item.vx / box.x;
            nv = -item.vy / box.y;
            norm = Math.sqrt(nu * nu + nv * nv);
            if (norm < 1e-6) return false;
        }

        nu /= norm;
        nv /= norm;

        // Part de l'entree portee par chaque axe, dans le meme repere. Positive
        // quand cet axe pousse la carapace vers le centre : le renverser la fait
        // donc ressortir.
        const inX = -(item.vx / box.x) * nu;
        const inY = -(item.vy / box.y) * nv;

        // Elle s'eloigne deja par les deux : la renvoyer la ferait rentrer.
        if (inX <= 0 && inY <= 0) return false;

        // Reposee sur l'arc le long de la normale, marge comprise : sans ca le
        // sous-pas suivant la retrouve dedans et la renvoie une seconde fois.
        let outX = pipe.worldX + nu * box.x * margin;
        let outY = pipe.y + nv * box.y * margin;

        // Un pipe colle au bord deborde de la piste : ressortir par ce flanc-la
        // poserait la carapace hors du bitume, ou le rebond de bord la
        // renverrait aussitot dans le tuyau. Elle repart alors par le bout — et
        // s'il n'y a rien a renverser la non plus, le sous-pas suivant
        // retrouvera une geometrie franche.
        if (outY > cfg.road.maxY || outY < cfg.road.minY) {
            if (inX <= 0) return false;
            const sideX = dx >= 0 ? 1 : -1;
            item.vx = -item.vx;
            outX = pipe.worldX + sideX * box.x * margin;
            outY = item.y;
        } else if (inY > inX) {
            // Flanc : c'est la profondeur qui se renverse.
            item.vy = -item.vy;
        } else {
            // Bout : c'est l'avance le long de la piste.
            item.vx = -item.vx;
        }

        item.worldX = outX;
        if (item.worldX < 0) item.worldX += cfg.world.width;
        if (item.worldX >= cfg.world.width) item.worldX -= cfg.world.width;
        item.y = outY;
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
                const pdx = getShortestDistance(cfg, item.worldX, pipe.worldX);
                if (Math.abs(pdx) >= spec.hitbox.x) continue;
                if (!insidePipe(spec.hitbox, pdx, item.y - pipe.y)) continue;

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

        const box = cfg.pipe.hitbox;

        // La carrosserie de CE kart, et non celle du kart de reference : c'est
        // la seule mesure qui decide de ce qui touche, et elle vient de son
        // sprite (cf. `kartHalfExtents`). Un kart long se cogne donc plus tot
        // qu'un court, sur le tuyau comme sur un adversaire.
        //
        // La carrosserie reste une boite, le tuyau est rond : leur somme est un
        // rectangle aux coins arrondis, et c'est exactement ce que teste le
        // rabotage plus bas. La partie PLATE de ce rectangle vaut exactement la
        // demi-carrosserie — c'est ce que `kartVsPipe - pipe.hitbox` rendait par
        // soustraction quand la mesure etait la meme pour tous, et qui se lit
        // maintenant directement.
        //
        // Seuls les coins changent. De face comme de flanc, le contact tombe sur
        // la partie plate et vaut ce qu'il valait — un kart ne passe pas plus
        // pres, il passe seulement en diagonale la ou la boite le retenait par
        // un angle que le tuyau n'a pas.
        const flat = kartHalfExtents(cfg, kart, now);
        const reachX = box.x + flat.x;
        const reachY = box.y + flat.y;

        for (let p = 0; p < pipes.length; p++) {
            const pipe = pipes[p];
            const dx = getShortestDistance(cfg, kart.worldX, pipe.worldX);
            if (Math.abs(dx) >= reachX) continue;
            const dy = kart.yPercent - pipe.y;
            if (Math.abs(dy) >= reachY) continue;

            // Hors de la croix plate : c'est l'arc du tuyau qui tranche.
            const cornerX = Math.abs(dx) - flat.x;
            const cornerY = Math.abs(dy) - flat.y;
            if (cornerX > 0 && cornerY > 0 && !insidePipe(box, cornerX, cornerY)) continue;

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
            // Un tuyau efface l'elan, y compris celui qu'un objet en cours
            // tenait de cote : sans ca, la fin de l'objet le rendrait en silence
            // et le choc n'aurait rien coute a celui qui l'a pris lance.
            kart.preBoostMomentum = -1;

            // Ecarte vers le cote le plus degage. Sans ca, un kart pousse par le
            // peloton resterait plaque contre le tuyau : le chien de garde du
            // service finirait par le signaler, sans pour autant le liberer.
            //
            // Dans `bumpVy`, comme la glissade de la toupie juste au-dessus et
            // comme tout ce qui est subi. Ecrite dans `vy`, elle offrait a tous
            // les karts le meme decalage gratuit — 3.6 unites, soit les trois
            // quarts d'une esquive de bowser contre un sixieme de celle d'un
            // koopa. Le tuyau rendait donc maniable qui ne l'est pas, et
            // precisement la ou la maniabilite devrait se payer : au redemarrage
            // contre un mur, piste encore encombree.
            kart.bumpVy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;

            // Le plan en cours ne vaut plus rien : il visait a passer, et le
            // kart est arrete contre le tuyau. Il rechoisira un couloir au
            // redemarrage, depuis la position ou la poussee laterale l'a mis.
            kart.aiState = 'cruising';
            kart.plan.threatId = 0;
            kart.pipeTargetIndex = -1;

            events.push({ type: 'kartBumped', kartId: kart.id, pipeIndex: p });
            return;
        }
    }

    // -----------------------------------------------------------------------
    // Le braquage
    //
    // ── Le modele ────────────────────────────────────────────────────────
    //
    // Une manoeuvre laterale est TOUJOURS une profondeur a rejoindre. Le trou
    // ou passer, la ligne a quitter, la cible a cadrer, la boite a ramasser :
    // la situation dit OU aller, et elle le dit pareil pour les huit karts.
    //
    // Ce qui separe un kart d'un autre est le TEMPS qu'il met a y arriver.
    //
    // C'est le point du systeme, et il a change : plusieurs manoeuvres
    // calculaient auparavant une AMPLITUDE proportionnelle a l'agilite —
    // pousser a `4 * agility` pendant une seconde — si bien qu'un kart maniable
    // ne se contentait pas d'aller plus vite au meme endroit, il allait ailleurs.
    // Une derive de confort emmenait un koopa sur trois fois plus de piste qu'un
    // bowser sans que rien, dans la situation, ne le demande. Desormais la
    // situation fixe la cible, l'agilite fixe la duree.
    //
    // Corollaire pratique : toute question de pilotage devient une question de
    // temps, donc mesurable. « Ce couloir, je l'atteins avant le tuyau ? »
    // `steerReach` et `steerDelay` y repondent par les deux bouts.
    //
    // ── Le reflexe ne depend pas du kart ─────────────────────────────────
    //
    // Il a deux etages, et aucun des deux ne regarde les stats :
    //   - la latence de decision, `ai.reactionBaseMs`, tiree a chaque menace ;
    //   - l'inertie du volant, `physics.steer.response`.
    //
    // Un kart ne voit pas plus tot ni ne decide plus vite qu'un autre. La seule
    // chose qu'il puisse faire en reponse a un reflexe, a une envie d'esquive ou
    // de visee, c'est actionner son volant — avec ses moyens a lui.
    //
    // ── Ses moyens, justement ────────────────────────────────────────────
    //
    // `steerCap` les rassemble, et il n'y en a que deux :
    //   - `agility`, ce que le personnage vaut au volant ;
    //   - l'appui qui lui reste a l'allure du moment (`physics.steer.pace`) :
    //     un kart lance tourne moins bien qu'un kart au ralenti.
    //
    // ── Qui ecrit `vy` ───────────────────────────────────────────────────
    //
    // Une seule fonction le fait sur ordre : `steer`. L'invariant se verifie en
    // cherchant `.vy` suivi d'une affectation dans ce fichier ; il ne doit rien
    // sortir d'autre que `steer`, l'initialisation d'un kart, et ces deux
    // contraintes — qui ne commandent rien, elles reprennent :
    //   - `clampKartToRoad` annule la composante SORTANTE au bord de piste ;
    //   - `resolveKartPair` reprend la part de volant qui pousse dans la
    //     carrosserie d'en face. Ce n'est pas une consigne, c'est un appui qui
    //     se derobe.
    //
    // Les chocs eux-memes n'y touchent pas : ils vivent dans `bumpVy`, un canal
    // separe, justement pour ne pas etre effaces par le volant en 200 ms.
    //
    // Ajouter une manoeuvre, c'est donc : trouver la profondeur a viser, lui
    // donner un profil dans `ai.steering`, et appeler `steer`. Rien d'autre.
    // -----------------------------------------------------------------------

    // Allure du kart, en fraction de sa propre pointe.
    //
    // Rapportee a SA pointe et non a une vitesse absolue, comme pour l'inertie
    // de contact : ce qui compte n'est pas de rouler vite dans l'absolu mais
    // d'etre lance pour soi. `contactSpeed` est le deplacement reellement
    // effectue au tick precedent — boosts, frottement de mur et chocs en cours y
    // sont deja, il n'y a rien a recomposer.
    function steerPace(kart) {
        const top = kart.stats.topSpeed;
        if (!(top > 0)) return 1;
        const pace = kart.contactSpeed / top;
        return pace < 0 ? 0 : (pace > 1 ? 1 : pace);
    }

    // Ce qu'il reste de volant a l'allure du moment. Vaut 1 a l'arret, et
    // `1 - drag` a pleine pointe.
    function steerGrip(cfg, kart) {
        const pace = cfg.physics.steer.pace;
        if (!pace.drag) return 1;
        return 1 - pace.drag * Math.pow(steerPace(kart), pace.curve);
    }

    // Vitesse laterale maximale d'un kart pour une manoeuvre de reference
    // donnee. C'est le seul endroit ou le personnage entre dans le braquage.
    //
    // Trois facteurs, et pas un de plus : ce que le personnage vaut, ce qu'il
    // lui reste d'appui a l'allure, et ce qu'un objet de vitesse lui rend
    // (`kart.steerBoost`, pose une fois par tick).
    //
    // Un bill en est exempt des trois : il ne pilote pas, il devie, et il vole a
    // pleine vitesse par definition. Le soumettre a l'appui a l'allure
    // reviendrait a lui interdire de contourner le tuyau qu'il vise.
    // Ce que le volant MORD a l'allure du moment.
    //
    // `steerGrip` dit ce qu'on perd de volant en etant lance. Il ne dit rien du
    // bas de l'echelle, et son bas de l'echelle etait faux : a l'arret `pace`
    // vaut 0, donc `grip` vaut 1, donc un kart IMMOBILE disposait de son volant
    // MAXIMUM. Un kart qui vient d'encaisser un objet repartait a 20 km/h en se
    // deplacant lateralement plus vite qu'a pleine pointe — il partait en crabe,
    // et pres d'un tuyau ca se voyait comme une embardee sortie de nulle part.
    //
    // Le commentaire de `physics.steer.pace` defendait meme l'effet : « la
    // remise en route se fait a allure reduite, donc avec du volant en plus ».
    // C'est faux a l'ecran : on ne change pas de direction sans avancer.
    //
    // Deux mecaniques distinctes, donc, et il en manquait une :
    //
    //   `drag`  ce qu'on perd de volant a FORCE d'aller vite. Existait.
    //   `bite`  ce qu'on n'a pas encore FAUTE d'avancer. Nouveau.
    //
    // Au-dessus de `bite` rien ne change — la croisiere est a 0.94, donc tout ce
    // qui a ete regle jusqu'ici tient trait pour trait. En dessous, le volant
    // s'efface avec l'allure, et le deplacement lateral redevient une fraction
    // du deplacement tout court.
    function steerBite(cfg, kart) {
        const bite = cfg.physics.steer.pace.bite;
        if (!(bite > 0)) return 1;

        const pace = steerPace(kart);
        return (pace >= bite) ? 1 : pace / bite;
    }

    function steerCap(cfg, kart, base) {
        if (kart.isBill) return base;
        return base * kart.stats.agility * steerGrip(cfg, kart)
            * steerBite(cfg, kart) * kart.steerBoost;
    }

    // Ce que braquer coute en vitesse d'avance, en multiplicateur a appliquer
    // tel quel. Vaut 1 quand le kart ne tourne pas, et quand la mecanique est
    // desactivee (`corner.cost` a 0).
    //
    // C'est LA fonction du cout, comme `steer` est celle du braquage : elle est
    // appelee une fois, au seul endroit qui decide de la vitesse, et rien
    // d'autre dans le moteur n'a a savoir qu'un virage coute quelque chose.
    //
    // ── Le piege, et il invalide les formulations spontanees ─────────────
    //
    // `vy` n'est pas la manoeuvre demandee : `steerCap` y a mis l'agilite du
    // kart, son appui a l'allure et son objet de vitesse. Facturer `|vy|` tel
    // quel PUNIT l'agile — il paie 4.6 fois plus cher pour la meme manoeuvre ;
    // et ne retirer qu'une fois l'agilite S'ANNULE exactement, ne produisant
    // rigoureusement rien.
    //
    // Deux temps, donc. D'abord retrouver la CONSIGNE, celle que le pilotage a
    // demandee et qui ne depend d'aucun personnage : on divise par ce que
    // `steerCap` rend pour une consigne de 1, ce qui retire les trois facteurs
    // d'un coup et suivra tout seul si un quatrieme arrive un jour. Puis la
    // facturer a la tenue du kart.
    //
    // ── Ce qui la reduit ────────────────────────────────────────────────
    //
    // `stats.cornering` : le handling et la puissance la reduisent, le poids
    // l'augmente. Un koopa ne perd presque rien, un bowser perd un peu.
    //
    // L'allure entre aussi : tourner a l'arret ne coute rien, tourner lance
    // coute plein tarif. C'est ce qui en fait une contrainte de virage et non
    // une taxe sur le volant.
    function steerCost(cfg, kart) {
        const corner = cfg.physics.steer.corner;
        if (!corner.cost || !kart.vy || kart.isBill) return 1;

        const unit = steerCap(cfg, kart, 1);
        if (unit <= 0) return 1;

        // Consigne demandee, rapportee au plein braquage : sans dimension, et
        // c'est ce qui rend `cost` lisible en pourcentage.
        const lock = Math.abs(kart.vy) / unit / corner.fullLock;

        const loss = corner.cost * lock * steerPace(kart) / kart.stats.cornering;
        return 1 - (loss > corner.maxLoss ? corner.maxLoss : loss);
    }

    // ── La loi de braquage, et ses deux lectures ────────────────────────────
    //
    // Le volant est un premier ordre de constante de temps `tau` : lache a
    // l'arret vers une consigne `cap`, il couvre
    //
    //     d(t) = cap * (t - tau * (1 - exp(-t / tau)))
    //
    // `steerReach` rend `d` pour un `t`, `steerDelay` rend `t` pour un `d`.
    // Elles sont exactement inverses l'une de l'autre, et doivent le rester.
    //
    // Le moteur n'utilise que la premiere, et pour une raison de cout : les
    // planificateurs comparent des candidats — quel couloir, quel trou — et une
    // portee se calcule une fois pour tous, la ou un temps se calculerait par
    // candidat. « Ce couloir est-il a portee » et « ai-je le temps de l'atteindre »
    // sont la meme question ; c'est la premiere forme qui est la moins chere.
    //
    // La seconde est exportee, et c'est la lecture qui se REGARDE : elle rend
    // en clair la duree d'une manoeuvre kart par kart, qui est la grandeur que
    // le systeme promet et que rien ne mesurait. Le banc de scenario s'en sert.

    // Distance laterale couverte en `ms`, en partant a l'arret. Sur une reaction
    // courte, une bonne part du trajet passe dans la montee en regime : c'est le
    // terme en `exp`, et c'est lui qui rend le calcul honnete pour un reflexe.
    function steerReach(cfg, cap, ms) {
        if (ms <= 0) return 0;
        const t = ms / 1000;
        const tau = 1 / cfg.physics.steer.response;
        return cap * (t - tau * (1 - Math.exp(-t / tau)));
    }

    // Temps, en ms, qu'il faut pour couvrir `dy` en partant a l'arret. Infini si
    // le kart n'a aucun volant a offrir — il n'y arrivera jamais, et c'est la
    // reponse juste.
    //
    // L'inversion n'a pas de forme fermee. En posant `u = t / tau` et
    // `s = dy / (cap * tau)`, il s'agit de resoudre `u - 1 + exp(-u) = s`.
    //
    // Newton, amorce sur l'asymptote qui convient : `sqrt(2s)` quand le trajet
    // tient dans la montee en regime — la loi y est parabolique — et `s + 1`
    // quand il la depasse, ou la montee n'est plus qu'un retard constant. Les
    // deux departs sont deja bons a quelques pour cent, et quatre tours rendent
    // l'inverse a la precision machine.
    //
    // Le garde-fou sur la derivee ne se declenche qu'a `u` nul, c'est-a-dire
    // pour un `dy` deja ecarte plus haut. Il est la pour que la boucle ne puisse
    // pas diviser par zero si les reglages changent.
    function steerDelay(cfg, cap, dy) {
        if (dy <= 0) return 0;
        if (cap <= 0) return Infinity;

        const tau = 1 / cfg.physics.steer.response;
        const s = dy / (cap * tau);

        let u = (s < 0.5) ? Math.sqrt(2 * s) : s + 1;
        for (let i = 0; i < 4; i++) {
            const e = Math.exp(-u);
            const slope = 1 - e;
            if (slope < 1e-12) break;
            u -= (u - 1 + e - s) / slope;
        }

        return u * tau * 1000;
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
    // A partir de QUAND une menace en est une, pour CE kart-la.
    //
    // ── Le defaut que ca corrige ─────────────────────────────────────────
    //
    // `ai.threatWindowMs` valait 900 ms pour tout le monde. Or il faut d'abord
    // reagir (`reactionBaseMs`, jusqu'a 378 ms), puis couvrir le degagement —
    // 7 unites de profondeur pour une banane pleine face. Un lourd esquive a
    // 7.8 unites par seconde au plus faible de son tirage : il lui faut plus de
    // 1400 ms. On lui en donnait 900.
    //
    // Consequence mesuree au banc, sur une banane POSEE, immobile, visible
    // pendant pres de trois secondes : bowser et dk la prenaient 100 % du
    // temps, mario 67 %. Ce n'etait ni de l'inattention (`dodgeMissChance`, 10 %)
    // ni un manque d'agilite — le kart n'avait tout simplement pas le droit de
    // commencer. Il regardait la banane arriver.
    //
    // La fenetre se taille donc sur le besoin : le temps de s'en apercevoir,
    // plus le temps de s'ecarter. `threatWindowMs` reste le PLANCHER — un vif
    // n'y gagne rien et garde exactement le comportement d'avant.
    //
    // Et elle se calcule au PIRE TIRAGE d'intensite (`dodgeIntensityMin`), pas
    // au tirage moyen : l'esquive tire son urgence au sort, et une fenetre
    // calee sur la moyenne laisse tomber une fois sur deux celui qui tire bas.
    // Au banc c'est tout l'ecart entre 49 % de prises et 12 %.
    function threatWindow(cfg, kart, threatY) {
        const ai = cfg.ai;
        const need = cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item
            - Math.abs(threatY - kart.yPercent);
        if (need <= 0) return ai.threatWindowMs;

        // A l'arret le volant ne mord plus (`steerBite`), donc le temps
        // necessaire tend vers l'infini et TOUT deviendrait une menace. Un kart
        // qui ne bouge pas n'a de toute facon pas de temps avant impact a
        // calculer : on s'en tient au plancher.
        const cap = steerCap(cfg, kart, ai.dodgeIntensityMin);
        if (!(cap > 0)) return ai.threatWindowMs;

        const own = ai.reactionBaseMs * ai.reactionJitterMax
            + steerDelay(cfg, cap, need);
        return (own > ai.threatWindowMs) ? own : ai.threatWindowMs;
    }

    // La laisse en distance qui accompagne la fenetre. Elle existe pour ne pas
    // s'alarmer de ce qui converge de tres loin ; elle n'a aucune raison de
    // refuser ce que la fenetre vient d'accepter. Sans ce plancher, allonger la
    // fenetre pour un lourd ne servait a rien : `threatMaxDistance` la
    // rattrapait aussitot.
    function threatLeash(cfg, windowMs, rel) {
        const reach = (rel > 0) ? (rel * windowMs) / 1000 : 0;
        const leash = cfg.ai.threatMaxDistance;
        return (reach > leash) ? reach : leash;
    }

    function missChance(cfg, kart, threatY, spareMs) {
        const ai = cfg.ai;
        const base = ai.dodgeMissChance;

        // Il passe deja assez a cote pour que la hitbox le manque.
        const need = cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item
            - Math.abs(threatY - kart.yPercent);
        if (need <= 0) return 0;
        if (spareMs <= 0) return base;

        // Etalonne sur l'agilite de reference, pas sur celle du kart : ce
        // tirage dit s'il a VU venir la menace, et un kart maniable n'est pas
        // plus attentif qu'un autre. Savoir l'esquiver se joue apres, dans le
        // decalage lui-meme.
        //
        // Il ne passe pas non plus par `steerCap` : l'appui a l'allure n'a rien
        // a faire dans un tirage d'attention. Un kart lance ne voit pas moins
        // bien venir, il s'en sortira moins bien — et ca, c'est le braquage qui
        // le dira.
        const cap = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * referenceAgility(cfg);
        const ease = steerReach(cfg, cap, spareMs) / need;

        if (ease <= 1) return base;
        if (ease >= ai.dodgeEasyRatio) return 0;
        return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
    }

    // -----------------------------------------------------------------------
    // La vue
    //
    // Un seul balayage par kart, et tout le pilotage lit son resultat.
    //
    // Avant, chaque manoeuvre avait sa propre perception : huit boucles sur les
    // memes tableaux, huit portees differentes, huit facons de decider ce qui
    // etait « devant ». Rien ne garantissait qu'elles voient le meme monde, et
    // elles ne le voyaient pas. L'esquive ne comptait aucune carrosserie, si
    // bien qu'un kart plongeait sous une carapace pour se planter dans son
    // voisin ; l'etoile et le bill blessent au contact sans que personne ne s'en
    // ecarte jamais ; et rien, nulle part, ne regardait derriere — une carapace
    // tiree vers l'avant rattrape sa victime par l'arriere, donc aucune n'etait
    // esquivable.
    //
    // Le balayage produit quatre choses, et la decision ne lit rien d'autre :
    //   - LA MENACE retenue, arbitree au cout (`vision.cost`) et non par un
    //     ordre fige de manoeuvres ;
    //   - LE DANGER LATENT : le porteur arme le plus proche qui partage la
    //     ligne, pour la precaution — personne n'a encore rien lance ;
    //   - L'ENCOMBREMENT de la piste en profondeur, une liste d'intervalles qui
    //     sert a la fois a masquer la vue et a chercher ou passer. C'est la meme
    //     donnee pour les deux, et c'est ce qui rend la vue moins chere que les
    //     huit boucles qu'elle remplace ;
    //   - LE TRAFIC ET LES OCCASIONS : le kart a doubler, la boite a prendre, et
    //     la cible sur laquelle se recaler pour tirer.
    //
    // Deux regles la gouvernent, et elles ne souffrent AUCUNE exception hors
    // celles ecrites plus bas :
    //   - ON NE VOIT QU'UN COTE. Regarder derriere coupe la vue de face.
    //   - UN CORPS SOLIDE MASQUE : un kart, un bill, un tuyau. Pas un objet au
    //     sol, trop petit pour cacher quoi que ce soit.
    //
    // Tout passe donc par une entree de balayage et par la marche qui la juge —
    // c'est ce qui rend la regle verifiable. Le danger latent se calculait
    // autrefois a cote, et echappait de ce fait a l'occlusion sans que rien ne
    // le dise ; la designation de cible de tir vers l'avant lisait carrement le
    // monde. Les deux sont rentres dans le rang.
    //
    // Et une exception, qui est le pendant des deux : LE DECOR NE SE PERD PAS.
    // Un tuyau porte une ombre mais n'en subit aucune, et reste vu meme quand le
    // regard porte derriere. Un pilote connait son circuit — ce que l'attention
    // lui retire, c'est la perception du trafic, pas la memoire du trace. Sans
    // cette exception un kart s'encastrerait dans un mur pour avoir regarde
    // ailleurs, ou pour avoir suivi quelqu'un de trop pres : spectaculairement
    // bete, et incomprehensible pour le spectateur qui, lui, voit le tuyau.
    //
    // Tout ce qui suit est commun a tout le plateau. Les statistiques de pilote
    // — brain, vision de jeu, sang-froid — viendront plus tard moduler les
    // memes valeurs kart par kart ; d'ici la, personne ne voit mieux que son
    // voisin ni ne decide mieux que lui.
    // -----------------------------------------------------------------------

    // Ce qu'une entree de balayage peut etre. Une meme entree en cumule
    // plusieurs : un objet traine ferme un passage ET fait mal.
    const SEE_BLOCK = 1;
    const SEE_THREAT = 2;
    const SEE_BOX = 4;
    const SEE_PRESSURE = 8;

    // Tampon de balayage, partage par tous les karts. `perceive` le remplit et
    // le consomme dans le meme appel — rien n'en ressort, tout ce qui doit
    // survivre est recopie dans `kart.sight`. Un seul tampon suffit donc, et il
    // cesse de grandir des les premieres frames : un balayage n'alloue rien.
    const scanPool = [];
    const scanOrder = [];
    let scanCount = 0;

    function scanTake() {
        if (scanCount === scanPool.length) {
            scanPool.push({
                look: 0, dx: 0, y: 0, shadowHalf: 0,
                blockHalf: 0, blockMargin: 0, blockCost: 0, blockHard: false, blockReach: 0,
                solid: false, pierces: false, role: 0,
                id: 0, kartId: -1, pipeIndex: -1, ttc: 0, cost: 0, kind: '',
                redHeld: false
            });
        }
        const e = scanPool[scanCount++];
        e.solid = false;
        e.pierces = false;
        e.role = 0;
        e.id = 0;
        e.kartId = -1;
        e.redHeld = false;
        e.pipeIndex = -1;
        e.ttc = 0;
        e.cost = 0;
        e.kind = '';
        e.shadowHalf = 0;
        e.blockHalf = 0;
        e.blockMargin = 0;
        e.blockCost = 0;
        e.blockHard = false;
        e.blockReach = 0;
        return e;
    }

    // Tri du balayage, par distance a l'oeil. Insertion et non `Array.sort` :
    // la liste depasse rarement la vingtaine, et a cette taille les appels au
    // comparateur coutent plus cher que les comparaisons elles-memes.
    function sortScan() {
        for (let i = 1; i < scanCount; i++) {
            const idx = scanOrder[i];
            const look = scanPool[idx].look;
            let j = i - 1;
            while (j >= 0 && scanPool[scanOrder[j]].look > look) {
                scanOrder[j + 1] = scanOrder[j];
                j--;
            }
            scanOrder[j + 1] = idx;
        }
    }

    // Les ombres portees, gardees telles quelles au lieu d'etre fusionnees :
    // avec huit karts et sept tuyaux la liste ne depasse pas la quinzaine, et
    // tester quinze volumes coute moins cher que de les tenir tries.
    //
    // Une ombre n'est plus une tranche de profondeur mais un VOLUME au sol, vu
    // depuis la camera de poursuite (cf. `vision.eye`) : deux pentes qui
    // s'ecartent en s'eloignant de l'oeil, et une longueur au-dela de laquelle
    // la route se revoit. Quatre nombres par corps au lieu de deux.
    //
    // Les pentes sont rapportees a l'oeil, jamais au corps : les rayons partent
    // de la camera, et une ombre ancree sur l'obstacle pointerait de travers des
    // que le kart n'est pas sur sa ligne.
    const shadowLo = [];    // pente basse, en profondeur par pixel
    const shadowHi = [];    // pente haute
    const shadowFrom = [];  // distance a l'oeil ou l'ombre commence
    const shadowTo = [];    // ... et ou elle s'arrete
    let shadowCount = 0;

    // La camera de CE balayage : son recul et la profondeur du kart. Poses par
    // `perceive`, lus par les deux fonctions ci-dessous — comme les tampons de
    // balayage, un seul jeu suffit puisque tout se consomme dans le meme appel.
    let shadowEyeBack = 0;
    let shadowEyeY = 0;
    let shadowRun = 0;

    // La distance a l'OEIL d'une entree du balayage. `look` se mesure depuis le
    // kart ; la camera est en arriere de lui, du cote oppose au regard.
    function eyeDist(look) {
        return look + shadowEyeBack;
    }

    // Ce corps est-il dans l'ombre d'un plus proche ?
    //
    // L'ancienne reponse tenait en une appartenance a un intervalle : la vue
    // etant DE COTE, disait le commentaire, une ombre occupe la meme tranche de
    // profondeur quelle que soit la distance. C'est vrai de la camera du
    // SPECTATEUR, et c'est ce qui rendait le raisonnement seduisant — mais le
    // kart, lui, regarde le long de la piste. De son point de vue une ombre est
    // bel et bien un cone, et la traiter en tranche donnait a un kart lointain
    // le meme pouvoir masquant qu'a un kart colle au pare-chocs.
    //
    // On compare donc des PENTES, pas des profondeurs — la meme chose qu'un
    // rayon lance depuis l'oeil, mais exacte et sans budget de rayons : un
    // lancer echantillonne raterait un passage plus fin que son pas angulaire,
    // et il en existe (deux karts a trois unites l'un de l'autre, a 800 px).
    // Une division par entree, et l'occlusion reste presque gratuite.
    function shadowHides(look, y) {
        const de = eyeDist(look);

        // Derriere la camera : il n'y a rien a masquer, et la pente n'aurait
        // aucun sens. Le seuil evite aussi la division qui explose a l'oeil.
        if (de <= 1) return false;

        const rel = (y - shadowEyeY) / de;

        for (let i = 0; i < shadowCount; i++) {
            // Devant l'obstacle, ou au-dela du bout de son ombre : on voit.
            // C'est TOUTE la difference avec une vue au ras du sol, ou la
            // seconde borne n'existait pas et ou un corps cachait tout ce qui
            // le suivait jusqu'a l'horizon.
            if (de <= shadowFrom[i] || de >= shadowTo[i]) continue;
            if (rel > shadowLo[i] && rel < shadowHi[i]) return true;
        }
        return false;
    }

    // L'urgence d'un danger : ce qu'il coute (`vision.cost`), rapporte au temps
    // qui reste. C'est la monnaie commune du systeme, et elle se calcule au meme
    // endroit pour tout le monde — le balayage s'en sert pour designer LA
    // menace, le pilotage pour savoir si un tuyau vaut d'interrompre une
    // esquive.
    function threatScore(cost, ttc) {
        return cost / Math.max(ttc, 1);
    }

    // Le tuyau vaut-il d'interrompre l'esquive en cours ?
    //
    // La comparaison porte sur le temps qui reste AU PLAN, et surtout pas sur ce
    // que le balayage tient pour le plus urgent a cet instant. Les deux
    // questions se ressemblent et n'ont rien a voir : une menace d'esquive cesse
    // d'etre vue des que le kart s'en est ecarte — c'est le but meme de la
    // manoeuvre — quand un tuyau, lui, reste vu sur toute la portee du regard.
    //
    // Confondre les deux lachait l'esquive a l'instant precis ou elle commencait
    // a marcher : le kart revenait dans l'objet qu'il venait d'eviter, et comme
    // le couloir de tuyau se calcule pareil pour les huit, tout le plateau
    // finissait sur la meme ligne.
    function pipeOutranksPlan(cfg, kart, now) {
        const sight = kart.sight;
        if (sight.pipeIndex < 0) return false;

        const pipeTtc = (sight.pipeDist / Math.max(kart.absoluteVelocity, 1)) * 1000;

        // Ce qui reste de l'echeance du plan, hors le sursis de relachement :
        // c'est le temps avant impact tel que le kart l'a estime. Negatif, le
        // plan expire de lui-meme au tour suivant — le score explose, et
        // l'esquive garde la main jusque-la plutot que d'etre coupee net.
        const spare = kart.plan.until - now - cfg.vision.holdAfterMs;

        return threatScore(cfg.vision.cost.pipe, pipeTtc)
             > threatScore(cfg.vision.cost.spin, spare);
    }

    // Menaces deja jugees : l'emplacement de `id`, ou -1.
    //
    // Un verdict a une DUREE DE VIE. Sans elle, une verte jugee « pas vue » a
    // son premier passage le restait toute sa vie — dix rebonds, plusieurs
    // secondes, une geometrie qui n'a plus rien a voir — et une menace revenue
    // apres un long detour retrouvait un reflexe deja echu, donc nul.
    //
    // Le releve se rafraichit tant que la menace reste sous les yeux : ce qui
    // se perime est l'ABSENCE, pas l'observation.
    function recallThreat(cfg, now, kart, id) {
        const ids = kart.judgedId;
        for (let i = 0; i < ids.length; i++) {
            if (ids[i] !== id) continue;
            if (now - kart.judgedSeenAt[i] > cfg.vision.memoryMs) return -1;
            kart.judgedSeenAt[i] = now;
            return i;
        }
        return -1;
    }

    // L'emplacement a ecraser : le premier libre ou perime, sinon le plus
    // ancien. L'anneau simple qu'il remplace ecrasait dans l'ordre, et pouvait
    // donc jeter une menace encore sous les yeux pour en loger une perimee.
    function judgeSlot(cfg, now, kart) {
        let oldest = 0;
        for (let i = 0; i < kart.judgedId.length; i++) {
            if (!kart.judgedId[i] || now - kart.judgedSeenAt[i] > cfg.vision.memoryMs) return i;
            if (kart.judgedSeenAt[i] < kart.judgedSeenAt[oldest]) oldest = i;
        }
        return oldest;
    }

    // Premiere perception d'une menace : le reflexe et le tirage d'inattention,
    // arretes une fois pour toutes et retenus (cf. `vision.memorySlots`).
    //
    // C'est ici que se joue toute la marge d'erreur d'un kart, et elle est la
    // meme pour les huit. Le jour ou les stats de pilote arriveront, elles
    // n'auront que ces deux lignes a moduler.
    function judgeThreat(cfg, rng, now, kart, id, y, ttc) {
        const ai = cfg.ai;
        const reactMs = ai.reactionBaseMs
            * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);

        const slot = judgeSlot(cfg, now, kart);
        kart.judgedId[slot] = id;
        kart.judgedSeenAt[slot] = now;
        kart.judgedReactAt[slot] = now + reactMs;

        // Ce qui restera une fois le reflexe passe, et non le delai brut avant
        // impact : c'est lui qui dit si l'esquive etait a sa portee.
        kart.judgedIgnored[slot] = rng() < missChance(cfg, kart, y, ttc - reactMs);
        return slot;
    }

    // Ce qui menace dans le dos, du souvenir plutot que de la vue.
    //
    // Rend '' quand il n'y a rien, ou plus rien d'assez frais. La duree est
    // celle de `pressureMemoryMs` : passe ce delai, un danger qu'on ne revoit
    // pas cesse de compter, et c'est ce qui oblige a se retourner encore pour
    // rester inquiet. Sans peremption, un kart double une fois resterait sur
    // ses gardes tout le tour.
    function dangerBehind(cfg, now, kart) {
        const sight = kart.sight;
        if (now - sight.dangerAt > cfg.vision.pressureMemoryMs) return '';
        return sight.dangerKind;
    }

    // L'attention : devant, ou derriere.
    //
    // Le tirage suit le rang — le premier n'a plus que l'arriere a surveiller,
    // le dernier a tout devant lui — et la CADENCE remonte quand quelqu'un le
    // vise dans le dos, ou quand c'est lui qui prepare un tir arriere.
    //
    // ── Pourquoi les gains portent sur l'intervalle et non sur la chance ──
    //
    // Le temps moyen entre deux coups d'oeil vaut `intervalle / chance` : y
    // multiplier la chance ou y diviser l'intervalle donne donc EXACTEMENT la
    // meme loi — sauf qu'une probabilite sature a 1 et pas une cadence.
    //
    // C'est ce qui rendait les deux gains inertes en tete de peloton, du temps
    // ou le premier regardait derriere 55 fois sur 100 : multiplie par
    // `pressureGlanceGain` (2.2) ca faisait 1.21, soit un coup d'oeil a chaque
    // tirage, et tout gain supplementaire tombait dans le vide. Le premier —
    // celui qui a le plus de raisons de regarder derriere — etait le seul que la
    // pression ne pressait plus.
    //
    // Les probabilites ont baisse depuis (`vision.backChance`), si bien que la
    // saturation ne menace plus ; la remarque tient quand meme, et c'est
    // pourquoi les gains restent sur la cadence. Les deux lois se composent
    // alors sans se manger : la cadence dit a quelle frequence il se POSE la
    // question, la probabilite ce qu'il repond.
    function updateGlance(cfg, rng, state, now, kart) {
        const vis = cfg.vision;
        const sight = kart.sight;

        if (sight.backUntil > now) {
            sight.back = true;
            return;
        }
        sight.back = false;

        if (now < sight.nextGlance) return;

        let pace = 1;

        // Le danger derriere ne presse plus la CADENCE, il releve la
        // PROBABILITE (`backChanceDanger`, plus bas). C'etait le meme signal
        // compte deux fois, et avec des coups d'oeil longs ca devenait nuisible :
        // a `pressureGlanceGain` (2.2) l'intervalle tombait a 636 ms, plus court
        // que la duree moyenne d'un coup d'oeil. Le kart serait reste tourne
        // vers l'arriere 60 % du temps — tres attentif a la carapace, et aveugle
        // a tout le reste.
        //
        // `sight.dangerAt` remplace exactement l'ancien `pressureBackAt` : meme
        // souvenir date, meme portee, mais il couvre aussi la carapace deja
        // partie et l'etoile, que l'ancien releve ne voyait pas.

        // Qui prepare un tir vers l'arriere se retourne pour viser. On ne tire
        // pas dans un peloton qu'on ne regarde pas, et c'est ce qui rend le tir
        // arriere JOUABLE pour celui qui le recoit : le tireur doit trouver son
        // moment, et pendant ce temps l'autre a pu se decaler.
        if (isAiming(cfg, kart) && now > kart.throwTime - cfg.ai.aimLeadMs
            && getShotDirection(state, kart) < 0) {
            pace *= vis.aimGlanceGain;
        }

        sight.nextGlance = now + vis.glanceIntervalMs / pace;

        // ── Ce qui donne envie de regarder derriere ──────────────────────
        //
        // Trois raisons, de la plus faible a la plus forte, et LE PLUS ELEVE
        // GAGNE : elles ne s'additionnent pas, ce sont trois lectures de la
        // meme question. Un kart qui vient d'avoir un objet ET qui sait
        // quelqu'un derriere ne regarde pas deux fois plus, il regarde pour la
        // meilleure des deux raisons.
        //
        //   sa place       le premier n'a plus que l'arriere a surveiller ; le
        //                  dernier n'a personne derriere, et n'y jette qu'un
        //                  oeil distrait.
        //   une zone vue   qui vient de traverser des boxes sait que ceux qui
        //                  l'entourent viennent peut-etre de s'armer.
        //   un danger vu   une carapace, un porteur, une etoile. Tant qu'il
        //                  est frais, la surveillance ne redescend pas.
        //
        // L'interpolation lineaire du rang a disparu : elle donnait au 4e une
        // valeur intermediaire qui ne voulait rien dire. `rankChance` dit les
        // trois cas qui existent — premier, peloton, dernier — comme partout
        // ailleurs dans le fichier.
        let chance = rankChance(vis.backChance, state, kart);

        if (now - kart.boxPassedAt <= vis.boxGlanceMs) {
            const armed = rankChance(vis.backChanceBox, state, kart);
            if (armed > chance) chance = armed;
        }

        if (dangerBehind(cfg, now, kart)) {
            const alert = rankChance(vis.backChanceDanger, state, kart);
            if (alert > chance) chance = alert;
        }

        if (rng() < chance) {
            // La duree se tire au sort. A duree fixe, huit karts qui se
            // retournent au meme tirage reviennent devant ensemble ; et surtout
            // un coup d'oeil trop court ne laisse pas le temps de voir arriver
            // quoi que ce soit — c'est ce qui rendait l'arriere invisible.
            sight.backUntil = now + randomRange(rng, vis.glanceDurationMin,
                                                     vis.glanceDurationMax);
            sight.back = true;
        }
    }

    // Garder son objet derriere soi, ou s'en debarrasser.
    //
    // ── Ce qui manquait ──────────────────────────────────────────────────
    //
    // Le choix de trainer se prenait UNE FOIS, a la seconde ou l'objet tombait
    // dans les mains (`chooseItemPlan`), c'est-a-dire au moment ou le kart en
    // savait le moins. Rien ne pouvait le lui faire reconsiderer ensuite. Un
    // kart qui avait prevu de tirer devant gardait ce plan pendant qu'une verte
    // lui arrivait dans le dos, et la prenait avec un bouclier dans les mains.
    //
    // Il retranche maintenant sa decision quand un danger apparait derriere, et
    // une fois par EPISODE de danger — pas a chaque balayage, sinon il tirerait
    // a pile ou face soixante fois par seconde.
    //
    // Contre une etoile ou un bill, rien : un objet traine ne les arrete pas.
    // Ce qu'il faut leur opposer, c'est de la place, et c'est l'esquive qui s'en
    // charge.
    function updateShield(cfg, rng, now, kart) {
        const ai = cfg.ai;
        const held = kart.heldItem;
        if (!held) return;

        const danger = dangerBehind(cfg, now, kart);
        if (!danger || danger === 'ram') return;

        const sight = kart.sight;

        // ── L'intouchable ────────────────────────────────────────────────
        //
        // Une etoile ou un bill ne se posent pas derriere soi : ils rendent
        // INTOUCHABLE, ce qui est une bien meilleure reponse qu'un bouclier —
        // la seule qui marche a coup sur contre une rouge, puisqu'elle suit.
        //
        // Rien ne les pressait : la date de declenchement se tirait a la prise
        // de l'objet, entre `holdItemMin` et `holdItemMax`, soit jusqu'a HUIT
        // SECONDES. Un kart pouvait donc rester assis sur son etoile pendant
        // qu'une rouge lui arrivait dessus, et la prendre en pleine face avec de
        // quoi l'annuler dans les mains. Ce n'etait pas un choix, c'etait un
        // minuteur qui ignorait la piste.
        //
        // Il n'avance pas la date a coup sur — `shield.panic` — et il ne la
        // recule jamais : un kart qui comptait s'en servir tout de suite n'a
        // aucune raison d'attendre parce qu'on le vise.
        if (held.type === 'star' || held.type === 'bill') {
            const red = sight.redBehindDist >= 0
                && sight.redBehindDist <= cfg.vision.giveWay.range;
            if (!red && danger !== 'shot') return;

            if (kart.shieldAt !== sight.dangerSince) {
                kart.shieldAt = sight.dangerSince;
                if (rng() < ai.shield.panic) {
                    // Le temps de s'en apercevoir, et rien de plus : c'est le
                    // meme reflexe que pour tout le reste.
                    const soon = now + ai.reactionBaseMs
                        * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);
                    if (soon < kart.throwTime) kart.throwTime = soon;
                }
            }
            return;
        }

        if (!isTrailable(cfg, held.type)) return;

        if (kart.shieldAt !== sight.dangerSince) {
            kart.shieldAt = sight.dangerSince;

            // Une carapace deja partie ne se discute presque plus : le bouclier
            // est la seule chose qui la mange. Un porteur laisse encore le choix
            // de le prendre de vitesse.
            const keep = (danger === 'shot') ? ai.shield.shot : ai.shield.carrier;
            kart.shieldHold = rng() < keep;

            if (!kart.shieldHold) {
                // Il s'en sert plutot que de s'en couvrir. Le plus souvent dans
                // la direction d'ou vient le danger — c'est la que se trouve
                // quelqu'un a toucher.
                if (rng() < ai.shield.backThrow) {
                    kart.shotDirection = -1;
                    kart.shotAsLeader = (kart.rank === 1);
                }
                kart.throwTime = now;
            } else if (held.holdPosition === 'hands'
                       && (!kart.trailTime || kart.trailTime > now)) {
                // TOUT DE SUITE, et pas seulement s'il n'avait rien prevu.
                //
                // Le test ne regardait que `!kart.trailTime` : un kart qui avait
                // deja programme de sortir son objet — dans 800 ms, comme le
                // veut `trailDelayMin/Max` — n'etait donc pas presse par la
                // carapace qui arrivait. Il attendait son minuteur avec un
                // bouclier dans les mains. Decider de se couvrir et le faire
                // plus tard, ce n'est pas se couvrir.
                kart.trailTime = now;
            }
        }

        // Tant que le danger dure, l'echeance de tir recule. Elle cesse d'etre
        // repoussee des que le souvenir se perime, et l'objet repart alors de
        // lui-meme : le bouclier ne se garde pas indefiniment, il se garde tant
        // qu'il sert.
        if (kart.shieldHold) kart.throwTime = now + cfg.vision.pressureMemoryMs;
    }

    // Un intervalle de plus dans l'encombrement retenu. Seul ce qui a ete VU y
    // entre : ce que le kart ne voit pas ne lui ferme aucun passage, et c'est
    // exactement le prix d'une vue bouchee.
    //
    // ── Ce qu'un span dit, et ce qu'il ne dit plus ───────────────────────
    //
    // Il portait un seul intervalle, gonfle des marges de confort, et tout le
    // monde le lisait comme un mur. Un tuyau, une banane et une carrosserie
    // fermaient donc la piste de la meme facon, alors qu'ils ne se valent pas
    // du tout : on ne traverse pas un tuyau, on encaisse une banane, on bouscule
    // un kart. Les couloirs etroits en mouraient — cf. `laneRisk`.
    //
    // Il en porte maintenant trois choses distinctes :
    //
    //   `lo`/`hi`  la limite DURE, en positions de centre : la hitbox nue, rien
    //              de plus. C'est de la geometrie, pas une preference.
    //   `margin`   le confort qu'on aimerait garder au-dela. L'entamer coute,
    //              proportionnellement — ce n'est pas un refus.
    //   `cost`     ce que coute le contact, en millisecondes, meme monnaie que
    //              `vision.cost`.
    //   `hard`     vrai pour le seul corps qu'on ne traverse pas : le tuyau.
    //              Tout le reste se paie et se franchit.
    function pushSpan(sight, e) {
        const i = sight.spanCount;
        if (i === sight.spans.length) {
            sight.spans.push({
                lo: 0, hi: 0, margin: 0, cost: 0, hard: false,
                dx: 0, reach: 0, pipeIndex: -1, spare: 0
            });
        }
        const s = sight.spans[i];
        s.lo = e.y - e.blockHalf;
        s.hi = e.y + e.blockHalf;
        s.margin = e.blockMargin;
        s.cost = e.blockCost;
        s.hard = e.blockHard;
        s.dx = e.dx;
        s.reach = e.blockReach;
        s.pipeIndex = e.pipeIndex;
        s.spare = 0;
        sight.spanCount = i + 1;
    }

    // Le balayage. Une passe par tableau, puis un tri, puis une seule marche qui
    // decide de tout : ce qui est vu, ce qui masque, ce qui menace.
    function perceive(cfg, state, rng, now, kart) {
        const vis = cfg.vision;
        const ai = cfg.ai;
        const sight = kart.sight;

        const dir = sight.back ? -1 : 1;
        const range = sight.back ? vis.range.back : vis.range.front;

        sight.at = now;

        // Le sens de CE balayage-la. `sight.back` bascule a la cadence de
        // l'affichage — c'est une attention — quand le balayage, lui, ne tourne
        // que toutes les `scanIntervalMs`. Au debut d'un coup d'oeil arriere,
        // `back` est donc deja vrai alors que tout le contenu de la vue vient
        // encore du balayage AVANT, et le releve de visee arriere mordait
        // dessus : le tireur relevait la profondeur d'un kart situe devant lui
        // pour viser derriere, sur environ un quart des coups d'oeil.
        sight.scanBack = sight.back;

        sight.threatId = 0;
        sight.threatKind = '';
        sight.threatY = 0;
        sight.threatTtc = Infinity;
        sight.planGone = false;
        sight.pipeIndex = -1;
        sight.pipeDist = 0;
        sight.pipeAheadIndex = -1;
        sight.pipeAheadDist = 0;
        sight.aheadKartY = 0;
        sight.aheadKartDist = -1;
        sight.seenKartY = 0;
        sight.seenKartDist = -1;
        sight.boxY = 0;
        sight.boxDist = -1;
        sight.pressure = false;
        sight.pressureY = 0;
        sight.pressureId = 0;
        sight.pressureBack = false;
        sight.spanCount = 0;
        sight.hiddenCount = 0;
        sight.scanRange = range;
        sight.crowdCount = 0;
        sight.redBehindDist = -1;
        sight.redBehindY = 0;
        sight.redBehindId = 0;
        sight.redBehindCount = 0;

        scanCount = 0;
        shadowCount = 0;

        // La camera de poursuite. Elle est TOUJOURS en arriere du regard : un
        // coup d'oeil arriere la fait passer devant le kart, ce qui est bien ce
        // qu'on veut — c'est le sens du regard qui la place, pas la marche.
        shadowEyeBack = vis.eye.back;
        shadowEyeY = kart.yPercent;
        shadowRun = vis.eye.run;

        const kartReach = cfg.hitboxes.kartVsKart;
        const pipeReach = cfg.hitboxes.kartVsPipe;
        const itemReach = cfg.hitboxes.itemVsKart;
        // Deux mesures de profondeur, et il ne faut pas les confondre.
        //
        // `clear` est le DEGAGEMENT : l'ecart au-dela duquel un objet passe a
        // cote pour de bon. C'est ce qu'une esquive doit couvrir, ce qu'un objet
        // ferme comme passage, et ce qu'une precaution cherche a prendre.
        //
        // `lane` est la VOIE : la bande de profondeur dans laquelle un objet est
        // considere comme etant sur la route du kart, donc a surveiller. Elle
        // est deliberement plus large que le degagement, et elle doit l'etre :
        // le kart et l'objet bougent tous deux en profondeur pendant le temps
        // avant impact, et il faut avoir commence a s'ecarter avant d'etre
        // pile dans l'axe. Un objet traine, en particulier, se suit sur
        // plusieurs secondes a faible vitesse relative — le resserrer a `clear`
        // revient a ne le voir qu'une fois dedans, trop tard pour un lourd.
        //
        // Les avoir confondues rendait les karts incapables d'esquiver : c'est
        // mesure a l'ecran, pas deduit.
        //
        // Une troisieme distance existe et ne se confond avec aucune des deux :
        // la LIMITE DURE d'un corps, sa hitbox nue. C'est elle qui borne les
        // spans (`pushSpan`), et le confort vient par-dessus en marge separee.
        const place = vis.place;
        const clear = itemReach.y + place.margin.item;
        const lane = vis.threatLane;
        const speed = kart.absoluteVelocity;

        // Demi-profondeur PROPRE d'un corps, celle qui porte son ombre. Les
        // hitboxes sont des ecarts entre centres : elles contiennent deja la
        // demi-carrosserie de la victime, qui n'a rien a faire dans une ombre.
        const kartHalf = kartReach.y * 0.5;
        const pipeHalf = pipeReach.y - kartHalf;
        const gain = vis.shadowGain;

        // ── Les tuyaux ───────────────────────────────────────────────────
        //
        // La bande de surveillance et le point d'arret ne dependent pas du
        // tuyau : ils se posent une fois. Cf. la note du test plus bas.
        const pipeWatch = pipeReach.y + place.margin.pipe;
        const pipeSettle = steerSettle(cfg, kart);

        const pipes = state.pipes;
        for (let p = 0; p < pipes.length; p++) {
            const dx = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
            if (dx < -pipeReach.x || dx > vis.range.front) continue;

            const e = scanTake();

            // `look` est une distance le long du REGARD, pour tout le monde :
            // c'est ce qui rend le tri du balayage comparable d'une entree a
            // l'autre. Un tuyau devant, pendant un coup d'oeil arriere, est donc
            // a une distance negative — il est derriere le regard.
            //
            // Sans effet visible aujourd'hui : un tuyau ne porte pas d'ombre
            // quand on regarde derriere, et n'en subit jamais. Mais c'etait la
            // seule entree a se mesurer autrement, et le jour ou l'une de ces
            // deux proprietes bouge, le tri melangeait deux metriques en
            // silence.
            e.look = dx * dir;
            e.dx = dx;
            e.y = pipes[p].y;

            // LE seul corps qu'on ne traverse pas. Masse infinie, il arrete net
            // — d'ou `blockHard`, que rien d'autre ne porte. Tout le reste du
            // decor se paie et se franchit.
            e.blockHalf = pipeReach.y;
            e.blockMargin = place.margin.pipe;
            e.blockCost = vis.cost.pipe;
            e.blockHard = true;

            // Aussi loin qu'on le voit, et pas une demi-seconde de course.
            //
            // Il empruntait `dodgeGuardDistance` (500), taille pour l'esquive :
            // « au-dela, l'ecart sera retombe avant d'arriver a sa hauteur ».
            // C'est vrai d'un objet qu'on evite d'un ecart, et faux d'un mur —
            // un tuyau ne s'en va pas, on ARRIVE dessus. Au-dela de 500 il
            // cessait donc d'etre un mur, le placement routait a travers, et le
            // kart ne s'ecartait qu'une fois collé : trop tard pour slalomer,
            // trop tard pour forcer un passage si quelqu'un occupait le sien.
            e.blockReach = cfg.pipe.seeDistance;
            e.shadowHalf = pipeHalf * gain;
            e.role = SEE_BLOCK;
            e.pipeIndex = p;

            // Il porte une ombre mais n'en subit aucune, et reste vu de dos :
            // c'est le decor, il se sait par coeur. Il cesse en revanche de
            // masquer pendant un coup d'oeil arriere, ou l'ordre des distances
            // est inverse et ou son ombre ne veut plus rien dire.
            e.solid = !sight.back;
            e.pierces = true;

            // Il ne barre la route que dans la voie. Ailleurs il ferme un
            // passage sans menacer personne.
            //
            // ── Deux erreurs, et le kart fonçait dedans sans broncher ────
            //
            // Ce test decide de `sight.pipeIndex`, et `pipeIndex` est la SEULE
            // chose qui autorise un tuyau a reprendre le volant a une esquive en
            // cours (`pipeOutranksPlan`). Rate ici, le tuyau n'existe plus pour
            // l'arbitrage : le plan garde la main, et le kart va au mur en
            // ligne droite. Ce n'est pas un manque d'agilite, c'est que la
            // manoeuvre de contournement n'a jamais ete appelee.
            //
            //   1. Il se mesurait a `kart.yPercent`, la profondeur du MOMENT.
            //      Or quand un plan tient le volant, le kart est justement en
            //      train de se deplacer en profondeur. Une esquive qui l'emmene
            //      DANS l'axe d'un tuyau ne le flaggait donc jamais : a chaque
            //      balayage il n'y etait pas encore. Comme partout ailleurs dans
            //      le placement, la reference est le point d'arret — la ou le
            //      kart finira s'il relache — et non la ou il est.
            //
            //   2. Il se mesurait a la hitbox NUE. C'est l'erreur contre
            //      laquelle la note de `vision.threatLane` met en garde : une
            //      bande de surveillance doit etre plus large que le contact,
            //      « parce qu'une esquive doit COMMENCER avant d'etre pile dans
            //      l'axe ». Un objet a 12 pour ca. Le tuyau avait 5.3, et un
            //      tuyau « un peu excentre » n'inquietait personne jusqu'a ce
            //      qu'il soit trop tard.
            //
            // On prend le DEGAGEMENT — hitbox plus la marge de confort du
            // placement — et non `threatLane` : de quoi s'alarmer a temps, sans
            // faire passer le decor devant une carapace pour un tuyau qu'on
            // longe. L'arbitrage lui-meme ne bouge pas d'un pouce : `threatScore`
            // continue de valoir 2000 pour un tete-a-queue contre 850 pour un
            // tuyau, et le tuyau doit toujours etre bien plus proche pour
            // l'emporter.
            if (dx > 0 && Math.abs(pipes[p].y - pipeSettle) < pipeWatch) {
                e.role |= SEE_THREAT;
                e.kind = 'pipe';
                e.cost = vis.cost.pipe;
                e.ttc = (dx / Math.max(speed, 1)) * 1000;
            }
        }

        // ── Les objets au sol ────────────────────────────────────────────
        const items = state.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];

            // Constat, et non absence : voir l'objet mort est ce qui autorise a
            // relacher le plan. Cf. `updatePlan`.
            if (item.isDead || item.spent) {
                if (item.id === kart.plan.threatId) sight.planGone = true;
                continue;
            }
            if (cfg.trailableItems.indexOf(item.type) === -1) continue;

            // ── Une banane en cloche se voit LA OU ELLE VA TOMBER ────────
            //
            // En vol elle file a 1060 px/s quand le kart en fait 495 : l'ecart
            // se CREUSE, donc `rel` est negatif, donc le temps avant impact
            // l'est aussi, donc elle n'etait une menace pour personne. Elle
            // n'existait qu'a l'atterrissage — et elle atterrit 480 px devant
            // son lanceur, pile sur sa ligne, soit moins d'une seconde. Aucun
            // kart ne couvre les 7 unites de degagement en si peu de temps ; un
            // lourd en met plus du double. Il se prenait donc sa propre banane
            // sans l'avoir jamais vue venir.
            //
            // Le point d'arrivee est pourtant connu d'avance — c'est `flightTo`,
            // et la date aussi. Une cloche est un obstacle FUTUR, pas un objet
            // qui s'echappe : on la perçoit ou elle sera. Le kart a alors le vol
            // entier en plus pour s'ecarter, et le lanceur voit sa banane se
            // poser sur sa route au moment ou il la lance.
            //
            // Elle est vue immobile pour la meme raison : ce qui compte est
            // qu'elle ne bougera plus, pas qu'elle bouge encore.
            const flying = item.flightUntil > now;
            let atX = item.worldX;
            if (flying) {
                atX = item.flightTo;
                if (atX >= cfg.world.width) atX -= cfg.world.width;
            }
            const atVx = flying ? 0 : item.vx;

            const dx = getShortestDistance(cfg, atX, kart.worldX);
            const look = dx * dir;
            if (look < -itemReach.x || look > range) continue;

            const e = scanTake();
            e.look = look;
            e.dx = dx;
            e.y = item.y;

            // Un objet se franchit — on ne le traverse pas sans dommage, mais
            // rien n'empeche physiquement d'y aller. La limite dure est sa
            // hitbox nue ; le degagement qu'on aimerait garder vient en marge.
            e.blockHalf = itemReach.y;
            e.blockMargin = place.margin.item;
            e.blockCost = vis.cost.spin;
            e.id = item.id;

            // Un objet A L'ARRET est un obstacle FIXE, au meme titre qu'un
            // tuyau : il ne s'en va pas, on arrive dessus. Il compte donc aussi
            // loin qu'on le voit, et le couloir se choisit en le sachant.
            //
            // Il empruntait `dodgeGuardDistance` (500), taille pour l'esquive.
            // Consequence : un couloir de tuyau se choisissait a 1100 px sans
            // savoir qu'une banane y etait posee, la banane n'apparaissait qu'a
            // 500 px — et il etait alors trop tard pour traverser vers l'autre
            // couloir, quand le seuil d'engagement ne l'interdisait pas
            // carrement. Le kart la prenait en pleine connaissance de cause,
            // sauf qu'il ne la connaissait pas au moment de decider.
            //
            // Ce qui bouge garde la portee courte : une carapace aura change de
            // place bien avant qu'on arrive a sa hauteur.
            e.blockReach = (atVx === 0) ? cfg.pipe.seeDistance : ai.dodgeGuardDistance;

            // Un objet ne masque rien : trop petit. Il ferme un passage, et
            // seulement s'il est encore devant.
            if (dx > 0) e.role = SEE_BLOCK;

            // Une rouge traque : elle arrive dans l'axe et par l'arriere, soit
            // pile le cas ou un kart la precede et la masque. Soumise a
            // l'occlusion, elle deviendrait inevitable — dans le jeu d'origine
            // c'est le son qui previent, ici c'est cette exception.
            e.pierces = vis.seeHomingThroughCover && item.type === 'redShell';

            // Une seule formule pour les deux sens. `dx / rel` est positif quand
            // l'ecart se referme, que l'objet soit devant et plus lent ou
            // derriere et plus rapide — c'est tout ce qui manquait pour qu'un
            // kart puisse enfin esquiver ce qui le rattrape.
            const rel = speed - atVx;
            const ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;

            const itemWindow = threatWindow(cfg, kart, item.y);
            if (ttc > 0 && ttc <= itemWindow
                && (dx < 0 ? -dx : dx) <= threatLeash(cfg, itemWindow, rel)
                && Math.abs(item.y - kart.yPercent) < lane) {
                e.role |= SEE_THREAT;
                e.kind = 'spin';
                e.cost = vis.cost.spin;
                e.ttc = ttc;
            }
        }

        // ── Les karts ────────────────────────────────────────────────────
        const karts = state.karts;
        const ramming = isRamming(kart);
        for (let k = 0; k < karts.length; k++) {
            const other = karts[k];
            if (other.id === kart.id || !isContactActive(other)) continue;

            const dx = getShortestDistance(cfg, other.worldX, kart.worldX);
            const look = dx * dir;
            const held = other.heldItem;

            if (look >= -kartReach.x && look <= range) {
                const e = scanTake();
                e.look = look;
                e.dx = dx;
                e.y = other.yPercent;

                // Une carrosserie se bouscule : elle coute le moins cher des
                // trois corps, et elle bouge — c'est le seul obstacle qui peut
                // s'ecarter tout seul.
                e.blockHalf = kartReach.y;
                e.blockMargin = place.margin.kart;
                e.blockCost = vis.cost.kart;
                e.shadowHalf = kartHalf * gain;

                // Une carrosserie ne ferme un passage que sur la longueur ou les
                // deux karts peuvent se toucher. Un kart trois cents pixels
                // devant roule a la meme allure : il sera toujours trois cents
                // pixels devant quand l'ecart sera fini, et le compter fermait
                // la piste pour rien — sept esquives sur dix se declaraient
                // acculees.
                e.blockReach = kartReach.x * 2;
                e.solid = true;
                e.role = SEE_BLOCK;
                e.kartId = other.id;

                // Porte-t-il une ROUGE ? C'est le seul objet auquel se decaler
                // ne repond pas — elle suit. La seule parade qui reste a qui n'a
                // rien a lui opposer est de cesser d'etre la cible, donc de le
                // laisser passer. Cf. `vision.giveWay`.
                e.redHeld = !!held && held.type === 'redShell';

                // Etoile et bill blessent au contact, et rien dans le pilotage
                // ne s'en ecartait : c'etait le seul danger immediat du moteur
                // que personne ne voyait venir. L'identifiant est negatif pour
                // ne jamais croiser celui d'un objet dans la memoire des
                // menaces.
                if (isRamming(other) && !ramming) {
                    const rel = speed - other.absoluteVelocity;
                    const ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;

                    // Meme fenetre taillee au besoin que pour un objet : ce qui
                    // arrive au contact ne se juge pas autrement selon que c'est
                    // une carapace ou une etoile. Un lourd avait ici le meme
                    // handicap, sur une menace qui coute plus cher encore.
                    if (ttc > 0 && ttc <= threatWindow(cfg, kart, other.yPercent)
                        && Math.abs(other.yPercent - kart.yPercent) < lane) {
                        e.role |= SEE_THREAT;
                        e.kind = 'spin';
                        e.cost = vis.cost.spin;
                        e.ttc = ttc;
                        e.id = -1 - other.id;
                    }
                }

                // ── Le danger latent ─────────────────────────────────
                //
                // Personne n'a rien lance : il n'y a ni temps avant impact, ni
                // esquive a faire. Ce qui se joue ici est une PRECAUTION —
                // quitter une ligne de tir avant qu'elle ne serve.
                //
                // Deux formes, et la meme reponse, parce que c'est le meme
                // probleme : partager sa profondeur avec quelqu'un qui peut
                // vous atteindre.
                //
                //   DERRIERE, il peut tirer vers l'avant : une carapace, en
                //   main ou en orbite (`isArmedForward`). Ne se remarque qu'en
                //   se retournant.
                //
                //   DEVANT, il porte de quoi finir derriere lui — verte, banane
                //   ou rouge, soit exactement `trailableItems`. Rester dans
                //   l'axe d'une verte, c'est attendre qu'elle parte en arriere ;
                //   rester derriere une banane, c'est attendre le moindre coup
                //   de coude.
                //
                // Les deux exigent L'ALIGNEMENT, et c'est ce qui les rend
                // jouables : hors de sa ligne il ne peut rien contre vous, et se
                // decaler ne veut rien dire. Sans cette condition, les huit
                // karts se decaleraient en permanence — tout le monde porte
                // quelque chose, presque personne n'est dans l'axe.
                //
                // Et les deux exigent LE REGARD, du bon cote. Un danger latent
                // n'est pas un pressentiment : c'est quelqu'un qu'on remarque,
                // avec quelque chose dans les mains. Qui regarde derriere ne
                // voit pas la banane du kart devant lui, et inversement — ce qui
                // donne au coup d'oeil un cout reel, et pas seulement une
                // portee.
                //
                // Il vit sur l'entree de balayage, et non a cote comme avant :
                // c'etait la SEULE perception du systeme a echapper a
                // l'occlusion, sans que rien ne le dise — un kart se rangeait
                // donc pour un porteur qu'il ne pouvait pas voir. Etre une
                // entree comme les autres lui rend aussi la portee du regard :
                // `pressureRange` ne peut plus depasser en silence ce que l'oeil
                // atteint.
                //
                // Ni l'un ni l'autre ne demande que l'objet soit DEJA en
                // trainee. C'est meme tout l'interet : la hitbox d'un objet ne
                // s'arme qu'au passage de la main au trainage, et un kart colle
                // derriere un porteur n'aurait alors plus le temps de rien. Un
                // danger se remarque tant qu'il est dans les mains ; ce qui
                // compte est ce que le porteur PEUT en faire, pas ce qu'il en a
                // deja fait.
                //
                // `look` vaut ici l'ecart au kart, les deux etant du meme cote.
                const behind = dx < 0;
                if (behind === sight.back
                    && look <= vis.pressureRange
                    && Math.abs(other.yPercent - kart.yPercent) < clear
                    && (behind ? isArmedForward(cfg, other)
                               : isTrailable(cfg, heldThreatType(held)))) {
                    e.role |= SEE_PRESSURE;
                }
            }

            // L'objet traine derriere lui. Il avance a la vitesse du porteur, et
            // c'est la profondeur DU PORTEUR qui compte : l'objet le suit.
            if (held && held.holdPosition === 'behind') {
                let hx = other.worldX + cfg.offsets.world.heldItemBehind;
                if (hx < 0) hx += cfg.world.width;
                if (hx >= cfg.world.width) hx -= cfg.world.width;

                const hdx = getShortestDistance(cfg, hx, kart.worldX);
                const hlook = hdx * dir;

                if (hlook > -itemReach.x && hlook <= range) {
                    const e = scanTake();
                    e.look = hlook;
                    e.dx = hdx;
                    e.y = other.yPercent;
                    e.blockHalf = itemReach.y;
                    e.blockMargin = place.margin.item;
                    e.blockCost = vis.cost.spin;
                    e.blockReach = ai.trailThreatDistance;
                    e.id = held.id;
                    if (hdx > 0) e.role = SEE_BLOCK;

                    // Seul celui qui revient dessus est menace : derriere un
                    // porteur plus rapide, l'objet s'eloigne.
                    const rel = speed - other.absoluteVelocity;
                    const ttc = (rel !== 0) ? (hdx / rel) * 1000 : Infinity;

                    if (ttc > 0 && (hdx < 0 ? -hdx : hdx) <= ai.trailThreatDistance
                        && Math.abs(other.yPercent - kart.yPercent) < lane) {
                        e.role |= SEE_THREAT;
                        e.kind = 'spin';
                        e.cost = vis.cost.spin;
                        e.ttc = ttc;
                    }
                }
            }

        }

        // ── Les boites ───────────────────────────────────────────────────
        //
        // Une boite masquee par un kart est une boite qu'il prendra le premier :
        // l'occlusion repond exactement a ce que `isBoxContested` calculait a
        // part, avec une boucle imbriquee en moins.
        if (!kart.heldItem && !sight.back) {
            const boxes = state.itemBoxes;
            for (let b = 0; b < boxes.length; b++) {
                if (!boxes[b].active) continue;

                const dx = getShortestDistance(cfg, boxes[b].worldX, kart.worldX);
                if (dx <= 0 || dx > ai.boxDetectionRange) continue;

                const e = scanTake();
                e.look = dx;
                e.dx = dx;
                e.y = boxes[b].y;
                e.role = SEE_BOX;
            }
        }

        // ── La marche ────────────────────────────────────────────────────
        //
        // Du plus proche au plus lointain : chacun est d'abord teste contre les
        // ombres deja posees, puis pose la sienne. Un corps ne se cache pas
        // lui-meme, d'ou cet ordre et pas l'autre.
        scanOrder.length = scanCount;
        for (let i = 0; i < scanCount; i++) scanOrder[i] = i;
        sortScan();

        let bestScore = 0;

        // Le pire danger apercu DERRIERE pendant ce balayage, du plus faible au
        // plus fort. Une carapace deja partie prime sur celui qui la porte ;
        // une etoile se classe entre les deux, parce qu'on ne peut rien lui
        // opposer d'autre que de la place.
        let dangerRank = 0;
        let dangerKind = '';

        let boxDiff = Infinity;
        let hiddenDiff = Infinity;
        let hiddenY = 0;
        let hiddenDist = -1;

        for (let i = 0; i < scanCount; i++) {
            const e = scanPool[scanOrder[i]];
            const seen = e.pierces || !shadowHides(e.look, e.y);

            // Ce que l'ombre a MANGE, releve pour l'observateur et pour lui
            // seul. Rien ne le lit dans le moteur, et c'est justement ce qui
            // manquait pour comprendre une non-reaction : sans lui, un kart qui
            // ignore une banane et un kart qui ne la voit pas se ressemblent
            // trait pour trait. Meme convention de signe que partout ailleurs —
            // les karts en negatif, les objets a partir de 1.
            //
            // Le tableau se reutilise d'un balayage a l'autre, comme les spans :
            // un balayage n'alloue rien.
            if (!seen) {
                const hidden = (e.kartId >= 0) ? (-1 - e.kartId) : e.id;
                if (hidden) {
                    sight.hiddenIds[sight.hiddenCount] = hidden;
                    sight.hiddenCount++;
                }
            }

            if (seen) {
                if (e.role & SEE_BLOCK) pushSpan(sight, e);

                // ── Qui roule avec lui ───────────────────────────────
                //
                // Une carrosserie ne ferme un couloir que sur `kartVsKart.x * 2`
                // — 120 px — et c'est juste : au-dela on ne se touche pas. Mais
                // le couloir d'un tuyau se choisit jusqu'a 1100 px, et a cette
                // distance-la plus personne n'est visible. Le kart decidait donc
                // toujours d'un passage comme s'il etait seul, et se retrouvait
                // a huit dans le meme trou.
                //
                // Ce releve repond a une AUTRE question que le span : non pas
                // « vais-je le toucher » mais « ce passage sera-t-il pris quand
                // j'y serai ». On ne garde que la profondeur : ce qui compte est
                // combien ils sont et ou, pas leur geometrie.
                //
                // Ce qui est masque n'y entre pas, comme partout ailleurs : un
                // kart aveugle par celui qui le precede croit le passage libre,
                // et c'est exactement le prix d'une vue bouchee.
                // Les ROUGES derriere. Il faut les avoir VUES, donc s'etre
                // retourne, et l'occlusion s'applique comme au reste : un porteur
                // cache derriere un autre kart ne compte pas.
                //
                // On retient la plus proche — c'est elle qui vise — et COMBIEN
                // il y en a : s'en trouver deux, c'est n'avoir nulle part ou se
                // ranger. Laisser passer la premiere revient a se donner a la
                // seconde.
                if (sight.scanBack && e.kartId >= 0 && e.dx < 0 && e.redHeld) {
                    const gap = -e.dx;
                    sight.redBehindCount++;
                    if (sight.redBehindDist < 0 || gap < sight.redBehindDist) {
                        sight.redBehindDist = gap;
                        sight.redBehindY = e.y;
                        sight.redBehindId = -1 - e.kartId;
                    }
                }

                if (e.kartId >= 0 && e.dx > 0 && e.dx <= vis.crowd.distance) {
                    sight.crowdY[sight.crowdCount] = e.y;
                    sight.crowdCount++;
                }

                if (e.role & SEE_THREAT) {
                    // Un tuyau ne surprend personne : il est dans le trace. Ni
                    // reflexe a passer, ni tirage d'inattention — seulement un
                    // cout et une echeance, comme tout le reste.
                    let ready = true;
                    if (e.kind !== 'pipe') {
                        let slot = recallThreat(cfg, now, kart, e.id);
                        if (slot < 0) slot = judgeThreat(cfg, rng, now, kart, e.id, e.y, e.ttc);
                        ready = !kart.judgedIgnored[slot] && now >= kart.judgedReactAt[slot];
                    }

                    // La table de cout remplace l'ordre fige des manoeuvres :
                    // le danger le plus cher par unite de temps l'emporte, et
                    // c'est ce qui fait qu'un kart accepte de froler un tuyau
                    // pour eviter une carapace, jamais l'inverse.
                    if (ready) {
                        if (sight.scanBack && e.dx < 0 && e.kind === 'spin') {
                            // `id` negatif : c'est une carrosserie lancee —
                            // etoile ou bill. Positif : un objet en vol.
                            const rank = (e.id < 0) ? 2 : 3;
                            if (rank > dangerRank) {
                                dangerRank = rank;
                                dangerKind = (e.id < 0) ? 'ram' : 'shot';
                            }
                        }

                        const score = threatScore(e.cost, e.ttc);
                        if (score > bestScore) {
                            bestScore = score;
                            sight.threatId = e.id;
                            sight.threatKind = e.kind;
                            sight.threatY = e.y;
                            sight.threatTtc = e.ttc;
                        }
                    }

                    // Le tuyau vise reste le plus proche qui BARRE LA ROUTE,
                    // qu'il ait gagne l'arbitrage ou non : c'est lui qui mesure
                    // l'urgence du tuyau (`pipeOutranksPlan`), et l'urgence
                    // demande d'etre dans son axe.
                    if (e.kind === 'pipe' && (sight.pipeIndex < 0 || e.dx < sight.pipeDist)) {
                        sight.pipeIndex = e.pipeIndex;
                        sight.pipeDist = e.dx;
                    }
                }

                // Et le tuyau le plus proche DEVANT, aligne ou non. C'est lui
                // qui declenche le contournement.
                //
                // La manoeuvre partait sur `pipeIndex`, donc seulement quand le
                // tuyau etait deja dans l'axe a 6.9 unites pres. En slalom, le
                // kart sortait de la voie du premier, se retrouvait hors de la
                // voie du second — donc sans rien a faire — repartait en maraude
                // ou rentrait a sa ligne, et ne reprenait la main qu'une fois
                // revenu dans l'axe du second. D'ou le manque de reaction : il
                // ne pilotait pas entre les tuyaux, il rebondissait de l'un a
                // l'autre.
                //
                // L'engager tot ne monopolise rien : le placement rend sa propre
                // ligne quand elle est deja la meilleure, et la manoeuvre rend
                // alors la main (cf. `steerAroundPipes`).
                if (e.pipeIndex >= 0 && e.dx > 0
                    && (sight.pipeAheadIndex < 0 || e.dx < sight.pipeAheadDist)) {
                    sight.pipeAheadIndex = e.pipeIndex;
                    sight.pipeAheadDist = e.dx;
                }

                if (e.role & SEE_BOX) {
                    const diff = Math.abs(e.y - kart.yPercent);
                    if (diff < boxDiff) {
                        boxDiff = diff;
                        sight.boxY = e.y;
                        sight.boxDist = e.dx;
                    }
                }

                // Le porteur le plus proche l'emporte : c'est sa ligne qui coute
                // le plus cher a partager. La marche allant du plus proche au
                // plus lointain, le premier vu est le bon — plus d'ecart a
                // comparer.
                if ((e.role & SEE_PRESSURE) && !sight.pressure) {
                    sight.pressure = true;
                    sight.pressureY = e.y;
                    sight.pressureId = -1 - e.kartId;

                    // De quel COTE. Un seul releve porte les deux formes du
                    // danger latent — le balayage ne regarde qu'un cote a la
                    // fois, elles ne peuvent pas se croiser — mais ce qu'on en
                    // fait differe : deux echeances de decision, et un releve
                    // de debug qui ne les met pas sur la meme ligne.
                    sight.pressureBack = sight.scanBack;

                    // Vu DERRIERE : c'est ce qui fait tourner la tete plus
                    // souvent. Etre vise dans le dos ne se constate qu'en se
                    // retournant, et le tirage du coup d'oeil n'a jamais lieu
                    // pendant un coup d'oeil (cf. `updateGlance`) : il lui faut
                    // un souvenir date, pas l'etat du balayage courant. C'est le
                    // plus faible des trois dangers — il n'a encore rien lance.
                    if (sight.scanBack) {
                        if (dangerRank < 1) {
                            dangerRank = 1;
                            dangerKind = 'carrier';
                        }
                    }
                }

                // Le kart visible le plus proche dans l'axe du regard, quel
                // qu'il soit. C'est LA cible de tir, dans les deux sens : on la
                // releve en regardant derriere, on la vise directement en
                // regardant devant.
                //
                // C'est donc l'occlusion qui decide qui est visable — celui qui
                // se cache derriere un autre ne se fait pas prendre pour cible —
                // et ca vaut maintenant devant aussi, ou la visee bouclait sur
                // le monde et voyait au travers de tout.
                if (e.kartId >= 0 && e.look > 0 && e.look < ai.aimScanDistance
                    && (sight.seenKartDist < 0 || e.look < sight.seenKartDist)) {
                    sight.seenKartDist = e.look;
                    sight.seenKartY = e.y;
                }

                if (e.kartId >= 0 && e.dx > 0 && e.dx < ai.overtakeDetectionRange
                    && Math.abs(e.y - kart.yPercent) < ai.overtakeMinDistance
                    && (sight.aheadKartDist < 0 || e.dx < sight.aheadKartDist)) {
                    sight.aheadKartDist = e.dx;
                    sight.aheadKartY = e.y;
                }
            } else if (e.role & SEE_BOX) {
                const diff = Math.abs(e.y - kart.yPercent);
                if (diff < hiddenDiff) {
                    hiddenDiff = diff;
                    hiddenY = e.y;
                    hiddenDist = e.dx;
                }
            }

            if (e.solid) {
                const de = eyeDist(e.look);

                // Un corps derriere la camera ne porte pas d'ombre devant elle.
                // Le cas existe : la camera recule de `eye.back`, et le balayage
                // prend les corps jusqu'a une carrosserie en arriere du kart —
                // ceux-la sont bien entre l'oeil et la route, et projettent.
                if (de > 1) {
                    const inv = 1 / de;
                    shadowLo[shadowCount] = (e.y - e.shadowHalf - shadowEyeY) * inv;
                    shadowHi[shadowCount] = (e.y + e.shadowHalf - shadowEyeY) * inv;
                    shadowFrom[shadowCount] = de;
                    shadowTo[shadowCount] = de * (1 + shadowRun);
                    shadowCount++;
                }
            }
        }

        // Le souvenir du danger. `dangerSince` ne bouge que si le precedent
        // s'etait perime : c'est la que commence un nouvel EPISODE, et c'est ce
        // qui fait que le choix du bouclier se tranche une fois et pas a chaque
        // balayage.
        if (dangerRank > 0) {
            if (now - sight.dangerAt > vis.pressureMemoryMs) sight.dangerSince = now;
            sight.dangerAt = now;
            sight.dangerKind = dangerKind;
        }

        // ── Et le souvenir de la ROUGE qui suit ──────────────────────────
        //
        // Il n'y en avait aucun, et c'est ce qui rendait « laisser passer »
        // presque injouable : le releve ne se remplit que sous un balayage
        // arriere, et il se vide au suivant. La decision ne pouvait donc se
        // prendre QUE pendant le coup d'oeil — un dixieme du temps — et la
        // seconde d'apres le kart ne savait plus que c'etait une rouge.
        //
        // A l'ecran ca donnait exactement ce qu'on a observe : un kart qui
        // reste vaguement inquiet, parce que `dangerKind` tient encore, mais
        // qui a oublie CE QUI le suit et ne se range donc jamais.
        //
        // Meme regle que partout ailleurs : le balayage tourne vers le danger
        // fait foi, l'autre laisse valoir le souvenir, meme peremption.
        //
        // La distance vieillit, et c'est assume : le porteur s'est rapproche ou
        // eloigne depuis. C'est une approximation, mais elle vaut infiniment
        // mieux que la seule alternative d'avant — ne rien savoir du tout des
        // que la tete revient devant.
        if (sight.scanBack) {
            if (sight.redBehindDist >= 0) {
                sight.redMemAt = now;
                sight.redMemDist = sight.redBehindDist;
                sight.redMemY = sight.redBehindY;
                sight.redMemId = sight.redBehindId;
                sight.redMemCount = sight.redBehindCount;
            } else {
                sight.redMemAt = -Infinity;
            }
        } else if (now - sight.redMemAt <= vis.pressureMemoryMs) {
            sight.redBehindDist = sight.redMemDist;
            sight.redBehindY = sight.redMemY;
            sight.redBehindId = sight.redMemId;
            sight.redBehindCount = sight.redMemCount;
        }

        // Les ombres, recopiees pour l'observateur. Rien dans le pilotage ne
        // les relit — elles ont deja servi pendant la marche — mais sans elles
        // la carte ne peut montrer que des entites grisees, jamais OU se trouve
        // le trou. Une quinzaine d'entrees, dans des tableaux reutilises : c'est
        // le meme prix que `hiddenIds`, paye pour la meme raison.
        for (let i = 0; i < shadowCount; i++) {
            sight.shadowLo[i] = shadowLo[i];
            sight.shadowHi[i] = shadowHi[i];
            sight.shadowFrom[i] = shadowFrom[i];
            sight.shadowTo[i] = shadowTo[i];
        }
        sight.shadowCount = shadowCount;
        sight.eyeBack = shadowEyeBack;
        sight.eyeY = shadowEyeY;

        // ── Et le souvenir du porteur qu'on SUIT ─────────────────────────
        //
        // Il manquait, et c'est la moitie du danger latent qui tombait avec.
        // La config presente les deux bouts comme la meme situation vue des
        // deux cotes ; le derriere avait sa memoire datee, le devant n'avait
        // que le balayage courant.
        //
        // Ce qui s'ensuivait : un coup d'oeil arriere — une demi-seconde a une
        // seconde et quart, et jusqu'a un tiers du temps quand quelqu'un le
        // suit — EFFACAIT purement et simplement le porteur que le kart avait
        // devant lui. Au retour de tete la precaution repartait de zero, son
        // tirage tombait rarement, et le kart restait dans l'axe d'une verte
        // jusqu'a ce qu'elle parte.
        //
        // Le balayage AVANT fait foi, dans les deux sens : il pose le souvenir
        // quand il voit, il l'efface quand il ne voit plus. Le balayage
        // arriere, lui, n'a rien a en dire — il le laisse valoir, exactement
        // comme `dangerBehind` laisse valoir ce qui est dans le dos pendant
        // qu'on regarde devant. Meme peremption pour les deux : ce qu'on ne
        // revoit pas cesse de compter.
        //
        // Un danger arriere garde la main quand il y en a un : lui peut tirer,
        // le porteur de devant ne peut que laisser tomber.
        if (!sight.scanBack) {
            if (sight.pressure) {
                sight.frontAt = now;
                sight.frontY = sight.pressureY;
                sight.frontId = sight.pressureId;
            } else {
                sight.frontAt = -Infinity;
            }
        } else if (!sight.pressure && now - sight.frontAt <= vis.pressureMemoryMs) {
            sight.pressure = true;
            sight.pressureBack = false;
            sight.pressureY = sight.frontY;
            sight.pressureId = sight.frontId;
        }

        // ── Le temps qu'il reste APRES le mur du moment ──────────────────
        //
        // Un seul mur s'impose vraiment : le plus proche devant. Ceux d'apres
        // laissent au kart le trajet qui les en separe pour se replacer, et
        // c'est ce trajet qu'on releve ici — en temps, parce que c'est en temps
        // que se compte un braquage, et parce que chaque manoeuvre le convertit
        // ensuite avec SON volant (cf. `laneRisk`).
        //
        // Zero pour le mur du moment lui-meme : rien ne le precede, il n'y a
        // plus rien a negocier, il refuse.
        let nearBlock = Infinity;
        for (let i = 0; i < sight.spanCount; i++) {
            const s = sight.spans[i];
            if (s.hard && s.dx > 0 && s.dx < nearBlock) nearBlock = s.dx;
        }
        if (nearBlock < Infinity) {
            const pace = Math.max(kart.absoluteVelocity, 1);
            for (let i = 0; i < sight.spanCount; i++) {
                const s = sight.spans[i];
                const d = s.dx < 0 ? -s.dx : s.dx;
                s.spare = (s.hard && d > nearBlock) ? ((d - nearBlock) / pace) * 1000 : 0;
            }
        }

        // Aucune boite libre : il tente quand meme la plus proche de sa
        // trajectoire. Le kart qui la lui bouche peut encore la manquer.
        if (sight.boxDist < 0 && hiddenDist >= 0) {
            sight.boxY = hiddenY;
            sight.boxDist = hiddenDist;
        }
    }

    // -----------------------------------------------------------------------
    // Ou se placer
    //
    // Une seule question, posee une seule fois : A QUELLE PROFONDEUR VAUT-IL
    // MIEUX ETRE ? La reponse est une note en millisecondes, et c'est la meme
    // monnaie que `vision.cost` — ce qu'un choc coute en temps perdu.
    //
    //     note = ce qu'on RISQUE en y etant  +  ce que coute d'Y ALLER
    //
    // ── Ce que ca remplace, et pourquoi ─────────────────────────────────
    //
    // Il y avait deux chercheurs de couloir, `widestLane` (le plus large, pour
    // une trajectoire) et `bestGap` (le plus proche praticable, pour un
    // reflexe), et tous deux repondaient par oui ou par non. Trois defauts en
    // sortaient, tous mesures a l'ecran :
    //
    //   LE PLUS LARGE GAGNAIT TOUJOURS. Un tuyau pose pres d'un bord laisse un
    //   couloir etroit d'un cote et large de l'autre ; le depart par proximite
    //   de `considerLane` ne se jouait qu'a 1.5 de largeur pres, donc jamais.
    //   Aucun kart n'empruntait le passage serre, meme place dedans, meme quand
    //   c'etait de loin le moins cher. Le trace pouvait dessiner ce qu'il
    //   voulait : il n'y avait qu'une ligne.
    //
    //   LES MARGES ETAIENT DES MURS. `edgeSafetyMargin` rognait 2 de chaque
    //   bord et le degagement d'objet en ajoutait 2 autour de chaque banane,
    //   avant meme qu'on regarde. Un couloir de fond de 3.1 devenait 1.1, un
    //   couloir de 6 sous une banane devenait 2, et `minPassageY` / `minWidth`
    //   les refusaient. Le kart ne savait pas qu'il ne tenait pas : on ne lui
    //   avait jamais dit qu'il y avait un trou.
    //
    //   TOUS LES CORPS SE VALAIENT. Un tuyau, une banane et une carrosserie
    //   fermaient la piste de la meme facon. Or on ne traverse pas un tuyau, on
    //   encaisse une banane, on bouscule un kart, et on frotte un bord.
    //
    // ── Le modele ───────────────────────────────────────────────────────
    //
    // UN SEUL CORPS EST UN MUR : le tuyau. Masse infinie, il arrete net. Tout
    // le reste se franchit contre son prix, et l'ordre des prix dit le reste :
    //
    //     tuyau        infranchissable de pres, puis preference qui s'efface
    //     objet        2000 ms de tete-a-queue
    //     carrosserie   300 ms de bousculade, et elle peut s'ecarter seule
    //     bord           200 ms de frottement, et il ne ferme rien
    //
    // Les marges de confort ne refusent plus rien : les entamer COUTE, en
    // proportion de ce qu'on entame. C'est ce qui rend un passage serre jouable
    // — cher, mais jouable — quand il est le moins cher de la piste.
    //
    // ── Ce qui n'y est pas ──────────────────────────────────────────────
    //
    // Aucune notion de manoeuvre. Le placement ne sait pas s'il sert une
    // esquive, un contournement ou une visee : il rend le meilleur endroit
    // compte tenu de ce que le kart voit, du temps qu'il a et de son volant.
    // Ce sont ces trois entrees qui portent la difference entre manoeuvres, et
    // c'est pour ca qu'il n'y a plus qu'une fonction la ou il y en avait deux.
    // -----------------------------------------------------------------------

    // Poids d'un obstacle selon sa distance. Plein dans sa portee.
    //
    // Au-dela, seul un MUR compte encore, et sa preference s'efface jusqu'a la
    // limite du regard. C'est ce qui enfile une sequence de tuyaux sans avoir a
    // les parcourir un par un : le couloir retenu est celui qui traverse le
    // plus loin, et le tuyau du bout pese moins que celui d'a cote.
    //
    // Ce qui bouge — une carrosserie, un objet — garde sa portee propre et
    // tombe a zero au-dela : il aura change de place avant qu'on y arrive.
    //
    // ── Il y avait ici une rampe, et elle n'a jamais tourne ──────────────
    //
    // Un mur devait voir sa preference s'effacer entre `s.reach` et
    // `vision.range.front`, « pour enfiler une sequence de tuyaux sans avoir a
    // les parcourir un par un ». L'intention etait la bonne. Seulement les deux
    // bornes valent 1100 toutes les deux — `pipe.seeDistance` et `range.front`
    // — si bien que la rampe s'etalait sur une fenetre de largeur nulle : TOUT
    // tuyau visible pesait 1, jusqu'au dernier pixel du regard.
    //
    // Ce que ca donnait a l'ecran, sur l'anneau du Moai : un kart deja place
    // dans le couloir haut du tuyau col 80 se voyait refuser ce couloir, parce
    // que le tuyau col 87 — a plus de deux secondes devant — bloquait le haut
    // lui aussi. `laneRisk` cherche UNE profondeur qui degage tous les murs vus
    // a la fois, comme si le kart ne pouvait plus bouger entre les deux. Toutes
    // les voies hautes valaient l'infini, et les huit karts plongeaient.
    //
    // La rampe est retiree plutot que reparee : ce n'est pas la PREFERENCE d'un
    // mur lointain qu'il faut effacer, c'est le fait qu'on ait le temps d'en
    // sortir. Cela se mesure, ça ne s'estompe pas — cf. `s.spare` et la dette
    // de deplacement dans `laneRisk`.
    function spanWeight(cfg, s) {
        const d = s.dx < 0 ? -s.dx : s.dx;
        return (d <= s.reach) ? 1 : 0;
    }

    // La place qu'un kart doit se garder EN PLUS de sa hitbox, parce qu'il ne
    // tient pas sa ligne au centimetre.
    //
    // C'etait le trou du modele : la note jugeait tous les karts capables de se
    // poser au dixieme d'unite. Un couloir de 3 unites etait donc declare
    // jouable pour les huit, et les lourds s'y coincaient — pas faute de place,
    // faute de PRECISION. Le passage n'etait pas trop petit, c'est le kart qui
    // etait trop imprecis pour lui.
    //
    // Deux termes, et ils sont dans le volant, pas dans une stat de plus :
    //
    //   `tolerance`  la bande morte du braquage. En deca, `steer` coupe la
    //                consigne — c'est la definition meme de « il ne corrige
    //                plus », donc le plancher de son imprecision.
    //   `slop / cap` ce qu'il derive avant de rattraper. Inversement
    //                proportionnel a son volant : un vif annule une bousculade
    //                tout de suite, un lourd met une demi-seconde, et pendant
    //                cette demi-seconde il faut que la place existe.
    //
    // Aux reglages actuels, en croisiere : ~0.8 pour koopa, ~1.6 pour bowser.
    // Un couloir de fond de 3.1 unites passe donc pour l'un et pas pour l'autre,
    // et c'est exactement ce qu'on veut lire a l'ecran — un passage serre est un
    // passage pour les vifs.
    function laneSlop(cfg, kart, cap, spec) {
        return spec.tolerance + cfg.vision.place.slop / Math.max(cap, 1);
    }

    // Ce que coute d'ETRE a la profondeur `y`, en millisecondes. `Infinity`
    // quand le kart ne peut physiquement pas y etre.
    //
    // `slop` gonfle chaque corps de l'imprecision du kart : viser le ras d'une
    // hitbox n'a de sens que si l'on sait s'y tenir.
    //
    // Elle ne lit que `kart.sight`, et c'est le point du systeme : ce qui n'a
    // pas ete vu ne coute rien. Un kart aveugle par celui qui le precede se
    // place donc au milieu de ce qu'il ne voit pas — et c'est exactement le
    // prix d'une vue bouchee.
    // Ce qui separe « pile sur la limite » de « dedans ». Purement numerique :
    // les candidats sont construits par addition depuis les bornes qu'ils
    // longent, et l'arrondi decide sinon du sens de l'inegalite.
    const LANE_EPS = 1e-9;

    function laneRisk(cfg, kart, y, cap, slop) {
        const road = cfg.road;
        if (y < road.minY || y > road.maxY) return Infinity;

        const sight = kart.sight;
        let risk = 0;

        for (let i = 0; i < sight.spanCount; i++) {
            const s = sight.spans[i];
            const w = spanWeight(cfg, s);
            if (w <= 0) continue;

            // ── Les murs d'APRES celui du moment ─────────────────────────
            //
            // `laneRisk` cherche une profondeur, une seule, et la juge contre
            // tout ce qui est vu. Prise au pied de la lettre, cette question
            // n'a de sens que pour le mur qu'on aborde : ceux d'apres, on aura
            // bouge d'ici la. Les traiter comme le premier revenait a exiger un
            // couloir qui traverse toute la sequence d'un trait — souvent
            // aucun — et a jeter le kart dans le contournement le plus large
            // alors qu'il etait deja bien place pour le tuyau suivant.
            //
            // Ce qu'un tel mur coute n'est donc pas un choc, c'est une DETTE :
            // le deplacement qu'il faudra faire plus tard pour en sortir. On la
            // chiffre dans la meme monnaie que tout le reste — le temps de
            // braquage — et on ne garde le refus que pour ce qui est hors
            // d'atteinte meme en s'y prenant tout de suite.
            //
            // `place.debt` dit ce que vaut un deplacement REPORTE face au meme
            // deplacement fait maintenant : il se paiera sous un horizon plus
            // court et dans un trafic qui aura bouge — cf. sa note.
            if (s.hard && s.spare > 0) {
                const room = steerReach(cfg, cap, s.spare);
                const need = (y > s.lo - slop && y < s.hi + slop)
                    ? Math.min(y - (s.lo - slop), (s.hi + slop) - y)
                    : 0;
                if (need > room) return Infinity;
                if (need > 0) {
                    risk += cfg.vision.place.detour * cfg.vision.place.debt
                        * steerDelay(cfg, cap, need);
                }
                continue;
            }

            // Ecart a la limite DURE, negatif quand on est dedans. Pose a zero
            // pile sur la limite : les hitboxes sont des `>=`, donc la frontiere
            // elle-meme ne touche pas. C'est la que passe un couloir serre.
            //
            // La tolerance n'est pas une precaution, elle est INDISPENSABLE.
            // `laneCandidates` propose exactement `s.hi + slop`, et le calcul
            // rend alors un ecart de l'ordre de 1e-16 — de signe imprevisible.
            // Le candidat ecrit pour rendre un couloir serre choisissable valait
            // donc 850 ou l'infini selon l'arrondi, et pour koopa il tombait du
            // mauvais cote : le kart le plus vif du plateau se voyait refuser le
            // seul passage taille pour lui.
            const gap = ((y <= s.lo) ? s.lo - y : (y >= s.hi) ? y - s.hi : -1) - slop;

            if (gap < -LANE_EPS) {
                if (s.hard && w >= 1) return Infinity;
                risk += s.cost * w;
                continue;
            }

            // Le confort entame, et SEULEMENT le confort : la limite dure est
            // deja passee au-dessus. Entamer tout le confort ne vaut donc pas le
            // contact, mais `place.graze` de ce contact — cf. sa note. La rampe
            // montait au cout plein, ce qui notait un frolement au prix d'un
            // choc et rendait le grand contournement toujours gagnant.
            const clear = (gap > 0) ? gap : 0;
            if (clear < s.margin) {
                risk += s.cost * w * cfg.vision.place.graze * (1 - clear / s.margin);
            }
        }

        // ── L'ENCOMBREMENT ───────────────────────────────────────────────
        //
        // Ce que coute un passage DEJA PRIS. Ce n'est pas un risque de choc —
        // les carrosseries proches ont leur span pour ca — c'est une file : on
        // y arrive derriere quelqu'un, on n'y double pas, et on s'y fait
        // bousculer par ceux qui poussent.
        //
        // Sans ce terme, `laneRisk` jugeait chaque passage comme si le kart
        // etait seul en piste : au banc, 44 % des couloirs retenus en
        // contenaient deja deux karts ou plus, et 13 % en contenaient trois.
        // C'est ce qu'on voit a l'ecran quand tout le monde s'entasse dans le
        // meme trou alors que l'autre est vide.
        //
        // Il se cumule, et c'est le point : un kart devant, on passe derriere ;
        // trois, le passage n'existe plus vraiment. La note monte donc avec la
        // foule, sans qu'aucun seuil ne soit ecrit.
        //
        // La bande n'est pas un reglage de plus : c'est la hitbox entre karts
        // plus leur marge de confort. Au-dela, on n'est plus dans le meme
        // passage.
        const crowd = cfg.vision.crowd;
        if (crowd.cost > 0 && sight.crowdCount > 0) {
            const band = cfg.hitboxes.kartVsKart.y + cfg.vision.place.margin.kart;
            let press = 0;
            for (let i = 0; i < sight.crowdCount; i++) {
                const d = Math.abs(y - sight.crowdY[i]);
                if (d < band) press += 1 - d / band;
            }
            if (press > 0) risk += crowd.cost * press;
        }

        // Le bord de piste ne ferme rien — on roule dessus, `clampKartToRoad` le
        // laisse faire — il coute de la vitesse par frottement. C'est le moins
        // cher des quatre, et c'est ce qui rend enfin jouable la banane posee
        // pres du bord : longer le mur vaut mieux que la prendre.
        const edge = Math.min(y - road.minY, road.maxY - y);
        const width = road.edgeSafetyMargin;
        if (edge < width) risk += cfg.vision.cost.edge * (1 - edge / width);

        // La boite. Seul terme NEGATIF de la note : une occasion, pas un risque.
        //
        // Elle avait sa propre manoeuvre, apres le contournement de tuyau dans
        // l'ordre de priorite — donc jamais atteinte des lors qu'un tuyau etait
        // quelque part devant, c'est-a-dire presque toujours. Une occasion ne se
        // classe pas avant ou apres un mur : elle se PESE contre lui, et c'est
        // ce que la note sait faire.
        //
        // Ce qui en decoule tout seul : le kart passe la prendre quand elle est
        // sur son chemin ou pas loin, la laisse quand il faudrait traverser
        // devant un tuyau (850) ou une carapace (2000), et l'accepte au prix
        // d'un frottement de bord (200). Aucune regle a ecrire pour ca.
        const box = kart.sight;
        if (box.boxDist >= 0) {
            const off = Math.abs(y - box.boxY);
            const grab = cfg.hitboxes.itemBox.y;
            if (off < grab) risk -= cfg.vision.place.boxBonus * (1 - off / grab);
        }

        return risk;
    }

    // La note d'un candidat.
    //
    // Le risque est mesure la ou le kart SERA vraiment, pas la ou il vise : une
    // profondeur hors de portee dans le temps imparti est ramenee au plus loin
    // qu'il puisse couvrir. C'est ce qui lui apprend a juger la place qu'il a —
    // viser un trou qu'on n'atteint pas ne vaut que ce que vaut l'endroit ou
    // l'on se retrouve a mi-chemin.
    //
    // Le detour, lui, se paie sur l'intention. Sans risque nulle part, la note
    // la plus basse est celle de sa propre ligne : pas de danger, pas de virage.
    function laneScore(cfg, kart, y, cap, settle, reach, weight, slop) {
        const target = (y > settle + reach) ? settle + reach
            : (y < settle - reach) ? settle - reach : y;

        const risk = laneRisk(cfg, kart, target, cap, slop);
        if (risk === Infinity) return Infinity;

        const move = (target > settle) ? target - settle : settle - target;
        return risk + weight * steerDelay(cfg, cap, move);
    }

    // Tampons du choix. Partages par tous les karts, remplis et consommes dans
    // le meme appel : un choix de placement n'alloue rien.
    const laneY = [];
    const laneCost = [];
    let laneN = 0;

    function laneAdd(cfg, y) {
        const lo = cfg.road.minY;
        const hi = cfg.road.maxY;
        const v = (y < lo) ? lo : (y > hi) ? hi : y;

        for (let i = 0; i < laneN; i++) {
            if (Math.abs(laneY[i] - v) < 1e-6) return;
        }
        laneY[laneN] = v;
        laneCost[laneN] = 0;
        laneN++;
    }

    // Les profondeurs qui valent d'etre examinees.
    //
    // Elles ne sont pas prises au hasard ni echantillonnees : ce sont les seuls
    // endroits ou la note peut avoir un minimum. Sa propre ligne (detour nul),
    // les deux bords (le refuge le moins cher), et pour chaque obstacle vu les
    // quatre points qui le bordent — au ras de sa hitbox, et au confort.
    //
    // Le ras et le confort sont deux options distinctes ET C'EST LE POINT : le
    // confort est gratuit en risque mais loin, le ras est proche mais coute. Un
    // couloir etroit n'offre que le ras, et il reste choisissable. C'est ce
    // qu'aucun des deux anciens chercheurs ne savait dire.
    function laneCandidates(cfg, kart, settle, slop) {
        laneN = 0;
        laneAdd(cfg, settle);
        laneAdd(cfg, cfg.road.minY);
        laneAdd(cfg, cfg.road.maxY);

        const sight = kart.sight;

        // La boite visee en fait partie : c'est une profondeur qui vaut d'etre
        // examinee, au meme titre qu'un obstacle a border.
        if (sight.boxDist >= 0) laneAdd(cfg, sight.boxY);

        for (let i = 0; i < sight.spanCount; i++) {
            const s = sight.spans[i];
            if (spanWeight(cfg, s) <= 0) continue;

            laneAdd(cfg, s.lo - slop);
            laneAdd(cfg, s.hi + slop);
            laneAdd(cfg, s.lo - slop - s.margin);
            laneAdd(cfg, s.hi + slop + s.margin);
        }
    }

    // Ou se placer. Rend la profondeur retenue, ou `null` s'il n'existe aucun
    // endroit tenable — au kart de freiner, il n'y a plus que ca a faire.
    //
    // ── La qualite de decision ──────────────────────────────────────────
    //
    // Le meilleur choix n'est pas toujours celui qui est pris. Le kart descend
    // le classement et s'arrete a chaque marche avec une chance de
    // `place.chance` : il retient donc le meilleur `chance` fois sur cent, le
    // deuxieme `chance * (1 - chance)` fois, et ainsi de suite. Une erreur reste
    // une option qui existait, jamais une absurdite.
    //
    // A 1 le kart est parfait — c'est l'interrupteur pour comparer au banc. La
    // meme valeur pour les huit tant qu'aucune stat de pilote n'existe ; le
    // jour ou elle arrive, c'est ce seul nombre qu'elle module.
    function chooseLane(cfg, rng, kart, cap, ttc, spec) {
        const place = cfg.vision.place;
        const settle = steerSettle(cfg, kart);
        const reach = steerReach(cfg, cap, ttc);

        // Trois passes, et les deux dernieres ne servent qu'a NE JAMAIS SE
        // FIGER. Chacune leve une exigence, dans l'ordre du moins couteux :
        //
        //   1. le kart tel qu'il est, imprecision comprise, dans le temps qu'il
        //      a. C'est la reponse juste, et c'est elle qui refuse a un lourd un
        //      couloir qu'il ne saurait pas tenir.
        //   2. sans son imprecision. Tout ce qu'il atteint est trop juste pour
        //      lui : mieux vaut tenter un passage serre que de ne rien tenter.
        //   3. sans limite de temps. Il n'atteindra pas le bon couloir avant
        //      l'obstacle — mais aller VERS lui reste strictement meilleur que
        //      tenir une ligne qui finit dans le decor.
        //
        // La troisieme manquait, et c'est ce qui produisait le pire defaut
        // visible du systeme : sorti d'un tuyau, le kart avait pour seul horizon
        // le temps qui restait avant CE tuyau-la — donc une portee de braquage
        // quasi nulle — et tout ce qu'il pouvait atteindre tombait dans le tuyau
        // SUIVANT. Tous les candidats infinis, aucun choix rendu, repli sur
        // « garde ta ligne » : il fonçait droit dans le second sans meme
        // esquisser un mouvement. Ce n'etait pas un manque de reaction, c'etait
        // un abandon.
        //
        // Regle generale, et elle vaut pour les trois : la portee, la precision
        // et le temps CLASSENT les passages, ils n'en suppriment aucun.
        let chosen = null;

        for (let pass = 0; pass < 3; pass++) {
            const slop = (pass === 0) ? laneSlop(cfg, kart, cap, spec) : 0;
            const horizon = (pass < 2) ? reach : Infinity;

            laneCandidates(cfg, kart, settle, slop);
            for (let i = 0; i < laneN; i++) {
                laneCost[i] = laneScore(cfg, kart, laneY[i], cap, settle, horizon,
                                        place.detour, slop);
            }

            chosen = pickLane(cfg, rng);
            if (chosen !== null) break;
        }

        return chosen;
    }

    // Le tirage dans le classement, une fois les notes posees.
    //
    // ── Les egalites se tirent au sort ──────────────────────────────────
    //
    // Elles ne sont pas rares, elles sont LE cas normal : un tuyau dans l'axe
    // avec de la place des deux cotes rend deux couloirs de confort a la meme
    // distance, donc a la meme note, au bit pres. Departagees par un `<` strict,
    // c'est l'ordre de construction qui tranchait — et `laneCandidates` pose
    // toujours le cote `lo` avant le cote `hi`. Le kart passait donc EN DESSOUS
    // huit fois sur dix, indefiniment, sur tous les tuyaux du circuit et pour
    // les huit personnages : un biais parfaitement systematique, invisible dans
    // les couts, ecrit nulle part.
    //
    // Deux options identiques n'ont aucune raison d'etre departagees : le tirage
    // uniforme (Vitter) leur donne une chance chacune, et le haut redevient une
    // trajectoire.
    function pickLane(cfg, rng) {
        const place = cfg.vision.place;
        let chosen = null;
        for (let round = 0; round < laneN; round++) {
            let pick = -1;
            let ties = 0;
            for (let i = 0; i < laneN; i++) {
                if (laneCost[i] === Infinity) continue;
                if (pick < 0 || laneCost[i] < laneCost[pick] - LANE_EPS) {
                    pick = i;
                    ties = 1;
                } else if (laneCost[i] <= laneCost[pick] + LANE_EPS) {
                    ties++;
                    if (rng() * ties < 1) pick = i;
                }
            }
            if (pick < 0) break;

            chosen = laneY[pick];
            if (rng() < place.chance) break;

            // Rate : cette option sort du classement et il regarde la suivante.
            laneCost[pick] = Infinity;
        }

        return chosen;
    }

    // Place libre d'un cote du kart, en profondeur de piste. Le bord la borne, et
    // tout ce que le kart VOIT pose devant lui la borne de la meme facon : un
    // tuyau, une carrosserie, un objet au sol, l'objet traine par un autre.
    //
    // Elle ne regarde plus le monde mais `kart.sight`, et la difference est le
    // point du systeme : ce qui n'a pas ete vu ne ferme rien. Un kart aveugle
    // par celui qui le precede se decale donc vers ce qu'il ne voit pas.
    function sideRoom(cfg, kart, dir) {
        const margin = cfg.road.edgeSafetyMargin;
        let limit = (dir > 0) ? (cfg.road.maxY - margin) : (cfg.road.minY + margin);

        const sight = kart.sight;
        for (let i = 0; i < sight.spanCount; i++) {
            const s = sight.spans[i];
            if (s.dx > s.reach || s.dx < -s.reach) continue;

            // Face tournee vers le kart. Elle ne ferme le cote que si elle est
            // vraiment de ce cote-la : un obstacle que le kart chevauche deja est
            // derriere sa propre face, et refermer sur lui rendrait une place
            // negative pour un obstacle qu'aucun ecart ne peut plus eviter.
            //
            // La face de CONFORT, marge comprise, et non la limite dure : c'est
            // un garde-fou, son travail est de refuser large. Le placement, lui,
            // note les deux separement (`laneRisk`) — un garde-fou dit oui ou
            // non, il ne marchande pas.
            const face = (dir > 0) ? (s.lo - s.margin) : (s.hi + s.margin);
            if (dir > 0 ? (face > kart.yPercent && face < limit)
                        : (face < kart.yPercent && face > limit)) {
                limit = face;
            }
        }

        return Math.max(0, dir * (limit - kart.yPercent));
    }

    // Ou le kart s'arreterait s'il relachait tout : sa position, plus la course
    // que le volant a encore a rendre. C'est la reference de `steer` — cf. sa
    // note — et c'est aussi la cible d'une manoeuvre qui ne veut rien commander.
    function steerSettle(cfg, kart) {
        return kart.yPercent + kart.vy / cfg.physics.steer.response;
    }

    // LA fonction de braquage. Rejoindre une profondeur visee, et la tenir.
    //
    // Toutes les manoeuvres passent par la, sans exception : esquive,
    // contournement, precaution, visee, depassement, collecte, maraude, retour
    // au calme, et jusqu'au bill. Elles ne different que par leur PROFIL —
    // `ai.steering` — et par la profondeur qu'elles visent. C'est ce qui rend le
    // systeme verifiable : une seule loi, un seul ecrivain, huit reglages.
    //
    //   `laneY` : la profondeur a rejoindre. C'est la SITUATION qui la donne,
    //             donc elle ne depend pas du personnage.
    //   `speed` : l'urgence, avant mise a l'echelle du kart. Portee par le
    //             profil, sauf pour l'esquive et la precaution qui la tirent de
    //             leur plan.
    //   `spec`  : `{ gain, tolerance, guard }`, cf. `ai.steering`.
    //
    // ── Pourquoi viser un point et non pousser d'un cote ─────────────────
    //
    // Le kart compare la cible a l'endroit ou il s'ARRETERAIT, non a celui ou il
    // est. Le volant a 200 ms d'inertie (1 / `steer.response`) : une consigne
    // proportionnelle au seul ecart courant commande encore du braquage quand la
    // cible est deja sous les roues, le systeme est sous-amorti a ces reglages,
    // et le kart depasse d'environ deux unites et demie. Sur un passage etroit —
    // six unites, trois de chaque cote — ce depassement le fait ressortir par
    // l'autre bord, dans ce qu'il etait en train d'eviter.
    //
    // Retrancher la course restante — `vy / response`, ce que le kart parcourt
    // encore s'il relache tout — rend la reponse aperiodique. Plus aucun
    // depassement, et sans ralentir la manoeuvre.
    //
    // Les manoeuvres qui poussaient a intensite constante jusqu'a ce que la
    // situation change depassaient leur cible par construction, et le kart
    // paraissait hesiter la ou il ne faisait que corriger. Il n'en reste
    // aucune.
    //
    // ── Le garde-fou ────────────────────────────────────────────────────
    //
    // `guard` refuse d'envoyer le kart dans ce qu'il avait sous les yeux. Le
    // seuil est la course restante et non zero : s'arreter pile a la face de
    // l'obstacle demande de lever le pied avant de la toucher.
    //
    // L'esquive, le contournement et la precaution ne l'ont pas, et c'est voulu :
    // eux traversent sciemment — l'un pour passer devant l'objet, l'autre pour
    // rejoindre un couloir situe derriere le tuyau — apres avoir juge la place
    // eux-memes, par `chooseLane`. Les manoeuvres de confort, elles, ne connaissent
    // pas les obstacles et n'ont pas a les connaitre : chacune repond a sa
    // propre question, et les rendre toutes prudentes reviendrait a ecrire cinq
    // fois le meme test.
    function steer(cfg, kart, deltaTime, laneY, speed, spec) {
        const response = cfg.physics.steer.response;
        const diff = laneY - steerSettle(cfg, kart);

        if (Math.abs(diff) <= spec.tolerance) {
            // Cible tenue : il ne corrige plus, sinon il tremble autour.
            kart.targetVy = 0;
        } else {
            const cap = steerCap(cfg, kart, speed);
            const seek = steerCap(cfg, kart, diff * spec.gain);
            kart.targetVy = Math.max(-cap, Math.min(cap, seek));
        }

        if (spec.guard && kart.targetVy) {
            // Il faut avoir REGARDE DEVANT pour garantir la place devant.
            //
            // `sight.spans` ne decrit qu'un cote du kart : celui que le dernier
            // balayage regardait. Sur un balayage arriere la piste devant y est
            // donc VIDE — non pas degagee, mais jamais consultee — et le
            // garde-fou laissait alors passer n'importe quelle consigne. Un kart
            // qui se recalait pour tirer juste apres un coup d'oeil derriere se
            // decalait ainsi droit dans un tuyau qu'il n'avait pas regarde.
            //
            // Il refuse plutot que d'inventer. Le kart tient sa ligne le temps
            // du coup d'oeil, ce qui est aussi ce qu'on fait en regardant par
            // dessus son epaule.
            //
            // L'esquive, le contournement et la precaution n'ont pas de
            // garde-fou et ne sont donc pas concernes : eux jugent la place
            // eux-memes, par `chooseLane`, et doivent pouvoir manoeuvrer meme mal
            // renseignes — leur plan est marque `coarse` et repris au premier
            // balayage de face.
            const dir = kart.targetVy > 0 ? 1 : -1;
            const settle = Math.max(0, dir * kart.vy) / response;
            if (kart.sight.scanBack || sideRoom(cfg, kart, dir) <= settle) kart.targetVy = 0;
        }

        // La reponse du volant. Le facteur est borne a 1 : sur une frame longue
        // — onglet en arriere-plan, machine qui peine — le lissage non borne
        // depassait la consigne et faisait osciller le kart. Avec la borne, une
        // frame lente se contente d'arriver pile sur la consigne.
        const k = response * deltaTime;
        kart.vy += (kart.targetVy - kart.vy) * (k > 1 ? 1 : k);
    }

    // -----------------------------------------------------------------------
    // Le plan
    //
    // Une decision prise ne se defait pas parce que le regard s'est porte
    // ailleurs. C'est la regle qui manquait le plus : l'esquive etait recalculee
    // de zero a chaque frame, si bien qu'un objet sorti de la fenetre de
    // detection une seule frame — ce qui arrive PARCE QUE le kart est en train
    // de l'esquiver — relachait la manoeuvre, et le retour au calme ramenait le
    // kart droit dans l'objet.
    //
    // Une absence d'observation ne prouve rien. Seule une echeance, ou une
    // menace VUE disparue, ferme un plan.
    // -----------------------------------------------------------------------

    // Ou passer, et de quel cote. Appele a la decision, puis a chaque revision.
    //
    // Il vise une POSITION et non une direction. L'ancienne version poussait
    // d'un cote a intensite constante, apres avoir jauge la place cote par cote
    // sans jamais compter les carrosseries : un kart plongeait sous une carapace
    // pour se planter dans son voisin. Viser le milieu du meilleur passage
    // repond a la meme question sans avoir a la poser deux fois.
    //
    // Toute la marge d'erreur tient dans une ligne : `crossJudgeError` deforme
    // la distance que le kart croit pouvoir couvrir. Il vise donc parfois un
    // trou hors de portee, et renonce parfois a un trou qu'il aurait atteint.
    // Le delai avant la prochaine reprise de trajectoire.
    //
    // Il est TIRE AU SORT a chaque fois, et c'est le remede a la monotonie :
    // a cadence fixe, huit karts qui voient la meme piste rejouent la meme
    // decision aux memes instants et tracent la meme ligne. Un intervalle
    // irregulier les desynchronise sans rien changer a ce que chacun decide.
    //
    // C'est aussi le point d'accroche naturel de la future stat de decision :
    // un cerveau rapide reprend souvent sa ligne et l'affine a mesure qu'il
    // approche, un cerveau lent s'engage tot et ne revient pas dessus. Commun
    // a tous pour l'instant, comme le reste de la perception.
    function reviewDelay(cfg, rng) {
        const vis = cfg.vision;
        return vis.reviewIntervalMs
            * randomRange(rng, vis.reviewJitterMin, vis.reviewJitterMax);
    }

    function placePlan(cfg, rng, kart, plan, ttc) {
        // Toute la marge d'erreur d'appreciation tient ici : le kart se croit
        // un peu plus vif, ou un peu moins, qu'il ne l'est. Il juge donc mal ce
        // qu'il peut atteindre — parfois il vise un trou hors de portee,
        // parfois il renonce a un trou qu'il aurait pris.
        //
        // C'est le meme `crossJudgeError` qu'avant, applique au volant plutot
        // qu'a une distance limite : ca dit la meme chose et ca se propage tout
        // seul aux deux endroits qui en dependent, la portee et le detour.
        const err = cfg.ai.crossJudgeError;
        const cap = steerCap(cfg, kart, plan.intensity)
            * randomRange(rng, 1 - err, 1 + err);

        const lane = chooseLane(cfg, rng, kart, cap, ttc, cfg.ai.steering.dodge);

        // Vraiment nulle part ou aller : tout ce qu'il peut atteindre est un
        // mur. Il ne reste que le frein, et la place qu'il grappillera.
        plan.stuck = lane === null;

        // Tout se mesure depuis le POINT D'ARRET — la ou le kart finirait s'il
        // relachait le volant — et non depuis sa position. C'est la reference du
        // braquage (cf. `steer`), et s'en ecarter ici ferait dire au plan qu'il
        // commande quelque chose alors que le volant, lui, n'a rien a faire.
        const settle = steerSettle(cfg, kart);

        plan.laneY = (lane === null) ? settle : lane;
        plan.dir = (plan.laneY > settle) ? 1 : (plan.laneY < settle) ? -1 : 0;

        // Rien a commander : le kart est deja la ou il veut etre. Le plan reste
        // en place — il tient l'emplacement de menace et evite d'etre rejoue a
        // chaque balayage — mais il rend la main au reste du pilotage. Sans ca,
        // un kart deja tire d'affaire se figeait le temps que sa propre esquive
        // expire, tuyau compris.
        //
        // Le seuil est celui du braquage lui-meme, et il le faut : le placement
        // rend une profondeur exacte, qui ne retombe donc pratiquement jamais
        // pile sur le point d'arret. Tester l'egalite laisserait l'esquive
        // commander en permanence une consigne que `steer` juge deja tenue —
        // exactement le figeage que ce drapeau existe pour eviter.
        plan.idle = !plan.stuck
            && Math.abs(plan.laneY - settle) <= cfg.ai.steering.dodge.tolerance;

        // Traverser, c'est passer DEVANT l'objet au lieu de s'en ecarter. Ca
        // coute l'ecart entier et ne se rattrape pas : le frein accompagne, le
        // temps de passer.
        const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
        plan.crossing = plan.dir !== 0 && plan.dir !== natural;

        // Un plan arrete sur un balayage arriere n'a pas vu le trafic devant :
        // il a choisi son cote sur le seul decor. Il est marque, et le premier
        // balayage de face le reprend d'office.
        //
        // C'est le SENS DU BALAYAGE qui compte, jamais l'attention du moment :
        // les deux se decalent jusqu'a `scanIntervalMs`, et c'est ce qu'on lit
        // dans `sight` qui a servi ici. Meme regle qu'au releve de visee.
        plan.coarse = kart.sight.scanBack;
    }

    // Le decalage de securite : quitter la ligne de celui qui porte l'objet.
    //
    // Il ne passe pas par `chooseLane`, et c'est delibere : celui-ci cherche le
    // meilleur ENDROIT, or la ligne a quitter n'est pas un endroit. Rien ne
    // barre la piste — le danger est une profondeur, pas un corps, et le kart
    // qui la porte est souvent trop loin devant pour compter comme obstacle.
    //
    // La question est donc plus simple : de quel cote ai-je la place, et
    // combien faut-il pour que l'objet me manque. `sideRoom` repond a la
    // premiere sur la meme vue que tout le reste, `clear` a la seconde.
    //
    // Le cote naturel gagne quand il s'ouvre — on s'ecarte du danger, on ne le
    // contourne pas. Un decalage de securite qui traverserait la ligne de tir
    // pour se ranger de l'autre cote serait exactement ce qu'on cherche a
    // eviter.
    function placeSafety(cfg, kart, plan) {
        const clear = cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item;
        const lo = cfg.road.minY + cfg.road.edgeSafetyMargin;
        const hi = cfg.road.maxY - cfg.road.edgeSafetyMargin;

        // Le jeu au-dela du degagement strict, et il n'est pas decoratif : c'est
        // ce qui empeche la decision de se reprendre en boucle.
        //
        // Vise pile a la limite d'alignement, le kart s'y arrete — et la
        // premiere derive de maraude l'y ramene, ce qui redeclenche la meme
        // decision, indefiniment. Une demi-carrosserie de marge suffit a ce que
        // la derive normale ne suffise plus a le rendre a l'axe. C'est la meme
        // valeur que vise une esquive, pour la meme raison.
        const slack = clear + cfg.hitboxes.kartVsKart.y * 0.5;

        const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
        const need = clear - Math.abs(kart.yPercent - plan.threatY);

        const roomNatural = sideRoom(cfg, kart, natural);
        const dir = (roomNatural >= need || roomNatural >= sideRoom(cfg, kart, -natural))
            ? natural : -natural;

        plan.dir = dir;
        plan.laneY = Math.min(hi, Math.max(lo, plan.threatY + dir * slack));

        // Une precaution ne freine pas et ne se declare jamais acculee : au pire
        // elle ne sert a rien, et le kart continue sa course.
        plan.stuck = false;
        plan.crossing = false;
        plan.idle = false;
        plan.coarse = kart.sight.scanBack;
    }

    function updatePlan(cfg, rng, now, kart) {
        const vis = cfg.vision;
        const sight = kart.sight;
        const plan = kart.plan;

        // La menace toujours en vue repousse l'echeance : le plan tient tant
        // qu'elle converge encore.
        //
        // Sans ca, un plan pose sur une ESTIMATION du temps avant impact
        // expirait avant l'impact reel — il suffit que l'un des deux ralentisse
        // — et le kart revenait sur sa ligne juste a temps pour s'y faire
        // cueillir. L'echeance n'est la que pour les menaces qu'on ne revoit
        // pas, pas pour celles qu'on a sous les yeux.
        if (plan.threatId && sight.threatId === plan.threatId
            && sight.threatTtc !== Infinity) {
            plan.until = now + sight.threatTtc + vis.holdAfterMs;
        }

        if (plan.threatId && (now >= plan.until || sight.planGone)) {
            plan.threatId = 0;
            plan.kind = '';
            plan.until = 0;
            plan.idle = false;
        }

        // Une menace plus urgente prend la main ; la meme ne rejoue rien.
        //
        // La nature compte autant que l'identite : un kart qu'on evitait par
        // precaution — il portait une banane — et qui ramasse une etoile garde
        // le meme identifiant tout en devenant mortel. Sans le test de nature,
        // il continuerait a etre traite avec des egards.
        if (sight.threatKind === 'spin'
            && (sight.threatId !== plan.threatId || plan.kind !== 'spin')) {
            plan.kind = 'spin';
            plan.threatId = sight.threatId;
            plan.threatY = sight.threatY;
            plan.intensity = randomRange(rng, cfg.ai.dodgeIntensityMin, cfg.ai.dodgeIntensityMax);
            plan.until = now + sight.threatTtc + vis.holdAfterMs;
            plan.reviewAt = now + reviewDelay(cfg, rng);
            placePlan(cfg, rng, kart, plan, sight.threatTtc);
            return;
        }

        // ── LAISSER PASSER ───────────────────────────────────────────────
        //
        // Une rouge suit. Se decaler n'y change rien — elle se recale sur la
        // profondeur de sa cible huit fois plus vite qu'un kart ne se deplace —
        // et un objet en bouclier la mange, mais encore faut-il en avoir un.
        // Sans rien dans les mains, il ne reste qu'une parade : cesser d'etre la
        // cible. Une rouge vise devant elle ; se faire doubler, c'est sortir de
        // sa liste.
        //
        // D'ou le geste : lever un peu le pied et se ranger, pour que celui qui
        // la porte passe. Ce n'est pas une esquive, c'est un calcul de rang.
        //
        // ── Et ce qui le rend inutile ───────────────────────────────────
        //
        // S'il y en a DEUX derriere, le calcul s'inverse : laisser passer la
        // premiere, c'est se retrouver juste devant la seconde. On a change de
        // tireur, pas de sort. Le kart le voit — il compte ce qu'il a dans le
        // dos — et il ne s'y resout presque plus.
        //
        // Elle passe AVANT la precaution : celle-ci se range hors d'une ligne de
        // tir, ce qui ne veut rien dire face a un objet qui suit.
        if (!plan.threatId && sight.redBehindDist >= 0
            && sight.redBehindDist <= vis.giveWay.range
            && !(kart.heldItem && isTrailable(cfg, kart.heldItem.type))
            && now >= kart.giveWayRetryAt) {
            const give = vis.giveWay;
            kart.giveWayRetryAt = now + give.retryMs;

            const chance = (sight.redBehindCount > 1) ? give.chanceRival : give.chance;
            if (rng() < chance) {
                plan.kind = 'giveWay';
                plan.threatId = sight.redBehindId;
                plan.threatY = sight.redBehindY;
                plan.intensity = give.speed;
                plan.until = now + give.holdMs;
                plan.reviewAt = now + reviewDelay(cfg, rng);
                placeSafety(cfg, kart, plan);
                return;
            }
        }

        // La decision de securite. Elle ne se prend que faute de mieux a faire :
        // un danger reel occupe deja le plan, et il n'y a aucune raison de
        // lacher une esquive pour une precaution.
        //
        // Elle a sa CHANCE de ne pas etre prise, et c'est le coeur du reglage.
        // Un kart qui s'ecarterait a tous les coups rendrait le jeu d'objets
        // inoffensif — plus personne ne prendrait jamais de carapace dans le
        // dos ; un kart qui ne le ferait jamais resterait colle derriere une
        // verte jusqu'a ce qu'elle parte. Ratee, la decision se retente apres
        // `retryMs` : le danger, lui, n'a pas disparu.
        //
        // Une echeance PAR COTE, et il en fallait deux. Un seul compteur tenait
        // les deux formes du danger latent, si bien qu'elles se volaient leurs
        // tirages : un de rate contre le porteur qu'on a dans le dos — pendant
        // un coup d'oeil arriere — rendait sourd pendant `retryMs` a celui
        // qu'on suit, et reciproquement. Ce sont deux decisions differentes,
        // prises sur deux dangers differents ; les faire attendre l'une pour
        // l'autre n'avait aucun sens, et penalisait surtout le devant, dont les
        // occasions sont les plus longues.
        const pressBack = sight.pressureBack;
        const retryAt = pressBack ? kart.safetyRetryBackAt : kart.safetyRetryFrontAt;

        if (!plan.threatId && sight.pressure && now >= retryAt) {
            const safety = vis.safety;
            if (pressBack) kart.safetyRetryBackAt = now + safety.retryMs;
            else kart.safetyRetryFrontAt = now + safety.retryMs;

            if (rng() < safety.chance) {
                plan.kind = 'safety';
                plan.threatId = sight.pressureId;
                plan.threatY = sight.pressureY;
                plan.intensity = safety.speed;
                plan.until = now + safety.holdMs;
                plan.reviewAt = now + reviewDelay(cfg, rng);
                placeSafety(cfg, kart, plan);
                return;
            }
        }

        if (!plan.threatId) return;

        // Le recalcul : une chance, a intervalle regulier, de reprendre le
        // placement avec la perception fraiche. C'est le seul endroit ou la
        // precision se joue APRES la decision — et donc le point d'accroche
        // naturel de la future stat de decision. Commun a tous pour l'instant.
        //
        // Un plan approximatif, lui, ne tire pas et n'attend pas son tour :
        // arrete sur un balayage arriere, il n'a pas vu le trafic devant, et le
        // PREMIER BALAYAGE DE FACE le reprend. C'est ce qui permet de decider en
        // regardant derriere sans manoeuvrer a l'aveugle plus de quelques
        // dixiemes — la decision, elle, ne se rejoue pas : seul son trace se
        // corrige.
        //
        // Il faut un balayage de face, pas un simple retour de l'attention. Ce
        // test lisait `sight.back`, qui bascule a la cadence de l'affichage
        // quand le balayage ne tourne que toutes les `scanIntervalMs` : la
        // reprise partait donc au premier tick suivant la fin du coup d'oeil,
        // ou deux fois sur trois — a 30 Hz pour 80 ms de balayage — `sight`
        // contenait encore la vue ARRIERE. Elle se rejouait sur les donnees
        // qu'elle etait censee remplacer, puis effacait le marquage : le
        // garde-fou se consommait sans avoir rien corrige.
        const forced = plan.coarse && !sight.scanBack;

        if (!forced && now < plan.reviewAt) return;
        plan.reviewAt = now + reviewDelay(cfg, rng);
        if (!forced && rng() >= vis.reviewChance) return;

        if (plan.kind === 'safety' || plan.kind === 'giveWay') {
            // La ligne a quitter est celle d'un kart, et il bouge : la revision
            // la reprend telle qu'elle est maintenant.
            if (sight.pressure && sight.pressureId === plan.threatId) {
                plan.threatY = sight.pressureY;
            }
            if (sight.redBehindDist >= 0 && sight.redBehindId === plan.threatId) {
                plan.threatY = sight.redBehindY;
            }
            placeSafety(cfg, kart, plan);
            return;
        }

        // Meme raison, et elle manquait ici. Un objet ne derive pas en
        // profondeur, mais les menaces de CONTACT — etoile, bill — sont des
        // karts qui manoeuvrent. `placePlan` en tire `crossing`, qui declenche
        // le frein : sur une profondeur perimee, un kart freinait pour une
        // position que l'etoile avait quittee.
        if (sight.threatId === plan.threatId) plan.threatY = sight.threatY;

        // Le temps qui reste, mais jamais moins que d'ici la prochaine reprise :
        // c'est l'horizon sur lequel le kart se place, et a zero il ne pourrait
        // plus atteindre nulle part — il se replacerait sur sa propre ligne et
        // lacherait l'esquive juste avant l'impact.
        placePlan(cfg, rng, kart, plan,
            Math.max(plan.until - now - vis.holdAfterMs, vis.reviewIntervalMs));
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

    // Couloir choisi pour passer un tuyau.
    //
    // Il n'y a plus rien de specifique au tuyau ici : c'est `chooseLane`, avec
    // le temps qui reste avant de l'atteindre et le profil de contournement.
    //
    // Ce qu'il remplace enfilait les tuyaux de proche en proche — on partait du
    // tuyau vise, on ajoutait le suivant tant qu'il restait un passage
    // `minPassageY`, et le premier qui fermait la sequence arretait le compte.
    // La note rend ce comportement toute seule et en mieux : un tuyau proche est
    // un mur, un tuyau lointain une preference qui s'efface (`spanWeight`), si
    // bien que le couloir retenu est celui qui traverse le plus loin sans qu'on
    // ait a parcourir la sequence. Et il compte AUSSI les objets au sol et les
    // carrosseries, que l'enfilage ignorait — un kart pouvait viser un couloir
    // de tuyau avec une banane posee dedans, et la prenait.
    function choosePipeLane(cfg, kart, rng, ttc, current) {
        const place = cfg.vision.place;
        const lane = cfg.ai.steering.pipe;
        const cap = steerCap(cfg, kart, lane.speed);
        const chosen = chooseLane(cfg, rng, kart, cap, ttc, lane);

        // Aucun endroit tenable d'ici la : il garde sa ligne et grappille ce
        // qu'il peut. Arriver contre le bord du tuyau vaut mieux que se figer,
        // et la poussee du choc l'en degagera.
        if (chosen === null) return kart.yPercent;
        if (current === null) return chosen;

        // ── S'ENGAGER ────────────────────────────────────────────────────
        //
        // On ne change de couloir que si le nouveau est NETTEMENT meilleur.
        //
        // Sans ce seuil, chaque reprise pouvait renvoyer un couloir different —
        // le trafic bouge, la portee de braquage se raccourcit a mesure qu'on
        // approche, et un tirage sur quatre ne retient de toute facon pas le
        // meilleur (`place.chance`). Le kart repartait alors dans l'autre sens a
        // mi-parcours, ce qui se voit exactement comme un manque d'agilite : il
        // n'etait pas lent, il faisait deux fois la moitie du chemin.
        //
        // Le seuil ne fige rien : un couloir devenu mauvais — quelqu'un s'y est
        // mis, il n'est plus a portee — perd bien plus que ca, et la reprise se
        // fait. Ce qu'il coupe, c'est le changement d'avis a prix nul.
        //
        // ── Et il ne s'applique qu'a mesure qu'on approche ───────────────
        //
        // Changer d'avis tot est GRATUIT : il reste tout le temps de traverser.
        // Changer d'avis tard coute la traversee elle-meme. Le seuil suit donc
        // ce qu'il reste a faire, de zero quand le kart a encore de quoi couvrir
        // toute la piste, a plein quand il n'a plus rien.
        //
        // Sans ca il defendait des decisions prises EN AVEUGLE, et c'etait le
        // pire defaut du contournement. Le kart s'engage des que le tuyau entre
        // dans sa vue, a 1100 px ; sur un tracé ou les tuyaux sont espaces de
        // 560 px, le SUIVANT est alors a 1660 px, donc invisible. Il choisissait
        // un couloir qui menait droit dans un tuyau qu'il ne pouvait pas encore
        // voir, et le seuil l'y maintenait quand il apparaissait. Il decidait
        // systematiquement un tuyau trop tot.
        //
        // La reference est le temps qu'il faut a CE kart pour traverser toute la
        // profondeur : au-dela, aucune option n'est encore fermee, donc rien a
        // defendre.
        const settle = steerSettle(cfg, kart);
        const reach = steerReach(cfg, cap, ttc);
        const slop = laneSlop(cfg, kart, cap, lane);

        const cross = steerDelay(cfg, cap, cfg.road.maxY - cfg.road.minY);
        const grip = (cross > 0) ? 1 - Math.min(1, ttc / cross) : 1;
        if (grip <= 0) return chosen;

        const held = laneScore(cfg, kart, current, cap, settle, reach, place.detour, slop);
        const next = laneScore(cfg, kart, chosen, cap, settle, reach, place.detour, slop);

        return (next < held - place.commit * grip) ? chosen : current;
    }

    // Contournement d'un pipe. Rend true s'il commande la trajectoire.
    //
    // Un tuyau n'est pas une menace au sens de l'esquive. Celle-ci est un
    // reflexe, taille pour un objet qui file et qu'on evite d'un ecart : on le
    // voit tard, on s'ecarte, c'est fini. Un mur se voit venir de loin, ne bouge
    // pas, et se negocie en trajectoire — on choisit un couloir et on le tient.
    //
    // Les faire passer par la meme machinerie donnait exactement ce qu'on voyait
    // a l'ecran : le kart freinait (le frein d'esquive, inutile devant un
    // obstacle immobile), s'ecartait, se croyait tire d'affaire des que la
    // hitbox etait degagee, se faisait ramener vers sa ligne d'origine — donc
    // vers le tuyau — par le retour au calme, et recommencait. D'ou l'hesitation.
    //
    // Deux regles en sortent, et la table de cout tranche le reste :
    //   - le tuyau vise le reste jusqu'a ce qu'il soit derriere, pas jusqu'a ce
    //     que la hitbox soit degagee ;
    //   - le couloir est choisi une seule fois, sinon le kart change d'avis a
    //     chaque pas puisque son ecart au tuyau evolue.
    //
    // Et aucun frein : ralentir devant un mur immobile ne fait que retarder le
    // moment de le contourner.
    function steerAroundPipes(cfg, state, rng, now, kart, deltaTime) {
        const pipes = state.pipes;
        if (!pipes.length) return false;

        const reach = cfg.hitboxes.kartVsPipe;
        const sight = kart.sight;

        // Le tuyau vise le reste tant qu'il n'est pas franchi. C'est la regle
        // qui tient toute la manoeuvre : la lacher des que la hitbox est
        // degagee, c'est relacher le kart en plein travers.
        let dist = 0;
        if (kart.pipeTargetIndex >= 0) {
            const held = pipes[kart.pipeTargetIndex];
            dist = held ? getShortestDistance(cfg, held.worldX, kart.worldX) : 0;
            if (!held || dist < -reach.x || dist > cfg.vision.range.front) {
                kart.pipeTargetIndex = -1;
            }
        }

        // Temps restant avant le tuyau : c'est lui qui dit jusqu'ou le kart peut
        // se deplacer d'ici la, donc quels couloirs comptent vraiment. Un kart a
        // l'arret — pousse, en tete-a-queue — n'a pas un temps infini pour
        // autant, il n'a simplement pas encore reduit la distance.
        //
        // Jamais moins que d'ici la prochaine reprise, en revanche. Le tuyau
        // vise reste tenu jusqu'a ce qu'il soit derriere, si bien qu'en fin de
        // depassement ce temps tend vers zero — et avec lui la portee de
        // braquage, donc le choix. Le kart se replacait alors sur sa propre
        // ligne au moment precis ou il aurait du viser le tuyau SUIVANT.
        const horizon = ms => Math.max(ms, cfg.vision.reviewIntervalMs);
        if (kart.pipeTargetIndex < 0) {
            // Le plus proche DEVANT, aligne ou non : on se place pour un tuyau
            // avant d'etre dans son axe, sinon on ne slalome pas, on rebondit.
            if (sight.pipeAheadIndex < 0) return false;

            kart.pipeTargetIndex = sight.pipeAheadIndex;
            dist = sight.pipeAheadDist;
            kart.pipeLaneY = choosePipeLane(cfg, kart, rng,
                horizon((dist / Math.max(kart.absoluteVelocity, 1)) * 1000), null);
            kart.pipeReviewAt = now + reviewDelay(cfg, rng);

        } else if (now >= kart.pipeReviewAt) {
            // LA REPRISE. Le couloir etait choisi une fois pour toutes, a la
            // seconde ou le tuyau entrait dans la vue — c'est-a-dire au moment
            // ou le kart en savait le moins, et sur une piste qui avait tout le
            // temps de changer ensuite. Il s'y tenait, quoi qu'il arrive.
            //
            // Il le reprend maintenant a cadence irreguliere, avec la perception
            // fraiche et la place qui reste : le couloir se corrige quand
            // quelqu'un vient s'y mettre, et il s'affine a mesure qu'on approche
            // — plus on est pres, plus la portee de braquage est courte, donc
            // plus le choix est realiste.
            //
            // Et comme la cadence est tiree au sort, deux karts ne reprennent
            // pas leur ligne au meme instant : c'est ce qui casse le peloton en
            // file indienne.
            kart.pipeReviewAt = now + reviewDelay(cfg, rng);
            if (rng() < cfg.vision.reviewChance) {
                kart.pipeLaneY = choosePipeLane(cfg, kart, rng,
                    horizon((Math.max(dist, 0) / Math.max(kart.absoluteVelocity, 1)) * 1000),
                    kart.pipeLaneY);
            }
        }

        const lane = cfg.ai.steering.pipe;
        const settle = steerSettle(cfg, kart);
        const need = Math.abs(kart.pipeLaneY - settle);

        // `originalLaneY` suit le couloir, et non la ligne d'avant la manoeuvre :
        // c'est lui que le retour au calme rejoint. Le laisser en arriere y
        // ramenerait le kart, c'est-a-dire dans le tuyau. Il est pose AVANT le
        // desengagement ci-dessous : meme quand le contournement n'a rien a
        // commander, c'est le couloir qui doit servir de ligne de repos.
        kart.originalLaneY = kart.pipeLaneY;

        // Rien a corriger : sa ligne actuelle EST le meilleur couloir. Il rend
        // la main plutot que de monopoliser le pilotage — sur un circuit charge,
        // un tuyau est presque toujours quelque part devant, et s'accrocher ici
        // priverait le kart de ses boites et de ses depassements pour ne rien
        // commander.
        //
        // C'est ce qui rend l'engagement precoce gratuit : il regarde tot, il
        // n'agit que s'il y a de quoi.
        if (need <= lane.tolerance) return false;

        kart.aiState = 'pipe';

        // ── Le contournement ne freine plus ─────────────────────────────
        //
        // Il y avait ici un coup de frein, arme quand `laneRisk` rendait
        // l'infini sur la ligne du moment et que le couloir vise semblait hors
        // d'atteinte : « ou je suis, je tape, et je n'y arriverai pas ». L'idee
        // se defendait — le volant etant deja au maximum, lever le pied est la
        // seule chose qui reste.
        //
        // Sauf que les deux conditions etaient vraies presque tout le temps, et
        // pour des raisons qui n'avaient rien a voir avec le freinage :
        //
        //   - `laneRisk` rendait l'infini des qu'un mur LOINTAIN croisait la
        //     ligne, comme si le kart ne pouvait plus bouger d'ici la. C'est
        //     corrige (cf. la dette de deplacement dans `laneRisk`), mais c'est
        //     ce qui armait `doomed` a tour de bras.
        //   - `steerDelay` chiffrait la traversee au plein braquage, que le
        //     volant n'engageait jamais pour un ecart ordinaire : le kart se
        //     croyait en retard sur une manoeuvre qu'il ratait pour cause de
        //     gain trop bas. C'est corrige aussi (`steering.pipe.gain`).
        //
        // Resultat a l'ecran : un coup de frein qui LATCHE 700 ms a 78 % de la
        // vitesse (`ai.edgeBrakeMs`, `ai.edgeBrakeFactor`), deux fois par tour,
        // le plus souvent pour une situation deja degagee. Une surcompensation,
        // pas une precaution.
        //
        // Les deux corrections l'avaient deja fait tomber de 2.0 a 0.5
        // declenchement par tour. Ce qui restait ne gagnait plus rien : au banc,
        // avec ou sans, les tuyaux touches valent 0.06 par tour. On ne garde pas
        // une perte de vitesse qui n'achete aucun choc evite.
        //
        // Le frein existe toujours ailleurs, la ou il travaille vraiment :
        // acculer au bord et poursuivre un objet traine (cf. `plan.stuck` et
        // `plan.crossing`).
        steer(cfg, kart, deltaTime, kart.pipeLaneY, lane.speed, lane);
        return true;
    }

    // Le pilotage d'un kart pour un pas de temps.
    //
    // Il ne regarde plus le monde : il regarde ce que le kart en a vu. Toute la
    // perception s'est deplacee dans `perceive`, et ce qui reste ici est la
    // decision — laquelle tient en un ordre de priorite, une fois que la table
    // de cout a designe le danger.
    function updateAI(cfg, state, rng, now, kart, deltaTime) {
        if (kart.state !== 'running') return;

        const ai = cfg.ai;
        const vis = cfg.vision;

        // Un bill ne se pilote pas : il rejoint le milieu de la piste et n'en
        // bouge plus. Ni esquive, ni depassement, ni derive — il ne voit rien, et
        // de toute facon rien ne peut le toucher. Un pipe fait exception : il ne
        // l'arreterait pas — il le traverse comme une etoile — mais un
        // projectile qui laboure le decor en ligne droite n'a rien d'un vol. On
        // lui rend donc juste assez de pilotage pour le contourner, et rien de
        // plus : c'est la seule chose qu'un bill regarde encore.
        if (kart.isBill) {
            steer(cfg, kart, deltaTime, billAimDepth(cfg, state, kart),
                cfg.bill.centerSpeed, cfg.ai.steering.bill);
            return;
        }

        const sight = kart.sight;

        // L'attention d'abord : c'est elle qui decide de ce que le balayage
        // verra. Puis le balayage, amorti — la perception n'a aucune raison de
        // tourner a la cadence de l'affichage, cf. `vision.scanIntervalMs`.
        updateGlance(cfg, rng, state, now, kart);
        if (now - sight.at >= vis.scanIntervalMs) perceive(cfg, state, rng, now, kart);

        updatePlan(cfg, rng, now, kart);
        updateShield(cfg, rng, now, kart);

        // ── L'esquive ────────────────────────────────────────────────────
        //
        // Elle passe avant le reste, mais PAS avant la table de cout, et c'est
        // la nuance qui manquait. `perceive` a deja tranche entre le tuyau et
        // l'objet, au score `cout / temps restant` ; l'esquive ne fait
        // qu'obeir a cet arbitrage, au lieu d'etre prioritaire par construction.
        //
        // Avant, la table ne tranchait qu'a la CREATION du plan. Une fois pose,
        // celui-ci passait devant le tuyau quel que soit le temps qui restait
        // avant de le percuter.
        //
        // Ceder ne ferme pas le plan, il le suspend : le tuyau franchi, l'ecart
        // reprend ou il en etait. Les deux cibles etant memorisees —
        // `plan.laneY` d'un cote, `kart.pipeLaneY` de l'autre — une bascule ne
        // coute aucune decision, seulement une trajectoire adoucie.
        //
        // La comparaison se fait au temps qui reste AU PLAN (`pipeOutranksPlan`)
        // et non a ce que le balayage tient pour le plus urgent : lire la vue
        // ici lachait l'esquive des qu'elle commencait a marcher, l'objet
        // evite cessant d'etre vu pendant que le tuyau, lui, reste en vue.
        //
        // Le couloir de tuyau, lui, reste memorise pendant l'ecart, si bien que
        // le kart y revient de lui-meme des que l'objet est passe.
        const plan = kart.plan;
        if (plan.threatId && plan.kind === 'spin' && !plan.idle
            && !pipeOutranksPlan(cfg, kart, now)) {
            if (kart.aiState !== 'dodging') {
                kart.aiState = 'dodging';
                kart.originalLaneY = kart.yPercent;
            }

            // Le frein n'accompagne que les esquives qui ne sont pas franches :
            // accule il n'a plus que lui, en traversee il recule l'impact le
            // temps de passer devant l'objet.
            if (plan.stuck || plan.crossing) {
                kart.brakeUntil = now + ai.edgeBrakeMs;
                kart.brakeFactor = ai.edgeBrakeFactor;
            }

            steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.dodge);
            return;
        }

        // Le tuyau passe avant la visee, le depassement et la maraude : c'est le
        // seul obstacle certain de la piste, les autres ne sont que des
        // occasions.
        if (steerAroundPipes(cfg, state, rng, now, kart, deltaTime)) return;

        // ── La precaution ────────────────────────────────────────────────
        //
        // Apres le tuyau, et la place compte : un mur est certain quand une
        // ligne de tir n'est qu'une possibilite. Se ranger hors de l'axe d'une
        // verte ne vaut pas de s'encastrer.
        //
        // Avant les manoeuvres de confort en revanche — ne pas prendre de
        // carapace dans le dos vaut mieux que gagner une place ou ramasser une
        // boite.
        if (plan.threatId && (plan.kind === 'safety' || plan.kind === 'giveWay')) {
            kart.aiState = plan.kind;
            kart.originalLaneY = kart.yPercent;

            // Se ranger ne suffit pas a laisser passer : il faut aussi lever le
            // pied, sinon celui qui suit ne double jamais et le kart reste
            // devant sa rouge, range pour rien. C'est le seul frein qui serve
            // une intention plutot qu'une urgence, d'ou sa propre severite —
            // `giveWay.brakeFactor`, bien plus douce que celle d'un kart accule.
            if (plan.kind === 'giveWay') {
                kart.brakeUntil = now + vis.giveWay.brakeMs;
                kart.brakeFactor = vis.giveWay.brakeFactor;
            }

            steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.safety);
            return;
        }

        // Visee, dans le sens de tir choisi a la reception. Apres l'esquive —
        // se faire toucher en visant reste prioritaire — et avant le
        // depassement.
        //
        // Viser n'est pas percevoir : le kart sait ou est sa cible parce qu'il
        // l'a choisie, et il n'a pas besoin de la vue pour se recaler dessus.
        //
        // Sauf vers l'arriere. Se retourner pour tirer dans le peloton est un
        // geste, pas une intention, et c'est le seul endroit ou la visee emprunte
        // quelque chose a la vue. Sans cette condition, le tir arriere etait
        // gratuit : le tireur se recalait parfaitement sur une cible qu'il ne
        // regardait pas, et le vise n'avait aucune fenetre pour s'en sortir.
        //
        // Ce qu'il faut est d'avoir REGARDE, pas de regarder pendant. La nuance
        // se paie comptant : exiger le regard pendant toute la visee laissait le
        // tireur aveugle devant du debut a la fin de sa manoeuvre, et le banc l'a
        // dit sans ambiguite — trois graines, un plateau nettement plus etale a
        // chaque fois. Il jette un oeil, il sait ou ils sont, il se recale. C'est
        // aussi ce que fait un joueur.
        //
        // Le tir part a l'heure dite s'il n'a jamais trouve son moment : il tire
        // alors dans le tas, depuis la ligne ou il se trouvait.
        const aimDir = isAiming(cfg, kart) ? getShotDirection(state, kart) : 0;
        const aiming = aimDir !== 0 && now > kart.throwTime - ai.aimLeadMs;

        // LE RELEVE. Pendant le coup d'oeil il ne vise pas : il regarde ou est
        // l'autre, et c'est tout. Ce qu'il en retient est une profondeur et une
        // date — pas un kart, pas un suivi. La visee vient apres, tourne vers
        // l'avant, sur ce souvenir-la.
        //
        // C'est de cette peremption que nait la chance du poursuivant, et elle ne
        // coute aucun tirage : celui qui bouge apres avoir ete releve se fait
        // manquer, celui qui tient sa ligne se fait toucher. Le decalage de
        // securite devient donc une vraie parade, et non plus une precaution
        // decorative.
        if (aiming && aimDir < 0 && sight.back && sight.scanBack && sight.seenKartDist >= 0) {
            kart.aimTargetY = sight.seenKartY;
            kart.aimTargetAt = now;
        }

        // On ne vise qu'en regardant devant. Derriere, on releve.
        if (aiming && !sight.back) {
            let targetY = null;

            if (aimDir > 0) {
                // Devant, il n'a rien a se rappeler : il voit sa cible. Mais il
                // ne vise que ce que LA VUE lui donne — le kart visible le plus
                // proche dans l'axe du regard, `perceive` l'a deja designe.
                //
                // C'etait le dernier endroit du pilotage a lire le monde
                // directement : une boucle sur `state.karts`, sans occlusion et
                // sans portee de regard. Un kart cache derriere un autre s'y
                // faisait donc prendre pour cible, alors que la meme visee vers
                // l'arriere le lui interdisait — et l'en-tete de cette fonction
                // affirmait deja le contraire.
                //
                // Meme exigence qu'au releve arriere : le balayage doit avoir
                // regarde du bon cote. `sight.back` peut etre retombe alors que
                // `sight` porte encore la vue arriere, et viser DEVANT sur la
                // profondeur d'un kart situe DERRIERE est exactement le defaut
                // que le releve a deja corrige.
                if (!sight.scanBack && sight.seenKartDist >= 0) targetY = sight.seenKartY;
            } else if (now - kart.aimTargetAt <= vis.aimMemoryMs) {
                targetY = kart.aimTargetY;
            }

            // Sans releve valable, il tire a l'aveugle : depuis sa ligne, a
            // l'heure dite, sans se decaler pour personne.
            if (targetY !== null) {
                const margin = cfg.road.edgeSafetyMargin;
                const desired = Math.min(cfg.road.maxY - margin,
                                         Math.max(cfg.road.minY + margin, targetY + kart.aimError));
                const diff = desired - kart.yPercent;

                // La visee passe par la meme loi que tout le reste, et elle y a
                // gagne deux choses. Elle ne depasse plus sa cible — elle coupait
                // sa consigne a l'alignement et derivait encore de la course
                // restante, jusqu'a plus de trois unites pour un kart tres
                // maniable, soit les deux tiers d'une hitbox d'objet ; et son
                // approche est enfin proportionnelle, la ou l'ancien terme
                // saturait son propre plafond des le premier dixieme d'unite
                // d'ecart et rendait le recalage tout-ou-rien pour les huit
                // karts.
                const aim = ai.steering.aim;
                if (Math.abs(diff) > aim.tolerance) {
                    kart.aiState = 'aiming';
                    kart.originalLaneY = kart.yPercent;
                    steer(cfg, kart, deltaTime, desired, aim.speed, aim);
                    return;
                }
            }
        }

        // Depassement : le kart le plus proche qui bouche vraiment la voie. Il
        // sort de la vue comme le reste, donc un kart qui regarde derriere ne
        // prepare pas de depassement — il a autre chose en tete.
        if (sight.aheadKartDist >= 0) {
            let dir = (kart.yPercent > sight.aheadKartY) ? 1 : -1;
            if (kart.yPercent > cfg.road.maxY - cfg.road.overtakeMargin) dir = -1;
            if (kart.yPercent < cfg.road.minY + cfg.road.overtakeMargin) dir = 1;

            // Sortir de SA voie, et s'arreter la. C'est deja ce que la poussee
            // d'avant obtenait, mais sans jamais le dire : elle poussait tant
            // que l'autre bouchait, donc jusqu'a cet ecart-la. Le viser rend la
            // manoeuvre lisible, et lui donne une fin.
            //
            // La demi-carrosserie de jeu au-dela du seuil n'est pas decorative :
            // visee pile a la limite, la manoeuvre se relance a la premiere
            // bousculade.
            const pass = ai.steering.overtake;
            const clear = ai.overtakeMinDistance + cfg.hitboxes.kartVsKart.y * 0.5;
            kart.originalLaneY = kart.yPercent;
            steer(cfg, kart, deltaTime, sight.aheadKartY + dir * clear, pass.speed, pass);
            return;
        }

        // Collecte. La boite visee est la plus proche de sa trajectoire parmi
        // celles qu'il voit libres — celle qu'un kart lui masque est une boite
        // que ce kart prendra le premier, et l'occlusion le dit toute seule.
        if (!kart.heldItem && sight.boxDist >= 0) {
            // Deja dans l'axe — a la tolerance du profil pres — il tient sa
            // ligne. Le laisser repartir en maraude le ferait deriver hors de la
            // boite qu'il vise.
            const grab = ai.steering.box;
            steer(cfg, kart, deltaTime, sight.boxY, grab.speed, grab);
            return;
        }

        if (now > kart.nextWanderTime) {
            kart.nextWanderTime = now + randomRange(rng, ai.wanderIntervalMin, ai.wanderIntervalMax);
            kart.wanderEndTime = now + randomRange(rng, ai.wanderDurationMin, ai.wanderDurationMax);
            // Plus de biais du danger latent ici : il a sa propre manoeuvre,
            // decidee et tenue (cf. `placeSafety`). Le faire aussi porter par la
            // maraude donnait deux mecanismes pour la meme idee, dont un qui
            // attendait le prochain tirage de derive — jusqu'a six secondes pour
            // une decision de securite.
            let dir = (rng() > 0.5) ? 1 : -1;

            if (kart.yPercent > cfg.road.maxY - cfg.road.wanderMargin) dir = -1;
            if (kart.yPercent < cfg.road.minY + cfg.road.wanderMargin) dir = 1;

            // Un ECART a rejoindre, et non plus une vitesse a tenir. La derive
            // emmenait les karts maniables trois fois plus loin que les lourds
            // sans que rien, dans la situation, ne le demande — c'etait la
            // derniere manoeuvre a confondre « aller vite » et « aller loin ».
            // Tout le monde vise le meme decalage ; seul le temps d'y arriver
            // change, et les plus lourds ne l'atteignent pas dans la fenetre.
            //
            // Vise dans la piste et non au-dela : le bord rattrapait ce qui
            // debordait, mais viser dehors revenait a demander au kart de se
            // plaquer contre le mur pour rien.
            kart.wanderY = Math.min(cfg.road.maxY - cfg.road.wanderMargin,
                Math.max(cfg.road.minY + cfg.road.wanderMargin,
                         kart.yPercent + dir * ai.wanderOffset));
        }

        const home = ai.steering.home;

        if (now < kart.wanderEndTime) {
            kart.originalLaneY = kart.yPercent;
            const drift = ai.steering.wander;
            steer(cfg, kart, deltaTime, kart.wanderY, drift.speed, drift);
            return;
        }

        // Le retour a sa ligne apres un ecart. Il ne recale plus la position a
        // la main : la tolerance du profil dit quand la ligne est tenue, et le
        // kart s'y arrete de lui-meme au lieu d'y etre pose. C'etait le dernier
        // endroit du pilotage ou une profondeur s'ecrivait sans passer par le
        // volant.
        if (kart.aiState === 'dodging') {
            if (Math.abs(kart.originalLaneY - kart.yPercent) <= home.tolerance) {
                kart.aiState = 'cruising';
            }
            steer(cfg, kart, deltaTime, kart.originalLaneY, home.speed, home);
            return;
        }

        // La croisiere ne vise rien : elle laisse le volant revenir a zero. Dit
        // dans la langue du systeme, c'est viser l'endroit ou l'on va s'arreter
        // — la consigne tombe alors d'elle-meme, sans coup de volant en sens
        // inverse pour aller y chercher.
        kart.aiState = 'cruising';
        steer(cfg, kart, deltaTime, steerSettle(cfg, kart), home.speed, home);
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

    // Le type qui MENACE, pour un objet tenu, et il n'est pas toujours celui
    // qu'on lit.
    //
    // Un triple annonce le type de son GROUPE — `tripleGreenShell` — et non
    // celui de ce qu'il largue. Lu tel quel, aucun des predicats de danger
    // latent ne le reconnaissait : ni `isTrailable`, dont la liste ne contient
    // que des objets simples, ni `isArmedForward`, qui a pourtant ete ecrit
    // pour fermer cet ecart-la. L'orbite y retombait des deux cotes.
    //
    // Sans effet a l'ecran tant que les triples sont dans `disabledItems`, et
    // c'est bien le probleme : le jour ou on vide cette liste, le trou revient
    // en silence.
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

    // De quoi atteindre celui qu'on PRECEDE : ce qui peut partir vers l'avant.
    //
    // C'est la question du danger latent vu de derriere, et elle n'est pas celle
    // de `isAiming`, qui dit si un kart execute une manoeuvre de visee. Les deux
    // se sont longtemps confondues, et l'orbite tombait dans l'ecart : un triple
    // ne se vise pas — d'ou son exclusion de `isAiming` — mais il se tire, et
    // celui qui l'avait dans le dos ne s'en mefiait donc jamais.
    //
    // Une banane ne compte pas : lachee, elle reste derriere son porteur. Lancee
    // en cloche, si — et c'est alors une visee, d'ou le meme test qu'ailleurs.
    function isArmedForward(cfg, kart) {
        const type = heldThreatType(kart.heldItem);
        if (!type) return false;
        if (type === 'greenShell' || type === 'redShell') return true;
        return type === 'banana' && kart.lobbing;
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
        // Combien de places il y a a prendre, et non combien de karts existent :
        // c'est l'echelle sur laquelle un rang se lit. Un plateau ampute — des
        // karts encore en grille, une course a six — doit rendre les memes
        // extremes qu'un plateau complet, sinon le rang ne veut plus dire la
        // meme chose d'une course a l'autre.
        state.rankedCount = activeKarts.length;
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
    // dans `vy` etait ramene vers la consigne de l'IA par le volant en
    // 200 ms, soit avant meme que les deux karts se soient decolles.

    // Demi-emprise d'un kart, et elle lui est PROPRE : elle vient de la taille
    // de son sprite, pas d'une constante commune (cf. `bodies` en config). Deux
    // karts au contact somment donc leurs deux emprises, ce qui fait qu'un long
    // et un court ne se touchent pas au meme ecart.
    //
    // Le repli sur le kart de reference ne devrait jamais servir : la config
    // refuse de charger si un personnage n'a pas sa mesure. Il est la pour que
    // le cas impossible reste une course a la taille moyenne du plateau, et non
    // un plantage en pleine partie.
    //
    // ── L'eclair retaille la carrosserie ────────────────────────────────
    //
    // Un kart rapetisse est dessine a `lightning.scale` : son emprise l'est
    // aussi, sur les deux axes. Ca n'allait pas de soi jusqu'ici — `scale`
    // n'etait qu'une valeur de rendu, et un kart reduit de moitie continuait de
    // se cogner aux tuyaux avec un corps de taille pleine. Il se faisait
    // arreter par un mur qu'il venait visiblement de franchir.
    //
    // Un objet du monde qui a l'air petit doit toucher petit : c'est la meme
    // regle que celle qui fait descendre la longueur du sprite, appliquee a un
    // gabarit qui change en cours de course au lieu d'etre fixe.
    //
    // Le chemin rapide ne fabrique rien : hors rapetissement, c'est l'objet de
    // la config qui ressort tel quel, et cette fonction est appelee pour chaque
    // paire de karts a chaque pas.
    function kartHalfExtents(cfg, kart, now) {
        const body = cfg.bodies.kart[kart.charName] || cfg.bodies.ref;
        if (!isShrunkAt(kart, now)) return body;
        const f = cfg.lightning.scale;
        return { x: body.x * f, y: body.y * f };
    }

    // Un ecart entre centres KART-OBJET, corrige du rapetissement.
    //
    // `box` est l'ecart regle pour un kart de taille normale — `itemVsKart`,
    // `orbitItemVsKart` — c'est-a-dire la demi-emprise de l'objet PLUS une
    // demi-carrosserie. Seule la seconde a rapetisse : on retire donc la part
    // que l'eclair a fait disparaitre, et l'objet garde la sienne entiere.
    //
    // La carrosserie retiree est celle du kart de REFERENCE, et non celle de ce
    // kart-ci. Ce n'est pas une approximation par paresse : les emprises
    // d'objets sont reglees a la main et n'ont jamais suivi le gabarit des
    // personnages. Les y faire entrer par cette porte changerait l'equilibrage
    // des esquives pour tout le monde, alors qu'on ne corrige ici qu'un kart
    // frappe par la foudre.
    //
    // A taille normale la valeur reglee ressort intacte, au bit pres. Et la
    // formule degrade juste : a `scale` nul, il ne reste que la demi-emprise de
    // l'objet — le kart est devenu un point.
    function shrunkReachX(cfg, box, kart, now) {
        if (!isShrunkAt(kart, now)) return box.x;
        return box.x - cfg.bodies.ref.x * (1 - cfg.lightning.scale);
    }

    function shrunkReachY(cfg, box, kart, now) {
        if (!isShrunkAt(kart, now)) return box.y;
        return box.y - cfg.bodies.ref.y * (1 - cfg.lightning.scale);
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
    // Ce qu'un kart oppose a un choc. Ce n'est pas sa masse : c'est son INERTIE,
    // masse et vitesse ensemble.
    //
    // La masse seule ne pouvait pas dire ce qu'un choc a pourtant de plus
    // evident — qu'emboutir a pleine vitesse et se faire rejoindre au ralenti ne
    // sont pas le meme evenement. Un kart sous champignon tapait plus fort, mais
    // recevait sa part du choc comme s'il etait a l'arret : il se punissait
    // lui-meme d'avoir accelere. La vitesse manquait des deux cotes de la
    // balance, pas d'un seul.
    //
    // Elle entre donc ici, au seul endroit qui decide de qui cede a qui, et
    // rapportee a la pointe DU KART : ce qui compte n'est pas de rouler vite
    // dans l'absolu mais de pousser plus fort que d'habitude. Un poids plume
    // lance ne devient pas un poids lourd — il cesse seulement d'etre traite
    // comme un poids plume a l'arret.

    // Les deux facteurs d'etat sont des multiplicateurs poses par-dessus, et non
    // des termes de l'exposant : ils ne decrivent pas un gabarit mais une
    // situation, et valent donc pareil pour un leger et pour un lourd.
    //
    //   TETE-A-QUEUE : un kart en toupie ne pilote plus, il traverse la piste en
    //   travers sans rien pour se rattraper. Il fait obstacle plutot qu'il ne se
    //   laisse pousser.
    //
    //   BILL : ce n'est plus un kart, c'est un projectile lance. Rien de ce
    //   qu'il percute ne le devie, et ca se dit ici et nulle part ailleurs — pas
    //   par une exception dans la resolution, mais par le seul chiffre qui
    //   decide deja qui cede a qui. Les deux karts se parlent donc toujours dans
    //   la meme langue, la masse, et les trois effets d'un contact suivent d'un
    //   coup : le bill n'est pas ejecte, ne perd pas son cap, et ne recule pas
    //   d'un pouce a la separation.
    //
    //   Deux bills, eux, portent le meme facteur : il s'annule entre eux et ils
    //   retombent sur un partage moitie-moitie, attenue par `bill.pushFactor`.
    //   C'est ce qui fait qu'un bill reste la seule chose qui devie un bill,
    //   sans avoir a l'ecrire nulle part.
    function contactInertia(cfg, kart) {
        const c = cfg.physics.contact;

        // Allure du moment, en fraction de la pointe du kart. `contactSpeed` est
        // le deplacement reellement effectue sur le tick : boosts, frottement de
        // mur et chocs en cours y sont deja, il n'y a rien a recomposer. Le
        // garde-fou n'est pas un reglage — il empeche le recul d'un tuyau (qui
        // rend une vitesse negative) d'inverser le partage, et un kart a l'arret
        // de devenir un fantome que tout traverse.
        const top = kart.stats.topSpeed;
        let pace = top > 0 ? kart.contactSpeed / top : 1;
        if (pace < c.speedClamp.min) pace = c.speedClamp.min;
        else if (pace > c.speedClamp.max) pace = c.speedClamp.max;

        const m = Math.pow(kart.stats.mass, c.massBias) * Math.pow(pace, c.speedBias);
        if (kart.isBill) return m * c.billMassFactor;
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

        // Meme forme que le volant (`steer`) et que la separation des contacts : un
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
            const halfA = kartHalfExtents(cfg, a, now);
            const halfB = kartHalfExtents(cfg, b, now);
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

        // ── L'ecrasement ────────────────────────────────────────────────────
        //
        // Un kart rapetisse qui rencontre un kart reste normal passe dessous. Le
        // couple ne s'echange alors RIEN : pas d'impulsion, pas de refus de
        // braquage, pas de separation. C'est le seul contact du jeu qui sorte
        // sans avoir rien deplace, et les trois consequences voulues en
        // decoulent d'un coup — le gros roule comme s'il n'avait rien touche, le
        // petit garde sa trajectoire, et les carrosseries se traversent.
        //
        // Place APRES le bloc des intouchables, et c'est ce qui donne la regle
        // « une etoile ne l'ecrase pas, elle le blesse » : le tete-a-queue a
        // deja ete pose au-dessus, et `isRamming` disqualifie ici l'ecraseur.
        //
        // Rien a defaire quand le petit regrossit : le tick suivant le trouve a
        // taille normale, la paire retombe dans le cas ordinaire, et le
        // chevauchement accumule se resorbe en poussant l'ecraseur. La poussee
        // du retour a la taille normale n'est donc ecrite nulle part — elle est
        // ce qui reste quand cette exception cesse de s'appliquer.
        const crushA = isShrunkAt(a, now) && !isShrunkAt(b, now) && !isRamming(b);
        const crushB = isShrunkAt(b, now) && !isShrunkAt(a, now) && !isRamming(a);
        if (crushA || crushB) {
            crushKart(cfg, now, crushA ? a : b, events);
            return;
        }

        const scale = billOnBill ? cfg.bill.pushFactor : 1;

        const iA = contactInertia(cfg, a);
        const iB = contactInertia(cfg, b);
        const total = iA + iB;
        // Part du choc encaissee par chacun : c'est l'inertie D'EN FACE qui la
        // fixe. Celui qui pese et qui pousse bouge peu, l'autre part.
        //
        // Ces deux parts sont le seul endroit ou le gabarit et l'allure se font
        // sentir dans un contact, mais elles servent aux TROIS effets d'un choc :
        // l'ejection, le refus de braquage, et la separation des carrosseries.
        // Regler `massBias` ou `speedBias` les deplace donc ensemble — celui qui
        // domine le contact est repousse moins loin, garde plus de volant et
        // cede moins de terrain, d'un seul coup.
        const shareA = iB / total;
        const shareB = iA / total;

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
    // Combien de temps un kart reste rapetisse. Deux lectures de la meme
    // question — « a quel point est-il devant ? » — melangees par `rankWeight`.
    //
    //   LA DISTANCE dit l'ecart reel. Elle est juste, mais aveugle a une chose :
    //   deux karts au coude a coude sont a egalite pour elle, alors que l'un des
    //   deux mene.
    //
    //   LE RANG dit la place, et rien qu'elle. Il est grossier — il ne fait pas
    //   la difference entre un leader colle au deuxieme et un leader qui a un
    //   tour d'avance — mais il tranche toujours.
    //
    // Les deux tombent d'accord aux extremes : le premier est a la fois au rang
    // 1 et a distance nulle du leader, le dernier est au dernier rang et le plus
    // loin. `shrinkMsMax` et `shrinkMsMin` restent donc les bornes exactes du
    // malus quel que soit `rankWeight` — ce reglage ne change pas ce que
    // l'eclair peut couter, seulement comment le cout se repartit au milieu.
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

    // Rapetisse a l'instant present. La date fait foi et non le drapeau : celui-ci
    // n'est rafraichi qu'une fois par tick, avant les contacts, et un kart qui
    // regrossit pile pendant la passe doit deja compter comme grand.
    function isShrunkAt(kart, now) {
        return kart.shrinkEndTime > now;
    }

    // L'ecrasement. Le petit est aplati, et c'est tout ce qui se passe : aucune
    // impulsion, aucune separation, aucun tete-a-queue. Voir `lightning.flatMs`.
    //
    // La date est bornee par la fin du rapetissement : on n'ecrase que ce qui
    // est petit, donc redevenir grand rend sa forme au kart, meme si les trois
    // secondes ne sont pas ecoulees. Se faire ecraser au dernier moment ne coute
    // donc presque rien — c'est la contrepartie de ce que l'ecrasement ne
    // retarde jamais le regrossissement.
    //
    // La borne est posee ici, une fois, plutot que relue a chaque tick : le
    // marche se conclut a l'instant du contact, et l'etat n'a ensuite qu'une
    // seule date a regarder comme tous les autres.
    //
    // Repoussee tant que le contact dure — un gros qui reste dessus le garde
    // plat — mais l'evenement ne part qu'a la premiere fois, sans quoi il
    // tomberait trente fois par seconde.
    function crushKart(cfg, now, kart, events) {
        const wasFlat = now < kart.flatEndTime;
        kart.flatEndTime = Math.min(now + cfg.lightning.flatMs, kart.shrinkEndTime);
        if (!wasFlat) events.push({ type: 'kartCrushed', kartId: kart.id });
    }

    // Duree d'un tete-a-queue. La MEME pour tout le monde, et c'est un choix :
    // une toupie n'est plus du pilotage, il n'y a plus de kart la-dedans, rien
    // qui puisse tourner mieux ou moins bien. Ce qu'un personnage a de propre se
    // joue apres, a la relance, et une seule stat y repond — l'acceleration.
    //
    // L'indexer sur la masse a ete essaye et retire : `mass` ne depend que du
    // poids, si bien que deux karts de meme poids et de handling different
    // tournaient exactement aussi longtemps. Ca elargissait la fenetre du poids
    // en croyant ouvrir celle du handling, et ca taxait l'axe poids une
    // troisieme fois pour une seule recompense.
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

                // Le passage se date en premier, et sans condition : la zone se
                // traverse qu'il y reste un cube ou non, qu'on ait les mains
                // pleines ou non. C'est l'endroit qui rend prudent, pas le
                // butin — celui qui suit vient peut-etre d'y prendre de quoi
                // tirer. Cf. `vision.boxGlanceMs`.
                //
                // C'est pour ce releve-la que la boucle ne saute plus les cubes
                // eteints : elle les parcourt pour leur position, qui ne bouge
                // jamais, et ne consomme que ceux qui sont encore la.
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

            // Double la date en booleen, comme l'etoile et l'eclair : le
            // protocole n'a pas d'horloge, le drapeau se lit tel quel dans le
            // snapshot. Pose ici et pas dans la branche 'running' : un kart
            // percute pendant son choc garderait sinon un drapeau fige jusqu'a
            // son retour en course.
            kart.bumped = now < kart.bumpEndTime;

            // Meme raison et meme place que le precedent : le protocole n'a pas
            // d'horloge, le drapeau se lit tel quel dans le snapshot. Pose hors
            // de la branche 'running' pour qu'un kart aplati puis percute ne
            // garde pas un drapeau fige pendant son tete-a-queue.
            kart.isFlat = now < kart.flatEndTime;

            // Ce que les objets de vitesse rendent au volant. Champignon et
            // etoile lancent le kart, et un kart lance perdrait de l'appui
            // (`steer.pace`) : sans ce gain, prendre un champignon reviendrait a
            // se rendre pataud au moment ou l'on double. Il fait plus que
            // compenser — sous objet on tourne MIEUX que d'habitude.
            //
            // Pose ici, une fois par tick, exactement comme les drapeaux
            // ci-dessus : c'est ce qui permet a `steerCap` de ne lire qu'un kart,
            // sans horloge, et donc de valoir pareil pour le pilotage et pour les
            // planificateurs qui l'appellent hors du tick.
            kart.steerBoost = (now < kart.boostEndTime || now < kart.starEndTime)
                ? cfg.physics.steer.boostGain : 1;

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

                    // L'elan est SUSPENDU, pas efface. L'objet porte le kart, et
                    // le rythme qu'il avait avant l'attend a la sortie.
                    //
                    // Il etait force a 1.0 ici, ce qui donnait a tout objet de
                    // vitesse une seconde prime que personne n'avait decidee : le
                    // kart ressortait a 100 % de sa pointe au lieu de sa
                    // croisiere, et y restait le temps d'un tirage entier — le
                    // compte a rebours etant repousse a chaque tick. Cinq
                    // secondes en moyenne, soit pres de la moitie de ce que
                    // rendait le champignon lui-meme.
                    //
                    // La mise de cote se fait au premier tick sous objet et vaut
                    // pour toute la chaine : deux objets qui se recouvrent ne
                    // font qu'une suspension, et c'est l'elan d'avant le premier
                    // qui revient. Le compte a rebours est gele avec lui, sinon
                    // la sortie tomberait sur une horloge qui a tourne dans le
                    // vide et redemanderait un tirage aussitot.
                    if (kart.preBoostMomentum < 0) {
                        kart.preBoostMomentum = kart.momentum;
                        kart.preBoostDriftLeft = Math.max(0, kart.nextMomentumChange - now);
                    }
                } else {
                    // Fin de suspension : l'elan reprend la main la ou il en
                    // etait, et pour le temps qu'il lui restait. Pose avant la
                    // lecture de l'horloge, pour qu'un compte a rebours arrive a
                    // terme pendant l'objet tire des le premier tick libre.
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
                    // Le frein porte sa propre severite : lever le pied pour
                    // laisser passer une rouge n'est pas la meme chose que
                    // freiner devant un mur. Elle est posee avec l'echeance, a
                    // chaque fois, et `edgeBrakeFactor` reste le defaut.
                    if (now < kart.brakeUntil) {
                        effectiveSpeed *= kart.brakeFactor || cfg.ai.edgeBrakeFactor;
                    }

                    // Ce que braquer coute en vitesse. Une seule ligne, parce
                    // qu'une seule fonction en decide (cf. `steerCost`).
                    //
                    // Ici et pas ailleurs : le cout disparait a l'instant ou le
                    // kart cesse de tourner, sans periode de recuperation, et il
                    // ne se compose pas avec `acceleration` — rogner
                    // `targetSpeed` ferait payer la reprise une seconde fois par
                    // une stat que la masse taxe deja.
                    //
                    // Sous objet, rien : un champignon n'est pas du pilotage et
                    // doit rendre le multiplicateur qu'on lui donne, comme pour
                    // le frein de bord juste au-dessus. Le volant, lui, y gagne
                    // (`steer.boostGain`).
                    //
                    // Propriete acquise gratuitement : `steer` met la consigne a
                    // zero des que la cible est tenue, donc le cout ne
                    // s'accumule que pendant les TRANSITIONS, jamais pendant
                    // qu'on tient une ligne. La ligne optimale devient
                    // « choisir tot, et tenir ».
                    //
                    // Le compteur est pose ICI, et nulle part ailleurs : c'est
                    // le seul endroit qui connaisse les conditions du tick — le
                    // kart tourne, il n'est pas sous objet, il court. Un banc ne
                    // peut pas le recalculer apres coup sans les refaire, et une
                    // valeur annoncee dans un commentaire de config finit
                    // toujours par mentir. Celle-ci se mesure.
                    //
                    // Aucune decision ne le lit : c'est une observation, pas un
                    // etat de jeu.
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

                // Apres le rapetissement, et multiplie par-dessus : les deux
                // malus se cumulent. Un kart aplati traine, il ne s'arrete pas —
                // c'est la difference avec le tete-a-queue, et c'est pour ca que
                // rien d'autre que la vitesse n'est touche ici.
                if (kart.isFlat) {
                    effectiveSpeed *= cfg.lightning.flatSpeedFactor;
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

                        // `dx` porte la carrosserie de la victime, donc son
                        // rapetissement. `dy` non : ce 8 n'est pas une somme de
                        // corps mais une tolerance de profondeur posee ici, et
                        // la rogner reviendrait a regler autre chose.
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

                    // Et le lateral avec, pour la meme raison. `vy` n'est pas
                    // integre pendant le tete-a-queue mais il n'etait pas remis
                    // a zero non plus : le kart repartait avec la vitesse
                    // laterale qu'il avait AVANT le choc, gelee pendant toute la
                    // toupie, et repartait donc en biais pendant le temps que le
                    // volant mette a la resorber. Un incident remet l'elan a
                    // zero ; il n'y a aucune raison qu'il garde une direction.
                    kart.vy = 0;
                    kart.targetVy = 0;

                    kart.momentum = 0.2;
                    kart.momentumTarget = randomRange(rng, 0.6, 1.0);
                    kart.nextMomentumChange = now + randomRange(rng, cfg.speeds.momentumDriftMin, cfg.speeds.momentumDriftMax);
                    // Comme pour le tuyau : le tete-a-queue refait l'elan de
                    // zero, il n'y a plus rien a rendre a la fin d'un objet qui
                    // aurait survecu au choc.
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

                // Le contact qui BLESSE, et le seul de cette boucle a mettre en
                // jeu une carrosserie : les deux tests plus haut opposent
                // l'objet a un autre objet — celui qu'on traine, celui qui
                // tourne en orbite — et n'ont pas de corps a rapetisser.
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

                // Elan mis de cote pendant un objet de vitesse, et ce qu'il
                // restait a son compte a rebours. -1 veut dire « rien en
                // attente » : c'est le seul etat qui autorise la mise de cote,
                // et le seul que produit un incident, qui refait l'elan et n'a
                // donc rien a rendre.
                preBoostMomentum: -1,
                preBoostDriftLeft: 0,
                vy: 0,
                targetVy: 0,

                // Canaux de choc, tenus a l'ecart du pilotage et du moteur.
                // `bumpVy` est en profondeur/s, `bumpVx` en pixels/s. Les deux
                // s'ajoutent au deplacement puis s'amortissent seuls : ecrire un
                // choc dans `vy` le faisait effacer par le volant avant que
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

                hitEndTime: 0,

                // Choc contre un pipe. `bumpEndTime` porte l'arret net,
                // `bumpRecoilLeft` ce qu'il reste a reculer. Le sursis est
                // retenu par tuyau : un kart qui vient d'en heurter un doit
                // pouvoir se cogner au suivant.
                bumpEndTime: 0,
                bumpRecoilLeft: 0,
                bumped: false,

                // Ecrase par un kart reste grand. Date et drapeau, comme le
                // reste. La date ne depasse jamais celle du rapetissement : un
                // kart redevenu grand n'est plus plat.
                flatEndTime: 0,
                isFlat: false,

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

                // Quand il a traverse une zone de boxes — le coup d'oeil
                // arriere en depend (cf. `vision.boxGlanceMs`) — et l'episode de
                // danger pour lequel il a deja tranche entre bouclier et tir.
                boxPassedAt: -Infinity,
                shieldAt: -Infinity,
                shieldHold: false,

                // Severite du frein en cours, et prochaine occasion de decider
                // de se laisser doubler (cf. `vision.giveWay`).
                brakeFactor: 0,
                giveWayRetryAt: 0,
                shotDirection: 1,
                // Le plan de tir a-t-il ete fait en tete ? Il ne vaut plus rien
                // si le kart s'est fait doubler depuis.
                shotAsLeader: false,
                lobbing: false,
                aimError: 0,

                // Le releve d'un tir vers l'arriere : la profondeur vue lors du
                // coup d'oeil, et sa date. Il se perime (`vision.aimMemoryMs`),
                // et c'est voulu — viser de memoire, c'est viser ou l'autre
                // ETAIT.
                aimTargetY: 0,
                aimTargetAt: -Infinity,

                // ── La vue ───────────────────────────────────────────
                //
                // Tout ce que le kart a percu au dernier balayage, et rien
                // d'autre : le pilotage ne lit plus le monde. `spans` est un
                // tampon qui grandit une fois puis se recycle, comme le reste
                // de la perception.
                //
                // Les deux dates de depart sont decalees kart par kart pour
                // qu'ils ne balayent ni ne tournent la tete tous ensemble.
                // C'est la moitie de ce que rend `vision.scanIntervalMs`.
                sight: {
                    at: now - cfg.vision.scanIntervalMs
                        + Math.round(index * cfg.vision.scanIntervalMs / names.length),
                    back: false,
                    backUntil: 0,

                    // Sens du dernier balayage effectue, a distinguer de `back`
                    // qui est l'attention du moment (cf. `perceive`).
                    scanBack: false,

                    nextGlance: now
                        + Math.round(index * cfg.vision.glanceIntervalMs / names.length),

                    // Date du dernier coup d'oeil en arriere. C'est elle qui
                    // autorise a viser derriere : avoir regarde, et non regarder
                    // pendant. Loin dans le passe au depart — personne n'a encore
                    // rien vu.
                    seenKartY: 0,
                    seenKartDist: -1,

                    threatId: 0,
                    threatKind: '',
                    threatY: 0,
                    threatTtc: Infinity,
                    planGone: false,

                    spans: [],
                    spanCount: 0,

                    // Ce que le balayage a vu passer sans le voir : ce qui
                    // tombait dans l'ombre d'un corps plus proche. Purement
                    // observable — aucune decision ne le lit. Cf. `perceive`.
                    hiddenIds: [],
                    hiddenCount: 0,

                    // Les ombres elles-memes, telles que la marche les a
                    // empilees : deux pentes depuis l'oeil, et les deux
                    // distances entre lesquelles elles portent. Observable
                    // aussi — la decision les a deja consommees.
                    shadowLo: [],
                    shadowHi: [],
                    shadowFrom: [],
                    shadowTo: [],
                    shadowCount: 0,

                    // Ou etait la camera pendant ce balayage. Sans elle, les
                    // pentes ci-dessus ne se rattachent a rien.
                    eyeBack: 0,
                    eyeY: 0,

                    // La portee du balayage courant, avant ou arriere. Elle se
                    // deduit du sens et de `vision.range`, mais l'observateur
                    // n'a pas a refaire ce choix : ce qui s'affiche doit etre ce
                    // que le moteur a regarde.
                    scanRange: 0,

                    // Les profondeurs des karts qui roulent avec lui — cf.
                    // `vision.crowd` et l'encombrement dans `laneRisk`.
                    crowdY: [],
                    crowdCount: 0,

                    pipeIndex: -1,
                    pipeDist: 0,
                    pipeAheadIndex: -1,
                    pipeAheadDist: 0,
                    aheadKartY: 0,
                    aheadKartDist: -1,
                    boxY: 0,
                    boxDist: -1,
                    pressure: false,
                    pressureY: 0,
                    pressureId: 0,
                    // De quel cote vient le releve ci-dessus : un porteur dans
                    // le dos qui peut tirer, ou un porteur devant qui peut
                    // lacher. Meme perception, deux decisions.
                    pressureBack: false,

                    // Le porteur qu'on SUIT, et depuis quand. Meme souvenir
                    // date que `dangerAt` plus bas, meme peremption, pour la
                    // meme raison : un coup d'oeil arriere ne doit pas effacer
                    // ce que le kart a devant lui. Seul un balayage AVANT pose
                    // ou leve ce souvenir.
                    frontAt: -Infinity,
                    frontY: 0,
                    frontId: 0,

                    // Le danger APERCU DERRIERE, et depuis quand.
                    //
                    // C'est un souvenir et non un etat : le tirage du coup
                    // d'oeil n'a jamais lieu pendant un coup d'oeil, donc il ne
                    // peut lire que ce qu'on a vu, pas ce qu'on voit.
                    //
                    // Meme raison que ci-dessus, et la meme portee : la tete
                    // revenue devant, le kart ne voit plus ce qui le suit. Sans
                    // souvenir il oublierait la carapace entre deux clignements,
                    // et retomberait a sa chance de base juste avant l'impact.
                    //
                    // `dangerAt` est rafraichi a chaque coup d'oeil qui le
                    // revoit ; `dangerSince` marque le debut de l'EPISODE, et
                    // c'est lui qui evite de rejouer le choix du bouclier a
                    // chaque balayage.
                    //
                    //   'shot'    une carapace en vol, deja lancee
                    //   'carrier' quelqu'un derriere qui en porte une
                    //   'ram'     une etoile ou un bill : rien a lui opposer,
                    //             seulement sa trajectoire a quitter
                    dangerAt: -Infinity,
                    dangerSince: -Infinity,
                    dangerKind: '',

                    // Les rouges apercues derriere : la plus proche, et combien.
                    // Cf. `vision.giveWay`.
                    redBehindDist: -1,
                    redBehindY: 0,
                    redBehindId: 0,
                    redBehindCount: 0,

                    // Et leur souvenir, sans lequel le releve ci-dessus
                    // n'existait que pendant le coup d'oeil. Meme peremption
                    // que `dangerAt`, et pose par le seul balayage arriere.
                    redMemAt: -Infinity,
                    redMemDist: -1,
                    redMemY: 0,
                    redMemId: 0,
                    redMemCount: 0
                },

                // Le plan d'evitement en cours. Il survit a la perte de vue :
                // seule son echeance, ou le constat que la menace est passee,
                // le ferme. Cf. `updatePlan`.
                plan: {
                    kind: '',
                    threatId: 0,
                    threatY: 0,
                    laneY: verticalPos,
                    dir: 0,
                    intensity: 30,
                    until: 0,
                    reviewAt: 0,
                    coarse: false,
                    idle: false,
                    stuck: false,
                    crossing: false
                },

                // Menaces deja jugees : reflexe tire et verdict d'inattention,
                // retenus le temps qu'elles passent. Ecrase le premier
                // emplacement libre ou perime, sinon le plus ancien — cf.
                // `vision.memorySlots` et `vision.memoryMs`. Zero ne designe
                // aucune menace : les objets s'identifient a partir de 1, les
                // karts en negatif.
                judgedId: new Array(cfg.vision.memorySlots).fill(0),
                judgedSeenAt: new Array(cfg.vision.memorySlots).fill(-Infinity),
                judgedReactAt: new Array(cfg.vision.memorySlots).fill(0),
                judgedIgnored: new Array(cfg.vision.memorySlots).fill(false),

                // Prochaine chance de prendre une decision de securite, UNE PAR
                // COTE. Ce qui se retente est la decision et non la perception
                // de celui qui la provoque — mais se ranger devant un porteur
                // et se ranger derriere un porteur sont deux decisions, prises
                // sur deux dangers. Un compteur commun les faisait s'annuler
                // l'une l'autre (cf. `updatePlan`).
                safetyRetryFrontAt: 0,
                safetyRetryBackAt: 0,
                // Prochaine reprise du couloir de tuyau. Zero : le premier
                // couloir choisi est aussitot revisable (cf. steerAroundPipes).
                pipeReviewAt: 0,

                nextWanderTime: now + randomRange(rng, 1000, 5000),
                wanderEndTime: 0,
                wanderY: 0,

                // Gain de volant sous objet de vitesse. Neutre au depart, repose
                // a chaque tick (cf. `stepPhysics`).
                steerBoost: 1,

                // Distance perdue a la contrainte de virage depuis le depart, en
                // pixels de monde. Compteur d'observation, jamais lu par le jeu.
                cornerLostPx: 0,


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
            rankedCount: 0,

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

        // La loi de braquage, pour les observateurs : le banc de scenario s'en
        // sert pour sortir, kart par kart, le temps d'une manoeuvre donnee. Le
        // moteur, lui, ne braque que par `steer`.
        steerCap,
        steerCost,
        steerGrip,
        steerPace,
        steerReach,
        steerDelay,

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
