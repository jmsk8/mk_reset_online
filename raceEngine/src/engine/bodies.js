// L'etat d'un corps : son emprise, son rapetissement, son contact.
// Repond a « quelle place ce kart prend-il, maintenant ? », question posee
// aussi bien par les tuyaux que par les collisions ou la vue.

// Rapetisse a l'instant present. La date fait foi et non le drapeau : celui-ci
// n'est rafraichi qu'une fois par tick, avant les contacts, et un kart qui
// regrossit pile pendant la passe doit deja compter comme grand.
function isShrunkAt(kart, now) {
    return kart.shrinkEndTime > now;
}

// Le CONTACT ENTRE KARTS se resout dans `road.js`, en une passe a part jouee
// apres que tous les karts ont bouge — sinon un kart est pousse contre un
// adversaire qui n'a pas encore avance, et le resultat depend de l'ordre du
// tableau.
//
// Ce fichier fournit ce que cette passe mesure : l'emprise d'un corps, son
// rapetissement, son inertie.

// Demi-emprise d'un kart, et elle lui est PROPRE : elle vient de la taille de son
// sprite, pas d'une constante commune. Deux karts au contact somment leurs deux
// emprises, si bien qu'un long et un court ne se touchent pas au meme ecart.
//
// Un kart rapetisse est dessine a `lightning.scale` : son emprise l'est aussi,
// sur les deux axes. Un objet du monde qui a l'air petit doit toucher petit —
// sans ca, un kart reduit se faisait arreter par un mur qu'il venait visiblement
// de franchir.
//
// Le repli sur le kart de reference ne devrait jamais servir, la config refusant
// de charger sans mesure. Le chemin rapide ne fabrique rien : hors rapetissement,
// l'objet de la config ressort tel quel.
function kartHalfExtents(cfg, kart, now) {
    const body = cfg.bodies.kart[kart.charName] || cfg.bodies.ref;
    if (!isShrunkAt(kart, now)) return body;
    const f = cfg.lightning.scale;
    return { x: body.x * f, y: body.y * f };
}

// Un ecart entre centres KART-OBJET, corrige du rapetissement. `box` est l'ecart
// regle pour un kart de taille normale, soit la demi-emprise de l'objet PLUS une
// demi-carrosserie : seule la seconde a rapetisse.
//
// La carrosserie retiree est celle du kart de REFERENCE, et non celle de ce
// kart-ci : les emprises d'objets sont reglees a la main et n'ont jamais suivi le
// gabarit des personnages. A taille normale, la valeur reglee ressort intacte.
function shrunkReachX(cfg, box, kart, now) {
    if (!isShrunkAt(kart, now)) return box.x;
    return box.x - cfg.bodies.ref.x * (1 - cfg.lightning.scale);
}

function shrunkReachY(cfg, box, kart, now) {
    if (!isShrunkAt(kart, now)) return box.y;
    return box.y - cfg.bodies.ref.y * (1 - cfg.lightning.scale);
}

// Ce qu'un kart oppose a un choc n'est pas sa masse mais son INERTIE, masse et
// vitesse ensemble.
//
// La masse seule ne pouvait pas dire ce qu'un choc a de plus evident — un kart
// sous champignon tapait plus fort mais recevait sa part comme s'il etait a
// l'arret. La vitesse manquait des deux cotes de la balance.
//
// `massBias` reouvre l'ecart de poids sans toucher a la masse elle-meme, qui sert
// aussi a l'acceleration et a la maniabilite. Meme forme que `massDragAccel` : un
// exposant, donc un pivot autour de la masse 1.

// Les deux facteurs d'etat sont des multiplicateurs poses par-dessus et non des
// termes de l'exposant : ils decrivent une situation, pas un gabarit.
//
//   TETE-A-QUEUE  un kart en toupie ne pilote plus : il fait obstacle plutot
//                 qu'il ne se laisse pousser.
//   BILL          ce n'est plus un kart mais un projectile. Ca se dit ici et
//                 nulle part ailleurs — par le seul chiffre qui decide qui
//                 cede a qui — donc les trois effets d'un contact suivent
//                 d'un coup.
//
// Deux bills portent le meme facteur : il s'annule entre eux, et un bill reste la
// seule chose qui devie un bill sans qu'on ait a l'ecrire.
function contactInertia(cfg, kart) {
    const c = cfg.physics.contact;

    // Allure du moment, en fraction de la pointe du kart. `contactSpeed` est
    // le deplacement reellement effectue sur le tick : boosts, frottement de
    // mur et chocs en cours y sont deja, il n'y a rien a recomposer. Le
    // garde-fou n'est pas un reglage — il empeche le recul d'un tuyau (qui
    // rend une vitesse negative) d'inverser le partage, et un kart a l'arret
    // de devenir un fantome que tout traverse.
    const top = kart.stats.topSpeed;
    let pace = top > 0 ? kart.contactSpeed / top : 1;
    if (pace < c.speedClamp.min) pace = c.speedClamp.min;
    else if (pace > c.speedClamp.max) pace = c.speedClamp.max;

    const m = Math.pow(kart.stats.mass, c.massBias) * Math.pow(pace, c.speedBias);
    if (kart.isBill) return m * c.billMassFactor;
    return kart.state === 'hit' ? m * c.spinMassFactor : m;
}

// Une toupie n'est plus un fantome : elle bouscule et se fait bousculer
// comme n'importe qui. Seul l'etat 'grid' — et un kart pas encore lance —
// reste hors de la passe.
function isContactActive(kart) {
    return kart.state === 'running' || kart.state === 'hit';
}

// Etoile et bill sont le meme etat vu de la physique : intouchable, et
// blessant au contact. Toutes les collisions posent cette question-la, jamais
// « a-t-il une etoile » — sans quoi chaque nouvel objet de ce genre obligerait
// a repasser sur les huit sites de collision.
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
