// La voie et le volant : choisir une profondeur, puis y aller.
// `steering.js` dit ce que le kart peut faire ; ce fichier dit ce qu'il fait.
// Les tableaux de candidates sont des tampons reutilises d'un appel a l'autre —
// le moteur tourne trente fois par seconde et n'alloue rien dans sa boucle.

import { steerCap, steerDelay, steerReach } from './steering.js';

// Ou se placer. Une seule question, posee une seule fois : A QUELLE PROFONDEUR
// VAUT-IL MIEUX ETRE ? La reponse est une note en millisecondes, meme monnaie que
// `vision.cost`.
//
//     note = ce qu'on RISQUE en y etant  +  ce que coute d'Y ALLER
//
// UN SEUL CORPS EST UN MUR : le tuyau, de masse infinie. Tout le reste se
// franchit contre son prix, et l'ordre des prix dit le reste :
//
//     tuyau        infranchissable de pres, puis preference qui s'efface
//     objet        2000 ms de tete-a-queue
//     carrosserie   300 ms de bousculade, et elle peut s'ecarter seule
//     bord           200 ms de frottement, et il ne ferme rien
//
// Les marges de confort ne refusent rien : les entamer COUTE, en proportion.
// C'est ce qui rend un passage serre jouable — cher, mais jouable — quand il est
// le moins cher de la piste. Les deux chercheurs de couloir d'avant repondaient
// par oui ou par non, et le plus large gagnait donc toujours.
//
// Aucune notion de manoeuvre ici : le placement ne sait pas s'il sert une
// esquive, un contournement ou une visee. Ce sont la vue, le temps disponible et
// le volant qui portent la difference.

// Poids d'un obstacle selon sa distance. Plein dans sa portee.
//
// Au-dela, seul un MUR compte encore, et sa preference s'efface jusqu'a la limite
// du regard : c'est ce qui enfile une sequence de tuyaux sans avoir a les
// parcourir un par un. Ce qui bouge garde sa portee propre et tombe a zero
// au-dela — il aura change de place avant qu'on y arrive.
//
// Une rampe faisait ce travail entre `s.reach` et `vision.range.front`, mais les
// deux bornes valent 1100 : elle s'etalait sur une fenetre nulle et tout tuyau
// visible pesait 1. Un kart deja bien place se voyait refuser son couloir a cause
// d'un tuyau situe deux secondes plus loin. Ce n'est pas la preference d'un mur
// lointain qu'il faut effacer, c'est le fait qu'on ait le temps d'en sortir — et
// ca se mesure (`s.spare`, et la dette dans `laneRisk`).
function spanWeight(cfg, s) {
    const d = s.dx < 0 ? -s.dx : s.dx;
    return (d <= s.reach) ? 1 : 0;
}

// La place qu'un kart doit se garder EN PLUS de sa hitbox, parce qu'il ne tient
// pas sa ligne au centimetre. Sans elle, la note jugeait les huit karts capables
// de se poser au dixieme d'unite : le passage n'etait pas trop petit, c'est le
// kart qui etait trop imprecis pour lui.
//
// Deux termes, tires du volant et non d'une stat de plus :
//
//   tolerance   la bande morte du braquage — en deca, `steer` coupe la
//               consigne, donc le plancher de son imprecision.
//   slop / cap  ce qu'il derive avant de rattraper, inversement
//               proportionnel a son volant.
//
// En croisiere : ~0.8 pour koopa, ~1.6 pour bowser. Un couloir de 3.1 unites
// passe donc pour l'un et pas pour l'autre.
function laneSlop(cfg, kart, cap, spec) {
    return spec.tolerance + cfg.vision.place.slop / Math.max(cap, 1);
}

