// Le realisateur : a qui la camera s'interesse, et pour combien de temps.
//
// Personne ne pilote la course, donc personne ne sait ou regarder. Ce fichier
// note ce qui se passe, en tire un score par kart, et coupe quand un autre plan
// vaut nettement mieux que celui en cours.

// Realisation automatique. La camera par defaut suit le peloton : elle ne rate
// rien, mais elle ne montre rien non plus. Ce module va chercher l'action la ou
// elle se joue, y reste le temps qu'elle se joue, et revient au plan large quand
// la course se calme.
//
//   1. Le depart se regarde en entier sur la vue d'ensemble.
//   2. Un plan DURE. `DIRECTOR_MIN_HOLD_MS` est un plancher ferme : une camera qui
//      saute a chaque evenement ne se regarde pas, elle se subit. Seul un plan
//      devenu vide passe outre.
//   3. Entre deux plans, on prend le plus fort — mais on ne revient JAMAIS au
//      defilement de base : passe le depart, la camera est chez quelqu'un.
//   4. L'arrivee est une SEQUENCE, pas une note, et elle passe devant les trois
//      autres regles.
//
// Tout se lit dans le snapshot deja recu : pas un champ n'a ete ajoute au
// protocole pour ca. Ce que le serveur ne dit pas se DEDUIT — une bleue qui
// tourne a cent unites d'un kart tourne au-dessus de lui.

// Vue d'ensemble au depart. Le temps que la grille s'etire et que les premiers
// objets tombent : avant, il n'y a rien a montrer de plus pres.
const DIRECTOR_WARMUP_MS = 6000;

// Duree minimale d'un plan. C'est la regle 2, et c'est elle qui fait la
// difference entre une realisation et un zapping. Sept secondes : le temps de
// comprendre ce qu'on regarde, et de voir l'action se terminer.
const DIRECTOR_MIN_HOLD_MS = 7000;

// Au-dela, le plan a fait son temps et laisse la place, meme s'il tient encore
// la meilleure note : sans ca, un kart en tete d'une course calme garderait la
// camera jusqu'a l'arrivee.
const DIRECTOR_MAX_HOLD_MS = 15000;

// On ne redecide pas soixante fois par seconde : les notes ne bougent pas assez
// vite pour ca, et un balayage de la scene par image serait du gaspillage.
const DIRECTOR_EVAL_MS = 300;

// Ce qu'un pretendant doit valoir, dans l'absolu, pour COUPER un plan en cours.
// Un plan ne s'interrompt que pour une vraie action — une etoile, une bleue, un
// bill, un tete-a-queue —, jamais parce qu'un autre kart est vaguement mieux
// place. Sans ce plancher en valeur, deux karts quelconques se renverraient la
// camera au rythme du plancher de duree.
const DIRECTOR_CUT_IN = 45;

// Et ce qu'il doit valoir DE PLUS que le plan en cours. Etre un peu plus
// interessant ne suffit pas : il faut l'etre nettement.
const DIRECTOR_TAKEOVER = 1.6;

// Un kart qu'on vient de quitter est minore le temps de ce delai : la
// realisation fait le tour du plateau au lieu de revenir sans cesse au meme.
const DIRECTOR_RECENT_MS = 9000;
const DIRECTOR_RECENT_FACTOR = 0.7;

// Distances de lecture, en unites de monde (1 unite = 1 px de rendu).
//
//   BLUE_LOCK  une bleue plus pres que ca d'un kart tourne au-dessus de lui.
//   CHASE      une carapace lancee a cette distance est une menace.
//   DUEL       deux karts a moins de ca tiennent dans le meme cadre.
const DIRECTOR_BLUE_LOCK_X = 110;
const DIRECTOR_CHASE_X = 220;
const DIRECTOR_DUEL_X = 120;
const DIRECTOR_DUEL_DEPTH = 12;

