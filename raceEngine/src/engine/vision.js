// Ce qu'un kart VOIT, et le jugement qu'il porte dessus. Le balayage ecrit dans
// des tampons de module plutot que d'allouer : huit karts, trente fois par
// seconde. Rien ici ne pilote — la vue produit des constats, `plans.js` et
// `ai.js` decident.

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { steerCap, steerDelay, steerReach } from './steering.js';
import { isContactActive, isRamming } from './bodies.js';
import { referenceAgility } from './stats.js';
import { steerSettle } from './driving.js';
import { getShotDirection, heldThreatType, isAiming, isArmedForward, isTrailable, rankChance } from './weapons.js';

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

    // A l'arret le volant ne mord plus (`steerBite`) : le temps necessaire
    // tendrait vers l'infini et tout deviendrait une menace. D'ou le plancher.
    const cap = steerCap(cfg, kart, ai.dodgeIntensityMin);
    if (!(cap > 0)) return ai.threatWindowMs;

    const own = ai.reactionBaseMs * ai.reactionJitterMax
        + steerDelay(cfg, cap, need);
    return (own > ai.threatWindowMs) ? own : ai.threatWindowMs;
}

// La laisse en distance qui accompagne la fenetre : elle existe pour ne pas
// s'alarmer de ce qui converge de tres loin, jamais pour refuser ce que la
// fenetre vient d'accepter.
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

    // Etalonne sur l'agilite de REFERENCE et non sur celle du kart : ce tirage
    // dit s'il a VU venir la menace, et un kart maniable n'est pas plus attentif
    // qu'un autre. Pas de `steerCap` non plus — l'appui a l'allure n'a rien a
    // faire dans un tirage d'attention.
    const cap = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * referenceAgility(cfg);
    const ease = steerReach(cfg, cap, spareMs) / need;

    if (ease <= 1) return base;
    if (ease >= ai.dodgeEasyRatio) return 0;
    return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
}

// La vue : un seul balayage par kart, et tout le pilotage lit son resultat.
//
// Il produit quatre choses, et la decision ne lit rien d'autre :
//
//   - LA MENACE retenue, arbitree au cout (`vision.cost`) et non par un ordre fige
//     de manoeuvres ;
//   - LE DANGER LATENT : le porteur arme le plus proche qui partage la ligne ;
//   - L'ENCOMBREMENT de la piste en profondeur, une liste d'intervalles qui sert a
//     la fois a masquer la vue et a chercher ou passer ;
//   - LE TRAFIC ET LES OCCASIONS : le kart a doubler, la boite a prendre, la cible
//     sur laquelle se recaler pour tirer.
//
// Deux regles la gouvernent, sans autre exception que celle qui suit :
//
//   - ON NE VOIT QU'UN COTE. Regarder derriere coupe la vue de face.
//   - UN CORPS SOLIDE MASQUE : kart, bill, tuyau. Pas un objet au sol.
//
// L'exception : LE DECOR NE SE PERD PAS. Un tuyau porte une ombre mais n'en subit
// aucune, et reste vu meme quand le regard porte derriere — un pilote connait son
// circuit. Sans elle, un kart s'encastrerait dans un mur pour avoir regarde
// ailleurs.
//
// Tout passe par une entree de balayage et par la marche qui la juge : c'est ce
// qui rend les regles verifiables.

// Ce qu'une entree de balayage peut etre. Une meme entree en cumule
// plusieurs : un objet traine ferme un passage ET fait mal.
const SEE_BLOCK = 1;

const SEE_THREAT = 2;

const SEE_BOX = 4;

const SEE_PRESSURE = 8;

// Ce qui SE RAPPROCHE dans le dos, en dehors de toute fenetre d'esquive. Porte
// par `approach` et non par un bit de role : c'est la meme entree, lue plus tot.
//
// Voir venir et devoir esquiver sont deux questions differentes. `approach` dit
// qu'un danger se rapproche — de quoi rester attentif (`backChanceDanger`) et
// sortir un bouclier — quand `SEE_THREAT` dit qu'il est temps de se decaler.
// Adosse a la seule fenetre d'esquive, le releve n'etait jamais arme assez tot :
// le kart retombait a sa chance de base et ne regardait plus quand la carapace
// arrivait.
const NEAR_RAM = 2;   // une etoile, un bill : une carrosserie lancee

const NEAR_SHOT = 3;  // un objet en vol ou traine, deja lache

// Tampon de balayage, partage par tous les karts. `perceive` le remplit et le
// consomme dans le meme appel ; ce qui doit survivre est recopie dans
// `kart.sight`.
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
            redHeld: false, approach: 0
        });
    }
    const e = scanPool[scanCount++];
    e.solid = false;
    e.pierces = false;
    e.role = 0;
    e.id = 0;
    e.kartId = -1;
    e.redHeld = false;
    e.approach = 0;
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

