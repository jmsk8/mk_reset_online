// Le plan de course d'un kart : la profondeur qu'il vise, et pourquoi.
// Un plan survit a plusieurs images — c'est ce qui distingue un pilote d'un
// reflexe. Sa revision est cadencee, jamais continue.

import { randomRange } from './math.js';
import { steerCap, steerReach } from './steering.js';
import { chooseLane, laneSlop, sideRoom, steerSettle } from './driving.js';
import { isTrailable } from './weapons.js';

// Le plan. Une decision prise ne se defait pas parce que le regard s'est porte
// ailleurs : l'esquive etait recalculee de zero a chaque image, si bien qu'un
// objet sorti de la fenetre une seule image — ce qui arrive PARCE QUE le kart est
// en train de l'esquiver — relachait la manoeuvre.
//
// Une absence d'observation ne prouve rien. Seule une echeance, ou une menace VUE
// disparue, ferme un plan.

// Ou passer, et de quel cote. Appele a la decision, puis a chaque revision.
//
// Il vise une POSITION et non une direction : pousser d'un cote a intensite
// constante, apres avoir jauge la place sans compter les carrosseries, faisait
// plonger un kart sous une carapace pour se planter dans son voisin.
//
// Le delai avant la reprise est TIRE AU SORT, et c'est le remede a la monotonie :
// a cadence fixe, huit karts qui voient la meme piste rejouent la meme decision
// au meme instant.
function reviewDelay(cfg, rng) {
    const vis = cfg.vision;
    return vis.reviewIntervalMs
        * randomRange(rng, vis.reviewJitterMin, vis.reviewJitterMax);
}

function placePlan(cfg, rng, kart, plan, ttc) {
    // Toute la marge d'erreur d'appreciation tient ici : le kart se croit un peu
    // plus vif, ou un peu moins, qu'il ne l'est. Applique au volant plutot qu'a
    // une distance limite, `crossJudgeError` se propage tout seul aux deux choses
    // qui en dependent — la portee, et le detour.
    const err = cfg.ai.crossJudgeError;
    const cap = steerCap(cfg, kart, plan.intensity)
        * randomRange(rng, 1 - err, 1 + err);

    const lane = chooseLane(cfg, rng, kart, cap, ttc, cfg.ai.steering.dodge);

    // Vraiment nulle part ou aller : tout ce qu'il peut atteindre est un mur. Il
    // ne reste que le frein, et la place qu'il grappillera.
    plan.stuck = lane === null;

    // Tout se mesure depuis le POINT D'ARRET — la ou le kart finirait s'il
    // relachait le volant — et non depuis sa position. C'est la reference du
    // braquage.
    const settle = steerSettle(cfg, kart);

    plan.laneY = (lane === null) ? settle : lane;
    plan.dir = (plan.laneY > settle) ? 1 : (plan.laneY < settle) ? -1 : 0;

    // Rien a commander : le kart est deja la ou il veut etre. Le plan reste en
    // place mais rend la main au reste du pilotage ; sans ca, un kart tire
    // d'affaire se figeait le temps que sa propre esquive expire, tuyau compris.
    //
    // Le seuil est celui du braquage lui-meme : le placement rend une profondeur
    // exacte qui ne retombe jamais pile sur le point d'arret, et tester l'egalite
    // laisserait l'esquive commander une consigne que `steer` juge deja tenue.
    plan.idle = !plan.stuck
        && Math.abs(plan.laneY - settle) <= cfg.ai.steering.dodge.tolerance;

    // Traverser, c'est passer DEVANT l'objet au lieu de s'en ecarter : ca coute
    // l'ecart entier et ne se rattrape pas, d'ou le frein qui accompagne.
    const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
    plan.crossing = plan.dir !== 0 && plan.dir !== natural;

    // Un plan arrete sur un balayage arriere n'a pas vu le trafic devant : il a
    // choisi son cote sur le seul decor. Il est marque, et le premier balayage de
    // face le reprend d'office. C'est le SENS DU BALAYAGE qui compte, jamais
    // l'attention du moment — les deux se decalent jusqu'a `scanIntervalMs`.
    plan.coarse = kart.sight.scanBack;
}

