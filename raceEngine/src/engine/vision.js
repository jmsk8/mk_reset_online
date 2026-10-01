// Vision et jugement d'un kart : la vue produit des constats, plans.js et ai.js
// decident. Le balayage ecrit dans des tampons de module (pas d'allocation).

import { randomRange } from './math.js';
import { getShortestDistance } from './geometry.js';
import { steerCap, steerDelay, steerReach } from './steering.js';
import { isContactActive, isRamming } from './bodies.js';
import { referenceAgility } from './stats.js';
import { steerSettle } from './driving.js';
import { getAggression, getShotDirection, heldThreatType, isAiming, isArmedForward, isTrailable, rankChance } from './weapons.js';

// Fenetre a partir de laquelle une menace en est une, pour ce kart : temps de
// reaction plus temps pour degager au pire tirage d'intensite
// (`dodgeIntensityMin`), avec `threatWindowMs` pour plancher. `clear` est le
// degagement propre a la menace (plus large pour un bill).
function threatWindow(cfg, kart, threatY, clear) {
    const ai = cfg.ai;
    const need = clear - Math.abs(threatY - kart.yPercent);
    if (need <= 0) return ai.threatWindowMs;

    // A l'arret le volant ne mord plus : d'ou le plancher.
    const cap = steerCap(cfg, kart, ai.dodgeIntensityMin);
    if (!(cap > 0)) return ai.threatWindowMs;

    const own = ai.reactionBaseMs * ai.reactionJitterMax
        + steerDelay(cfg, cap, need);
    return (own > ai.threatWindowMs) ? own : ai.threatWindowMs;
}

// Distance maximale accompagnant la fenetre (ne refuse jamais ce qu'elle accepte).
function threatLeash(cfg, windowMs, rel) {
    const reach = (rel > 0) ? (rel * windowMs) / 1000 : 0;
    const leash = cfg.ai.threatMaxDistance;
    return (reach > leash) ? reach : leash;
}

// Probabilite qu'un kart ne voie pas venir la menace, d'autant plus faible que
// sa marge (distance couvrable avant l'impact / degagement necessaire) est grande.
function missChance(cfg, kart, threatY, spareMs, clear) {
    const ai = cfg.ai;
    const base = ai.dodgeMissChance;

    // Deja assez a cote pour que la hitbox le manque.
    const need = clear - Math.abs(threatY - kart.yPercent);
    if (need <= 0) return 0;
    if (spareMs <= 0) return base;

    // Etalonne sur l'agilite de reference : l'attention ne depend pas du kart.
    const cap = (ai.dodgeIntensityMin + ai.dodgeIntensityMax) * 0.5 * referenceAgility(cfg);
    const ease = steerReach(cfg, cap, spareMs) / need;

    if (ease <= 1) return base;
    if (ease >= ai.dodgeEasyRatio) return 0;
    return base * (1 - (ease - 1) / (ai.dodgeEasyRatio - 1));
}

// La vue : un balayage par kart, dont le pilotage lit le resultat :
//   - la menace retenue, arbitree au cout (`vision.cost`) ;
//   - le danger latent : porteur arme le plus proche dans la ligne ;
//   - l'encombrement en profondeur (masquage de la vue et choix du passage) ;
//   - trafic et occasions : kart a doubler, boite, cible a viser.
// On ne voit qu'un cote a la fois, et un corps solide (kart, bill, tuyau)
// masque. Exception : les tuyaux restent connus meme en regardant derriere.

// Roles d'une entree de balayage (cumulables).
const SEE_BLOCK = 1;

const SEE_THREAT = 2;

const SEE_BOX = 4;

const SEE_PRESSURE = 8;

// Ce qui se rapproche dans le dos, hors fenetre d'esquive (`approach`) : de
// quoi rester attentif et sortir un bouclier.
const NEAR_RAM = 2; // etoile ou bill

const NEAR_SHOT = 3; // objet en vol ou traine

// Tampon de balayage partage, rempli et consomme dans le meme appel.
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
            redHeld: false, approach: 0, clear: 0, rel: 0
        });
    }
    const e = scanPool[scanCount++];
    e.clear = 0;
    e.solid = false;
    e.pierces = false;
    e.role = 0;
    e.id = 0;
    e.kartId = -1;
    e.redHeld = false;
    e.rel = 0;
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