// Ce qui merite un plan, et de combien. Tout le reglage de la realisation tient
// dans cette table : la modifier change ce que la camera raconte, rien d'autre.
const DIRECTOR_WEIGHTS = {
    // Un bill traverse le peloton a contre-sens du classement. C'est le plan le
    // plus spectaculaire de la course, il passe devant tout.
    bill: 100,
    // La bleue est au-dessus de lui : il va etre souffle, on veut le voir.
    blueLock: 90,
    // Une bleue est en vol et personne n'est encore vise : elle va vers le
    // premier, on se place a l'arrivee plutot qu'a la poursuite.
    blueFlight: 55,
    // Le souffle lui-meme, pour les quelques images ou il couvre l'ecran.
    blast: 72,
    star: 60,
    // L'orage rapetisse tout le monde sauf celui qui l'a lance : c'est lui qui
    // traverse un peloton de miniatures.
    stormShooter: 65,
    // Le tete-a-queue vaut pour son debut ; la note fond avec lui (cf. `fresh`).
    hit: 45,
    bumped: 28,
    shrunk: 20,
    // Une bleue en main, c'est un plan a venir : on prend les devants.
    holdBlue: 40,
    holdBig: 24,
    chased: 34,
    duel: 26,
    leader: 12,
    lastLap: 14,
    // Les deux derniers tours (c'est la que commence la phase 'finishing') :
    // le premier encore en course y gagne le droit d'etre suivi. L'approche de
    // la ligne, elle, ne se joue plus aux notes — cf. la regle 4.
    finishing: 40
};

// Etat de la scene lu une fois par evaluation, plutot qu'une fois par kart :
// le balayage des objets est le seul travail non trivial de la realisation.
function directorScan(gameNow) {
    const scan = {
        blueTarget: null,
        blueInFlight: false,
        blastNear: null,
        chased: {},
        leadRunner: null
    };

    for (const item of worldState.items) {
        const blue = item.type === 'blueShell';
        const blast = item.type === 'blueBlast';
        const shell = item.type === 'greenShell' || item.type === 'redShell';
        if (!blue && !blast && !shell) continue;

        // Le kart le plus proche de l'objet, et lui seul : une carapace ne
        // menace pas tout un peloton, elle menace celui qu'elle rattrape.
        let nearest = null;
        let nearestGap = Infinity;
        for (const kart of worldState.karts) {
            if (kart.finished || kart.state === 'grid') continue;
            const gap = Math.abs(shortestDelta(kart.worldX, item.worldX));
            if (gap < nearestGap) {
                nearestGap = gap;
                nearest = kart;
            }
        }

        if (blue) {
            scan.blueInFlight = true;
            if (nearest && nearestGap < DIRECTOR_BLUE_LOCK_X) scan.blueTarget = nearest.id;
        } else if (blast) {
            if (nearest && nearestGap < (WORLD.blastRadius || 120)) scan.blastNear = nearest.id;
        } else if (nearest && nearestGap < DIRECTOR_CHASE_X) {
            scan.chased[nearest.id] = true;
        }
    }

    // Le premier encore en course. Pendant la phase d'arrivee, c'est lui qui va
    // couper la ligne : les karts deja arrives ne se filment plus.
    for (const kart of worldState.karts) {
        if (kart.finished || kart.state === 'grid') continue;
        if (!scan.leadRunner || kart.rank < scan.leadRunner.rank) scan.leadRunner = kart;
    }

    return scan;
}

