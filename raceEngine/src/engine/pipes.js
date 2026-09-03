// Les tuyaux : ce qui rebondit dessus, ce qui s'y cogne, ce qui les evite.
// Un tuyau est le seul obstacle fixe de la piste ; il merite donc a la fois une
// collision propre et une manoeuvre d'evitement dediee.

import { getShortestDistance } from './geometry.js';
import { steerCap, steerDelay, steerReach } from './steering.js';
import { isRamming, kartHalfExtents } from './bodies.js';
import { spendItem } from './items.js';
import { chooseLane, laneScore, laneSlop, steer, steerSettle } from './driving.js';
import { reviewDelay } from './plans.js';

// Un pipe est un DISQUE pose au sol, seul corps rond du moteur. Ses deux axes
// n'ont pas la meme unite — `worldX` en px de monde, `y` en profondeur — et rien
// ici ne les convertit.
//
// La rondeur se lit donc dans un ESPACE NORMALISE, chaque ecart divise par son
// demi-axe : le tuyau y devient le cercle unite, les deux unites disparaissent,
// et c'est le seul repere ou un angle veut dire quelque chose pour lui.

// Cet ecart tombe-t-il dans l'emprise ronde `box` ?
function insidePipe(box, dx, dy) {
    const u = dx / box.x;
    const v = dy / box.y;
    return u * u + v * v < 1;
}

// Un rebond de plus au compteur d'une verte ; rend true si c'etait celui de trop.
// Bords de piste et tuyaux comptent pareil. C'est aussi ce qui donne une duree de
// vie a une verte, qui n'en avait aucune.
function registerBounce(cfg, item, now) {
    if (item.type !== 'greenShell') return false;

    item.bounces++;
    if (item.bounces > cfg.pipe.maxShellBounces) {
        spendItem(cfg, item, now);
        return true;
    }
    return false;
}

// Rebond d'une carapace sur un tuyau. Rend true si le contact a eu lieu.
//
// Un corps rond a une NORMALE differente en chaque point, qui se lit directement
// sur la position dans l'espace normalise. Elle sert a poser le point de sortie
// sur l'arc et a dire quel axe renverser.
//
// UN SEUL AXE SE RENVERSE. La reflexion complete est la reponse geometrique et
// elle est fausse ici : les deux axes du monde ne portent pas la meme echelle de
// vitesse (880 px/s le long de la piste contre 1.5 unite/s en profondeur), et
// reflechir pour de bon echange les deux budgets a 12 : 1 — un tir effleurant
// traversait la piste en un tiers de seconde, en enjambant `maxSubStepY` et donc
// les karts.
//
// Le rond decide de l'ANGLE du renvoi, pas de la vitesse. L'axe renverse est
// celui qui porte le plus l'ENTREE dans le tuyau, mesuree sur la normale : elle
// vaut zero sur un axe que la carapace ne franchit pas.
function bounceItemOffPipe(cfg, pipe, item) {
    const box = cfg.pipe.hitbox;
    const margin = 1 + cfg.pipe.escapeMargin;

    const dx = getShortestDistance(cfg, item.worldX, pipe.worldX);
    const dy = item.y - pipe.y;

    // La normale au point touche : dans l'espace normalise, c'est la position
    // elle-meme, ramenee a l'unite.
    let nu = dx / box.x;
    let nv = dy / box.y;
    let norm = Math.sqrt(nu * nu + nv * nv);

    // Pile au centre, aucune normale ne se calcule : on la prend sur la
    // trajectoire, ce qui renvoie la carapace d'ou elle vient. Le cas ne se verra
    // jamais, mais une division par zero ne se laisse pas au hasard.
    if (norm < 1e-6) {
        nu = -item.vx / box.x;
        nv = -item.vy / box.y;
        norm = Math.sqrt(nu * nu + nv * nv);
        if (norm < 1e-6) return false;
    }

    nu /= norm;
    nv /= norm;

    // Part de l'entree portee par chaque axe. Positive quand cet axe pousse la
    // carapace vers le centre : le renverser la fait ressortir.
    const inX = -(item.vx / box.x) * nu;
    const inY = -(item.vy / box.y) * nv;

    // Elle s'eloigne deja par les deux : la renvoyer la ferait rentrer.
    if (inX <= 0 && inY <= 0) return false;

    // Reposee sur l'arc le long de la normale, marge comprise : sans ca le
    // sous-pas suivant la retrouve dedans et la renvoie une seconde fois.
    let outX = pipe.worldX + nu * box.x * margin;
    let outY = pipe.y + nv * box.y * margin;

    // Un tuyau colle au bord deborde de la piste : ressortir par ce flanc
    // poserait la carapace hors du bitume, ou le rebond de bord la renverrait
    // dedans. Elle repart alors par le bout.
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
// Un seul pas de 33 ms ne suffit plus des que la profondeur bouge vite : a 45
// degres une verte avance de huit unites par pas, pour une hitbox de kart qui en
// fait cinq. Elle enjamberait ses victimes et traverserait un tuyau sans le voir.
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
// Masse infinie : rien ne se transmet au tuyau, tout est pour le kart. Arrete
// net, recule un peu, repart de zero — c'est son acceleration qui decide de ce
// que le choc lui aura coute, ce qui fait payer les lourds sans qu'aucune
// penalite ne soit ecrite pour eux.
//
// Etoile et bill le traversent. Le tuyau, lui, encaisse un sursaut purement
// visuel.
//
// Le sursis est retenu PAR TUYAU : un kart qui vient d'en heurter un doit encore
// pouvoir se cogner au suivant, sans quoi deux tuyaux cote a cote ne feraient
// qu'un seul mur franchissable.
function collideKartWithPipes(cfg, state, kart, now, events) {
    kart.pipeBlocked = false;

    const pipes = state.pipes;
    if (!pipes.length) return;

    const box = cfg.pipe.hitbox;

    // La carrosserie de CE kart, pas celle du kart de reference : elle vient de
    // son sprite (`kartHalfExtents`), et un kart long se cogne plus tot qu'un
    // court.
    //
    // La carrosserie est une boite, le tuyau est rond : leur somme est un
    // rectangle aux coins arrondis, et c'est ce que teste le rabotage plus bas.
    // Seuls les coins changent — de face comme de flanc, le contact tombe sur la
    // partie plate et vaut ce qu'il valait.
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

        // Une toupie ne se cogne pas, elle est deja hors de controle : le tuyau
        // l'arrete et la fait glisser, sans nouveau choc ni recul. Lui rejouer le
        // choc du kart en course rallongeait `bumpEndTime` par a-coups et faisait
        // clignoter le sprite. Le sursis par tuyau est saute a dessein, sans quoi
        // la toupie traverserait.
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
        // Un tuyau efface l'elan, y compris celui qu'un objet en cours tenait de
        // cote : sans ca, la fin de l'objet le rendrait en silence et le choc
        // n'aurait rien coute a celui qui l'a pris lance.
        kart.preBoostMomentum = -1;

        // Ecarte vers le cote le plus degage, sans quoi un kart pousse par le
        // peloton resterait plaque contre le tuyau.
        //
        // Dans `bumpVy`, comme tout ce qui est subi. Ecrite dans `vy`, elle
        // offrait a tous le meme decalage gratuit — les trois quarts d'une
        // esquive de bowser contre un sixieme de celle d'un koopa : le tuyau
        // rendait maniable qui ne l'est pas.
        kart.bumpVy = pipeSlideDir(cfg, kart, pipe) * cfg.pipe.slideAway;

        // Le plan en cours ne vaut plus rien : il visait a passer, et le kart est
        // arrete contre le tuyau. Il rechoisira un couloir au redemarrage.
        kart.aiState = 'cruising';
        kart.plan.threatId = 0;
        kart.pipeTargetIndex = -1;

        events.push({ type: 'kartBumped', kartId: kart.id, pipeIndex: p });
        return;
    }
}