// Tri par insertion (liste courte).
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

// Ombres vues depuis la camera de poursuite (`vision.eye`) : deux pentes
// depuis l'oeil et la distance au-dela de laquelle la route se revoit.
const shadowLo = []; // pente basse, en profondeur par pixel

const shadowHi = []; // pente haute

const shadowFrom = []; // distance a l'oeil du debut de l'ombre

const shadowTo = []; // ... et de sa fin

let shadowCount = 0;

// Camera de ce balayage : recul et profondeur du kart.
let shadowEyeBack = 0;

let shadowEyeY = 0;

let shadowRun = 0;

// Distance a l'oeil d'une entree (`look` est mesure depuis le kart).
function eyeDist(look) {
    return look + shadowEyeBack;
}

// Vrai si le corps est dans l'ombre d'un plus proche (comparaison de pentes).
function shadowHides(look, y) {
    const de = eyeDist(look);

    // Derriere la camera : rien a masquer.
    if (de <= 1) return false;

    const rel = (y - shadowEyeY) / de;

    for (let i = 0; i < shadowCount; i++) {
        // Devant l'obstacle ou au-dela de son ombre : visible.
        if (de <= shadowFrom[i] || de >= shadowTo[i]) continue;
        if (rel > shadowLo[i] && rel < shadowHi[i]) return true;
    }
    return false;
}

// Urgence d'un danger : son cout (`vision.cost`) rapporte au temps restant.
function threatScore(cost, ttc) {
    return cost / Math.max(ttc, 1);
}

// Emplacement de la menace `id` parmi celles deja jugees, ou -1. Un verdict se
// perime s'il n'est plus rafraichi par l'observation.
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

// Emplacement a ecraser : le premier libre ou perime, sinon le plus ancien.
function judgeSlot(cfg, now, kart) {
    let oldest = 0;
    for (let i = 0; i < kart.judgedId.length; i++) {
        if (!kart.judgedId[i] || now - kart.judgedSeenAt[i] > cfg.vision.memoryMs) return i;
        if (kart.judgedSeenAt[i] < kart.judgedSeenAt[oldest]) oldest = i;
    }
    return oldest;
}

// Premiere perception d'une menace : reflexe et tirage d'inattention, retenus.
function judgeThreat(cfg, rng, now, kart, id, y, ttc, clear) {
    const ai = cfg.ai;
    const reactMs = ai.reactionBaseMs
        * randomRange(rng, ai.reactionJitterMin, ai.reactionJitterMax);

    const slot = judgeSlot(cfg, now, kart);
    kart.judgedId[slot] = id;
    kart.judgedSeenAt[slot] = now;
    kart.judgedReactAt[slot] = now + reactMs;

    // Tirage sur le temps restant apres le reflexe.
    kart.judgedIgnored[slot] = rng() < missChance(cfg, kart, y, ttc - reactMs, clear);
    return slot;
}

// Danger derriere, de memoire ; '' si plus rien n'est assez frais
// (`pressureMemoryMs`).
function dangerBehind(cfg, now, kart) {
    const sight = kart.sight;
    if (now - sight.dangerAt > cfg.vision.pressureMemoryMs) return '';
    return sight.dangerKind;
}

