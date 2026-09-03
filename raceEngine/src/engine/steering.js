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

// Les deux facteurs d'allure, pour une allure DONNEE. Tires de `steerGrip` et
// `steerBite` parce qu'ils repondent maintenant a deux questions distinctes : ce
// que le kart a sous les mains CET INSTANT, et ce dont une manoeuvre disposera en
// moyenne D'ICI A SON ECHEANCE (`steerCapOver`).
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

// Ce qu'il reste de volant a l'allure du moment. Vaut 1 a l'arret, et
// `1 - drag` a pleine pointe.
function steerGrip(cfg, kart) {
    return gripAt(cfg, steerPace(kart));
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
    return biteAt(cfg, steerPace(kart));
}

function steerCap(cfg, kart, base) {
    if (kart.isBill) return base;
    return base * kart.stats.agility * steerGrip(cfg, kart)
        * steerBite(cfg, kart) * kart.steerBoost;
}

// LES DEUX MESURES D'UN PLAN. Une manoeuvre laterale se juge sur une fenetre —
// combien de temps me reste-t-il, et de quel volant y disposerai-je — et les deux
// se lisaient jusqu'ici sur l'instant. C'est exact tant que rien ne change ; ca
// devient faux precisement quand la question se pose, c'est-a-dire apres un choc.

// Temps, en ms, pour couvrir `dist` px de piste, en partant de la vitesse du
// moment et sous l'acceleration du kart.
//
// `dist / vitesse` ne vaut que si la vitesse ne change pas. Un kart qui vient de
// heurter un tuyau est A ZERO : la division rendait alors quatre-vingt-dix
// SECONDES de fenetre pour les quatre-vingt-dix pixels de son recul, et tout
// couloir de la piste paraissait atteignable. Le kart s'engageait vers l'autre
// cote, redemarrait, et se recognait au meme endroit sans avoir traverse.
//
// Deux regimes, comme dans le moteur : la montee a `accelerationRate`, puis la
// pointe. Le plafond est `topSpeed` et non l'elan du moment — surestimer la
// vitesse RACCOURCIT la fenetre, donc rend moins de portee laterale : l'erreur
// tombe du cote prudent.
function approachMs(cfg, kart, dist) {
    if (dist <= 0) return 0;

    const v = kart.absoluteVelocity > 0 ? kart.absoluteVelocity : 0;
    const top = kart.stats.topSpeed;
    const a = cfg.speeds.accelerationRate * kart.stats.acceleration;

    if (!(a > 0) || !(top > 0)) return (dist / Math.max(v, 1)) * 1000;
    if (v >= top) return (dist / top) * 1000;

    // Ce que la montee en regime couvre a elle seule.
    const ramp = (top * top - v * v) / (2 * a);
    if (dist <= ramp) return ((Math.sqrt(v * v + 2 * a * dist) - v) / a) * 1000;

    return ((top - v) / a + (dist - ramp) / top) * 1000;
}

// Le volant dont une manoeuvre disposera EN MOYENNE sur sa fenetre, et non celui
// que le kart a cet instant.
//
// Les deux se separent des qu'il vient d'etre arrete. `steerBite` annule le
// volant a l'arret, et il a raison — on ne braque pas une voiture immobile. Mais
// un PLANIFICATEUR qui lit ce zero en conclut qu'aucun couloir n'est atteignable
// : `steerReach` rend 0, `steerDelay` rend l'infini, et `chooseLane` n'a plus
// une seule option finie a proposer. Il repondait « nulle part » la ou la reponse
// etait « pas encore ».
//
// L'allure retenue est celle du trajet — `dist / duree` — soit la moyenne exacte
// sur la fenetre. Elle ne remplace pas `steerCap` : celui-ci reste seul a dire ce
// que `steer` peut commander sur le tick en cours.
function steerCapOver(cfg, kart, base, dist, ms) {
    if (kart.isBill || ms <= 0 || !(kart.stats.topSpeed > 0)) {
        return steerCap(cfg, kart, base);
    }

    const mean = (dist / (ms / 1000)) / kart.stats.topSpeed;
    const pace = mean < 0 ? 0 : (mean > 1 ? 1 : mean);

    return base * kart.stats.agility * gripAt(cfg, pace) * biteAt(cfg, pace)
        * kart.steerBoost;
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
    approachMs,
    steerCap,
    steerCapOver,
    steerCost,
    steerDelay,
    steerGrip,
    steerPace,
    steerReach,
};
