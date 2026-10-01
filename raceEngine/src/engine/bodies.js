// Etat d'un corps : emprise, rapetissement, contact.

// Rapetisse a cet instant (la date fait foi, pas le drapeau).
function isShrunkAt(kart, now) {
    return kart.shrinkEndTime > now;
}

// Le contact entre karts est resolu dans road.js, apres le deplacement de tous.

// Demi-emprise propre au kart (taille de son sprite), reduite par l'eclair.
function kartHalfExtents(cfg, kart, now) {
    const body = cfg.bodies.kart[kart.charName] || cfg.bodies.ref;
    if (!isShrunkAt(kart, now)) return body;
    const f = cfg.lightning.scale;
    return { x: body.x * f, y: body.y * f };
}

// Ecart entre centres kart-objet, corrige du rapetissement (seule la
// demi-carrosserie du kart de reference rapetisse).
function shrunkReachX(cfg, box, kart, now) {
    if (!isShrunkAt(kart, now)) return box.x;
    return box.x - cfg.bodies.ref.x * (1 - cfg.lightning.scale);
}

function shrunkReachY(cfg, box, kart, now) {
    if (!isShrunkAt(kart, now)) return box.y;
    return box.y - cfg.bodies.ref.y * (1 - cfg.lightning.scale);
}

// Inertie de contact : masse (avec `massBias`) et vitesse. Le tete-a-queue et
// le bill sont des multiplicateurs d'etat ; deux bills s'annulent.
function contactInertia(cfg, kart) {
    const c = cfg.physics.contact;

    // Allure reelle du tick en fraction de la pointe, avec un plancher pour
    // qu'un recul ou un arret n'inverse pas le partage.
    const top = kart.stats.topSpeed;
    let pace = top > 0 ? kart.contactSpeed / top : 1;
    if (pace < c.speedClamp.min) pace = c.speedClamp.min;
    else if (pace > c.speedClamp.max) pace = c.speedClamp.max;

    const m = Math.pow(kart.stats.mass, c.massBias) * Math.pow(pace, c.speedBias);
    if (kart.isBill) return m * c.billMassFactor;
    return kart.state === 'hit' ? m * c.spinMassFactor : m;
}

// Tout kart lance participe au contact (hors grille).
function isContactActive(kart) {
    return kart.state === 'running' || kart.state === 'hit';
}

// Etoile et bill : intouchable et blessant au contact.
function isRamming(kart) {
    return kart.isInvincible || kart.isBill;
}

export {
    contactInertia,
    isContactActive,
    isRamming,
    isShrunkAt,
    kartHalfExtents,
    shrunkReachX,
    shrunkReachY,
};