// Tri par distance a l'oeil. Insertion et non `Array.sort` : la liste depasse
// rarement la vingtaine, et a cette taille les appels au comparateur coutent plus
// cher que les comparaisons.
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

// Les ombres, gardees telles quelles plutot que fusionnees : une quinzaine
// d'entrees, moins cher a tester qu'a tenir triees.
//
// Une ombre est un VOLUME au sol vu depuis la camera de poursuite (`vision.eye`)
// : deux pentes qui s'ecartent en s'eloignant de l'oeil, et une longueur au-dela
// de laquelle la route se revoit. Les pentes sont rapportees a l'OEIL, jamais au
// corps — une ombre ancree sur l'obstacle pointerait de travers.
const shadowLo = [];    // pente basse, en profondeur par pixel

const shadowHi = [];    // pente haute

const shadowFrom = [];  // distance a l'oeil ou l'ombre commence

const shadowTo = [];    // ... et ou elle s'arrete

let shadowCount = 0;

// La camera de CE balayage : son recul et la profondeur du kart. Un seul jeu
// suffit, tout se consomme dans le meme appel.
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
// On compare des PENTES et non des profondeurs : le kart regarde le long de la
// piste, une ombre est donc un cone. La traiter en tranche donnait a un kart
// lointain le meme pouvoir masquant qu'a un kart colle au pare-chocs. Une
// division par entree, exacte, la ou un lancer de rayons raterait les passages
// plus fins que son pas angulaire.
function shadowHides(look, y) {
    const de = eyeDist(look);

    // Derriere la camera : il n'y a rien a masquer, et la pente n'aurait
    // aucun sens. Le seuil evite aussi la division qui explose a l'oeil.
    if (de <= 1) return false;

    const rel = (y - shadowEyeY) / de;

    for (let i = 0; i < shadowCount; i++) {
        // Devant l'obstacle, ou au-dela du bout de son ombre : on voit. C'est
        // toute la difference avec une vue au ras du sol, ou un corps cachait
        // tout ce qui le suivait jusqu'a l'horizon.
        if (de <= shadowFrom[i] || de >= shadowTo[i]) continue;
        if (rel > shadowLo[i] && rel < shadowHi[i]) return true;
    }
    return false;
}

