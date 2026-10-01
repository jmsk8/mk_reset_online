// Corps des karts : mesures des sprites (`scripts/sprite-metrics.py`) et
// emprises qui en decoulent, calculees par `deriveBodies`.

export function deriveBodies(cfg) {
    const b = cfg.bodies;
    const names = Object.keys(b.sprite.kart);

    // Tout personnage doit etre mesure ; `wheels` manquant donnerait NaN.
    for (const n of Object.keys(cfg.kartStats.characters)) {
        const sprite = b.sprite.kart[n];
        if (!sprite || !(sprite.w > 0) || !(sprite.wheels > 0)) {
            throw new Error(`bodies.sprite.kart : ${n} n'a pas de mesure `
                + 'complete (w, h, wheels). Relancer '
                + '`python3 scripts/sprite-metrics.py` et recopier le bloc.');
        }
    }

    // Sprite de reference : moyenne de `referenceKarts`.
    const refNames = b.referenceKarts;
    for (const n of refNames) {
        if (!b.sprite.kart[n]) {
            throw new Error(`bodies.referenceKarts : ${n} n'a pas de mesure `
                + 'dans bodies.sprite.kart.');
        }
    }
    let sumW = 0;
    let sumWheels = 0;
    for (const n of refNames) {
        sumW += b.sprite.kart[n].w;
        sumWheels += b.sprite.kart[n].wheels;
    }
    const refW = sumW / refNames.length;
    const refWheels = sumWheels / refNames.length;

    // Px de demi-emprise par px de sprite (facteur commun).
    const perPx = (b.kartDraw * b.fill * 0.5) / refW;

    // Profondeur du kart de reference ; les autres au prorata de `wheels`.
    const refHalfY = (refW * perPx) / (b.flatten * b.depthPx);

    const bodyOf = (w, wheels) => ({
        // Longueur : largeur du fichier, a l'echelle du monde.
        x: w * perPx,
        // Largeur : ecart roue a roue, rapporte a celui du kart de reference.
        y: refHalfY * (wheels / refWheels),
        // Rapport du dessin au kart de reference (longueur seulement), multiplie
        // par le client.
        scale: w / refW
    });

    b.refSpriteW = refW;
    b.refSpriteWheels = refWheels;
    b.ref = bodyOf(refW, refWheels);
    b.kart = {};
    for (const n of names) {
        b.kart[n] = bodyOf(b.sprite.kart[n].w, b.sprite.kart[n].wheels);
    }

    // Tuyau : longueur dessinee propre (67.2 au lieu de 84) et profondeur prise
    // sur sa longueur, car il est rond (pas de `flatten`).
    const pipeHalfX = b.pipeDraw * b.pipeFill * 0.5;
    cfg.pipe.hitbox = { x: pipeHalfX, y: pipeHalfX / b.depthPx };
    cfg.pipe.draw = {
        w: b.pipeDraw,
        // Hauteur selon les proportions du fichier.
        h: b.pipeDraw * b.sprite.pipe.h / b.sprite.pipe.w
    };

    // Ecarts entre centres pour le kart de reference (perception, validation de
    // piste) ; le contact reel passe par `kartHalfExtents`.
    cfg.hitboxes.kartVsKart = { x: b.ref.x * 2, y: b.ref.y * 2 };
    cfg.hitboxes.kartVsPipe = {
        x: cfg.pipe.hitbox.x + b.ref.x,
        y: cfg.pipe.hitbox.y + b.ref.y
    };

    // Idem pour l'objet.
    cfg.hitboxes.itemVsKart = {
        x: b.item.x + b.ref.x,
        y: b.item.y + b.ref.y
    };
    cfg.hitboxes.orbitItemVsKart = {
        x: cfg.hitboxes.itemVsKart.x,
        y: cfg.hitboxes.itemVsKart.y + b.orbitSlack
    };

    return cfg;
}