// Ce que coute d'ETRE a la profondeur `y`, en millisecondes ; `Infinity` quand le
// kart ne peut physiquement pas y etre. `slop` gonfle chaque corps de son
// imprecision : viser le ras d'une hitbox n'a de sens que si l'on sait s'y tenir.
//
// Elle ne lit que `kart.sight`, et c'est le point du systeme : ce qui n'a pas ete
// vu ne coute rien. Un kart aveugle par celui qui le precede se place au milieu
// de ce qu'il ne voit pas.
//
// `LANE_EPS` separe « pile sur la limite » de « dedans ». Purement numerique :
// les candidats sont construits par addition depuis les bornes qu'ils longent.
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

        // Les murs d'APRES celui du moment. `laneRisk` cherche UNE profondeur et
        // la juge contre tout ce qui est vu — ce qui n'a de sens que pour le mur
        // qu'on aborde. Exiger un couloir qui traverse toute la sequence d'un
        // trait n'en laisse souvent aucun, et jette le kart dans le contournement
        // le plus large alors qu'il etait deja bien place pour le suivant.
        //
        // Un tel mur ne coute donc pas un choc mais une DETTE : le deplacement
        // qu'il faudra faire plus tard pour en sortir, chiffre dans la meme
        // monnaie. Le refus ne reste que pour ce qui est hors d'atteinte meme en
        // s'y prenant tout de suite.
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

        // Ecart a la limite DURE, negatif quand on est dedans. Zero pile sur la
        // limite : les hitboxes sont des `>=`, donc la frontiere elle-meme ne
        // touche pas — c'est la que passe un couloir serre.
        //
        // La tolerance est INDISPENSABLE : `laneCandidates` propose exactement
        // `s.hi + slop`, et le calcul rend alors un ecart de l'ordre de 1e-16, de
        // signe imprevisible. Le candidat ecrit pour rendre un couloir serre
        // choisissable valait donc 850 ou l'infini selon l'arrondi.
        const gap = ((y <= s.lo) ? s.lo - y : (y >= s.hi) ? y - s.hi : -1) - slop;

        if (gap < -LANE_EPS) {
            if (s.hard && w >= 1) return Infinity;
            risk += s.cost * w;
            continue;
        }

        // Le confort entame, et seulement lui : la limite dure est deja passee
        // au-dessus. Entamer tout le confort vaut `place.graze` du contact et non
        // le contact plein — sinon un frolement se note au prix d'un choc, et le
        // grand contournement gagne toujours.
        const clear = (gap > 0) ? gap : 0;
        if (clear < s.margin) {
            risk += s.cost * w * cfg.vision.place.graze * (1 - clear / s.margin);
        }
    }

    // L'ENCOMBREMENT : ce que coute un passage DEJA PRIS. Ce n'est pas un risque
    // de choc — les carrosseries proches ont leur span pour ca — c'est une file :
    // on y arrive derriere quelqu'un, on n'y double pas, on s'y fait bousculer.
    //
    // Sans ce terme, chaque passage etait juge comme si le kart etait seul en
    // piste : au banc, 44 % des couloirs retenus contenaient deja deux karts ou
    // plus. Il se cumule, donc la note monte avec la foule sans qu'aucun seuil ne
    // soit ecrit.
    //
    // La bande n'est pas un reglage de plus : c'est la hitbox entre karts plus
    // leur marge de confort.
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

    // Le bord ne ferme rien — on roule dessus — il coute de la vitesse par
    // frottement. Le moins cher des quatre, et c'est ce qui rend jouable la
    // banane posee pres du bord : longer le mur vaut mieux que la prendre.
    const edge = Math.min(y - road.minY, road.maxY - y);
    const width = road.edgeSafetyMargin;
    if (edge < width) risk += cfg.vision.cost.edge * (1 - edge / width);

    // La boite : seul terme NEGATIF de la note, une occasion et non un risque.
    //
    // Elle avait sa propre manoeuvre, placee apres le contournement de tuyau —
    // donc jamais atteinte des lors qu'un tuyau etait quelque part devant. Une
    // occasion ne se classe pas avant ou apres un mur, elle se PESE contre lui :
    // le kart la prend quand elle est sur son chemin, la laisse s'il faut
    // traverser devant un tuyau ou une carapace, et l'accepte au prix d'un
    // frottement de bord.
    const box = kart.sight;
    if (box.boxDist >= 0) {
        const off = Math.abs(y - box.boxY);
        const grab = cfg.hitboxes.itemBox.y;
        if (off < grab) risk -= cfg.vision.place.boxBonus * (1 - off / grab);
    }

    return risk;
}

// La note d'un candidat. Le risque est mesure la ou le kart SERA vraiment, pas la
// ou il vise : une profondeur hors de portee est ramenee au plus loin qu'il
// puisse couvrir. Le detour, lui, se paie sur l'intention — sans risque nulle
// part, la note la plus basse est celle de sa propre ligne.
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

// Les profondeurs qui valent d'etre examinees : ni tirees au hasard ni
// echantillonnees, ce sont les seuls endroits ou la note peut avoir un minimum.
// Sa propre ligne, les deux bords, et pour chaque obstacle vu les quatre points
// qui le bordent — au ras de sa hitbox, et au confort.
//
// Le ras et le confort sont deux options distinctes ET C'EST LE POINT : le
// confort est gratuit en risque mais loin, le ras est proche mais coute. Un
// couloir etroit n'offre que le ras, et il reste choisissable.
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