// Couloir choisi pour passer un tuyau : c'est `chooseLane`, avec le temps restant
// et le profil de contournement — plus rien de specifique au tuyau ici.
//
// Ce qu'il remplace enfilait les tuyaux de proche en proche. La note rend ce
// comportement toute seule et en mieux (`spanWeight`), et elle compte AUSSI les
// objets au sol et les carrosseries, que l'enfilage ignorait — un kart pouvait
// viser un couloir avec une banane dedans, et la prenait.
function choosePipeLane(cfg, kart, rng, ttc, current) {
    const place = cfg.vision.place;
    const lane = cfg.ai.steering.pipe;
    const cap = steerCap(cfg, kart, lane.speed);
    const chosen = chooseLane(cfg, rng, kart, cap, ttc, lane);

    // Aucun endroit tenable d'ici la : il garde sa ligne et grappille ce qu'il
    // peut. Arriver contre le bord du tuyau vaut mieux que se figer, la poussee
    // du choc l'en degagera.
    if (chosen === null) return kart.yPercent;
    if (current === null) return chosen;

    // S'ENGAGER : on ne change de couloir que si le nouveau est NETTEMENT
    // meilleur. Sans seuil, le kart repartait dans l'autre sens a mi-parcours —
    // ce qui se voit comme un manque d'agilite alors qu'il faisait deux fois la
    // moitie du chemin.
    //
    // Et le seuil ne s'applique qu'a mesure qu'on approche : changer d'avis tot
    // est gratuit, changer d'avis tard coute la traversee. Sans cette montee il
    // defendait des decisions prises EN AVEUGLE — le kart s'engage des qu'un
    // tuyau entre dans sa vue, quand le suivant est encore invisible, et le seuil
    // l'y maintenait.
    //
    // La reference est le temps qu'il faut a CE kart pour traverser toute la
    // profondeur : au-dela, aucune option n'est fermee, donc rien a defendre.
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

// Contournement d'un tuyau. Rend true s'il commande la trajectoire.
//
// Un tuyau n'est pas une menace au sens de l'esquive : celle-ci est un reflexe
// pour un objet qui file et qu'on evite d'un ecart, un mur se voit venir de loin
// et se negocie en trajectoire. Les faire passer par la meme machinerie faisait
// freiner le kart, s'ecarter, se croire tire d'affaire des que la hitbox etait
// degagee, puis se faire ramener vers sa ligne — donc vers le tuyau. D'ou
// l'hesitation.
//
// Deux regles en sortent : le tuyau vise reste jusqu'a etre DERRIERE et non
// jusqu'a ce que la hitbox soit degagee, et le couloir est choisi une seule fois.
// Aucun frein : ralentir devant un mur immobile ne fait que retarder le
// contournement.
function steerAroundPipes(cfg, state, rng, now, kart, deltaTime) {
    const pipes = state.pipes;
    if (!pipes.length) return false;

    const reach = cfg.hitboxes.kartVsPipe;
    const sight = kart.sight;

    // Le tuyau vise reste tant qu'il n'est pas franchi. Le lacher des que la
    // hitbox est degagee, c'est relacher le kart en plein travers.
    let dist = 0;
    if (kart.pipeTargetIndex >= 0) {
        const held = pipes[kart.pipeTargetIndex];
        dist = held ? getShortestDistance(cfg, held.worldX, kart.worldX) : 0;
        if (!held || dist < -reach.x || dist > cfg.vision.range.front) {
            kart.pipeTargetIndex = -1;
        }
    }

    // Temps restant avant le tuyau : c'est lui qui dit jusqu'ou le kart peut se
    // deplacer d'ici la, donc quels couloirs comptent.
    //
    // Jamais moins que d'ici la prochaine reprise : le tuyau vise etant tenu
    // jusqu'a etre derriere, ce temps tend vers zero en fin de depassement, et le
    // kart se replacait sur sa ligne au moment ou il aurait du viser le tuyau
    // SUIVANT.
    const horizon = ms => Math.max(ms, cfg.vision.reviewIntervalMs);
    if (kart.pipeTargetIndex < 0) {
        // Le plus proche DEVANT, aligne ou non : on se place pour un tuyau avant
        // d'etre dans son axe, sinon on ne slalome pas, on rebondit.
        if (sight.pipeAheadIndex < 0) return false;

        kart.pipeTargetIndex = sight.pipeAheadIndex;
        dist = sight.pipeAheadDist;
        kart.pipeLaneY = choosePipeLane(cfg, kart, rng,
            horizon((dist / Math.max(kart.absoluteVelocity, 1)) * 1000), null);
        kart.pipeReviewAt = now + reviewDelay(cfg, rng);

    } else if (now >= kart.pipeReviewAt) {
        // LA REPRISE. Le couloir etait choisi une fois pour toutes, a la seconde
        // ou le tuyau entrait dans la vue — au moment ou le kart en savait le
        // moins.
        //
        // Il le reprend maintenant a cadence irreguliere : le couloir se corrige
        // quand quelqu'un vient s'y mettre, et s'affine a mesure qu'on approche.
        // La cadence etant tiree au sort, deux karts ne reprennent pas leur ligne
        // au meme instant — c'est ce qui casse le peloton en file indienne.
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

    // `originalLaneY` suit le couloir et non la ligne d'avant la manoeuvre :
    // c'est lui que le retour au calme rejoint, et le laisser en arriere y
    // ramenerait le kart, c'est-a-dire dans le tuyau. Pose AVANT le desengagement
    // ci-dessous.
    kart.originalLaneY = kart.pipeLaneY;

    // Rien a corriger : sa ligne EST le meilleur couloir. Il rend la main plutot
    // que de monopoliser le pilotage — sur un circuit charge un tuyau est presque
    // toujours quelque part devant, et s'accrocher ici priverait le kart de ses
    // boites et de ses depassements. C'est ce qui rend l'engagement precoce
    // gratuit.
    if (need <= lane.tolerance) return false;

    kart.aiState = 'pipe';

    // Le contournement ne freine plus. Il y avait ici un coup de frein arme quand
    // la ligne du moment paraissait condamnee et le couloir vise hors d'atteinte
    // — mais les deux conditions etaient vraies presque tout le temps, pour des
    // raisons corrigees depuis (la dette de deplacement dans `laneRisk`, et
    // `steering.pipe.gain`).
    //
    // Ce qui restait ne gagnait plus rien : au banc, avec ou sans, les tuyaux
    // touches valent 0.06 par tour. Le frein existe toujours la ou il travaille —
    // acculer au bord, et poursuivre un objet traine.
    steer(cfg, kart, deltaTime, kart.pipeLaneY, lane.speed, lane);
    return true;
}

export {
    advanceProjectile,
    collideKartWithPipes,
    steerAroundPipes,
};