export default {
    // Participants : `perRace` karts tires parmi les personnages a `true`, a
    // l'ouverture d'un grand prix (les memes pour toutes ses manches). Tout
    // personnage de `kartStats.characters` doit figurer ici. Equivalent C++ :
    // `enabled` et `kartCount` dans raceEngineCpp/src/config/config.hpp.
    roster: {
        perRace: 8,
        enabled: {
            bowser: true,
            dk:     true,
            mario:  true,
            birdo:  true,
            luigi:  true,
            yoshi:  true,
            peach:  true,
            daisy:  true,
            toad:   true,
            koopa:  true
        }
    },

    kartStats: {
        budget: 15,
        minPoints: 0,
        maxPoints: 10,

        mass:  { min: 0.72, max: 1.25 },
        force: { min: 0.85, max: 1.40 },
        grip:  { min: 0.45, max: 1.32 },

        // Forme de l'axe handling : `grip = lerp(min, max, handling ^ gripCurve)`.
        // Koopa (reference) doit rester a une agilite de 1.548. Reperes Mario /
        // Bowser a massDragAgility 1.70 :
        //     curve 1.6 min 0.62 max 1.28 -> 0.905 / 0.475 (x3.26)
        //     curve 2.5 min 0.45 max 1.32 -> 0.619 / 0.334 (x4.64)
        //     curve 2.8 min 0.40 max 1.36 -> 0.553 / 0.296 (x5.23)
        gripCurve: 2.5,

        // `acceleration = force / masse ^ massDragAccel` (pivot a la masse 1).
        // Au-dela de ~1.5, les lourds deviennent injouables apres les tuyaux.
        massDragAccel: 1.0,

        // Garde-fou, ne doit pas mordre sur le plateau actuel.
        accelClamp: { min: 0.75, max: 1.85 },

        // `agilite = grip / masse ^ massDragAgility` ; 1.70 est le plafond
        // pratique (au-dela, Toad repasse devant Koopa).
        massDragAgility: 1.70,
        // Garde-fou, ne doit pas mordre sur le plateau actuel.
        agilityClamp: { min: 0.25, max: 1.70 },

        // `cornering = handling ^ cornerGripGain * puissance ^ cornerPowerGain
        //                / poids ^ cornerMassDrag`
        // Cout du braquage en vitesse (`steerCost`), independant de la vitesse
        // a laquelle le kart tourne (`massDragAgility`).

        // Ecart de tenue en virage entre lourds et legers (pivot a la masse 1) :
        // le rapport entre deux karts est multiplie par
        // `(masse_lourd / masse_leger) ^ ecart d'exposant`.
        cornerMassDrag: 5.00,

        // Effet du handling sur ce cout (deja courbe par `gripCurve`).
        cornerGripGain: 1.0,

        // Effet de la puissance sur ce cout (levier doux).
        cornerPowerGain: 1.0,

        // `topSpeed = speedBase + speedPerWeight * poids + speedPerPower *
        // puissance` (axes normalises dans [0, 1]), en px/s. Reglage tres
        // sensible : ~0.5 point de taux de victoire par px/s d'ecart ; 1 s de
        // course vaut ~4.5 px/s de pointe.
        speedBase: 490,
        speedPerWeight: 35,
        speedPerPower: 10,

        // Stats calees sur Mario Kart 8 Deluxe (poids, acceleration,
        // maniabilite). L'ordre des cles fixe le tirage du roster.
        characters: {
            bowser: { weight: 9, power: 5, handling: 1 },
            // Plus proche de Mario que de Bowser dans MK8D.
            dk:     { weight: 7, power: 5, handling: 3 },
            mario:  { weight: 5, power: 5, handling: 5 },
            // Yoshi, Birdo et Peach ont les memes stats dans MK8D.
            birdo:  { weight: 4, power: 5, handling: 6 },
            // Mario avec un cran de maniabilite pris sur la puissance.
            luigi:  { weight: 5, power: 4, handling: 6 },
            yoshi:  { weight: 4, power: 5, handling: 6 },
            peach:  { weight: 4, power: 5, handling: 6 },
            // Un peu plus legere que Peach.
            daisy:  { weight: 3, power: 5, handling: 7 },
            toad:   { weight: 2, power: 5, handling: 8 },
            koopa:  { weight: 2, power: 4, handling: 9 }
        }
    },

    // Mesures des sprites et loi des emprises (appliquee par `deriveBodies()`).
    bodies: {
        // Mesures des fichiers, regenerees par `python3 scripts/sprite-metrics.py`
        // (taille des karts : `python3 scripts/resize-karts.py`).
        //   w / h    cadre de la pose de course (`side-right`)
        //   wheels   largeur roue a roue, lue sur le sprite de dos (`back`)
        sprite: {
            kart: {
                bowser: { w: 123, h: 137, wheels: 124 },
                dk:     { w: 123, h: 128, wheels: 117 },
                mario:  { w: 112, h: 119, wheels: 112 },
                birdo:  { w: 106, h: 137, wheels: 106 },
                luigi:  { w: 111, h: 123, wheels: 111 },
                yoshi:  { w: 119, h: 122, wheels: 112 },
                peach:  { w: 112, h: 124, wheels: 112 },
                daisy:  { w: 112, h: 128, wheels: 112 },
                toad:   { w:  95, h: 103, wheels:  96 },
                koopa:  { w:  95, h:  98, wheels:  95 }
            },
            pipe: { w: 95, h: 124 }
        },

        // Karts dont la moyenne fait le kart de reference, figes pour qu'un
        // ajout ou le roster ne redimensionne pas les autres.
        referenceKarts: ['bowser', 'dk', 'mario', 'luigi', 'yoshi', 'peach', 'toad', 'koopa'],

        // Longueur dessinee du kart de reference en px de monde (identique a
        // `GAME_CONFIG.rendering.kartWidth` cote client).
        kartDraw: 100,

        // Longueur dessinee du tuyau en px de monde (20 % sous l'echelle commune).
        pipeDraw: 67.2,

        // Part de la longueur dessinee qui touche reellement (karts seulement).
        fill: 0.75,

        // Part du tuyau qui touche : le fut, plus etroit que la collerette.
        pipeFill: 0.65,

        // Aplatissement du kart de reference vu de dessus (px de longueur par px
        // de profondeur) ; choix de jeu pour pouvoir rouler cote a cote.
        flatten: 10 / 3,

        // Px a l'ecran par unite de profondeur (35 unites pour 126 px sur PC).
        depthPx: 3.6,

        // Emprise propre d'un objet au sol, reglee a la main.
        item: { x: 10, y: 2.5 },

        // Supplement de profondeur d'un objet en orbite (oscillation).
        orbitSlack: 3
    },

    hitboxes: {
        // Les hitboxes sont des ecarts entre centres, posees par `deriveBodies()` :
        //     kartVsKart       { x: 60, y: 5 }
        //     itemVsKart       { x: 40, y: 5 }   objet + demi-carrosserie
        //     kartVsPipe       { x: 50.16, y: 5.3 }   tuyau + demi-carrosserie
        //     orbitItemVsKart  { x: 40, y: 8 }   itemVsKart + `bodies.orbitSlack`
        // `itemBox` est une zone de ramassage pour le centre d'un kart.
        itemBox: { x: 10, y: 8 }
    },
};