// Le decalage de securite : quitter la ligne de celui qui porte l'objet.
//
// Il ne passe pas par `chooseLane`, et c'est delibere : celui-ci cherche le
// meilleur ENDROIT, or la ligne a quitter n'est pas un endroit — rien ne barre la
// piste. La question est plus simple : de quel cote ai-je la place, et combien
// faut-il pour que l'objet me manque.
//
// Le cote naturel gagne quand il s'ouvre : on s'ecarte du danger, on ne le
// contourne pas.
function placeSafety(cfg, kart, plan) {
    const clear = cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item;
    const lo = cfg.road.minY + cfg.road.edgeSafetyMargin;
    const hi = cfg.road.maxY - cfg.road.edgeSafetyMargin;

    // Le jeu au-dela du degagement strict n'est pas decoratif : vise pile a la
    // limite d'alignement, le kart s'y arrete, et la premiere derive de maraude
    // l'y ramene — ce qui redeclenche la meme decision, indefiniment.
    const slack = clear + cfg.hitboxes.kartVsKart.y * 0.5;

    const natural = (plan.threatY > kart.yPercent) ? -1 : 1;
    const need = clear - Math.abs(kart.yPercent - plan.threatY);

    const roomNatural = sideRoom(cfg, kart, natural);
    const roomOther = sideRoom(cfg, kart, -natural);
    const dir = (roomNatural >= need || roomNatural >= roomOther)
        ? natural : -natural;

    plan.dir = dir;

    // Et on ne se range QUE JUSQU'OU IL Y A LA PLACE. `sideRoom` servait a
    // choisir le cote et lui seul ; la profondeur visee n'etait bornee que par
    // les bords, si bien qu'un kart pouvait retenir le cote le moins encombre
    // puis viser au travers du tuyau qui bornait justement ce cote-la.
    //
    // La borne est celle du garde-fou : la face de CONFORT du premier corps vu de
    // ce cote. Elle ne marchande pas comme `laneRisk` — une precaution n'a aucune
    // raison de payer un obstacle pour eviter une menace que personne n'a encore
    // lancee.
    const room = (dir === natural) ? roomNatural : roomOther;
    const want = Math.min(hi, Math.max(lo, plan.threatY + dir * slack));
    const edge = kart.yPercent + dir * room;
    plan.laneY = (dir > 0) ? Math.min(want, edge) : Math.max(want, edge);

    // Une precaution ne freine pas et ne se declare jamais acculee : au pire elle
    // ne sert a rien, et le kart continue sa course.
    plan.stuck = false;
    plan.crossing = false;

    // Rien a commander — nulle part ou aller, ou deja arrive. Le drapeau existait
    // mais etait force a faux, la manoeuvre visant toujours quelque chose ;
    // maintenant que la place la borne, elle peut n'avoir rien a dire, et un kart
    // coince contre un tuyau ne reste plus fige en « se range » pendant deux
    // secondes.
    plan.idle = Math.abs(plan.laneY - steerSettle(cfg, kart))
        <= cfg.ai.steering.safety.tolerance;
    plan.coarse = kart.sight.scanBack;
}