// Attention : devant ou derriere. Les gains portent sur la cadence des coups
// d'oeil (et non sur la probabilite, qui sature a 1).
function updateGlance(cfg, rng, state, now, kart) {
    const vis = cfg.vision;
    const sight = kart.sight;
    const alert = kart.alert;

    if (sight.backUntil > now) {
        sight.back = true;
        // Il regarde deja.
        alert.startle = false;

        // Suivi du regard jusqu'a la decision d'esquive (prolonge a chaque pas).
        if (alert.watch) {
            const hold = now + 2 * vis.scanIntervalMs;
            if (hold > sight.backUntil) sight.backUntil = hold;
        }
        return;
    }
    sight.back = false;

        // Ce qui vient de s'entendre declenche la question tout de suite.
    if (alert.startle) {
        alert.startle = false;
        sight.nextGlance = now;
    }

    if (now < sight.nextGlance) return;

    let pace = 1;

    // Qui prepare un tir arriere se retourne pour viser.
    if (isAiming(cfg, kart) && now > kart.throwTime - cfg.ai.aimLeadMs
        && getShotDirection(state, kart) < 0) {
        pace *= vis.aimGlanceGain;
    }

    sight.nextGlance = now + vis.glanceIntervalMs / pace;

    // Quatre raisons de regarder derriere, la plus forte l'emporte :
    //   sa place      le premier surveille surtout l'arriere
    //   une zone vue  apres des boites, les autres viennent peut-etre de s'armer
    //   un danger vu  tant qu'il est frais
    //   un bruit      etoile ou bill
    let chance = rankChance(vis.backChance, state, kart);

    if (now - kart.boxPassedAt <= vis.boxGlanceMs) {
        const armed = rankChance(vis.backChanceBox, state, kart);
        if (armed > chance) chance = armed;
    }

    if (dangerBehind(cfg, now, kart)) {
        const alert = rankChance(vis.backChanceDanger, state, kart);
        if (alert > chance) chance = alert;
    }

    // Ce qui s'entend n'a pas besoin d'avoir ete vu (`hear`).
    if (alert.ram) {
        const loud = rankChance(vis.backChanceRam, state, kart);
        if (loud > chance) chance = loud;
    }

    // Bleue en approche alors qu'il est en tete : voir qui le suit (`updateBlue`).
    if (alert.blueLook && vis.alerts.blue.glance > chance) chance = vis.alerts.blue.glance;

    if (rng() < chance) {
        // Duree tiree au sort.
        sight.backUntil = now + randomRange(rng, vis.glanceDurationMin,
                                                 vis.glanceDurationMax);
        sight.back = true;
    }
}

