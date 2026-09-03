// La loi de braquage : ce qu'un kart PEUT faire du volant. Sept fonctions, aucune
// dependance, aucun etat. Elles disent la capacite — l'appui, la pointe, le
// plafond, le cout, la portee, le delai — jamais l'intention : qui decide ou
// aller, c'est `driving.js`.
//
// LE MODELE. Une manoeuvre laterale est TOUJOURS une profondeur a rejoindre : la
// situation dit OU aller, et elle le dit pareil pour les huit karts. Ce qui les
// separe est le TEMPS qu'ils mettent a y arriver. Plusieurs manoeuvres
// calculaient autrefois une AMPLITUDE proportionnelle a l'agilite, si bien qu'un
// kart maniable n'allait pas seulement plus vite au meme endroit, il allait
// ailleurs.
//
// Corollaire : toute question de pilotage devient une question de temps, donc
// mesurable — `steerReach` et `steerDelay` y repondent par les deux bouts.
//
// LE REFLEXE NE DEPEND PAS DU KART. Deux etages, aucun ne regarde les stats : la
// latence de decision (`ai.reactionBaseMs`) et l'inertie du volant
// (`physics.steer.response`). Ses MOYENS, eux, tiennent dans `steerCap` : son
// agilite, et l'appui qui lui reste a l'allure du moment.
//
// QUI ECRIT `vy` : une seule fonction sur ordre, `steer`. Deux contraintes le
// reprennent sans rien commander — `clampKartToRoad` annule la composante
// sortante au bord, `resolveKartPair` reprend la part de volant qui pousse dans
// la carrosserie d'en face. Les chocs, eux, vivent dans `bumpVy`.
//
// Ajouter une manoeuvre : trouver la profondeur a viser, lui donner un profil
// dans `ai.steering`, appeler `steer`. Rien d'autre.

// Allure du kart, en fraction de sa propre pointe. Rapportee a SA pointe et non a
// une vitesse absolue : ce qui compte n'est pas de rouler vite dans l'absolu mais
// d'etre lance pour soi. `contactSpeed` est le deplacement reellement effectue au
// tick precedent — boosts, frottement et chocs y sont deja.
function steerPace(kart) {
    const top = kart.stats.topSpeed;
    if (!(top > 0)) return 1;
    const pace = kart.contactSpeed / top;
    return pace < 0 ? 0 : (pace > 1 ? 1 : pace);
}

// Ce qu'il reste de volant a l'allure du moment. Vaut 1 a l'arret, et
// `1 - drag` a pleine pointe.
function steerGrip(cfg, kart) {
    const pace = cfg.physics.steer.pace;
    if (!pace.drag) return 1;
    return 1 - pace.drag * Math.pow(steerPace(kart), pace.curve);
}

// Ce que le volant MORD a l'allure du moment.
//
// `steerGrip` dit ce qu'on perd de volant en etant lance, mais ne dit rien du bas
// de l'echelle — et il etait faux : a l'arret `grip` vaut 1, donc un kart
// IMMOBILE disposait de son volant MAXIMUM et repartait en crabe apres un choc.
//
// Deux mecaniques distinctes, donc : `drag` ce qu'on perd a FORCE d'aller vite,
// `bite` ce qu'on n'a pas encore FAUTE d'avancer. Au-dessus de `bite`, rien ne
// change.
function steerBite(cfg, kart) {
    const bite = cfg.physics.steer.pace.bite;
    if (!(bite > 0)) return 1;

    const pace = steerPace(kart);
    return (pace >= bite) ? 1 : pace / bite;
}

function steerCap(cfg, kart, base) {
    if (kart.isBill) return base;
    return base * kart.stats.agility * steerGrip(cfg, kart)
        * steerBite(cfg, kart) * kart.steerBoost;
}

// Ce que braquer coute en vitesse d'avance, en multiplicateur a appliquer tel
// quel. Appelee une fois, au seul endroit qui decide de la vitesse.
//
// LE PIEGE, et il invalide les formulations spontanees : `vy` n'est pas la
// manoeuvre demandee — `steerCap` y a mis l'agilite du kart, son appui a l'allure
// et son objet de vitesse. Facturer `|vy|` tel quel PUNIT l'agile ; ne retirer
// qu'une fois l'agilite S'ANNULE exactement.
//
// Deux temps, donc : retrouver la CONSIGNE en divisant par ce que `steerCap` rend
// pour une consigne de 1 — ce qui retire les trois facteurs d'un coup et suivra
// si un quatrieme arrive — puis la facturer a la tenue du kart
// (`stats.cornering`).
//
// L'allure entre aussi : tourner a l'arret ne coute rien. C'est ce qui en fait
// une contrainte de virage et non une taxe sur le volant.
function steerCost(cfg, kart) {
    const corner = cfg.physics.steer.corner;
    if (!corner.cost || !kart.vy || kart.isBill) return 1;

    const unit = steerCap(cfg, kart, 1);
    if (unit <= 0) return 1;

    // Consigne demandee, rapportee au plein braquage : sans dimension, et c'est
    // ce qui rend `cost` lisible en pourcentage.
    const lock = Math.abs(kart.vy) / unit / corner.fullLock;

    const loss = corner.cost * lock * steerPace(kart) / kart.stats.cornering;
    return 1 - (loss > corner.maxLoss ? corner.maxLoss : loss);
}

// La loi de braquage, et ses deux lectures. Le volant est un premier ordre de
// constante de temps `tau` : lache a l'arret vers une consigne `cap`, il couvre
//
//     d(t) = cap * (t - tau * (1 - exp(-t / tau)))
//
// `steerReach` rend `d` pour un `t`, `steerDelay` rend `t` pour un `d`. Elles
// sont exactement inverses l'une de l'autre et doivent le rester.
//
// Le moteur n'utilise que la premiere, pour une raison de cout : une portee se
// calcule une fois pour tous les candidats, un temps se calculerait par candidat.
// La seconde est exportee pour le banc de scenario, ou elle rend en clair la
// duree d'une manoeuvre kart par kart.

// Distance laterale couverte en `ms`, en partant a l'arret. Sur une reaction
// courte, une bonne part du trajet passe dans la montee en regime — le terme en
// `exp` — et c'est lui qui rend le calcul honnete pour un reflexe.
function steerReach(cfg, cap, ms) {
    if (ms <= 0) return 0;
    const t = ms / 1000;
    const tau = 1 / cfg.physics.steer.response;
    return cap * (t - tau * (1 - Math.exp(-t / tau)));
}

// Temps, en ms, pour couvrir `dy` en partant a l'arret ; infini si le kart n'a
// aucun volant a offrir.
//
// L'inversion n'a pas de forme fermee. En posant `u = t / tau` et `s = dy / (cap
// * tau)`, il s'agit de resoudre `u - 1 + exp(-u) = s`. Newton, amorce sur
// l'asymptote qui convient : `sqrt(2s)` quand le trajet tient dans la montee en
// regime, `s + 1` quand il la depasse. Quatre tours rendent l'inverse a la
// precision machine.
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
    steerCap,
    steerCost,
    steerDelay,
    steerGrip,
    steerPace,
    steerReach,
};
