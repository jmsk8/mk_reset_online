// Constantes de rendu du banner SMK : de l'apparence, et rien d'autre. Ce qui
// decrit le monde simule vit dans le service `race`, qui en transmet le strict
// necessaire dans son `hello` (voir WORLD plus bas, et
// docs/banner/architecture.md).
//
// L'eclair n'a pas d'asset : il est dessine ici en SVG, et c'est une source
// d'image comme une autre.
const LIGHTNING_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 32">' +
    '<path d="M15 1 L4 18 L10 18 L8 31 L20 12 L13 12 Z" fill="#ffcf1a" ' +
    'stroke="#4a3300" stroke-width="2.5" stroke-linejoin="round"/>' +
    '<path d="M13.5 6 L8 16.5 L11.5 16.5 L10 24 L16.5 13.5 L12 13.5 Z" fill="#fff6b0"/>' +
    '</svg>';

const LIGHTNING_SRC = 'data:image/svg+xml,' + encodeURIComponent(LIGHTNING_SVG);

const GAME_CONFIG = {
    debugMode: false,

    resources: {
        characters: ['mario', 'luigi', 'peach', 'toad', 'yoshi', 'bowser', 'dk', 'koopa'],
        initials: { 'mario': 'M', 'luigi': 'L', 'peach': 'P', 'toad': 'T', 'yoshi': 'Y', 'bowser': 'B', 'dk': 'D', 'koopa': 'K' },
        // Les 5 orientations disponibles en asset. Les 3 manquantes pour un 360
        // complet (sud-ouest, ouest, nord-ouest) sont obtenues en miroir.
        kartDirections: ['side-right', 'front-right', 'front', 'back-right', 'back'],
        paths: {
            char: (name) => `static/img/${name}/${name}-asset-anime/${name}-side-right.png`,
            charFrame: (name, dir) => `static/img/${name}/${name}-asset-anime/${name}-${dir}.png`,
            pp: (name) => `static/img/${name}/${name}-pp.png`,
            greenShell: (frame) => `static/img/items/green-shell/green-shell${frame}.png`,
            redShell: (frame) => `static/img/items/red-shell/red-shell${frame}.png`,
            blueShell: (frame) => `static/img/items/blue-shell/${frame}.png`,
            lakitu: (group, frame) => `static/img/lakitu/${group}/${frame}.png`,
            banana: 'static/img/items/banana/banana.png',
            shroom: 'static/img/items/shroom/shroom.png',
            star: 'static/img/items/star/star.png',
            lightning: LIGHTNING_SRC,
            bill: (frame) => `static/img/items/bill-ball/${frame}.png`
        }
    },
    rendering: {
        bufferZone: 200,
        zIndexBase: 400,
        mobileBreakpoint: 769,
        // Miroir de `.kart-container-moving` en CSS. Le sprite est centre sur la
        // position du kart, qui est aussi le centre de sa hitbox : c'est la
        // demi-largeur qui sert.
        //
        // C'est la largeur du kart de REFERENCE : chaque kart la multiplie par le
        // `scale` que le serveur envoie, tire de la taille de son PNG. Tout
        // ramener a 100 px dessinait dk exactement aussi long que koopa.
        //
        // Ce qui reste ici est le DESSIN seul, d'ou les deux valeurs — la hitbox,
        // elle, ne depend pas de l'appareil.
        kartWidth: { pc: 100, mobile: 80 },

        // Levitation decorative des item-boxes : amplitude en px, vitesse en
        // radians par ms. Aucun effet sur la simulation.
        boxFloat: { amplitude: 10, speed: 0.003 }
    },
    offsets: {
        // Rendu uniquement, jamais lu par la physique.
        render: {
            // Il y avait ici un `heldItemBehind`, decalage de DESSIN de l'objet
            // traine. Il n'y en a plus : un objet traine a une emprise, testee
            // par le moteur a `worldX + heldBehindX`, et cette valeur-la vient
            // du serveur (WORLD.hitboxes.heldBehindX). Un reglage de rendu en
            // face n'aurait fait qu'une chose : dessiner l'objet a cote de ce
            // qui touche.
            heldItemHands: { x: { pc: 28, mobile: 18 }, yShift: { pc: 30, mobile: 25 } },
            // Abaissement de l'orbite, en pixels vers le bas. Au point le plus
            // recule l'objet monte de radiusY au-dessus des roues et donne
            // l'impression de leviter ; ce decalage le ramene au ras du sol sur
            // toute la rotation. Purement visuel : la hitbox suit toujours la
            // position monde calculee par getOrbitItemPosition().
            orbitDrop: { pc: 10, mobile: 8 }
        }
    },
    visuals: {
        greenShell: { width: 48, widthMobile: 32 },
        redShell: { width: 48, widthMobile: 32 },
        blueShell: { width: 58, widthMobile: 40 },
        banana: { width: 32, widthMobile: 28 },
        shroom: { width: 36, widthMobile: 26 },
        star: { width: 36, widthMobile: 26 },
        lightning: { width: 30, widthMobile: 22 },
        bill: { width: 69, widthMobile: 51 },
        box: { sizePC: 42, sizeMobile: 42 },
        // La taille du tuyau N'EST PLUS ICI : elle vient du serveur
        // (WORLD.pipeDraw), parce que c'est elle qui decide de son emprise —
        // `pipe.hitbox` en est une fraction fixe. Une largeur de dessin qui
        // arrete un kart est une valeur du monde, pas d'apparence. Le repli hors
        // ligne se lit dans OFFLINE_WORLD, avec les autres.
        // Taille du souffle : voir WORLD.blastRadius, transmis par le serveur.
    },
    // Tête-à-queue joué pendant l'état 'hit'. La durée du malus n'est pas
    // configurable ici : elle reste delays.hitDecelDuration + hitPauseDuration.
    // durationRatio ne règle que la vitesse de la toupie, en la jouant sur une
    // fraction de ce malus ; le kart tient ensuite side-right jusqu'au départ.
    // Baisser = plus rapide (0.8 = 2 tours en 1600 ms, soit 100 ms/frame).
    kartSpin: {
        turns: 2,
        durationRatio: 0.8,
        // Un tour complet dans le sens horaire depuis side-right (est).
        // mirror: true = scaleX(-1) sur l'asset "droite" équivalent.
        frames: [
            { dir: 'side-right',  mirror: false }, // est
            { dir: 'front-right', mirror: false }, // sud-est
            { dir: 'front',       mirror: false }, // sud
            { dir: 'front-right', mirror: true  }, // sud-ouest
            { dir: 'side-right',  mirror: true  }, // ouest
            { dir: 'back-right',  mirror: true  }, // nord-ouest
            { dir: 'back',        mirror: false }, // nord
            { dir: 'back-right',  mirror: false }  // nord-est
        ]
    }
};

