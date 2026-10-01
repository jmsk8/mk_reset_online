// Loi de braquage : ce que le volant d'un kart peut faire (appui, pointe,
// plafond, cout, portee, delai), sans etat ; les decisions sont dans driving.js.
//
// Une manoeuvre laterale est toujours une profondeur a rejoindre, la meme pour
// tous les karts ; seul le temps pour y arriver depend du kart (`steerReach`,
// `steerDelay`). Le reflexe (`ai.reactionBaseMs`, `physics.steer.response`) ne
// depend pas du kart, ses moyens si (`steerCap`).
//
// `vy` n'est ecrit sur ordre que par `steer` ; `clampKartToRoad` et
// `resolveKartPair` le contraignent, les chocs passent par `bumpVy`.

// Allure du kart en fraction de sa propre pointe (`contactSpeed` : deplacement
// reel du tick precedent).
function steerPace(kart) {
    const top = kart.stats.topSpeed;
    if (!(top > 0)) return 1;
    const pace = kart.contactSpeed / top;
    return pace < 0 ? 0 : (pace > 1 ? 1 : pace);
}

// Facteurs d'allure pour une allure donnee (instantanee, ou moyenne sur une
// manoeuvre dans `steerCapOver`).
function gripAt(cfg, pace) {
    const p = cfg.physics.steer.pace;
    if (!p.drag) return 1;
    return 1 - p.drag * Math.pow(pace, p.curve);
}

function biteAt(cfg, pace) {
    const bite = cfg.physics.steer.pace.bite;
    if (!(bite > 0)) return 1;
    return (pace >= bite) ? 1 : pace / bite;
}

// Volant restant a l'allure du moment (1 a l'arret, `1 - drag` a pleine pointe).
function steerGrip(cfg, kart) {
    return gripAt(cfg, steerPace(kart));
}

// Mordant du volant a l'allure du moment : nul a l'arret, plein au-dessus de `bite`.
function steerBite(cfg, kart) {
    return biteAt(cfg, steerPace(kart));
}

function steerCap(cfg, kart, base) {
    if (kart.isBill) return base;
    return base * kart.stats.agility * steerGrip(cfg, kart)
        * steerBite(cfg, kart) * kart.steerBoost;
}

// Mesures d'un plan sur sa fenetre (et non a l'instant, faux apres un choc).

// Temps en ms pour couvrir `dist` px a partir de la vitesse actuelle : montee a
// `accelerationRate` puis pointe (`topSpeed`, erreur du cote prudent).
function approachMs(cfg, kart, dist) {
    if (dist <= 0) return 0;

    const v = kart.absoluteVelocity > 0 ? kart.absoluteVelocity : 0;
    const top = kart.stats.topSpeed;
    const a = cfg.speeds.accelerationRate * kart.stats.acceleration;

    if (!(a > 0) || !(top > 0)) return (dist / Math.max(v, 1)) * 1000;
    if (v >= top) return (dist / top) * 1000;

    // Distance couverte pendant la montee en regime.
    const ramp = (top * top - v * v) / (2 * a);
    if (dist <= ramp) return ((Math.sqrt(v * v + 2 * a * dist) - v) / a) * 1000;

    return ((top - v) / a + (dist - ramp) / top) * 1000;
}

// Volant moyen dont disposera une manoeuvre sur sa fenetre (allure moyenne
// `dist / duree`), utile juste apres un arret. `steerCap` reste la valeur du
// tick en cours.
function steerCapOver(cfg, kart, base, dist, ms) {
    if (kart.isBill || ms <= 0 || !(kart.stats.topSpeed > 0)) {
        return steerCap(cfg, kart, base);
    }

    const mean = (dist / (ms / 1000)) / kart.stats.topSpeed;
    const pace = mean < 0 ? 0 : (mean > 1 ? 1 : mean);

    return base * kart.stats.agility * gripAt(cfg, pace) * biteAt(cfg, pace)
        * kart.steerBoost;
}

// Cout du braquage en vitesse (multiplicateur). La consigne est retrouvee en
// divisant `vy` par ce que `steerCap` rend pour 1, puis facturee a la tenue
// du kart (`stats.cornering`) et a l'allure.
function steerCost(cfg, kart) {
    const corner = cfg.physics.steer.corner;
    if (!corner.cost || !kart.vy || kart.isBill) return 1;

    const unit = steerCap(cfg, kart, 1);
    if (unit <= 0) return 1;

    // Consigne rapportee au plein braquage, sans dimension.
    const lock = Math.abs(kart.vy) / unit / corner.fullLock;

    const loss = corner.cost * lock * steerPace(kart) / kart.stats.cornering;
    return 1 - (loss > corner.maxLoss ? corner.maxLoss : loss);
}

// Volant du premier ordre (constante de temps `tau`) vers une consigne `cap` :
//
//     d(t) = cap * (t - tau * (1 - exp(-t / tau)))
//
// `steerReach` et `steerDelay` sont inverses l'une de l'autre (le moteur
// n'utilise que la premiere ; la seconde sert au banc de scenario).

// Distance laterale couverte en `ms` en partant a l'arret.
function steerReach(cfg, cap, ms) {
    if (ms <= 0) return 0;
    const t = ms / 1000;
    const tau = 1 / cfg.physics.steer.response;
    return cap * (t - tau * (1 - Math.exp(-t / tau)));
}

// Temps en ms pour couvrir `dy` en partant a l'arret (infini sans volant).
// Resolution de `u - 1 + exp(-u) = s` (u = t / tau, s = dy / (cap * tau)) par
// Newton, amorce sur `sqrt(2s)` ou `s + 1`.
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

export {
    approachMs,
    steerCap,
    steerCapOver,
    steerCost,
    steerDelay,
    steerGrip,
    steerPace,
    steerReach,
};
