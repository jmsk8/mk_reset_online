// Realisation automatique : choisit le kart suivi par la camera d'apres un score
// tire du snapshot.
//   1. Le depart se regarde en vue d'ensemble.
//   2. Un plan dure au moins DIRECTOR_MIN_HOLD_MS (sauf s'il devient vide).
//   3. On passe au plan le plus fort, sans revenir au defilement de base.
//   4. L'arrivee est une sequence prioritaire sur le reste.

// Duree de la vue d'ensemble au depart.
const DIRECTOR_WARMUP_MS = 6000;

// Duree minimale d'un plan.
const DIRECTOR_MIN_HOLD_MS = 7000;

// Duree maximale d'un plan, meme s'il garde la meilleure note.
const DIRECTOR_MAX_HOLD_MS = 15000;

// Intervalle entre deux evaluations.
const DIRECTOR_EVAL_MS = 300;

// Note minimale d'un pretendant pour couper un plan en cours.
const DIRECTOR_CUT_IN = 45;

// Rapport minimal de sa note sur celle du plan en cours.
const DIRECTOR_TAKEOVER = 1.6;

// Duree pendant laquelle un kart qu'on vient de quitter est minore.
const DIRECTOR_RECENT_MS = 9000;
const DIRECTOR_RECENT_FACTOR = 0.7;

// Distances en unites de monde :
//   BLUE_LOCK  une bleue plus pres d'un kart tourne au-dessus de lui
//   CHASE      distance a laquelle une carapace est une menace
//   DUEL       deux karts plus proches tiennent dans le meme cadre
const DIRECTOR_BLUE_LOCK_X = 110;
const DIRECTOR_CHASE_X = 220;
const DIRECTOR_DUEL_X = 120;
const DIRECTOR_DUEL_DEPTH = 12;

// Poids de chaque situation dans le score d'un kart.
const DIRECTOR_WEIGHTS = {
    bill: 100,
    blueLock: 90,
    // Bleue en vol sans cible : on se place sur le premier.
    blueFlight: 55,
    blast: 72,
    star: 60,
    // Lanceur de l'orage, seul a garder sa taille.
    stormShooter: 65,
    // Valeur qui decroit avec la toupie.
    hit: 45,
    bumped: 28,
    shrunk: 20,
    holdBlue: 40,
    holdBig: 24,
    chased: 34,
    duel: 26,
    leader: 12,
    lastLap: 14,
    // Deux derniers tours (phase 'finishing') : le premier encore en course.
    finishing: 40
};

// Etat de la scene lu une fois par evaluation.
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

        // Seul le kart le plus proche est menace.
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

    // Le premier encore en course.
    for (const kart of worldState.karts) {
        if (kart.finished || kart.state === 'grid') continue;
        if (!scan.leadRunner || kart.rank < scan.leadRunner.rank) scan.leadRunner = kart;
    }

    return scan;
}

// Note d'un kart a l'ecran, maintenant (0 = pas filme).
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

    // Le tete-a-queue perd son interet a mesure que la toupie avance.
    if (kart.state === 'hit') {
        const left = kart.hitEndTime
            ? (kart.hitEndTime - gameNow) / (kart.hitDuration || WORLD.hitDuration || 1) : 1;
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

    // Duel : adversaire proche et a la meme profondeur.
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
    // Active par defaut ; un clic sur un kart la coupe pour la course, le
    // bouton camera la remet.
    auto: true,

    racingSince: 0,
    shotSince: 0,
    nextEvalAt: 0,
    leftAt: {},

    // Course neuve : compteurs remis a zero et realisation automatique reactivee.
    reset() {
        this.racingSince = 0;
        this.nextEvalAt = 0;
        this.leftAt = {};
        this.setAuto(true);
    },

    setAuto(on) {
        this.auto = on;
        this.shotSince = 0;
        this.nextEvalAt = 0;
        updateFocusMarks();
    },

    // Ne fait rien si le plan demande est deja en cours.
    cut(kartId, gameNow) {
        if (kartId === focusedKartId) return;
        if (focusedKartId !== null) this.leftAt[focusedKartId] = gameNow;
        this.shotSince = gameNow;
        setFocus(kartId);
    },

    update(gameNow) {
        if (!this.auto) return;

        // Grille, classement, tableau des scores : plan large.
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

        // Arrivee : on suit le premier a l'approche de la ligne (drapeau sorti),
        // puis on passe a la vue par defaut, garee sur la ligne.
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

        // Un plan devenu vide (kart arrive ou disparu) ne tient plus.
        const target = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
        const lost = focusedKartId !== null &&
                     (!target || target.finished || target.state === 'grid');
        // Horloge recalee en arriere : on redate le plan.
        if (this.shotSince > gameNow) this.shotSince = gameNow;

        const held = gameNow - this.shotSince;
        if (focusedKartId !== null && !lost && held < DIRECTOR_MIN_HOLD_MS) return;

        if (gameNow < this.nextEvalAt) return;
        this.nextEvalAt = gameNow + DIRECTOR_EVAL_MS;

        const scan = directorScan(gameNow);

        // Meilleur pretendant, hors plan en cours.
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

            // Handicap pour un kart quitte recemment.
            const since = this.leftAt[kart.id];
            const weighted = (since && gameNow - since < DIRECTOR_RECENT_MS)
                ? score * DIRECTOR_RECENT_FACTOR : score;

            if (weighted > bestScore) {
                bestScore = weighted;
                best = kart;
            }
        }

        if (!best) return;

        // Fin du plan large du depart : on part sur le meilleur.
        if (focusedKartId === null) {
            this.cut(best.id, gameNow);
            return;
        }

        // Plan devenu vide : on repart sur le meilleur.
        if (lost) {
            this.cut(best.id, gameNow);
            return;
        }

        // On change si le plan a fait son temps, ou si un pretendant fait
        // nettement mieux et agit vraiment.
        const stale = held > DIRECTOR_MAX_HOLD_MS;
        const beaten = bestScore >= DIRECTOR_CUT_IN &&
                       bestScore >= heldScore * DIRECTOR_TAKEOVER;

        if (!stale && !beaten) return;

        this.cut(best.id, gameNow);
    }
};