// Ce qu'un kart vaut a l'ecran, maintenant. Zero = on ne le filme pas.
function directorScore(kart, scan, gameNow) {
    if (kart.finished || kart.state === 'grid') return 0;

    const W = DIRECTOR_WEIGHTS;
    let score = 0;

    if (kart.isBill) score += W.bill;
    if (scan.blueTarget === kart.id) score += W.blueLock;
    else if (scan.blueInFlight && kart.rank === 1) score += W.blueFlight;
    if (scan.blastNear === kart.id) score += W.blast;
    if (kart.isInvincible) score += W.star;
    if (scan.chased[kart.id]) score += W.chased;
    if (kart.bumped) score += W.bumped;
    if (kart.isShrunk) score += W.shrunk;

    // Le tete-a-queue perd son interet en tournant : ce qui se regarde, c'est
    // le moment ou il part, pas la fin de la toupie. `hitEndTime` et la duree du
    // malus donnent la fraction qu'il en reste, sans rien memoriser.
    if (kart.state === 'hit') {
        const left = kart.hitEndTime ? (kart.hitEndTime - gameNow) / (WORLD.hitDuration || 1) : 1;
        score += W.hit * (0.4 + 0.6 * Math.max(0, Math.min(1, left)));
    }

    const held = kart.heldItem;
    if (held) {
        if (held.type === 'blueShell') score += W.holdBlue;
        else if (held.type === 'star' || held.type === 'bill' || held.type === 'lightning') score += W.holdBig;
    }

    const storm = worldState.storm;
    if (storm && gameNow >= storm[1] && gameNow < storm[2] && storm[3] === kart.id) {
        score += W.stormShooter;
    }

    // La bagarre : un adversaire assez pres pour tenir dans le meme cadre, et a
    // la meme profondeur — deux karts separes par toute la largeur de la piste
    // se doublent sans se voir.
    for (const other of worldState.karts) {
        if (other === kart || other.finished || other.state === 'grid') continue;
        if (Math.abs(shortestDelta(kart.worldX, other.worldX)) > DIRECTOR_DUEL_X) continue;
        if (Math.abs(kart.yPercent - other.yPercent) > DIRECTOR_DUEL_DEPTH) continue;
        score += W.duel;
        break;
    }

    if (kart.rank === 1) score += W.leader;

    const lap = Math.floor(kart.totalDistance / WORLD.width) + 1;
    if (WORLD.laps && lap >= WORLD.laps) score += W.lastLap;
    if (worldState.phase === 'finishing' && scan.leadRunner === kart) score += W.finishing;

    return score;
}