// L'urgence d'un danger : ce qu'il coute (`vision.cost`) rapporte au temps qui
// reste. Monnaie commune du systeme — le balayage s'en sert pour designer LA
// menace, le pilotage pour savoir si un tuyau vaut d'interrompre une esquive.
function threatScore(cost, ttc) {
    return cost / Math.max(ttc, 1);
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

// L'emplacement a ecraser : le premier libre ou perime, sinon le plus ancien. Un
// anneau simple pouvait jeter une menace encore sous les yeux pour en loger une
// perimee.
function judgeSlot(cfg, now, kart) {
    let oldest = 0;
    for (let i = 0; i < kart.judgedId.length; i++) {
        if (!kart.judgedId[i] || now - kart.judgedSeenAt[i] > cfg.vision.memoryMs) return i;
        if (kart.judgedSeenAt[i] < kart.judgedSeenAt[oldest]) oldest = i;
    }
    return oldest;
}

// Premiere perception d'une menace : le reflexe et le tirage d'inattention,
// arretes une fois pour toutes et retenus (`vision.memorySlots`). Toute la marge
// d'erreur d'un kart se joue ici, et elle est la meme pour les huit.
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

// Ce qui menace dans le dos, du souvenir plutot que de la vue. Rend '' quand il
// n'y a plus rien d'assez frais (`pressureMemoryMs`) : c'est la peremption qui
// oblige a se retourner encore pour rester inquiet.
function dangerBehind(cfg, now, kart) {
    const sight = kart.sight;
    if (now - sight.dangerAt > cfg.vision.pressureMemoryMs) return '';
    return sight.dangerKind;
}

// Une etoile ou un bill arrive derriere, et ca S'ENTEND.
//
// Toute la surveillance soutenue demande d'avoir DEJA vu le danger, et on ne voit
// derriere qu'en s'etant retourne. Pour une carapace, la manquer est une vraie
// faute de pilote. Pour une carrosserie lancee, non : elle ne reste dans la
// portee arriere que trois secondes, quand un kart du peloton ne se retourne
// qu'une fois toutes les onze — le plateau se faisait faucher sans qu'un seul ait
// regarde.
//
// Meme limite que `seeHomingThroughCover` : ca fait tourner la tete, rien de
// plus. Ce qu'il verra ensuite passe par le balayage ordinaire.
function ramNoise(cfg, state, kart) {
    if (isRamming(kart)) return false;

    const karts = state.karts;
    for (let i = 0; i < karts.length; i++) {
        const other = karts[i];
        if (other.id === kart.id) continue;
        if (!isRamming(other) || !isContactActive(other)) continue;

        // Derriere, et a portee de regard. Au-dela le bruit existe mais il n'y a
        // rien a voir : se retourner ne servirait qu'a etre aveugle devant.
        const dx = getShortestDistance(cfg, other.worldX, kart.worldX);
        if (dx < 0 && -dx <= cfg.vision.range.back) return true;
    }

    return false;
}

// L'attention : devant, ou derriere. Le tirage suit le rang, et la CADENCE
// remonte quand quelqu'un vise dans le dos ou quand c'est le kart qui prepare un
// tir arriere.
//
// Les gains portent sur l'intervalle et non sur la chance : le temps moyen entre
// deux coups d'oeil vaut `intervalle / chance`, donc les deux formes donnent la
// meme loi — sauf qu'une probabilite sature a 1, pas une cadence. La cadence dit
// a quelle frequence il se POSE la question, la probabilite ce qu'il repond.
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

    // Le danger derriere ne presse plus la CADENCE, il releve la PROBABILITE
    // (`backChanceDanger`). C'etait le meme signal compte deux fois, et avec des
    // coups d'oeil longs le kart serait reste tourne vers l'arriere 60 % du temps
    // — tres attentif a la carapace, aveugle au reste.

    // Qui prepare un tir arriere se retourne pour viser. C'est ce qui rend le tir
    // arriere JOUABLE pour celui qui le recoit : le tireur doit trouver son
    // moment, et pendant ce temps l'autre a pu se decaler.
    if (isAiming(cfg, kart) && now > kart.throwTime - cfg.ai.aimLeadMs
        && getShotDirection(state, kart) < 0) {
        pace *= vis.aimGlanceGain;
    }

    sight.nextGlance = now + vis.glanceIntervalMs / pace;

    // Quatre raisons de regarder derriere, et LE PLUS ELEVE GAGNE : elles ne
    // s'additionnent pas, ce sont quatre lectures de la meme question.
    //
    //   sa place      le premier n'a plus que l'arriere a surveiller ; le
    //                 dernier n'y jette qu'un oeil distrait.
    //   une zone vue  qui vient de traverser des boxes sait que ceux qui
    //                 l'entourent viennent peut-etre de s'armer.
    //   un danger vu  tant qu'il est frais, la surveillance ne redescend pas.
    //   un bruit      etoile ou bill : la seule raison qui ne demande pas
    //                 d'avoir deja regarde.
    let chance = rankChance(vis.backChance, state, kart);

    if (now - kart.boxPassedAt <= vis.boxGlanceMs) {
        const armed = rankChance(vis.backChanceBox, state, kart);
        if (armed > chance) chance = armed;
    }

    if (dangerBehind(cfg, now, kart)) {
        const alert = rankChance(vis.backChanceDanger, state, kart);
        if (alert > chance) chance = alert;
    }

    // La plus forte des quatre : ce qui s'entend n'a pas besoin d'avoir ete vu.
    // Cf. `ramNoise`.
    if (ramNoise(cfg, state, kart)) {
        const loud = rankChance(vis.backChanceRam, state, kart);
        if (loud > chance) chance = loud;
    }

    if (rng() < chance) {
        // La duree se tire au sort : a duree fixe, huit karts qui se retournent
        // au meme tirage reviennent devant ensemble, et un coup d'oeil trop court
        // ne laisse rien voir arriver.
        sight.backUntil = now + randomRange(rng, vis.glanceDurationMin,
                                                 vis.glanceDurationMax);
        sight.back = true;
    }
}