// Garder son objet derriere soi ou s'en debarrasser, reconsidere une fois par
// episode de danger. Rien contre une etoile ou un bill (c'est l'esquive).
function updateShield(cfg, rng, state, now, kart) {
    const ai = cfg.ai;
    const held = kart.heldItem;
    if (!held) return;

    const sight = kart.sight;

    // Une rouge le vise : etoile ou bill tout de suite, objet trainable garde
    // derriere tant qu'elle le vise. L'episode de danger vu est tranche du meme
    // coup.
    if (kart.alert.red) {
        if (held.type === 'star' || held.type === 'bill') {
            if (now < kart.throwTime) kart.throwTime = now;
        } else if (isTrailable(cfg, held.type)) {
            kart.shieldHold = true;
            if (held.holdPosition === 'hands' && (!kart.trailTime || kart.trailTime > now)) {
                kart.trailTime = now;
            }
            kart.throwTime = now + cfg.vision.pressureMemoryMs;
        } else {
            return;
        }
        kart.shieldAt = sight.dangerSince;
        return;
    }

    const danger = dangerBehind(cfg, now, kart);
    if (!danger || danger === 'ram') return;

    // Etoile ou bill contre une rouge : declenchement avance, avec une chance
    // `shield.panic`.
    if (held.type === 'star' || held.type === 'bill') {
        const red = sight.redBehindDist >= 0
            && sight.redBehindDist <= cfg.vision.giveWay.range;
        if (!red && danger !== 'shot') return;

        if (kart.shieldAt !== sight.dangerSince) {
            kart.shieldAt = sight.dangerSince;
            if (rng() < ai.shield.panic) {
                // Le reflexe ordinaire.
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

        // Contre une carapace partie, le bouclier ; contre un porteur, le choix
        // de tirer suit l'agressivite (`trailRatio`, comme `planItemUse`).
        let keep = ai.shield.shot;
        if (danger !== 'shot') {
            const aggression = getAggression(cfg, state, kart);
            keep = ai.shield.carrier * (1 - aggression * (1 - ai.aggression.trailRatio));
        }
        kart.shieldHold = rng() < keep;

        if (!kart.shieldHold) {
            // Il tire, le plus souvent vers le danger.
            let back = false;
            if (rng() < ai.shield.backThrow) {
                kart.shotDirection = -1;
                kart.shotAsLeader = (kart.rank === 1);
                back = true;
            }

            // Contre une carapace en vol, tout de suite ; contre un porteur, le
            // temps de viser (`aimGlanceGain`).
            kart.throwTime = (back && danger !== 'shot' && isAiming(cfg, kart))
                ? now + ai.aimLeadMs
                : now;
        } else if (held.holdPosition === 'hands'
                   && (!kart.trailTime || kart.trailTime > now)) {
            // Bouclier sorti immediatement.
            kart.trailTime = now;
        }
    }

    // L'echeance de tir recule tant que le danger dure.
    if (kart.shieldHold) kart.throwTime = now + cfg.vision.pressureMemoryMs;
}

// Ajoute un intervalle d'encombrement (seul ce qui a ete vu y entre) :
//   lo/hi   limite dure, en positions de centre (hitbox nue)
//   margin  confort au-dela, dont l'entame coute en proportion
//   cost    prix du contact (`vision.cost`)
//   hard    vrai pour le tuyau, seul corps infranchissable
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

// Balayage : une passe par tableau, un tri, puis une marche qui decide de ce qui
// est vu, de ce qui masque et de ce qui menace.
function perceive(cfg, state, rng, now, kart) {
    const vis = cfg.vision;
    const ai = cfg.ai;
    const sight = kart.sight;

    const dir = sight.back ? -1 : 1;
    const range = sight.back ? vis.range.back : vis.range.front;

    sight.at = now;

    // Sens de ce balayage (`sight.back` suit l'attention a chaque image).
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
    sight.pressureDist = 0;
    sight.spanCount = 0;
    sight.hiddenCount = 0;
    sight.scanRange = range;
    sight.crowdCount = 0;
    sight.redBehindDist = -1;
    sight.redBehindY = 0;
    sight.redBehindId = 0;
    sight.redBehindCount = 0;
    sight.rearKartDist = -1;
    sight.rearKartY = 0;
    sight.rearKartId = 0;
    sight.rearKartRel = 0;

    scanCount = 0;
    shadowCount = 0;

    // La camera de poursuite est toujours en arriere du regard.
    shadowEyeBack = vis.eye.back;
    shadowEyeY = kart.yPercent;
    shadowRun = vis.eye.run;

    const kartReach = cfg.hitboxes.kartVsKart;
    const pipeReach = cfg.hitboxes.kartVsPipe;
    const itemReach = cfg.hitboxes.itemVsKart;
    // `clear` : degagement a couvrir pour qu'un objet passe a cote ; `lane` :
    // bande, plus large, dans laquelle un objet est surveille.
    const place = vis.place;
    const clear = itemReach.y + place.margin.item;
    const lane = vis.threatLane;
    const speed = kart.absoluteVelocity;

    // Demi-profondeur propre d'un corps (pour son ombre), sans la carrosserie
    // de la victime incluse dans les hitboxes.
    const kartHalf = kartReach.y * 0.5;
    const pipeHalf = pipeReach.y - kartHalf;
    const gain = vis.shadowGain;

    // Bande de surveillance et point d'arret, communs a tous les tuyaux.
    const pipeWatch = pipeReach.y + place.margin.pipe;
    const pipeSettle = steerSettle(cfg, kart);

    const pipes = state.pipes;
    for (let p = 0; p < pipes.length; p++) {
        const dx = getShortestDistance(cfg, pipes[p].worldX, kart.worldX);
        if (dx < -pipeReach.x || dx > vis.range.front) continue;

        const e = scanTake();

        // `look` : distance le long du regard (negative derriere).
        e.look = dx * dir;
        e.dx = dx;
        e.y = pipes[p].y;

        // Seul corps infranchissable.
        e.blockHalf = pipeReach.y;
        e.blockMargin = place.margin.pipe;
        e.blockCost = vis.cost.pipe;
        e.blockHard = true;

        // Tuyau compte aussi loin qu'on le voit.
        e.blockReach = cfg.pipe.seeDistance;
        e.shadowHalf = pipeHalf * gain;
        e.role = SEE_BLOCK;
        e.pipeIndex = p;

        // Il porte une ombre sans en subir, et reste connu de dos ; il ne masque
        // pas pendant un coup d'oeil arriere.
        e.solid = !sight.back;
        e.pierces = true;

        // Il barre la route s'il est dans la bande de surveillance mesuree au
        // point d'arret (decide de `sight.pipeIndex`, utilise par
        // `pipeOutranksPlan`).
        if (dx > 0 && Math.abs(pipes[p].y - pipeSettle) < pipeWatch) {
            e.role |= SEE_THREAT;
            e.kind = 'pipe';
            e.cost = vis.cost.pipe;
            e.ttc = (dx / Math.max(speed, 1)) * 1000;
        }
    }

    // ── Objets au sol ──────────────────────────────────────────────
    const items = state.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];

        // Voir l'objet mort autorise a relacher le plan (`updatePlan`).
        if (item.isDead || item.spent) {
            if (item.id === kart.plan.threatId) sight.planGone = true;
            continue;
        }
        if (cfg.trailableItems.indexOf(item.type) === -1) continue;

        // Banane en cloche : vue a son point d'arrivee (`flightTo`), immobile.
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

        // Limite dure : hitbox nue de l'objet.
        e.blockHalf = itemReach.y;
        e.blockMargin = place.margin.item;
        e.blockCost = vis.cost.spin;
        e.id = item.id;

        // Objet a l'arret : compte aussi loin qu'on le voit ; un objet qui bouge
        // garde la portee courte.
        e.blockReach = (atVx === 0) ? cfg.pipe.seeDistance : ai.dodgeGuardDistance;

        // Une rouge en chasse n'est pas masquee (`seeHomingThroughCover`).
        e.pierces = vis.seeHomingThroughCover && item.type === 'redShell' && !item.resting;

        // `dx / rel` > 0 quand l'ecart se referme.
        const rel = speed - atVx;
        const ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;

        const aligned = Math.abs(item.y - kart.yPercent) < lane;

        // Rapprochement dans la voie : rester sur ses gardes.
        if (ttc > 0 && aligned) e.approach = NEAR_SHOT;

        // Ferme le passage devant, ou la ligne sur laquelle il revient (`approach`).
        if (dx > 0 || e.approach) e.role |= SEE_BLOCK;

        e.clear = clear;
        const itemWindow = threatWindow(cfg, kart, item.y, clear);
        if (ttc > 0 && ttc <= itemWindow
            && (dx < 0 ? -dx : dx) <= threatLeash(cfg, itemWindow, rel)
            && aligned) {
            e.role |= SEE_THREAT;
            e.kind = 'spin';
            e.cost = vis.cost.spin;
            e.ttc = ttc;
        }
    }

    // ── Karts ─────────────────────────────────────────────────────
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

            // Carrosserie : le moins cher des trois corps.
            e.blockHalf = kartReach.y;
            e.blockMargin = place.margin.kart;
            e.blockCost = vis.cost.kart;
            e.shadowHalf = kartHalf * gain;

            // Ne ferme un passage que la ou les deux karts peuvent se toucher.
            e.blockReach = kartReach.x * 2;
            e.solid = true;
            e.role = SEE_BLOCK;
            e.kartId = other.id;

            // Porteur de rouge : la parade est de le laisser passer (`vision.giveWay`).
            e.redHeld = !!held && held.type === 'redShell';

            // Gain reel sur nous (`contactSpeed`).
            e.rel = other.contactSpeed - kart.contactSpeed;

            // Etoile et bill blessent au contact ; id negatif pour les karts.
            if (isRamming(other) && !ramming) {
                const rel = speed - other.absoluteVelocity;
                let ttc = (rel !== 0) ? (dx / rel) * 1000 : Infinity;

                // Temps jusqu'au contact des emprises, pas des centres.
                if (ttc > 0 && ttc !== Infinity) {
                    const reachX = other.isBill ? cfg.bill.hitbox.x : kartReach.x;
                    const far = (dx < 0) ? -dx : dx;
                    ttc = (far > reachX) ? ttc * (far - reachX) / far : 1;
                }

                // Un bill balaie `bill.hitbox.y`, plus du double d'un kart ;
                // l'etoile garde les valeurs d'une carrosserie.
                let ramClear = clear;
                if (other.isBill) {
                    e.blockHalf = cfg.bill.hitbox.y;
                    e.blockMargin = place.margin.item;
                    ramClear = cfg.bill.hitbox.y + place.margin.item;
                }
                e.clear = ramClear;
                const aligned = Math.abs(other.yPercent - kart.yPercent)
                    < ((ramClear > lane) ? ramClear : lane);

                // Approche rapide : le reflexe seul reste.
                if (ttc > 0 && aligned) e.approach = NEAR_RAM;

                // Prix d'un tete-a-queue, portee d'une carapace.
                e.blockCost = vis.cost.spin;
                if (e.approach) e.blockReach = ai.dodgeGuardDistance;

                // Meme fenetre que pour un objet.
                if (ttc > 0 && ttc <= threatWindow(cfg, kart, other.yPercent, ramClear)
                    && aligned) {
                    e.role |= SEE_THREAT;
                    e.kind = 'spin';
                    e.cost = vis.cost.spin;
                    e.ttc = ttc;
                    e.id = -1 - other.id;
                }
            }

            // Danger latent (precaution) : partager sa profondeur avec un kart
            // qui peut vous atteindre, derriere (`isArmedForward`) ou devant
            // (`trailableItems`). Exige l'alignement et le regard du bon cote.
            const behind = dx < 0;
            if (behind === sight.back
                && look <= vis.pressureRange
                && Math.abs(other.yPercent - kart.yPercent) < clear
                && (behind ? isArmedForward(cfg, other)
                           : isTrailable(cfg, heldThreatType(held)))) {
                e.role |= SEE_PRESSURE;
            }
        }

        // Objet traine : a la profondeur du porteur.
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
                e.clear = clear;

                // Seul celui qui revient dessus est menace.
                const rel = speed - other.absoluteVelocity;
                const ttc = (rel !== 0) ? (hdx / rel) * 1000 : Infinity;

                const aligned = Math.abs(other.yPercent - kart.yPercent) < lane;
                const near = (hdx < 0 ? -hdx : hdx) <= ai.trailThreatDistance;

                // Portee de la menace (un porteur lointain releve du danger latent).
                if (ttc > 0 && aligned && near) e.approach = NEAR_SHOT;

                // Devant il encombre, derriere il ferme sa ligne de retour.
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

    // Une boite masquee par un kart est une boite qu'il prendra le premier.
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

    // Marche du plus proche au plus lointain, contre les ombres deja posees.
    scanOrder.length = scanCount;
    for (let i = 0; i < scanCount; i++) scanOrder[i] = i;
    sortScan();

    let bestScore = 0;

    // Pire danger apercu derriere : carapace partie > etoile > porteur.
    let dangerRank = 0;
    let dangerKind = '';

    let boxDiff = Infinity;
    let hiddenDiff = Infinity;
    let hiddenY = 0;
    let hiddenDist = -1;

    for (let i = 0; i < scanCount; i++) {
        const e = scanPool[scanOrder[i]];
        const seen = e.pierces || !shadowHides(e.look, e.y);

        // Corps masques, pour l'observateur seulement (karts negatifs, objets >= 1).
        if (!seen) {
            const hidden = (e.kartId >= 0) ? (-1 - e.kartId) : e.id;
            if (hidden) {
                sight.hiddenIds[sight.hiddenCount] = hidden;
                sight.hiddenCount++;
            }
        }

        if (seen) {
            if (e.role & SEE_BLOCK) pushSpan(sight, e);

            // Profondeurs des karts voisins (encombrement), et rouges vues
            // derriere : la plus proche et leur nombre.
            if (sight.scanBack && e.kartId >= 0 && e.dx < 0 && e.redHeld) {
                const gap = -e.dx;
                sight.redBehindCount++;
                if (sight.redBehindDist < 0 || gap < sight.redBehindDist) {
                    sight.redBehindDist = gap;
                    sight.redBehindY = e.y;
                    sight.redBehindId = -1 - e.kartId;
                }
            }

            // Kart le plus proche derriere, qui gagne du terrain (pour la bleue).
            if (sight.scanBack && e.kartId >= 0 && e.dx < 0
                && (sight.rearKartDist < 0 || -e.dx < sight.rearKartDist)) {
                sight.rearKartDist = -e.dx;
                sight.rearKartY = e.y;
                sight.rearKartId = -1 - e.kartId;
                sight.rearKartRel = e.rel;
            }

            if (e.kartId >= 0 && e.dx > 0 && e.dx <= vis.crowd.distance) {
                sight.crowdY[sight.crowdCount] = e.y;
                sight.crowdCount++;
            }

            // Ce qui se rapproche dans le dos, avant le test de menace
            // (`NEAR_RAM` / `NEAR_SHOT`).
            if (sight.scanBack && e.dx < 0 && e.approach > dangerRank) {
                dangerRank = e.approach;
                dangerKind = (e.approach === NEAR_RAM) ? 'ram' : 'shot';
            }

            if (e.role & SEE_THREAT) {
                // Un tuyau est dans le trace : ni reflexe ni inattention.
                let ready = true;
                if (e.kind !== 'pipe') {
                    let slot = recallThreat(cfg, now, kart, e.id);
                    if (slot < 0) slot = judgeThreat(cfg, rng, now, kart, e.id, e.y, e.ttc, e.clear);
                    ready = !kart.judgedIgnored[slot] && now >= kart.judgedReactAt[slot];
                }

                // Le danger le plus cher par unite de temps l'emporte.
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

                // Tuyau le plus proche qui barre la route (`pipeOutranksPlan`).
                if (e.kind === 'pipe' && (sight.pipeIndex < 0 || e.dx < sight.pipeDist)) {
                    sight.pipeIndex = e.pipeIndex;
                    sight.pipeDist = e.dx;
                }
            }

            // Tuyau le plus proche devant, aligne ou non : declenche le contournement.
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

            // Le porteur le plus proche l'emporte (premier vu).
            if ((e.role & SEE_PRESSURE) && !sight.pressure) {
                sight.pressure = true;
                sight.pressureY = e.y;
                sight.pressureId = -1 - e.kartId;
                sight.pressureDist = e.look;

                // Cote du porteur.
                sight.pressureBack = sight.scanBack;

                // Vu derriere : souvenir date pour les coups d'oeil suivants.
                if (sight.scanBack) {
                    if (dangerRank < 1) {
                        dangerRank = 1;
                        dangerKind = 'carrier';
                    }
                }
            }

            // Kart visible le plus proche dans l'axe du regard : la cible de tir.
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

    // Souvenir du danger ; `dangerSince` marque le debut d'un episode.
    if (dangerRank > 0) {
        if (now - sight.dangerAt > vis.pressureMemoryMs) sight.dangerSince = now;
        sight.dangerAt = now;
        sight.dangerKind = dangerKind;
    }

    // Souvenir du kart qui suit (le balayage arriere fait foi).
    if (sight.scanBack) {
        if (sight.rearKartDist >= 0) {
            sight.rearMemAt = now;
            sight.rearMemDist = sight.rearKartDist;
            sight.rearMemY = sight.rearKartY;
            sight.rearMemId = sight.rearKartId;
            sight.rearMemRel = sight.rearKartRel;
        } else {
            sight.rearMemAt = -Infinity;
        }
    } else if (now - sight.rearMemAt <= vis.pressureMemoryMs) {
        sight.rearKartDist = sight.rearMemDist;
        sight.rearKartY = sight.rearMemY;
        sight.rearKartId = sight.rearMemId;
        sight.rearKartRel = sight.rearMemRel;
    }

    // Souvenir de la rouge qui suit (le balayage arriere fait foi).
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

    // Souvenir du porteur qui suit, pose avant celui du porteur de devant.
    if (sight.scanBack) {
        if (sight.pressure) {
            sight.carrierAt = now;
            sight.carrierY = sight.pressureY;
            sight.carrierId = sight.pressureId;
            sight.carrierDist = sight.pressureDist;
        } else {
            sight.carrierAt = -Infinity;
        }
    }

    // Ombres recopiees pour l'observateur (tableaux reutilises).
    for (let i = 0; i < shadowCount; i++) {
        sight.shadowLo[i] = shadowLo[i];
        sight.shadowHi[i] = shadowHi[i];
        sight.shadowFrom[i] = shadowFrom[i];
        sight.shadowTo[i] = shadowTo[i];
    }
    sight.shadowCount = shadowCount;
    sight.eyeBack = shadowEyeBack;
    sight.eyeY = shadowEyeY;

    // Souvenir du porteur qu'on suit (le balayage avant fait foi).
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

    // Temps restant apres le mur du moment avant chacun des murs suivants (0
    // pour le mur du moment).
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

    // Aucune boite libre : il tente la plus proche de sa trajectoire.
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