const raceDirector = {
    // Active par defaut : un visiteur qui ne touche a rien doit avoir la
    // meilleure version du spectacle. Le premier clic sur un kart la coupe —
    // c'est lui qui realise, a partir de la.
    auto: true,

    // Debut de la phase de course, pour le compte a rebours du plan large.
    racingSince: 0,
    // Debut du plan en cours, plancher de duree compris.
    shotSince: 0,
    nextEvalAt: 0,
    // Quand la camera a quitte chaque kart, pour ne pas y revenir aussitot.
    leftAt: {},

    // Course neuve : les identifiants sont les memes mais les personnages ont
    // change, et les compteurs repartent de zero. Le mode, lui, ne se remet pas
    // tout seul : un spectateur qui a pris la main la garde.
    reset() {
        this.racingSince = 0;
        this.shotSince = 0;
        this.nextEvalAt = 0;
        this.leftAt = {};
    },

    setAuto(on) {
        this.auto = on;
        this.shotSince = 0;
        this.nextEvalAt = 0;
        updateFocusMarks();
    },

    // Un plan. Rien ne bouge si c'est deja celui qu'on a — l'appel tourne a
    // chaque image, il doit pouvoir ne rien faire.
    cut(kartId, gameNow) {
        if (kartId === focusedKartId) return;
        if (focusedKartId !== null) this.leftAt[focusedKartId] = gameNow;
        this.shotSince = gameNow;
        setFocus(kartId);
    },

    update(gameNow) {
        if (!this.auto) return;

        // Grille, classement, tableau des scores : le plan large est le seul qui
        // raconte quelque chose. La phase d'arrivee, elle, se realise encore.
        const phase = worldState.phase;
        if (phase !== 'racing' && phase !== 'finishing') {
            this.racingSince = 0;
            this.cut(null, gameNow);
            return;
        }

        if (!this.racingSince) this.racingSince = gameNow;
        if (gameNow - this.racingSince < DIRECTOR_WARMUP_MS) {
            this.cut(null, gameNow);
            return;
        }

        // L'arrivee ne se joue pas aux notes : c'est une sequence, et elle passe
        // devant tout, plancher de duree compris.
        //
        // Le drapeau sorti est le signal de l'approche REELLE de la ligne — la
        // phase 'finishing' commence deux tours plus tot et collerait la camera
        // au premier pendant tout ce temps.
        //
        // Puis, des la premiere arrivee, on lache le premier pour la vue par
        // defaut, qui EST la ligne : le serveur y a gare sa camera. Tous les
        // suivants passent donc dans ce cadre.
        if (phase === 'finishing' && worldState.sign && worldState.sign[0] === 'finish') {
            if (worldState.finishOrder.length > 0) {
                this.cut(null, gameNow);
                return;
            }

            let leader = null;
            for (const kart of worldState.karts) {
                if (kart.finished || kart.state === 'grid') continue;
                if (!leader || kart.rank < leader.rank) leader = kart;
            }
            if (leader) {
                this.cut(leader.id, gameNow);
                return;
            }
        }

        // Le plan tient, sauf s'il est devenu vide : un kart arrive ou disparu
        // ne se filme plus, et attendre le plancher montrerait la piste nue.
        const target = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
        const lost = focusedKartId !== null &&
                     (!target || target.finished || target.state === 'grid');
        // L'horloge du serveur peut reculer d'un coup au recalage (cf.
        // `stepClock`). Un plan commence « dans le futur » ne finirait jamais :
        // on le redate plutot que de figer la camera dessus.
        if (this.shotSince > gameNow) this.shotSince = gameNow;

        const held = gameNow - this.shotSince;
        if (focusedKartId !== null && !lost && held < DIRECTOR_MIN_HOLD_MS) return;

        if (gameNow < this.nextEvalAt) return;
        this.nextEvalAt = gameNow + DIRECTOR_EVAL_MS;

        const scan = directorScan(gameNow);

        // Le meilleur pretendant, le plan en cours mis a part : les deux ne se
        // comparent pas a la meme aune, et les melanger etait ce qui faisait
        // changer de plan des que le plancher tombait.
        let best = null;
        let bestScore = 0;
        let heldScore = 0;

        for (const kart of worldState.karts) {
            const score = directorScore(kart, scan, gameNow);

            if (kart.id === focusedKartId) {
                heldScore = score;
                continue;
            }
            if (score <= 0) continue;

            // Un kart qu'on vient de quitter part avec un handicap : la
            // realisation fait le tour du plateau au lieu d'y revenir.
            const since = this.leftAt[kart.id];
            const weighted = (since && gameNow - since < DIRECTOR_RECENT_MS)
                ? score * DIRECTOR_RECENT_FACTOR : score;

            if (weighted > bestScore) {
                bestScore = weighted;
                best = kart;
            }
        }

        // Rien a filmer : grille vide, tout le monde arrive. On garde ce qu'on a.
        if (!best) return;

        // Fin du plan large du depart. On part sur le meilleur, quel qu'il
        // soit : passe ce moment-la, la camera reste sur les karts. Le
        // defilement de base ne revient plus de lui-meme — un plan de coupe qui
        // ne montre personne n'est pas un repli, c'est un aveu.
        if (focusedKartId === null) {
            this.cut(best.id, gameNow);
            return;
        }

        // Plan devenu vide : le kart suivi est arrive ou a disparu. On repart
        // sur le meilleur sans rien exiger de lui — n'importe quel kart vaut
        // mieux que de filmer une place laissee libre.
        if (lost) {
            this.cut(best.id, gameNow);
            return;
        }

        // Sur un kart. Deux raisons d'en changer, et deux seulement : le plan a
        // fait son temps, ou quelqu'un fait nettement mieux ET fait vraiment
        // quelque chose. Hors de ces cas on RESTE — c'est le defaut, pas le
        // repli, et une course calme se regarde tres bien de derriere un kart.
        const stale = held > DIRECTOR_MAX_HOLD_MS;
        const beaten = bestScore >= DIRECTOR_CUT_IN &&
                       bestScore >= heldScore * DIRECTOR_TAKEOVER;

        if (!stale && !beaten) return;

        this.cut(best.id, gameNow);
    }
};