function updatePlan(cfg, rng, now, kart) {
    const vis = cfg.vision;
    const sight = kart.sight;
    const plan = kart.plan;

    // La menace toujours en vue repousse l'echeance : le plan tient tant qu'elle
    // converge encore. Sans ca, un plan pose sur une ESTIMATION du temps avant
    // impact expirait avant l'impact reel, et le kart revenait sur sa ligne juste
    // a temps pour sy faire cueillir.
    if (plan.threatId && sight.threatId === plan.threatId
        && sight.threatTtc !== Infinity) {
        plan.until = now + sight.threatTtc + vis.holdAfterMs;
    }

    // Et la meme regle pour la PRECAUTION, qui n'avait qu'une duree fixe : le
    // kart quittait la ligne d'un porteur deux secondes puis y revenait alors que
    // l'autre etait toujours la, toujours arme, toujours dans l'axe.
    //
    // La decision ne se rejoue pas, elle se PROLONGE tant que le danger est
    // percu. Et elle retombe seule : se decaler rompt l'alignement, qui est la
    // condition meme du danger latent.
    if (plan.kind === 'safety' && sight.pressure
        && sight.pressureId === plan.threatId) {
        plan.until = now + vis.safety.holdMs;
    }

    if (plan.threatId && (now >= plan.until || sight.planGone)) {
        plan.threatId = 0;
        plan.kind = '';
        plan.until = 0;
        plan.idle = false;
    }

    // Une menace plus urgente prend la main ; la meme ne rejoue rien. La NATURE
    // compte autant que l'identite : un kart qu'on evitait par precaution — il
    // portait une banane — et qui ramasse une etoile garde le meme identifiant
    // tout en devenant mortel.
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

    // LAISSER PASSER. Une rouge suit : se decaler n'y change rien, elle se recale
    // huit fois plus vite qu'un kart ne se deplace. Sans rien dans les mains, la
    // seule parade est de cesser d'etre la cible — une rouge vise devant elle, se
    // faire doubler c'est sortir de sa liste.
    //
    // S'il y en a DEUX derriere, le calcul s'inverse : on change de tireur, pas
    // de sort. Passe AVANT la precaution, qui se range hors d'une ligne de tir —
    // ce qui ne veut rien dire face a un objet qui suit.
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

    // La decision de securite, prise faute de mieux a faire : un danger reel
    // occupe deja le plan.
    //
    // Elle a sa CHANCE de ne pas etre prise, et c'est le coeur du reglage —
    // s'ecarter a tous les coups rendrait le jeu d'objets inoffensif, ne jamais
    // le faire laisserait les karts colles derriere une verte.
    //
    // Une echeance PAR COTE, et il en fallait deux : un seul compteur faisait que
    // les deux formes du danger latent se volaient leurs tirages.
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

    // Le recalcul : une chance, a intervalle regulier, de reprendre le placement
    // avec la perception fraiche. Seul endroit ou la precision se joue APRES la
    // decision.
    //
    // Un plan approximatif ne tire pas et n'attend pas son tour : arrete sur un
    // balayage arriere, il est repris au PREMIER BALAYAGE DE FACE. Il faut un
    // balayage, pas un simple retour de l'attention — `sight.back` bascule a la
    // cadence de l'affichage, et la reprise se rejouait deux fois sur trois sur
    // la vue arriere qu'elle etait censee remplacer.
    const forced = plan.coarse && !sight.scanBack;

    if (!forced && now < plan.reviewAt) return;
    plan.reviewAt = now + reviewDelay(cfg, rng);
    if (!forced && rng() >= vis.reviewChance) return;

    if (plan.kind === 'safety' || plan.kind === 'giveWay') {
        // La ligne a quitter est celle d'un kart, et il bouge : la revision la
        // reprend telle qu'elle est maintenant.
        if (sight.pressure && sight.pressureId === plan.threatId) {
            plan.threatY = sight.pressureY;
        }
        if (sight.redBehindDist >= 0 && sight.redBehindId === plan.threatId) {
            plan.threatY = sight.redBehindY;
        }
        placeSafety(cfg, kart, plan);
        return;
    }

    // Meme raison, et elle manquait ici. Un objet ne derive pas en profondeur,
    // mais les menaces de CONTACT — etoile, bill — sont des karts qui manoeuvrent
    // : sur une profondeur perimee, un kart freinait pour une position que
    // l'etoile avait quittee.
    if (sight.threatId === plan.threatId) plan.threatY = sight.threatY;

    // Le temps qui reste, mais jamais moins que d'ici la prochaine reprise : a
    // zero, le kart ne pourrait plus atteindre nulle part et lacherait l'esquive
    // juste avant l'impact.
    placePlan(cfg, rng, kart, plan,
        Math.max(plan.until - now - vis.holdAfterMs, vis.reviewIntervalMs));
}

// Le tuyau vaut-il d'interrompre l'esquive en cours ?
//
// Ce n'est pas un arbitrage de couts : un tuyau ne se paie pas, il ARRETE. Le
// mettre dans la meme monnaie que le reste revenait a lui donner un tarif — une
// carapace a 800 ms l'emportait sur un mur a 500, et le kart y allait en pleine
// connaissance de cause.
//
// La question est geometrique : EN OBEISSANT A L'ESQUIVE, OU SERAI-JE AU TUYAU ?
// Dedans, le tuyau reprend le volant. A cote, l'esquive continue — et elle a le
// droit d'emmener le kart de l'autre cote du tuyau si la place est la. C'est la
// portee de braquage sur le temps restant, rien de plus.
//
// Ceder ne coute pas l'esquive : le couloir de tuyau se choisit sur la meme vue,
// ou la carapace est un span comme un autre.
function pipeOutranksPlan(cfg, kart) {
    const sight = kart.sight;
    if (sight.pipeIndex < 0) return false;

    // La limite dure du tuyau vise : la hitbox nue, sans la marge de confort — on
    // ne veto que le choc, le confort reste l'affaire du placement.
    let lo = 0;
    let hi = 0;
    let found = false;
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        if (s.pipeIndex !== sight.pipeIndex) continue;
        lo = s.lo;
        hi = s.hi;
        found = true;
        break;
    }
    if (!found) return false;

    const pipeTtc = (sight.pipeDist / Math.max(kart.absoluteVelocity, 1)) * 1000;

    // Ou l'esquive l'aura emmene d'ici la. Le point d'arret est la reference
    // du braquage, ici comme partout ailleurs.
    const plan = kart.plan;
    const settle = steerSettle(cfg, kart);
    const cap = steerCap(cfg, kart, plan.intensity);
    const reach = steerReach(cfg, cap, pipeTtc);

    const want = plan.laneY - settle;
    const at = settle
        + ((want > reach) ? reach : (want < -reach) ? -reach : want);

    // Son imprecision comprise : le placement gonfle deja chaque corps d'autant,
    // et un arbitrage plus optimiste enverrait le kart dans un couloir que le
    // placement venait de refuser.
    const slop = laneSlop(cfg, kart, cap, cfg.ai.steering.dodge);

    return at > lo - slop && at < hi + slop;
}

export {
    pipeOutranksPlan,
    reviewDelay,
    updatePlan,
};
