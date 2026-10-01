// Constantes de rendu du banner (apparence uniquement ; le monde simule vient
// du service `race` dans son `hello`). L'eclair est dessine en SVG.
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
        // Tous les personnages que le serveur peut aligner, pour le prechargement.
        characters: ['mario', 'luigi', 'peach', 'daisy', 'toad', 'yoshi', 'birdo', 'bowser', 'dk', 'koopa'],
        // Initiales de la carte de debug (B = bowser, D = dk).
        initials: { 'mario': 'M', 'luigi': 'L', 'peach': 'P', 'daisy': 'Da', 'toad': 'T', 'yoshi': 'Y', 'birdo': 'Bi', 'bowser': 'B', 'dk': 'D', 'koopa': 'K' },
        // Orientations disponibles ; les 3 autres sont obtenues en miroir.
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
            bill: (frame) => `static/img/items/bill-ball/${frame}.png`,
            position: (n) => `static/img/pos/${n}.png`
        }
    },
    rendering: {
        bufferZone: 200,
        zIndexBase: 400,
        // Ecran compact, identique aux @media de banner.css.
        compactQuery: 'screen and (max-width: 768px), screen and (max-height: 500px) and (orientation: landscape)',
        // Largeur du kart de reference (identique a .kart-container-moving),
        // multipliee par le `scale` envoye par le serveur.
        kartWidth: 100,

        // Levitation des item-boxes : amplitude en px, vitesse en rad/ms.
        boxFloat: { amplitude: 10, speed: 0.003 },

        // Cahot des karts et de l'objet tenu : amplitude en px, periode en ms
        // (calcule en JS, voir kartBounceY dans render.js).
        kartBounce: { amplitude: 3, periodMs: 300 }
    },
    offsets: {
        // Rendu uniquement.
        render: {
            heldItemHands: { x: 28, yShift: 30 },
            // Abaissement de l'orbite (visuel seulement).
            orbitDrop: 10
        }
    },
    visuals: {
        greenShell: { width: 48 },
        redShell: { width: 48 },
        blueShell: { width: 58 },
        banana: { width: 32 },
        shroom: { width: 36 },
        star: { width: 36 },
        lightning: { width: 30 },
        bill: { width: 69 },
        box: { size: 42 },
        // Taille du tuyau et rayon du souffle : envoyes par le serveur (WORLD).
    },
    // Tête-à-queue de l'état 'hit' : durationRatio règle la vitesse de la toupie
    // sur une fraction du malus.
    kartSpin: {
        turns: 2,
        durationRatio: 0.8,
        // Un tour horaire depuis side-right ; mirror = scaleX(-1).
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

// Constantes du monde de repli, pour faire defiler le decor hors ligne (en
// ligne, elles viennent du `hello`).
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
    ai: {
        states: ['cruising', 'pipe', 'dodging', 'safety', 'giveWay', 'aiming', 'yieldLead'],
        dangers: ['', 'carrier', 'ram', 'shot'],
        alerts: ['', 'ram', 'red', 'blue']
    },
    // Demi-emprises des corps pour la carte de debug (repli).
    hitboxes: {
        kart: { x: 37.5, y: 3.125 },
        pipe: { x: 21.84, y: 6.067, round: true },
        item: { x: 10, y: 2.5 },
        heldBehindX: -70,
        itemBox: { x: 10, y: 8 }
    },
    // Taille dessinee du tuyau, en px de monde (repli).
    pipeDraw: { w: 67.2, h: 87.71 }
};

let WORLD = OFFLINE_WORLD;
