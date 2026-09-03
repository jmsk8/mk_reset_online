// Le bord de piste et le contact entre karts.
// Deux facons de se faire arreter par quelque chose de solide, resolues au meme
// endroit parce qu'elles se disputent la meme grandeur : la place disponible.

import { clamp } from './math.js';
import { getShortestDistance } from './geometry.js';
import { contactInertia, isContactActive, isRamming, isShrunkAt, kartHalfExtents } from './bodies.js';
import { crushKart, spinOutKart } from './effects.js';
import { collideKartWithPipes } from './pipes.js';

// Le bord de piste : un mur GLISSANT, et les deux mots comptent. On ne le
// traverse pas — la position est ramenee au bord — mais on n'y rebondit pas et on
// n'y est pas arrete : le kart garde son cap et repart quand il veut. Y rester
// coute de la vitesse, le mur tirant le moteur vers `topSpeed * speedFactor`.
//
// Le declencheur n'est pas un choc mais une PRESENCE, ce qui couvre d'un coup les
// deux cas — se faire pousser contre le mur, et devoir s'y coller pour esquiver.
//
// Seule la composante SORTANTE du mouvement lateral est annulee : l'annuler dans
// les deux sens collerait au mur un kart qui essaie d'en partir.
//
// Les objets ne passent pas par ici : le mur n'est glissant que pour les karts.
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

    // Meme forme que le volant et que la separation des contacts : un taux en
    // 1/s, borne a 1 pour qu'une frame longue arrive pile sur le plancher.
    const wall = cfg.physics.wall;
    const floor = kart.stats.topSpeed * wall.speedFactor;
    if (kart.absoluteVelocity > floor) {
        const k = wall.grip * deltaTime;
        kart.absoluteVelocity += (floor - kart.absoluteVelocity) * (k > 1 ? 1 : k);
    }
}

// Combien de profondeur il reste a ce kart avant le bord. Sert au sandwich : un
// kart plaque contre le bord ne peut pas reculer, sa part de separation passe a
// l'autre.
function roomToward(cfg, kart, n) {
    return n > 0 ? cfg.road.maxY - kart.yPercent : kart.yPercent - cfg.road.minY;
}

// Deplace un kart le long de la piste en gardant position et progression cousues,
// comme le fait la boucle de deplacement. Le compteur de tours en fait partie :
// rien n'interdit qu'une separation de quelques pixels tombe sur la ligne
// d'arrivee.
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

// Un intouchable fait toupiller ce qu'il percute. Deux gardes qui comptent : on
// ne relance pas un tete-a-queue deja en cours — la passe se rejoue a chaque tick
// tant que le contact dure — et on respecte le sursis d'apres-choc.
function spinOnContact(cfg, now, kart, events) {
    if (kart.state !== 'running') return;
    if (kart.hitInvincibleUntil > now) return;
    spinOutKart(cfg, now, kart, events);
}

