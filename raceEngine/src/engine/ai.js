// Le pilote. Une seule fonction, et c'est elle qui arbitre.
// Tout le reste du moteur lui fournit des elements — ce qu'il voit, ce qu'il
// peut, ce qu'il porte ; `updateAI` decide de l'ordre dans lequel ca compte.

import { randomRange } from './math.js';
import { steer, steerSettle } from './driving.js';
import { billAimDepth, getShotDirection, isAiming } from './weapons.js';
import { pipeOutranksPlan, updatePlan } from './plans.js';
import { perceive, updateGlance, updateShield } from './vision.js';
import { steerAroundPipes } from './pipes.js';

// Le pilotage d'un kart pour un pas de temps. Il ne regarde pas le monde mais ce
// que le kart en a vu : toute la perception est dans `perceive`, et ce qui reste
// ici est la decision — un ordre de priorite, une fois la menace designee.
function updateAI(cfg, state, rng, now, kart, deltaTime) {
    if (kart.state !== 'running') return;

    const ai = cfg.ai;
    const vis = cfg.vision;

    // Un bill ne se pilote pas : il rejoint le milieu de la piste et n'en bouge
    // plus. Un tuyau fait exception — il ne l'arreterait pas, mais un projectile
    // qui laboure le decor en ligne droite n'a rien d'un vol. Juste assez de
    // pilotage pour le contourner, et rien de plus.
    if (kart.isBill) {
        steer(cfg, kart, deltaTime, billAimDepth(cfg, state, kart),
            cfg.bill.centerSpeed, cfg.ai.steering.bill);
        return;
    }

    const sight = kart.sight;

    // L'attention d'abord : c'est elle qui decide de ce que le balayage verra.
    // Puis le balayage, amorti (`vision.scanIntervalMs`).
    updateGlance(cfg, rng, state, now, kart);
    if (now - sight.at >= vis.scanIntervalMs) perceive(cfg, state, rng, now, kart);

    updatePlan(cfg, rng, now, kart);
    updateShield(cfg, rng, now, kart);

    // L'esquive passe avant tout le reste, MAIS JAMAIS DEVANT UN TUYAU. C'est le
    // seul veto du pilotage : `pipeOutranksPlan` ne compare pas deux prix, il
    // verifie que la ligne commandee sort bel et bien du mur dans le temps qui
    // reste.
    //
    // Ceder ne ferme pas le plan, il le suspend — les deux cibles etant
    // memorisees, une bascule ne coute aucune decision. Et ceder ne revient pas a
    // encaisser la carapace : le couloir de tuyau se choisit sur la meme vue, ou
    // l'objet qui rattrape est un span comme un autre.
    //
    // La table de cout garde son role ailleurs — designer LA menace dans
    // `perceive`. Ce qu'elle n'a plus, c'est le droit de mettre un tarif sur un
    // mur.
    const plan = kart.plan;
    if (plan.threatId && plan.kind === 'spin' && !plan.idle
        && !pipeOutranksPlan(cfg, kart)) {
        kart.aiState = 'dodging';

        // Le frein n'accompagne que les esquives qui ne sont pas franches :
        // accule il n'a plus que lui, en traversee il recule l'impact le temps de
        // passer devant l'objet.
        if (plan.stuck || plan.crossing) {
            kart.brakeUntil = now + ai.edgeBrakeMs;
            kart.brakeFactor = ai.edgeBrakeFactor;
        }

        steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.dodge);
        return;
    }

    // Le tuyau passe avant la visee, le depassement et la maraude : c'est le seul
    // obstacle certain de la piste, les autres ne sont que des occasions.
    if (steerAroundPipes(cfg, state, rng, now, kart, deltaTime)) return;

    // La precaution vient apres le tuyau — un mur est certain quand une ligne de
    // tir n'est qu'une possibilite — et avant les manoeuvres de confort.
    //
    // `giveWay` passe meme sans rien a braquer : son geste principal est de LEVER
    // LE PIED. Une precaution qui n'a nulle part ou aller rend le volant plutot
    // que de figer le kart.
    if (plan.threatId
        && (plan.kind === 'giveWay' || (plan.kind === 'safety' && !plan.idle))) {
        kart.aiState = plan.kind;

        // Se ranger ne suffit pas a laisser passer : sans lever le pied, celui
        // qui suit ne double jamais et le kart reste devant sa rouge, range pour
        // rien. Seul frein qui serve une intention plutot qu'une urgence, d'ou sa
        // douceur.
        if (plan.kind === 'giveWay') {
            kart.brakeUntil = now + vis.giveWay.brakeMs;
            kart.brakeFactor = vis.giveWay.brakeFactor;
        }

        steer(cfg, kart, deltaTime, plan.laneY, plan.intensity, ai.steering.safety);
        return;
    }

    // Visee, dans le sens de tir choisi a la reception. Apres l'esquive, avant le
    // depassement.
    //
    // Viser n'est pas percevoir : le kart sait ou est sa cible parce qu'il l'a
    // choisie. Sauf vers l'arriere — se retourner pour tirer dans le peloton est
    // un geste, et c'est le seul endroit ou la visee emprunte a la vue. Sans
    // cette condition, le tireur se recalait parfaitement sur une cible qu'il ne
    // regardait pas.
    //
    // Il faut avoir REGARDE, pas regarder pendant : exiger le regard sur toute la
    // visee laissait le tireur aveugle du debut a la fin, et le banc l'a dit sans
    // ambiguite. Le tir part a l'heure dite s'il n'a jamais trouve son moment.
    const aimDir = isAiming(cfg, kart) ? getShotDirection(state, kart) : 0;
    const aiming = aimDir !== 0 && now > kart.throwTime - ai.aimLeadMs;

    // LE RELEVE. Pendant le coup d'oeil il ne vise pas, il regarde ou est l'autre
    // : ce qu'il en retient est une profondeur et une date. De cette peremption
    // nait la chance du poursuivant, et elle ne coute aucun tirage — celui qui
    // bouge apres avoir ete releve se fait manquer.
    if (aiming && aimDir < 0 && sight.back && sight.scanBack && sight.seenKartDist >= 0) {
        kart.aimTargetY = sight.seenKartY;
        kart.aimTargetAt = now;
    }

    // On ne vise qu'en regardant devant. Derriere, on releve.
    if (aiming && !sight.back) {
        let targetY = null;

        if (aimDir > 0) {
            // Devant, il voit sa cible — mais il ne vise que ce que LA VUE lui
            // donne. C'etait le dernier endroit du pilotage a lire le monde
            // directement, sans occlusion ni portee de regard : un kart cache
            // derriere un autre s'y faisait prendre pour cible, alors que la meme
            // visee arriere l'interdisait.
            //
            // Meme exigence qu'au releve : le balayage doit avoir regarde du bon
            // cote.
            if (!sight.scanBack && sight.seenKartDist >= 0) targetY = sight.seenKartY;
        } else if (now - kart.aimTargetAt <= vis.aimMemoryMs) {
            targetY = kart.aimTargetY;
        }

        // Sans releve valable, il tire a l'aveugle : depuis sa ligne, a l'heure
        // dite.
        if (targetY !== null) {
            const margin = cfg.road.edgeSafetyMargin;
            const desired = Math.min(cfg.road.maxY - margin,
                                     Math.max(cfg.road.minY + margin, targetY + kart.aimError));
            const diff = desired - kart.yPercent;

            // La visee passe par la meme loi que le reste. Elle ne depasse plus
            // sa cible — elle coupait sa consigne a l'alignement et derivait
            // encore de la course restante — et son approche est proportionnelle,
            // la ou l'ancien terme saturait des le premier dixieme d'unite.
            const aim = ai.steering.aim;
            if (Math.abs(diff) > aim.tolerance) {
                kart.aiState = 'aiming';
                steer(cfg, kart, deltaTime, desired, aim.speed, aim);
                return;
            }
        }
    }

    // Depassement : le kart le plus proche qui bouche vraiment la voie. Il sort
    // de la vue comme le reste, donc un kart qui regarde derriere n'en prepare
    // pas.
    if (sight.aheadKartDist >= 0) {
        let dir = (kart.yPercent > sight.aheadKartY) ? 1 : -1;
        if (kart.yPercent > cfg.road.maxY - cfg.road.overtakeMargin) dir = -1;
        if (kart.yPercent < cfg.road.minY + cfg.road.overtakeMargin) dir = 1;

        // Sortir de SA voie, et s'arreter la. C'est deja ce que la poussee
        // d'avant obtenait, sans jamais le dire ; le viser rend la manoeuvre
        // lisible et lui donne une fin. La demi-carrosserie de jeu evite qu'elle
        // se relance a la premiere bousculade.
        const pass = ai.steering.overtake;
        const clear = ai.overtakeMinDistance + cfg.hitboxes.kartVsKart.y * 0.5;
        steer(cfg, kart, deltaTime, sight.aheadKartY + dir * clear, pass.speed, pass);
        return;
    }

    // Collecte. La boite visee est la plus proche de sa trajectoire parmi celles
    // qu'il voit libres — celle qu'un kart lui masque est une boite que ce kart
    // prendra le premier.
    if (!kart.heldItem && sight.boxDist >= 0) {
        // Deja dans l'axe : il tient sa ligne. Le laisser repartir en maraude le
        // ferait deriver hors de la boite qu'il vise.
        const grab = ai.steering.box;
        steer(cfg, kart, deltaTime, sight.boxY, grab.speed, grab);
        return;
    }

    if (now > kart.nextWanderTime) {
        kart.nextWanderTime = now + randomRange(rng, ai.wanderIntervalMin, ai.wanderIntervalMax);
        kart.wanderEndTime = now + randomRange(rng, ai.wanderDurationMin, ai.wanderDurationMax);
        // Plus de biais du danger latent ici : il a sa propre manoeuvre, decidee
        // et tenue (`placeSafety`). Le porter aussi par la maraude donnait deux
        // mecanismes pour la meme idee, dont un qui attendait le prochain tirage
        // de derive.
        let dir = (rng() > 0.5) ? 1 : -1;

        if (kart.yPercent > cfg.road.maxY - cfg.road.wanderMargin) dir = -1;
        if (kart.yPercent < cfg.road.minY + cfg.road.wanderMargin) dir = 1;

        // Un ECART a rejoindre, et non une vitesse a tenir : la derive emmenait
        // les karts maniables trois fois plus loin que les lourds sans que rien
        // ne le demande. Tout le monde vise le meme decalage, seul le temps d'y
        // arriver change.
        //
        // Vise dans la piste et non au-dela : viser dehors revient a demander au
        // kart de se plaquer contre le mur pour rien.
        kart.wanderY = Math.min(cfg.road.maxY - cfg.road.wanderMargin,
            Math.max(cfg.road.minY + cfg.road.wanderMargin,
                     kart.yPercent + dir * ai.wanderOffset));
    }

    if (now < kart.wanderEndTime) {
        const drift = ai.steering.wander;
        steer(cfg, kart, deltaTime, kart.wanderY, drift.speed, drift);
        return;
    }

    // La croisiere ne vise rien : elle laisse le volant revenir a zero. Dit dans
    // la langue du systeme, c'est viser l'endroit ou l'on va s'arreter.
    //
    // ET IL N'Y A RIEN APRES : aucun retour a la ligne d'avant l'ecart. La piste
    // est une bande qui defile, `yPercent` en est la PROFONDEUR et non une
    // trajectoire — pas de virage, pas de corde, et la seule profondeur que la
    // physique fasse payer est le mur lui-meme (`clampKartToRoad`). Une esquive
    // finie ne laisse donc le kart nulle part de mauvais : elle le laisse la ou
    // le placement venait de le juger le moins cher.
    //
    // Ce qui vivait ici visait une profondeur MEMORISEE au lieu de la note, seul
    // endroit du pilotage a le faire. Quatre manoeuvres reecrivaient ce souvenir
    // a chaque image sans jamais le lire — l'effacement etait devenu le vrai
    // comportement — et ce qui en restait ramenait le kart vers une place que
    // personne n'avait revue depuis.
    const cruise = ai.steering.cruise;
    kart.aiState = 'cruising';
    steer(cfg, kart, deltaTime, steerSettle(cfg, kart), 0, cruise);
}

export {
    updateAI,
};