// Garder son objet derriere soi, ou s'en debarrasser.
//
// Le choix de trainer se prenait UNE FOIS, a la seconde ou l'objet tombait dans
// les mains — au moment ou le kart en savait le moins. Il le reconsidere
// maintenant quand un danger apparait derriere, une fois par EPISODE de danger :
// a chaque balayage, il tirerait a pile ou face soixante fois par seconde.
//
// Contre une etoile ou un bill, rien : ce qu'il faut leur opposer c'est de la
// place, et c'est l'esquive qui s'en charge.
function updateShield(cfg, rng, now, kart) {
    const ai = cfg.ai;
    const held = kart.heldItem;
    if (!held) return;

    const danger = dangerBehind(cfg, now, kart);
    if (!danger || danger === 'ram') return;

    const sight = kart.sight;

    // Une etoile ou un bill ne se posent pas derriere soi : ils rendent
    // INTOUCHABLE, ce qui est la seule reponse sure contre une rouge, puisqu'elle
    // suit.
    //
    // Rien ne les pressait : la date de declenchement se tirait a la prise de
    // l'objet, jusqu'a HUIT SECONDES. Le kart prenait la rouge en pleine face
    // avec de quoi l'annuler dans les mains. Il n'avance pas la date a coup sur
    // (`shield.panic`), et il ne la recule jamais.
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

        // Une carapace deja partie ne se discute presque plus : le bouclier est
        // la seule chose qui la mange. Un porteur laisse encore le choix de le
        // prendre de vitesse.
        const keep = (danger === 'shot') ? ai.shield.shot : ai.shield.carrier;
        kart.shieldHold = rng() < keep;

        if (!kart.shieldHold) {
            // Il s'en sert plutot que de s'en couvrir, le plus souvent vers le
            // danger — c'est la qu'il y a quelqu'un a toucher.
            if (rng() < ai.shield.backThrow) {
                kart.shotDirection = -1;
                kart.shotAsLeader = (kart.rank === 1);
            }
            kart.throwTime = now;
        } else if (held.holdPosition === 'hands'
                   && (!kart.trailTime || kart.trailTime > now)) {
            // TOUT DE SUITE, et pas seulement s'il n'avait rien prevu : un kart
            // qui avait deja programme de sortir son objet attendait son minuteur
            // avec un bouclier dans les mains. Decider de se couvrir et le faire
            // plus tard, ce n'est pas se couvrir.
            kart.trailTime = now;
        }
    }

    // Tant que le danger dure, l'echeance de tir recule ; le souvenir perime,
    // l'objet repart de lui-meme. Le bouclier se garde tant qu'il sert, pas
    // indefiniment.
    if (kart.shieldHold) kart.throwTime = now + cfg.vision.pressureMemoryMs;
}