// Ou se placer. Rend la profondeur retenue, ou `null` s'il n'existe aucun endroit
// tenable — au kart de freiner, il n'y a plus que ca a faire.
//
// Le meilleur choix n'est pas toujours celui qui est pris : le kart descend le
// classement et s'arrete a chaque marche avec une chance de `place.chance`. Une
// erreur reste une option qui existait, jamais une absurdite. A 1 le kart est
// parfait, c'est l'interrupteur du banc.
function chooseLane(cfg, rng, kart, cap, ttc, spec) {
    const place = cfg.vision.place;
    const settle = steerSettle(cfg, kart);
    const reach = steerReach(cfg, cap, ttc);

    // Trois passes, et les deux dernieres ne servent qu'a NE JAMAIS SE FIGER.
    // Chacune leve une exigence, dans l'ordre du moins couteux :
    //
    //   1. le kart tel qu'il est, imprecision comprise, dans le temps qu'il a.
    //   2. sans son imprecision : mieux vaut tenter un passage serre que rien.
    //   3. sans limite de temps : aller VERS le bon couloir reste meilleur que
    //      tenir une ligne qui finit dans le decor.
    //
    // La troisieme manquait, et c'est ce qui produisait le pire defaut visible :
    // sorti d'un tuyau, le kart n'avait pour horizon que le temps restant avant
    // CE tuyau-la, tous les candidats valaient l'infini, et il fonçait droit dans
    // le suivant sans esquisser un mouvement.
    //
    // Regle generale : la portee, la precision et le temps CLASSENT les passages,
    // ils n'en suppriment aucun.
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
// Les egalites sont LE cas normal : un tuyau dans l'axe avec de la place des deux
// cotes rend deux couloirs a la meme note, au bit pres. Departagees par un `<`
// strict, c'est l'ordre de construction qui tranchait — et `laneCandidates` pose
// toujours le cote `lo` avant le cote `hi` : le kart passait EN DESSOUS huit fois
// sur dix, sur tous les tuyaux et pour les huit personnages. Le tirage uniforme
// (Vitter) leur donne une chance chacune.
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
// tout ce que le kart VOIT pose devant lui la borne de la meme facon.
//
// Elle ne regarde pas le monde mais `kart.sight` : ce qui n'a pas ete vu ne ferme
// rien, et un kart aveugle par celui qui le precede se decale vers ce qu'il ne
// voit pas.
function sideRoom(cfg, kart, dir) {
    const margin = cfg.road.edgeSafetyMargin;
    let limit = (dir > 0) ? (cfg.road.maxY - margin) : (cfg.road.minY + margin);

    const sight = kart.sight;
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        if (s.dx > s.reach || s.dx < -s.reach) continue;

        // Face tournee vers le kart. Elle ne ferme le cote que si elle est
        // vraiment de ce cote-la : un obstacle deja chevauche est derriere sa
        // propre face, et refermer sur lui rendrait une place negative.
        //
        // La face de CONFORT et non la limite dure : c'est un garde-fou, son
        // travail est de refuser large. Le placement, lui, note les deux
        // separement.
        const face = (dir > 0) ? (s.lo - s.margin) : (s.hi + s.margin);
        if (dir > 0 ? (face > kart.yPercent && face < limit)
                    : (face < kart.yPercent && face > limit)) {
            limit = face;
        }
    }

    return Math.max(0, dir * (limit - kart.yPercent));
}

// Ou le kart s'arreterait s'il relachait tout : sa position, plus la course que
// le volant a encore a rendre. C'est la reference de `steer`, et la cible d'une
// manoeuvre qui ne veut rien commander.
function steerSettle(cfg, kart) {
    return kart.yPercent + kart.vy / cfg.physics.steer.response;
}

// LA fonction de braquage : rejoindre une profondeur visee, et la tenir.
//
// Toutes les manoeuvres passent par la, sans exception. Elles ne different que
// par leur PROFIL (`ai.steering`) et par la profondeur visee — une seule loi, un
// seul ecrivain, huit reglages.
//
//   `laneY`  la profondeur a rejoindre. C'est la SITUATION qui la donne,
//            donc elle ne depend pas du personnage.
//   `speed`  l'urgence, avant mise a l'echelle du kart. Portee par le profil,
//            sauf pour l'esquive et la precaution qui la tirent de leur plan.
//   `spec`   `{ gain, tolerance, guard }`, cf. `ai.steering`.
//
// Le kart compare la cible a l'endroit ou il s'ARRETERAIT, non a celui ou il est
// : le volant a 200 ms d'inertie, et une consigne proportionnelle au seul ecart
// courant depasse d'environ deux unites et demie — de quoi ressortir par l'autre
// bord d'un passage de six. Retrancher la course restante rend la reponse
// aperiodique, sans ralentir la manoeuvre.
//
// `guard` refuse d'envoyer le kart dans ce qu'il avait sous les yeux, avec pour
// seuil la course restante et non zero. L'esquive, le contournement et la
// precaution ne l'ont pas : eux traversent sciemment, apres avoir juge la place
// par `chooseLane`.
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
        // `sight.spans` ne decrit que le cote que le dernier balayage regardait :
        // sur un balayage arriere, la piste devant y est VIDE — non pas degagee,
        // jamais consultee — et le garde-fou laissait alors passer n'importe
        // quelle consigne. Il refuse plutot que d'inventer, et le kart tient sa
        // ligne le temps du coup d'oeil.
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

export {
    chooseLane,
    laneScore,
    laneSlop,
    laneY,
    sideRoom,
    steer,
    steerSettle,
};