// Resolution d'une paire. `withImpulse` n'est vrai qu'a la premiere passe ; les
// suivantes ne font que finir de decoller les positions.
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

    // Qui SENT le contact. Un intouchable — etoile ou bill — ne sent pas ce qu'il
    // percute : il fait toupiller sa victime et poursuit sa route sans etre
    // devie. Ici seulement, le couple echangeait encore une impulsion, si bien
    // que le porteur d'etoile se faisait bousculer par ce qu'il venait d'envoyer
    // en toupie.
    //
    // Sortir avant l'impulsion coupe les trois effets d'un choc d'un coup :
    // ejection, refus de braquage, separation. Le chevauchement se resorbe tout
    // seul.
    //
    // L'exception est le BILL : il tient le milieu de la piste et le traverse en
    // trombe, s'y croiser sans rien serait le seul endroit du jeu ou deux karts
    // s'ignorent entierement. Le partage reste tres inegal (`billMassFactor`).
    // Etoile contre etoile, en revanche, se traversent.
    const ramA = isRamming(a);
    const ramB = isRamming(b);

    // Un seul des deux est intouchable : il blesse, sa victime toupille.
    if (ramA !== ramB) spinOnContact(cfg, now, ramA ? b : a, events);

    const ramContact = ramA && ramB && (a.isBill || b.isBill);
    if ((ramA || ramB) && !ramContact) return;

    // L'ECRASEMENT. Un kart rapetisse qui rencontre un kart normal passe dessous,
    // et le couple ne s'echange RIEN : ni impulsion, ni refus de braquage, ni
    // separation. Seul contact du jeu qui sorte sans rien deplacer — le gros ne
    // sent rien, le petit garde sa trajectoire, les carrosseries se traversent.
    //
    // Place APRES le bloc des intouchables, et c'est ce qui donne la regle « une
    // etoile ne l'ecrase pas, elle le blesse ».
    //
    // Rien a defaire quand le petit regrossit : le tick suivant le trouve a
    // taille normale, et le chevauchement accumule se resorbe en poussant
    // l'ecraseur.
    const crushA = isShrunkAt(a, now) && !isShrunkAt(b, now) && !isRamming(b);
    const crushB = isShrunkAt(b, now) && !isShrunkAt(a, now) && !isRamming(a);
    if (crushA || crushB) {
        crushKart(cfg, now, crushA ? a : b, events);
        return;
    }

    // Une bousculade entre intouchables est attenuee : elle n'est la que pour
    // qu'ils ne se traversent pas.
    const scale = ramContact ? cfg.bill.pushFactor : 1;

    const iA = contactInertia(cfg, a);
    const iB = contactInertia(cfg, b);
    const total = iA + iB;
    // Part du choc encaissee par chacun : c'est l'inertie D'EN FACE qui la fixe.
    //
    // Ces deux parts sont le seul endroit ou le gabarit et l'allure se font
    // sentir dans un contact, mais elles servent aux TROIS effets — ejection,
    // refus de braquage, separation. Regler `massBias` ou `speedBias` les deplace
    // donc ensemble.
    const shareA = iB / total;
    const shareB = iA / total;

    // Fraction du chevauchement resorbee sur ce pas, bornee a 1 comme le lissage
    // du volant.
    const k = c.separationRate * deltaTime;
    const sep = k > 1 ? 1 : k;

    // La normale du choc. Les deux axes n'ont ni la meme unite ni la meme echelle
    // — 60 px de long contre 5 de profondeur — donc on passe en ESPACE NORMALISE,
    // ou le contact redevient rond et ou une direction se calcule.
    //
    // C'est ce qui donne l'angle : un tamponnement pile dans l'axe rend une
    // normale horizontale, le meme avec un demi-kart de decalage rend une
    // diagonale. Le choix d'axe unique d'avant rangeait ce contact dans «
    // tamponnement » et poussait tout droit.
    let ux = dx / boxX;
    let uy = dy / boxY;
    let len = Math.sqrt(ux * ux + uy * uy);
    if (len < 1e-6) {
        // Superposition parfaite. Arrive pour de vrai — deux karts clampes au
        // meme endroit du bord — et se tranche sur l'identifiant, pour que la
        // passe reste reproductible.
        ux = 0;
        uy = a.id < b.id ? 1 : -1;
        len = 1;
    }
    // Unitaire, pointe de `b` vers `a`.
    const nx = ux / len;
    const ny = uy / len;

    if (withImpulse) {
        // Vitesse de rapprochement, un axe a la fois et dans son unite : l'elan
        // reel du tick pour la longueur, volant et choc en cours confondus pour
        // la profondeur.
        const sgnX = nx >= 0 ? 1 : -1;
        const sgnY = ny >= 0 ? 1 : -1;
        const closeX = (b.contactSpeed - a.contactSpeed) * sgnX;
        const closeY = ((b.vy + b.bumpVy) - (a.vy + a.bumpVy)) * sgnY;

        // Rapprochement le long de la normale, ramene en boites par seconde — la
        // seule facon de melanger les deux axes.
        const approach = (closeX / boxX) * Math.abs(nx)
                       + (closeY / boxY) * Math.abs(ny);

        // LA porte du modele : une impulsion ne part que s'ils se rapprochent
        // ENCORE. Deux karts qui se touchent en s'ecartant deja n'ont plus rien a
        // se dire, et les repousser a chaque tick est exactement ce qui les
        // collait l'un a l'autre.
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

        // Refus de braquage, applique a chaque tick du contact : ce n'est pas une
        // poussee mais un appui qui se derobe. Chacun perd la part de son volant
        // qui pousse dans l'autre, en proportion de la masse d'en face — c'est
        // ici, et nulle part ailleurs, qu'un lourd force le passage. Dose par
        // `ny` : un tamponnement pur ne prend le volant de personne.
        const denyReach = Math.abs(ny) * scale;
        const intoA = -a.vy * sgnY;
        if (intoA > 0) a.vy += intoA * c.steerDeny * shareA * denyReach * sgnY;
        const intoB = b.vy * sgnY;
        if (intoB > 0) b.vy -= intoB * c.steerDeny * shareB * denyReach * sgnY;
    }

    // Separation : le filet de securite, pas le moteur du choc. L'ejection fait
    // le travail, ceci empeche seulement deux carrosseries de rester l'une dans
    // l'autre.
    const corrX = Math.max(penX - c.slopX, 0) * sep * Math.abs(nx);
    const corrY = Math.max(penY - c.slopY, 0) * sep * Math.abs(ny);

    // Le sandwich contre le bord se traite ici : un kart sans place devant lui
    // rend sa part a l'autre, sinon la paire reste collee au bord.
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

// Passe complete : plusieurs relaxations sur toutes les paires, puis remise en
// ordre. Une seule passe laisse un paquet de trois karts en chevauchement.
//
// La remise en ordre finale n'est pas optionnelle : un contact peut pousser un
// kart hors de la piste ou dans un tuyau, et ces deux verdicts ont ete rendus
// plus tot dans le tick, sur une position qui n'est plus la sienne.
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

        // Un kart que la passe de contacts vient de plaquer contre le bord y
        // frotte comme s'il s'y etait mis lui-meme.
        clampKartToRoad(cfg, kart, deltaTime);

        // Le sursis par tuyau rend ce second passage sans danger : seul un tuyau
        // ou la poussee vient de mettre le kart peut encore le cogner.
        collideKartWithPipes(cfg, state, kart, now, events);
    }
}

export {
    clampKartToRoad,
    resolveKartContacts,
};