// Un intervalle de plus dans l'encombrement retenu. Seul ce qui a ete VU y entre
// : ce que le kart ne voit pas ne lui ferme aucun passage, et c'est le prix d'une
// vue bouchee.
//
// Quatre choses distinctes, la ou un span unique faisait passer un tuyau, une
// banane et une carrosserie pour le meme mur :
//
//   lo/hi   la limite DURE, en positions de centre : la hitbox nue.
//   margin  le confort qu'on aimerait garder au-dela. L'entamer coute,
//           proportionnellement — ce n'est pas un refus.
//   cost    ce que coute le contact, meme monnaie que `vision.cost`.
//   hard    vrai pour le seul corps qu'on ne traverse pas : le tuyau.
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

    // Le sens de CE balayage. `sight.back` bascule a la cadence de l'affichage —
    // c'est une attention — quand le balayage ne tourne que toutes les
    // `scanIntervalMs` : au debut d'un coup d'oeil, le contenu de la vue vient
    // encore du balayage AVANT.
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

    // La camera de poursuite est TOUJOURS en arriere du regard : un coup d'oeil
    // arriere la fait passer devant le kart. C'est le sens du regard qui la
    // place, pas la marche.
    shadowEyeBack = vis.eye.back;
    shadowEyeY = kart.yPercent;
    shadowRun = vis.eye.run;

    const kartReach = cfg.hitboxes.kartVsKart;
    const pipeReach = cfg.hitboxes.kartVsPipe;
    const itemReach = cfg.hitboxes.itemVsKart;
    // Deux mesures de profondeur a ne pas confondre.
    //
    // `clear` est le DEGAGEMENT : l'ecart au-dela duquel un objet passe a cote
    // pour de bon. C'est ce qu'une esquive doit couvrir.
    //
    // `lane` est la VOIE : la bande dans laquelle un objet est considere sur la
    // route, donc a surveiller. Deliberement plus large — kart et objet bougent
    // en profondeur pendant le temps avant impact, et il faut avoir commence a
    // s'ecarter avant d'etre pile dans l'axe.
    //
    // Une troisieme existe et ne se confond avec aucune : la LIMITE DURE d'un
    // corps, sa hitbox nue, qui borne les spans.
    const place = vis.place;
    const clear = itemReach.y + place.margin.item;
    const lane = vis.threatLane;
    const speed = kart.absoluteVelocity;

    // Demi-profondeur PROPRE d'un corps, celle qui porte son ombre. Les hitboxes
    // sont des ecarts entre centres : elles contiennent deja la demi-carrosserie
    // de la victime, qui n'a rien a faire dans une ombre.
    const kartHalf = kartReach.y * 0.5;
    const pipeHalf = pipeReach.y - kartHalf;
    const gain = vis.shadowGain;

    // La bande de surveillance et le point d'arret ne dependent pas du tuyau :
    // ils se posent une fois.
    const pipeWatch = pipeReach.y + place.margin.pipe;
    const pipeSettle = steerSettle(cfg, kart);

    const pipes = state.pipes;
    for (let p = 0; p < pipes.length; p++) {
        const dx = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
        if (dx < -pipeReach.x || dx > vis.range.front) continue;

        const e = scanTake();

        // `look` est une distance le long du REGARD, pour tout le monde : c'est
        // ce qui rend le tri comparable d'une entree a l'autre. Un tuyau devant,
        // pendant un coup d'oeil arriere, est donc a une distance negative.
        e.look = dx * dir;
        e.dx = dx;
        e.y = pipes[p].y;

        // LE seul corps qu'on ne traverse pas. Masse infinie, il arrete net —
        // d'ou `blockHard`, que rien d'autre ne porte.
        e.blockHalf = pipeReach.y;
        e.blockMargin = place.margin.pipe;
        e.blockCost = vis.cost.pipe;
        e.blockHard = true;

        // Aussi loin qu'on le voit, et pas une demi-seconde de course. Il
        // empruntait `dodgeGuardDistance`, taille pour l'esquive : vrai d'un
        // objet qu'on evite d'un ecart, faux d'un mur — un tuyau ne s'en va pas,
        // on ARRIVE dessus. Au-dela de 500 le placement routait a travers, et le
        // kart ne s'ecartait qu'une fois colle.
        e.blockReach = cfg.pipe.seeDistance;
        e.shadowHalf = pipeHalf * gain;
        e.role = SEE_BLOCK;
        e.pipeIndex = p;

        // Il porte une ombre mais n'en subit aucune, et reste vu de dos : c'est
        // le decor, il se sait par coeur. Il cesse de masquer pendant un coup
        // d'oeil arriere, ou l'ordre des distances est inverse.
        e.solid = !sight.back;
        e.pierces = true;

        // Il ne barre la route que dans la voie ; ailleurs il ferme un passage
        // sans menacer personne.
        //
        // Ce test decide de `sight.pipeIndex`, seule chose qui autorise un tuyau
        // a reprendre le volant a une esquive (`pipeOutranksPlan`). Rate ici, le
        // tuyau n'existe plus pour l'arbitrage et le kart va au mur en ligne
        // droite.
        //
        // D'ou les deux precautions : on se mesure au POINT D'ARRET et non a la
        // profondeur du moment — un plan qui emmene le kart dans l'axe ne le
        // flaggait jamais — et au DEGAGEMENT et non a la hitbox nue, une bande de
        // surveillance devant etre plus large que le contact.
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

        // Une banane en cloche se voit LA OU ELLE VA TOMBER.
        //
        // En vol l'ecart se creuse, donc le temps avant impact est negatif et
        // elle n'etait une menace pour personne ; elle n'existait qu'a
        // l'atterrissage, 480 px devant son lanceur et pile sur sa ligne.
        // Personne ne couvre 7 unites de degagement en si peu de temps.
        //
        // Son point d'arrivee est connu d'avance (`flightTo`) : une cloche est un
        // obstacle FUTUR, pas un objet qui s'echappe. Vue immobile pour la meme
        // raison — ce qui compte est qu'elle ne bougera plus.
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

        // Un objet se franchit : rien n'empeche physiquement d'y aller. La limite
        // dure est sa hitbox nue, le degagement vient en marge.
        e.blockHalf = itemReach.y;
        e.blockMargin = place.margin.item;
        e.blockCost = vis.cost.spin;
        e.id = item.id;

        // Un objet A L'ARRET est un obstacle FIXE, comme un tuyau : il compte
        // aussi loin qu'on le voit. Avec la portee courte de l'esquive, un
        // couloir de tuyau se choisissait a 1100 px sans savoir qu'une banane y
        // etait posee, et elle n'apparaissait qu'a 500 — trop tard pour
        // traverser.
        //
        // Ce qui bouge garde la portee courte : une carapace aura change de place
        // bien avant qu'on arrive a sa hauteur.
        e.blockReach = (atVx === 0) ? cfg.pipe.seeDistance : ai.dodgeGuardDistance;

        // Une rouge traque : elle arrive dans l'axe et par l'arriere, pile le cas
        // ou un kart la precede et la masque. Soumise a l'occlusion, elle serait
        // inevitable.
        e.pierces = vis.seeHomingThroughCover && item.type === 'redShell';

        // Une seule formule pour les deux sens : `dx / rel` est positif quand
        // l'ecart se referme, que l'objet soit devant et plus lent ou derriere et
        // plus rapide.
        const rel = speed - atVx;
        const ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;

        const aligned = Math.abs(item.y - kart.yPercent) < lane;

        // Il se rapproche et il est dans la voie : ca suffit a rester sur
        // ses gardes, meme s'il est encore loin de la fenetre d'esquive.
        if (ttc > 0 && aligned) e.approach = NEAR_SHOT;

        // Et ca ferme un passage : CELUI OU LE KART EST.
        //
        // Le test ne gardait que ce qui etait devant, si bien que le placement
        // ignorait la carapace qui rattrapait le kart. `chooseLane` ne lit rien
        // d'autre que les spans : sans span, aucun candidat ne faisait mieux
        // qu'un detour nul, l'esquive etait decidee et ne commandait rien.
        //
        // Un objet derriere ne ferme pas la piste : il ferme LA LIGNE SUR
        // LAQUELLE IL REVIENT, ce que dit exactement `approach`.
        if (dx > 0 || e.approach) e.role |= SEE_BLOCK;

        const itemWindow = threatWindow(cfg, kart, item.y);
        if (ttc > 0 && ttc <= itemWindow
            && (dx < 0 ? -dx : dx) <= threatLeash(cfg, itemWindow, rel)
            && aligned) {
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

            // Une carrosserie se bouscule : elle coute le moins cher des trois
            // corps, et c'est le seul obstacle qui peut s'ecarter tout seul.
            e.blockHalf = kartReach.y;
            e.blockMargin = place.margin.kart;
            e.blockCost = vis.cost.kart;
            e.shadowHalf = kartHalf * gain;

            // Une carrosserie ne ferme un passage que sur la longueur ou les deux
            // karts peuvent se toucher. Un kart trois cents pixels devant roule a
            // la meme allure : le compter fermait la piste pour rien — sept
            // esquives sur dix se declaraient acculees.
            e.blockReach = kartReach.x * 2;
            e.solid = true;
            e.role = SEE_BLOCK;
            e.kartId = other.id;

            // Porte-t-il une ROUGE ? Le seul objet auquel se decaler ne repond
            // pas — elle suit. La parade est de cesser d'etre la cible, donc de
            // le laisser passer (`vision.giveWay`).
            e.redHeld = !!held && held.type === 'redShell';

            // Etoile et bill blessent au contact, et rien dans le pilotage ne
            // s'en ecartait. L'identifiant est negatif pour ne jamais croiser
            // celui d'un objet dans la memoire des menaces.
            if (isRamming(other) && !ramming) {
                const rel = speed - other.absoluteVelocity;
                const ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;
                const aligned = Math.abs(other.yPercent - kart.yPercent) < lane;

                // Une carrosserie lancee fond sur sa proie bien plus vite qu'une
                // carapace : le temps qu'elle entre dans la fenetre d'esquive, il
                // ne reste que le reflexe.
                if (ttc > 0 && aligned) e.approach = NEAR_RAM;

                // Et elle ne se BOUSCULE pas : la ferrer coute un tete-a-queue.
                // Avec le prix d'une carrosserie ordinaire, le placement
                // acceptait de passer sur une etoile pour eviter une banane. Sa
                // portee suit : tant qu'elle revient dans la voie, elle compte
                // aussi loin qu'une carapace.
                e.blockCost = vis.cost.spin;
                if (e.approach) e.blockReach = ai.dodgeGuardDistance;

                // Meme fenetre taillee au besoin que pour un objet : ce qui
                // arrive au contact ne se juge pas autrement selon que c'est une
                // carapace ou une etoile.
                if (ttc > 0 && ttc <= threatWindow(cfg, kart, other.yPercent)
                    && aligned) {
                    e.role |= SEE_THREAT;
                    e.kind = 'spin';
                    e.cost = vis.cost.spin;
                    e.ttc = ttc;
                    e.id = -1 - other.id;
                }
            }

            // Le danger latent : personne n'a rien lance, il n'y a ni temps avant
            // impact ni esquive a faire. Ce qui se joue est une PRECAUTION —
            // quitter une ligne de tir avant qu'elle ne serve.
            //
            // Deux formes, meme probleme : partager sa profondeur avec quelqu'un
            // qui peut vous atteindre. DERRIERE, il peut tirer vers l'avant
            // (`isArmedForward`) ; DEVANT, il porte de quoi finir derriere lui
            // (`trailableItems`).
            //
            // Les deux exigent L'ALIGNEMENT — hors de sa ligne il ne peut rien
            // contre vous — et LE REGARD du bon cote, ce qui donne au coup d'oeil
            // un cout reel. Aucune ne demande que l'objet soit deja en trainee :
            // ce qui compte est ce que le porteur PEUT en faire.
            //
            // Il vit sur l'entree de balayage et non a cote : c'etait la seule
            // perception du systeme a echapper a l'occlusion, sans que rien ne le
            // dise.
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

                // Seul celui qui revient dessus est menace : derriere un
                // porteur plus rapide, l'objet s'eloigne.
                const rel = speed - other.absoluteVelocity;
                const ttc = (rel !== 0) ? (hdx / rel) * 1000 : Infinity;

                const aligned = Math.abs(other.yPercent - kart.yPercent) < lane;
                const near = (hdx < 0 ? -hdx : hdx) <= ai.trailThreatDistance;

                // Meme portee que la menace, et pas celle du regard : un objet
                // encore tenu par un kart lointain n'est pas un tir mais un
                // porteur, et le danger latent le dit deja.
                if (ttc > 0 && aligned && near) e.approach = NEAR_SHOT;

                // Meme regle que pour un objet au sol : devant il encombre,
                // derriere il ne ferme que la ligne sur laquelle il revient.
                if (hdx > 0 || e.approach) e.role |= SEE_BLOCK;

                if (ttc > 0 && near
                    && aligned) {
                    e.role |= SEE_THREAT;
                    e.kind = 'spin';
                    e.cost = vis.cost.spin;
                    e.ttc = ttc;
                }
            }
        }

    }

    // Une boite masquee par un kart est une boite qu'il prendra le premier :
    // l'occlusion repond exactement a la question, avec une boucle imbriquee en
    // moins.
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

    // La marche, du plus proche au plus lointain : chacun est teste contre les
    // ombres deja posees, puis pose la sienne. Un corps ne se cache pas lui-meme,
    // d'ou cet ordre.
    scanOrder.length = scanCount;
    for (let i = 0; i < scanCount; i++) scanOrder[i] = i;
    sortScan();

    let bestScore = 0;

    // Le pire danger apercu DERRIERE pendant ce balayage. Une carapace deja
    // partie prime sur celui qui la porte ; une etoile se classe entre les deux,
    // parce qu'on ne peut rien lui opposer d'autre que de la place.
    let dangerRank = 0;
    let dangerKind = '';

    let boxDiff = Infinity;
    let hiddenDiff = Infinity;
    let hiddenY = 0;
    let hiddenDist = -1;

    for (let i = 0; i < scanCount; i++) {
        const e = scanPool[scanOrder[i]];
        const seen = e.pierces || !shadowHides(e.look, e.y);

        // Ce que l'ombre a MANGE, releve pour l'observateur seul : sans lui, un
        // kart qui ignore une banane et un kart qui ne la voit pas se ressemblent
        // trait pour trait. Meme convention de signe que partout — karts en
        // negatif, objets a partir de 1.
        if (!seen) {
            const hidden = (e.kartId >= 0) ? (-1 - e.kartId) : e.id;
            if (hidden) {
                sight.hiddenIds[sight.hiddenCount] = hidden;
                sight.hiddenCount++;
            }
        }

        if (seen) {
            if (e.role & SEE_BLOCK) pushSpan(sight, e);

            // Qui roule avec lui. Ce releve repond a une AUTRE question que le
            // span : non pas « vais-je le toucher » mais « ce passage sera-t-il
            // pris quand j'y serai ». On ne garde que la profondeur.
            //
            // Et les ROUGES derriere, qu'il faut avoir VUES : on retient la plus
            // proche — c'est elle qui vise — et COMBIEN il y en a. S'en trouver
            // deux, c'est n'avoir nulle part ou se ranger.
            //
            // Ce qui est masque n'y entre pas, comme partout ailleurs.
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

            // Ce qui se rapproche dans le dos, AVANT le test de menace et hors de
            // lui. Ce releve sert a rester attentif en amont : exiger l'imminence
            // le rendait muet precisement quand il servait. Cf. `NEAR_RAM` /
            // `NEAR_SHOT`.
            if (sight.scanBack && e.dx < 0 && e.approach > dangerRank) {
                dangerRank = e.approach;
                dangerKind = (e.approach === NEAR_RAM) ? 'ram' : 'shot';
            }

            if (e.role & SEE_THREAT) {
                // Un tuyau ne surprend personne, il est dans le trace : ni
                // reflexe a passer, ni tirage d'inattention.
                let ready = true;
                if (e.kind !== 'pipe') {
                    let slot = recallThreat(cfg, now, kart, e.id);
                    if (slot < 0) slot = judgeThreat(cfg, rng, now, kart, e.id, e.y, e.ttc);
                    ready = !kart.judgedIgnored[slot] && now >= kart.judgedReactAt[slot];
                }

                // La table de cout remplace l'ordre fige des manoeuvres : le
                // danger le plus cher par unite de temps l'emporte. C'est ce qui
                // fait qu'un kart accepte de froler un tuyau pour eviter une
                // carapace, jamais l'inverse.
                if (ready) {
                    const score = threatScore(e.cost, e.ttc);
                    if (score > bestScore) {
                        bestScore = score;
                        sight.threatId = e.id;
                        sight.threatKind = e.kind;
                        sight.threatY = e.y;
                        sight.threatTtc = e.ttc;
                    }
                }

                // Le tuyau vise reste le plus proche qui BARRE LA ROUTE, qu'il
                // ait gagne l'arbitrage ou non : c'est contre lui qu'une esquive
                // en cours est verifiee (`pipeOutranksPlan`), et pour barrer il
                // faut etre dans l'axe.
                if (e.kind === 'pipe' && (sight.pipeIndex < 0 || e.dx < sight.pipeDist)) {
                    sight.pipeIndex = e.pipeIndex;
                    sight.pipeDist = e.dx;
                }
            }

            // Et le tuyau le plus proche DEVANT, aligne ou non : c'est lui qui
            // declenche le contournement.
            //
            // Partir sur `pipeIndex` seul le declenchait trop tard : en slalom,
            // le kart sortait de la voie du premier, se retrouvait sans rien a
            // faire et ne reprenait la main qu'une fois dans l'axe du second — il
            // ne pilotait pas entre les tuyaux, il rebondissait de l'un a
            // l'autre. L'engager tot ne monopolise rien, la manoeuvre rend la
            // main des que la propre ligne du kart redevient la meilleure.
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

            // Le porteur le plus proche l'emporte : c'est sa ligne qui coute le
            // plus cher a partager. La marche allant du plus proche au plus
            // lointain, le premier vu est le bon.
            if ((e.role & SEE_PRESSURE) && !sight.pressure) {
                sight.pressure = true;
                sight.pressureY = e.y;
                sight.pressureId = -1 - e.kartId;

                // De quel COTE. Un seul releve porte les deux formes du danger
                // latent — le balayage ne regarde qu'un cote a la fois — mais ce
                // qu'on en fait differe.
                sight.pressureBack = sight.scanBack;

                // Vu DERRIERE : c'est ce qui fait tourner la tete plus souvent.
                // Le tirage du coup d'oeil n'ayant jamais lieu pendant un coup
                // d'oeil, il lui faut un souvenir date et non l'etat du balayage
                // courant. C'est le plus faible des trois dangers — il n'a encore
                // rien lance.
                if (sight.scanBack) {
                    if (dangerRank < 1) {
                        dangerRank = 1;
                        dangerKind = 'carrier';
                    }
                }
            }

            // Le kart visible le plus proche dans l'axe du regard : LA cible de
            // tir, dans les deux sens. C'est donc l'occlusion qui decide qui est
            // visable, devant comme derriere — la visee bouclait autrefois sur le
            // monde et voyait au travers de tout.
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

            // Un corps derriere la camera ne porte pas d'ombre devant elle. Le
            // cas existe : la camera recule de `eye.back`, et le balayage prend
            // les corps jusqu'a une carrosserie en arriere du kart.
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

    // Le souvenir du danger. `dangerSince` ne bouge que si le precedent s'etait
    // perime : c'est la que commence un nouvel EPISODE, et c'est ce qui fait que
    // le choix du bouclier se tranche une fois.
    if (dangerRank > 0) {
        if (now - sight.dangerAt > vis.pressureMemoryMs) sight.dangerSince = now;
        sight.dangerAt = now;
        sight.dangerKind = dangerKind;
    }

    // Et le souvenir de la ROUGE qui suit. Sans lui, le releve ne valait que
    // pendant le coup d'oeil — un dixieme du temps — et la seconde d'apres le
    // kart ne savait plus que c'etait une rouge : il restait vaguement inquiet et
    // ne se rangeait jamais.
    //
    // Meme regle que partout : le balayage tourne vers le danger fait foi,
    // l'autre laisse valoir le souvenir. La distance vieillit, et c'est assume.
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

    // Les ombres, recopiees pour l'observateur seul : sans elles la carte ne peut
    // montrer que des entites grisees, jamais OU se trouve le trou. Tableaux
    // reutilises d'un balayage a l'autre.
    for (let i = 0; i < shadowCount; i++) {
        sight.shadowLo[i] = shadowLo[i];
        sight.shadowHi[i] = shadowHi[i];
        sight.shadowFrom[i] = shadowFrom[i];
        sight.shadowTo[i] = shadowTo[i];
    }
    sight.shadowCount = shadowCount;
    sight.eyeBack = shadowEyeBack;
    sight.eyeY = shadowEyeY;

    // Et le souvenir du porteur qu'on SUIT — l'autre moitie du danger latent.
    //
    // Sans lui, un coup d'oeil arriere EFFACAIT le porteur que le kart avait
    // devant : au retour de tete la precaution repartait de zero, et le kart
    // restait dans l'axe d'une verte jusqu'a ce qu'elle parte.
    //
    // Le balayage AVANT fait foi dans les deux sens — il pose le souvenir quand
    // il voit, l'efface quand il ne voit plus ; l'arriere le laisse valoir. Un
    // danger arriere garde la main : lui peut tirer, le porteur de devant ne peut
    // que laisser tomber.
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

    // Le temps qu'il reste APRES le mur du moment.
    //
    // Un seul mur s'impose vraiment, le plus proche devant. Ceux d'apres laissent
    // au kart le trajet qui les en separe pour se replacer, et c'est ce trajet
    // qu'on releve — en temps, parce que c'est en temps que se compte un braquage
    // et que chaque manoeuvre le convertit avec SON volant (cf. `laneRisk`).
    //
    // Zero pour le mur du moment : il n'y a plus rien a negocier, il refuse.
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

export {
    perceive,
    shadowCount,
    shadowFrom,
    shadowHi,
    shadowLo,
    shadowTo,
    updateGlance,
    updateShield,
};