// Constantes du monde. Elles arrivent du serveur dans le `hello` : le client
// n'en garde aucune copie, sans quoi un reglage de gameplay pourrait changer
// d'un cote sans l'autre. Celles ci-dessous ne servent qu'a faire defiler le
// decor quand le serveur est injoignable — aucune course n'est jouee avec.
const OFFLINE_WORLD = {
    width: 3840,
    finishLineX: 1440,
    sunX: 1920,
    roadMinY: 0,
    roadMaxY: 35,
    roadPPS: 250,
    hitDuration: 2000,
    orbit: { count: 3, radiusX: 62, radiusY: 3.2 },
    shellAnimSpeed: 100,
    billAnimSpeed: 70,
    shrinkScale: 0.5,
    laps: 5,
    // Repli seulement : en marche le serveur envoie ses propres tables dans son
    // `hello`, et ce sont elles qui font foi.
    ai: {
        states: ['cruising', 'pipe', 'dodging', 'safety', 'giveWay', 'aiming'],
        dangers: ['', 'carrier', 'ram', 'shot']
    },
    // Demi-emprises des corps, pour la carte de debug. Repli seulement : le
    // serveur les envoie dans son `hello`, et c'est lui qui fait foi. Elles se
    // recalculent en une ligne — demi-longueur = `draw * fill / 2`, et la
    // profondeur du tuyau n'est que sa demi-longueur divisee par
    // `bodies.depthPx`, puisqu'il est ROND.
    hitboxes: {
        kart: { x: 37.5, y: 3.125 },
        pipe: { x: 21.84, y: 6.067, round: true },
        item: { x: 10, y: 2.5 },
        heldBehindX: -70,
        itemBox: { x: 10, y: 8 }
    },
    // Taille DESSINEE du tuyau, en px de monde. Meme repli, meme raison : c'est
    // elle qui decide de l'emprise, `pipe.hitbox` en etant une fraction fixe.
    //
    // 67.2 et non 84 (l'echelle commune pour un fichier de 95 px) : le tuyau est
    // dessine 20 % plus petit, il mangeait trop de piste. Une seule taille, PC
    // comme mobile — deux tailles dessinees donneraient deux tuyaux pour un
    // obstacle.
    pipeDraw: { w: 67.2, h: 87.71 }
};

let WORLD = OFFLINE_WORLD;
