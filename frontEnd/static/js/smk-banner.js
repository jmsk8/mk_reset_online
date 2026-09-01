// Constantes de rendu du banner SMK.
//
// Uniquement de l'apparence : chemins d'assets, tailles en px, z-index,
// seuils mobile, animations. Les constantes qui decrivent le monde simule
// (vitesses, hitboxes, delais, distribution des objets) n'existent plus ici :
// elles vivent dans le service `race`, qui en transmet le strict necessaire
// dans son `hello` (voir WORLD plus bas, et docs/MIGRATION_BANNER_WSS.md).
// L'eclair n'a pas d'asset : il est dessine ici en SVG plutot que d'attendre un
// PNG. Meme traitement que n'importe quel objet tenu ensuite — c'est une source
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
        // Miroir de .kart-container-moving en CSS. Le sprite est centre sur la
        // position du kart, qui est aussi le centre de sa hitbox : c'est la
        // demi-largeur qui sert, pour reculer l'element de son coin gauche.
        //
        // C'est la largeur du kart de REFERENCE, et elle ne suffit plus a elle
        // seule : chaque kart la multiplie par le `scale` que le serveur envoie
        // dans son `hello`, tire de la taille de son PNG. Un sprite de 119 px
        // se dessine 5 % plus long qu'un de 110, et son emprise l'est d'autant —
        // c'est le meme rapport des deux cotes, pose une seule fois en config
        // moteur (`bodies`). Tout ramener a 100 px, comme avant, dessinait dk
        // exactement aussi long que koopa.
        //
        // Ce qui reste ici est le DESSIN seul, d'ou les deux valeurs : la
        // hitbox, elle, ne depend pas de l'appareil.
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
    // Demi-emprises des corps, pour la carte de debug. Repli seulement : le
    // serveur les envoie dans son `hello`, et c'est lui qui fait foi.
    //
    // Elles etaient restees a `bodies.fill: 0.6` alors que la config est passee
    // a 0.75 : le repli dessinait un plateau 25 % trop fin. Recopiees ici a
    // leur valeur derivee actuelle. Elles se recalculent en une ligne —
    // demi-longueur = `draw * fill / 2` — et la profondeur du tuyau n'est que sa
    // demi-longueur divisee par `bodies.depthPx` : il est ROND. Le tuyau prend
    // `bodies.pipeFill` (0.65) et non `fill` : sa collerette deborde de son fut.
    hitboxes: {
        kart: { x: 37.5, y: 3.125 },
        pipe: { x: 21.84, y: 6.067, round: true },
        item: { x: 10, y: 2.5 },
        heldBehindX: -70,
        itemBox: { x: 10, y: 8 }
    },
    // Taille DESSINEE du tuyau, en px de monde. Meme repli, meme raison que les
    // emprises ci-dessus : le serveur l'envoie, parce que c'est elle qui decide
    // de l'emprise — `pipe.hitbox` en est une fraction fixe (bodies.fill).
    //
    // Le dessin et la hitbox ont longtemps diverge ici : 67.2 de large pour une
    // emprise de 42, soit 12.6 px de sprite en trop de chaque cote de ce qui
    // arrete reellement un kart. Les deux descendent maintenant de la meme
    // mesure, et 21.84 est exactement 67.2 * 0.65 / 2.
    //
    // 67.2 et non 84 (l'echelle commune pour un fichier de 95 px) : le tuyau est
    // volontairement dessine 20 % plus petit, il mangeait trop de piste. La
    // hauteur suit les proportions du fichier (95 x 124), elle ne se regle pas.
    //
    // Une seule taille, PC comme mobile : la hitbox ne depend pas de l'appareil,
    // et deux tailles dessinees donneraient deux tuyaux pour un meme obstacle.
    pipeDraw: { w: 67.2, h: 87.71 }
};

let WORLD = OFFLINE_WORLD;

// Ecart entre l'horloge locale et celle du serveur, estime par ping/pong :
// aucune date locale ne doit entrer dans un calcul partage, celles des
// visiteurs sont fausses, parfois de plusieurs secondes.
//
// Deux valeurs et non une : la mesure vise une cible que l'horloge effective
// rejoint doucement. Appliquer chaque mesure telle quelle ferait sauter
// l'instant affiche, donc toute la scene, a chaque recalage.
let serverClockOffset = 0;
let targetClockOffset = 0;
let clockCalibrated = false;

let cachedBg = null;
let cachedFg = null;
let cachedGround = null;
let cachedIsSummerBanner = false;
let cachedContainer = null;
let cachedIsMobile = false;
let cachedGameWrapper = null;
let cachedFinishBand = 0;

// ── Mesures de mise en page ────────────────────────────────────────────────
//
// Elles sont lues UNE fois par changement de fenetre, jamais pendant le rendu.
// Une lecture de `offsetWidth` au milieu d'une frame, apres les ecritures de
// style, force le navigateur a recalculer toute la mise en page sur-le-champ
// pour repondre — c'est ce que la boucle faisait deux fois par image, dont une
// dans le HUD de debug, qui faussait ainsi la mesure qu'il affiche.
//
// `wrapperHeight` est la hauteur du CONTAINING BLOCK des corps places.
// `#karts-container` n'est pas positionne : ce sont donc les dimensions de
// `.game-content-wrapper` qui resolvent leurs pourcentages. Sur mobile ce
// wrapper est plus grand qu'a l'ecran — 166,67 % puis `scale(0.6)` — et c'est
// bien sa hauteur de MISE EN PAGE qu'il faut ici, celle que rend offsetHeight.
// `hudWidth` est la largeur du cadre de la carte de debug : elle decide de la
// portion de piste que la fenetre montre, et se lisait elle aussi a chaque
// image, apres les ecritures de `renderState`.
// `roadBandHeight` est la hauteur de la PISTE : la bande que les karts peuvent
// atteindre, `roadMinY` en bas, `roadMaxY` en haut. C'est elle qui convertit une
// profondeur en pixels. La feuille de style la declare en `--road-band-pct`.
//
// `groundHeight` est la hauteur de l'ASPHALTE, qui est plus grande : les
// derniers pixels du haut sont du bitume derriere la piste, sur lequel rien ne
// roule — sans eux, la rangee du fond posait ses roues sur la bordure rouge et
// blanche. Elle ne sert qu'a savoir jusqu'ou la neige peut se poser.
//
// Les trois ont longtemps ete confondues : l'asphalte valait 35 % d'une scene de
// 360 px, la piste 35 unites, et une unite tombait donc a 1 % de la scene. Deux
// coincidences, defaites l'une apres l'autre — le cadre a grandi, puis
// l'asphalte a depasse la piste.
const viewMetrics = { containerWidth: 0, wrapperHeight: 0, hudWidth: 0, groundHeight: 0, roadBandHeight: 0 };

const imageCache = {};

// L'heure du serveur, telle qu'on l'estime. C'est la seule horloge du banner :
// elle date les snapshots, cale les animations decoratives et sert de reference
// au retard de rendu.
function getGameTime() {
    return Date.now() + serverClockOffset;
}

// Miroir local de l'etat recu. Ne contient que ce dont le rendu a besoin : les
// dix-sept autres champs d'un kart restent au serveur.
let worldState = {
    cameraX: 0,
    bgCameraX: 0,
    karts: [],
    kartsById: {},
    items: [],
    itemBoxes: [],
    // Statiques et indestructibles : ils arrivent dans le `hello` et ne
    // bougent plus. Aucun snapshot ne les porte.
    pipes: [],
    finishLine: null,
    sun: null,

    phase: 'countdown',
    leaderLap: 1,
    sign: null,
    // [debut, frappe, fin] en temps serveur, ou null hors orage.
    storm: null,
    finishOrder: [],
    // [manche, points de la course, points du grand prix], les deux tableaux
    // etant alignes sur les identifiants de kart.
    gp: null,
    // [voix posees, spectateurs connectes]. Le snapshot etant commun a tous, il
    // ne porte que le total : savoir si c'est nous qui avons vote est une
    // affaire locale, tenue par `myVote`.
    vote: [0, 0],

    // Le releve de vision du kart suivi, ou null. Il n'arrive que sur demande
    // (`requestVision`), donc jamais hors mode debug, et il ne sert qu'a la
    // carte : un client qui l'ignore affiche exactement la meme course.
    vision: null
};

// Notre propre voix. Effacee a chaque course neuve, le serveur remettant alors
// tous les compteurs a zero.
let myVote = false;

const kartEls = {};
const itemEls = {};
const ppEls = {};

// Emplacement courant de chaque photo du classement, et drapeau pose le temps
// qu'une animation de depassement joue. La reconciliation ne repositionne que
// les photos qui ne sont pas en train de glisser, sinon elle couperait
// l'animation a la frame suivante.
const ppSlots = {};
const ppAnimating = {};

let leaderboardState = {
    container: null,
    slots: [],
    cameraEl: null,
    pauseEl: null,
    voteEl: null,
    bound: false
};

let lastFrameTime = 0;
let animationId = null;

function getZIndex(yPercent) {
    return (GAME_CONFIG.rendering.zIndexBase - yPercent) | 0;
}

function updateMobileStatus() {
    cachedIsMobile = window.innerWidth < GAME_CONFIG.rendering.mobileBreakpoint;
    return cachedIsMobile;
}

// Remesure la scene. Le seul endroit du fichier qui a le droit de lire une
// dimension du DOM : partout ailleurs on lit `viewMetrics`.
//
// Une mesure nulle est ignoree plutot que memorisee : le decor peut n'etre pas
// encore mis en page au premier appel, et retenir un zero figerait la scene sur
// une hauteur de repli pour toute la session.
function refreshLayoutMetrics() {
    updateMobileStatus();

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedGameWrapper) cachedGameWrapper = document.querySelector('.game-content-wrapper');

    const w = cachedContainer ? cachedContainer.offsetWidth : 0;
    if (w > 0) viewMetrics.containerWidth = w;

    const h = cachedGameWrapper ? cachedGameWrapper.offsetHeight : 0;
    if (h > 0) viewMetrics.wrapperHeight = h;

    if (!cachedGround) cachedGround = document.querySelector('.layer-ground');
    const gh = cachedGround ? cachedGround.offsetHeight : 0;
    if (gh > 0) viewMetrics.groundHeight = gh;

    // La piste ne se mesure pas : aucun element ne la dessine, elle est plus
    // courte que l'asphalte qui la porte. La feuille de style la declare, on la
    // lit. Un seul `getComputedStyle` par changement de fenetre.
    if (cachedGameWrapper && viewMetrics.wrapperHeight > 0) {
        const pct = parseFloat(getComputedStyle(cachedGameWrapper)
            .getPropertyValue('--road-band-pct'));
        if (pct > 0) viewMetrics.roadBandHeight = (pct / 100) * viewMetrics.wrapperHeight;
    }

    // La bande d'arrivee se mesure ici plutot qu'a la demande : sa largeur vient
    // du CSS et change avec l'appareil, et `finishBandWidth()` est appele depuis
    // le rendu, ou plus rien ne doit toucher le DOM.
    const bandEl = document.querySelector('.layer-finish-line');
    const bw = bandEl ? bandEl.offsetWidth : 0;
    if (bw > 0) cachedFinishBand = bw;

    // Le cadre de la carte de debug, quand il existe : il se construit apres le
    // decor, d'ou la remesure depuis `initDebugHUD()`.
    const hudEl = document.getElementById('debug-hud');
    const hw = hudEl ? hudEl.clientWidth : 0;
    if (hw > 0) viewMetrics.hudWidth = hw;
}

// Un seul rafraichissement par image, quoi qu'il arrive : redimensionner une
// fenetre emet des dizaines d'evenements, et chacun coute une mise en page.
let layoutRefreshQueued = false;

function onViewportChange() {
    if (layoutRefreshQueued) return;
    layoutRefreshQueued = true;
    requestAnimationFrame(() => {
        layoutRefreshQueued = false;
        refreshLayoutMetrics();
    });
}

window.addEventListener('resize', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);

// La profondeur d'un corps, en pixels de translation verticale.
//
// Les corps se posaient a `bottom: N%` et cette ligne se reecrivait a chaque
// image. `bottom` est une propriete de MISE EN PAGE : chaque ecriture
// invalidait la mise en page du conteneur, qui recalculait tous ses enfants —
// une quarantaine de fois par image — et annulait au passage les
// `will-change: transform` deja poses juste a cote. Le meme deplacement, plie
// dans la `translate3d` qui etait deja la, ne coute plus qu'une composition.
//
// Negatif : dans le repere des transformations, monter c'est aller vers les Y
// negatifs, la ou `bottom` montait en croissant. Les corps gardent donc
// `bottom: 0` en CSS et toute leur profondeur passe par la transformation.
function depthToY(yPercent) {
    return -yPercent * depthToWorldPx();
}

// Le decor defile par TRANSFORMATION, pas par `background-position`.
//
// Ecrire `background-position` a chaque image repeint la texture du calque
// entier a chaque image — le `will-change` qui l'accompagnait est un indice, pas
// une promotion : aucun moteur ne sait compositer un fond qui glisse.
//
// Le calque est donc elargi d'un PAS et translate. Comme le motif se repete, il
// suffit de garder la translation dans [-pas, 0] et de rattraper les multiples
// du pas sur `background-position`, qui ne se reecrit alors qu'une fois tous les
// `LAYER_STEP` pixels parcourus — deux secondes au rythme de croisiere, au lieu
// de soixante fois par seconde.
//
// LAYER_TILE est la periode du motif de fond, celle que le CSS pose en
// `background-size` ; LAYER_STEP la divise, pour que les valeurs rattrapees
// restent alignees sur le motif.
const LAYER_TILE = 3840;
const LAYER_STEP = 480;

// `phase` est le decalage de motif voulu au bord gauche du cadre : exactement
// ce qui s'ecrivait en `background-position`.
function scrollLayer(el, phase, state) {
    const m = ((phase % LAYER_TILE) + LAYER_TILE) % LAYER_TILE;
    const q = Math.floor(m / LAYER_STEP) * LAYER_STEP;

    if (state.bp !== q) {
        state.bp = q;
        // Le pas ajoute compense la translation, qui est toujours negative :
        // c'est ce qui garde le bord gauche du calque hors du cadre.
        el.style.backgroundPosition = `${q + LAYER_STEP}px 0px`;
    }

    el.style.transform = `translate3d(${(m - q) - LAYER_STEP}px, 0, 0)`;
}

const bgScroll = { bp: null };
const fgScroll = { bp: null };

// `cameraX` designe le **centre** de ce qu'on voit, pas son bord gauche : la
// fenetre s'etend symetriquement de part et d'autre, sur la largeur dont
// l'appareil dispose. Un ecran etroit montre donc moins de piste qu'un large,
// mais tous deux sont centres sur le meme point du monde — sans quoi un mobile
// et un PC, partant du meme bord gauche, regardent deux portions differentes.
function getScreenPosition(worldX, cameraX, screenWidth) {
    const w = WORLD.width;
    const buffer = GAME_CONFIG.rendering.bufferZone;

    let rawDiff = worldX - cameraX + screenWidth / 2;

    if (rawDiff > -buffer && rawDiff < screenWidth + buffer) {
        return rawDiff;
    }

    let diffPlus = rawDiff + w;
    if (diffPlus > -buffer && diffPlus < screenWidth + buffer) {
        return diffPlus;
    }

    let diffMinus = rawDiff - w;
    if (diffMinus > -buffer && diffMinus < screenWidth + buffer) {
        return diffMinus;
    }

    return rawDiff;
}

// Rend une promesse tenue quand toutes les images sont decodees : c'est l'une
// des conditions de levee du rideau (§ bannerLink). Une image qui manque ne doit
// pas bloquer le banner, d'ou le catch — au pire elle apparaitra en retard.
function preloadImages() {
    const waits = [];

    function cache(key, src) {
        const img = new Image();
        img.src = src;
        imageCache[key] = img;
        waits.push(img.decode ? img.decode().catch(() => {})
                              : new Promise(resolve => { img.onload = img.onerror = resolve; }));
        return img;
    }

    for (let i = 1; i <= 3; i++) {
        cache(`greenShell_${i}`, GAME_CONFIG.resources.paths.greenShell(i));
        cache(`redShell_${i}`, GAME_CONFIG.resources.paths.redShell(i));
        cache(`blueShell_${i}`, GAME_CONFIG.resources.paths.blueShell(i));
        cache(`bill_${i}`, GAME_CONFIG.resources.paths.bill(i));
    }

    // Lakitu : feux de depart, panneaux de tour, drapeau a damier.
    LAKITU_SPRITES.forEach(([group, frame]) => {
        cache(`lakitu_${group}_${frame}`, GAME_CONFIG.resources.paths.lakitu(group, frame));
    });

    cache('banana', GAME_CONFIG.resources.paths.banana);
    cache('shroom', GAME_CONFIG.resources.paths.shroom);
    cache('star', GAME_CONFIG.resources.paths.star);

    GAME_CONFIG.resources.characters.forEach(charName => {
        cache(`pp_${charName}`, GAME_CONFIG.resources.paths.pp(charName));

        // Toutes les orientations, sinon le premier tête-à-queue clignote
        // le temps que les frames se téléchargent.
        GAME_CONFIG.resources.kartDirections.forEach(dir => {
            cache(`kart_${charName}_${dir}`, GAME_CONFIG.resources.paths.charFrame(charName, dir));
        });
    });

    return Promise.all(waits);
}

function getKartFrameSrc(charName, dir) {
    const cached = imageCache[`kart_${charName}_${dir}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.charFrame(charName, dir);
}

// Kart suivi par la camera, ou null pour la camera par defaut. Purement local :
// deux spectateurs peuvent regarder des karts differents, ils voient la meme
// course sous un autre angle. Cet etat ne part jamais au serveur.
let focusedKartId = null;

// Course figee. Aussi local que la camera : le serveur continue de courir et
// de diffuser, c'est notre rendu seul qui s'arrete sur l'image. Rien ne part
// donc au serveur — un spectateur qui met en pause ne fige la course de
// personne d'autre, et la reprise le remet sur le direct, pas la ou il l'avait
// laissee. C'est le meme parti que l'onglet endormi : « la course continue sans
// nous, il n'y a rien a reprendre ».
let racePaused = false;

// Camera effectivement utilisee pour le rendu. Elle vaut celle du serveur en
// mode par defaut, et la position du kart suivi sinon.
let renderCameraX = 0;
let renderBgCameraX = 0;
let lastFocusCameraX = null;

function wrapWorld(x) {
    const w = WORLD.width;
    if (x < 0) return x + w;
    if (x >= w) return x - w;
    return x;
}

function shortestDelta(from, to) {
    const w = WORLD.width;
    let delta = to - from;
    if (delta > w / 2) delta -= w;
    else if (delta < -w / 2) delta += w;
    return delta;
}

function updateRenderCamera() {
    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];

    if (!kart) {
        renderCameraX = worldState.cameraX;
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = null;
        return;
    }

    // Le fond ne peut pas garder sa propre vitesse : il avance de la moitie du
    // deplacement de la camera, sinon decor et route se desolidarisent des que
    // celle-ci change d'allure.
    if (lastFocusCameraX === null) {
        renderBgCameraX = worldState.bgCameraX;
        lastFocusCameraX = worldState.cameraX;
    }

    renderBgCameraX = wrapWorld(renderBgCameraX + shortestDelta(lastFocusCameraX, kart.worldX) / 2);
    renderCameraX = kart.worldX;
    lastFocusCameraX = kart.worldX;
}

// ── Le cartouche du kart suivi ──────────────────────────────────────────────
//
// Tour et vitesse, en bas a gauche, et seulement quand la camera suit un kart :
// c'est une lecture de son tableau de bord, elle n'a pas de sens sur la vue
// d'ensemble.
//
// Les deux se DEDUISENT de `totalDistance`, qui est la seule chose transmise
// des deux. Le tour parce qu'il n'est pas diffuse — le classement de debug le
// derive deja de la meme facon. La vitesse parce que ce qui interesse un
// spectateur n'est pas la consigne du moteur mais le terrain reellement couvert :
// un kart bloque derriere un autre, en tete-a-queue ou en train de reculer
// contre un tuyau roule a ce que dit sa position, pas a ce que dit sa vitesse
// moteur. C'est la meme mesure que celle du banc de reglage.
//
// Rien n'est donc a ajouter au protocole.
let focusHudEl = null;
let focusHudPrevDistance = null;
let focusHudSpeed = 0;
let focusHudText = '';

// Constante de temps du lissage, en ms. La distance est interpolee entre deux
// snapshots : la derivee brute saute a chaque arrivee de paquet, et un compteur
// qui clignote est illisible. Assez court pour qu'un champignon se voie tout de
// suite, assez long pour ne pas trembler.
const FOCUS_HUD_SMOOTH_MS = 220;

function resetFocusHud() {
    focusHudPrevDistance = null;
    focusHudSpeed = 0;
    focusHudText = '';
    if (focusHudEl) focusHudEl.classList.remove('is-on');
}

function updateFocusHud(frameMs) {
    if (!focusHudEl) {
        focusHudEl = document.getElementById('race-focus-hud');
        if (!focusHudEl) return;
    }

    const kart = focusedKartId === null ? null : worldState.kartsById[focusedKartId];
    if (!kart) {
        if (focusHudPrevDistance !== null) resetFocusHud();
        return;
    }

    // Le premier passage n'a pas de pas precedent : il pose le repere et
    // n'affiche pas encore de vitesse, plutot que d'en inventer une.
    if (focusHudPrevDistance === null) {
        focusHudPrevDistance = kart.totalDistance;
        focusHudEl.classList.add('is-on');
    } else if (frameMs > 0) {
        const moved = kart.totalDistance - focusHudPrevDistance;
        focusHudPrevDistance = kart.totalDistance;

        // Un recul contre un tuyau rendrait une vitesse negative : le compteur
        // affiche l'allure, pas le sens de la marche.
        const raw = Math.max(0, (moved * 1000) / frameMs);
        const k = frameMs / FOCUS_HUD_SMOOTH_MS;
        focusHudSpeed += (raw - focusHudSpeed) * (k > 1 ? 1 : k);
    }

    const lap = Math.min(WORLD.laps || 1, Math.floor(kart.totalDistance / WORLD.width) + 1);
    const text = `TOUR ${lap}/${WORLD.laps || 1} \u00B7 ${Math.round(focusHudSpeed)} px/s`;

    // Le DOM n'est touche que quand le texte change vraiment : a 60 images par
    // seconde, la vitesse arrondie ne bouge pas a chaque frame.
    if (text !== focusHudText) {
        focusHudText = text;
        focusHudEl.textContent = text;
    }
}

// ── Le releve de decision, sous la banniere, en mode debug ──────────────
//
// Ce que le kart suivi VOIT, et ce qu'il en FAIT. Quatre lignes, pas une de
// plus : un tableau de bord qu'on ne lit pas d'un coup d'oeil ne sert a rien
// pendant une course.
//
// Tout vient du seul entier `kart.ai` du snapshot (cf. `aiTuple` dans
// raceEngine/protocol.js). Le client ne DEDUIT rien — il traduit. C'est la meme
// regle que partout ailleurs : ce qui s'affiche est ce que le moteur a decide,
// jamais une reconstitution qui pourrait diverger en silence.
// L'ORDRE est le contrat, pas les mots : le serveur envoie un indice, ces
// tables sont ses jumelles dans `raceEngine/protocol.js`. Y inserer une valeur
// au milieu decale tout l'affichage en silence.
const AI_STATES = ['roule', 'contourne un tuyau', 'esquive', 'se range', 'laisse passer', 'vise'];
const AI_DANGERS = ['\u2014', 'porteur arme', 'etoile / bill', 'carapace en vol'];

let aiHudEl = null;
let aiHudValue = -1;

function aiRow(key, value, tone) {
    const cls = tone || 'ai-val';
    return `<div class="ai-row"><span class="ai-key">${key}</span>` +
           `<span class="${cls}">${value}</span></div>`;
}

function updateAiHud() {
    if (!aiHudEl) {
        aiHudEl = document.getElementById('race-ai-hud');
        if (!aiHudEl) return;
    }

    const kart = (GAME_CONFIG.debugMode && focusedKartId !== null)
        ? worldState.kartsById[focusedKartId] : null;

    if (!kart) {
        if (aiHudValue !== -1) {
            aiHudValue = -1;
            aiHudEl.classList.remove('is-on');
            aiHudEl.innerHTML = '';
        }
        return;
    }

    const v = kart.ai || 0;

    // Le DOM n'est touche que quand l'etat change vraiment. A dix snapshots par
    // seconde et soixante images, le releve est identique la plupart du temps.
    if (v === aiHudValue) return;
    aiHudValue = v;

    const state = AI_STATES[v & 15] || AI_STATES[0];
    const danger = AI_DANGERS[(v >> 4) & 3];
    const back = (v >> 6) & 1;
    const brake = (v >> 7) & 1;
    const shield = (v >> 8) & 1;
    const twoReds = (v >> 9) & 1;
    const itemAhead = (v >> 10) & 1;
    const pipeAhead = (v >> 11) & 1;
    const carrierAhead = (v >> 12) & 1;

    // Le regard d'abord, parce qu'il conditionne tout le reste : ce qui n'est
    // pas regarde n'est pas vu, et donc pas traite.
    const look = back ? 'DERRIERE' : 'devant';

    const rear = ((v >> 4) & 3)
        ? danger + (twoReds ? '  \u00B7  deux rouges' : '')
        : '\u2014';

    // « porteur » n'est pas un objet en vol : c'est un kart devant, dans l'axe,
    // qui tient de quoi finir derriere lui. C'est le seul danger que le releve
    // taisait, et donc le seul qu'on ne pouvait pas voir manquer.
    const front = [];
    if (pipeAhead) front.push('tuyau');
    if (itemAhead) front.push('objet');
    if (carrierAhead) front.push('porteur');

    const doing = [state];
    if (brake) doing.push('frein');
    if (shield) doing.push('bouclier');

    aiHudEl.innerHTML =
        aiRow('regard', look, back ? 'ai-warn' : 'ai-val') +
        aiRow('derriere', rear, ((v >> 4) & 3) ? 'ai-hot' : 'ai-off') +
        aiRow('devant', front.length ? front.join('  \u00B7  ') : '\u2014',
              front.length ? 'ai-warn' : 'ai-off') +
        aiRow('decision', doing.join('  \u00B7  '), 'ai-val');

    aiHudEl.classList.add('is-on');
}

function setFocus(kartId) {
    focusedKartId = kartId;
    lastFocusCameraX = null;
    aiHudValue = -1;
    resetFocusHud();
    updateFocusMarks();
    requestVision();
}

// Le releve de vision du kart suivi. Il ne se demande qu'en mode debug, et il
// coute au service une seconde serialisation par snapshot : hors debug, ce
// message ne part jamais et le spectateur reste sur le flux commun.
//
// A renvoyer apres chaque `hello` : le service ne garde rien d'une connexion a
// l'autre, et une course neuve renumerote... non, les identifiants tiennent —
// mais une reconnexion, elle, repart d'une fiche vierge.
function requestVision() {
    if (!GAME_CONFIG.debugMode) return;
    bannerNet.send({ t: 'watch', id: focusedKartId });
    if (focusedKartId === null) worldState.vision = null;
}

function updateFocusMarks() {
    const cameraBtn = leaderboardState.cameraEl;
    if (cameraBtn) {
        cameraBtn.classList.toggle('is-focused', focusedKartId === null);
        // La camera jaune dit que la realisation tourne, y compris pendant
        // qu'elle est posee sur un kart : sans ce reperage, un spectateur ne
        // peut pas savoir si la vue bougera toute seule.
        cameraBtn.classList.toggle('is-auto', raceDirector.auto);
        cameraBtn.title = raceDirector.auto
            ? 'Realisation automatique — cliquer pour rester sur la vue d\'ensemble'
            : 'Vue d\'ensemble — cliquer pour la realisation automatique';
    }

    for (const id in ppEls) {
        ppEls[id].classList.toggle('is-focused', String(focusedKartId) === id);
    }
}

function onLeaderboardClick(event) {
    const target = event.target.closest('.leaderboard-vote, .leaderboard-pause, .leaderboard-camera, [data-kart-id]');
    if (!target) return;

    if (target.classList.contains('leaderboard-vote')) {
        toggleVote();
        return;
    }

    if (target.classList.contains('leaderboard-pause')) {
        togglePause();
        return;
    }

    // Le bouton camera bascule la realisation automatique. Son etat de repos —
    // la vue d'ensemble — est exactement celui que la realisation occupe entre
    // deux plans : couper l'automatique, c'est donc s'y arreter.
    if (target.classList.contains('leaderboard-camera')) {
        raceDirector.setAuto(!raceDirector.auto);
        setFocus(null);
        return;
    }

    // Cliquer un joueur passe en focus manuel : a partir de la, c'est le
    // spectateur qui realise, et la camera ne bougera plus sans lui.
    raceDirector.setAuto(false);
    setFocus(Number(target.dataset.kartId));
}

// ---------------------------------------------------------------------------
// Realisation automatique
//
// La camera par defaut suit le peloton : elle ne rate rien, mais elle ne montre
// rien non plus. Ce module en fait une realisation — aller chercher l'action la
// ou elle se joue, y rester le temps qu'elle se joue, et revenir au plan large
// quand la course se calme.
//
// Trois regles, dans cet ordre :
//
//   1. Le depart se regarde en entier sur la vue d'ensemble. Couper sur un kart
//      pendant que la grille s'elance, ce serait perdre le seul moment ou toute
//      la course tient dans le cadre.
//   2. Un plan DURE. `DIRECTOR_MIN_HOLD_MS` est un plancher ferme : meme un bill
//      qui part a l'autre bout ne coupe pas un plan commence. Une camera qui
//      saute a chaque evenement ne se regarde pas, elle se subit. Seul un plan
//      devenu vide — kart arrive, kart disparu — passe outre.
//   3. Entre deux plans, on prend le plus fort. Les notes disent ce qui merite
//      un plan et de combien : un bill vaut mieux qu'un duel, qui vaut mieux
//      qu'un premier tout seul en tete. Mais on ne revient JAMAIS au defilement
//      de base : passe le depart, la camera est chez quelqu'un. Un plan calme
//      derriere un kart raconte encore la course ; un plan large ou personne
//      n'est designe ne raconte plus rien.
//   4. L'arrivee est une SEQUENCE, pas une note : le premier a l'approche de la
//      ligne, puis la ligne elle-meme le temps que tout le monde passe. Elle
//      passe devant les trois autres regles, plancher de duree compris.
//
// Tout se lit dans le snapshot deja recu : pas un champ n'a ete ajoute au
// protocole pour ca. Ce que le serveur ne dit pas se DEDUIT — la bleue ne porte
// pas sa cible sur le fil, mais une bleue qui tourne a cent unites d'un kart
// tourne au-dessus de lui, et c'est tout ce qu'il faut savoir pour la filmer.
// ---------------------------------------------------------------------------

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
//   BLUE_LOCK : une bleue plus pres que ca d'un kart ne passe pas dans le
//               decor, elle tourne au-dessus de lui — c'est la victime.
//   CHASE     : une carapace lancee a cette distance est une menace, pas un
//               objet du decor.
//   DUEL      : deux karts a moins de ca tiennent dans le meme cadre. C'est ce
//               qui fait la bagarre plutot que deux karts a la suite.
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

        // ── L'arrivee ────────────────────────────────────────────────────
        //
        // Elle ne se joue pas aux notes : c'est une sequence, et elle passe
        // devant tout — plancher de duree compris. Une fin de course ne se rate
        // pas sous pretexte qu'un plan a commence il y a deux secondes.
        //
        // Le drapeau sorti est le signal de l'approche REELLE de la ligne. La
        // phase 'finishing', elle, commence deux tours plus tot (cf.
        // `cameraApproachDistance`) : s'en servir collerait la camera au premier
        // pendant deux tours. Le serveur, lui, sort Lakitu a `flagDistance`.
        //
        // Puis, des la premiere arrivee, on lache le premier pour la vue par
        // defaut — qui EST la ligne : le serveur y a gare sa camera en entrant
        // dans la phase, et elle s'y arrete net. Tous les suivants passent donc
        // dans ce cadre, sans qu'on ait a clouer une camera nous-memes.
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

// Gel de la scene. On ne coupe pas la boucle d'animation — elle continue de
// tourner pour pouvoir repartir au clic suivant — on cesse simplement de lire
// le tampon et de peindre : le dernier etat affiche reste a l'ecran. Les
// animations CSS, elles, ne dependent pas de nous : c'est la classe `is-paused`
// qui les arrete (cf. smk-banner.css).
//
// Le tampon reseau, lui, ne demande rien : il se purge tout seul a la reception
// puisque son seuil suit l'horloge, qui ne s'arrete pas. A la reprise, l'instant
// a afficher retombe donc dans un tampon deja rempli d'etats frais.
function togglePause() {
    racePaused = !racePaused;

    // A la reprise, la scene saute de toute la duree du gel : c'est un
    // changement de structure comme un autre, et il faut reconcilier avant de
    // repeindre. Sans ca, les karts arrives ou repartis pendant la pause ne
    // seraient pris en compte qu'au prochain snapshot.
    if (!racePaused) domDirty = true;

    renderPause();
}

function renderPause() {
    const el = leaderboardState.pauseEl;
    if (!el) return;

    el.classList.toggle('is-paused', racePaused);
    el.title = racePaused ? 'Reprendre la course' : 'Figer la course';

    // Le rendu JS s'arrete en ne peignant plus, mais les animations CSS — la
    // toupie, le halo d'etoile, la neige — tournent toutes seules et
    // continueraient sur une scene arretee. Seul le navigateur peut les
    // suspendre, et c'est cette classe qui le lui demande.
    const banner = document.getElementById('bannerSection');
    if (banner) banner.classList.toggle('is-paused', racePaused);
}

// Le serveur tient le decompte : on ne fait qu'annoncer un changement d'avis et
// attendre le snapshot qui l'enterine. Basculer le compteur localement le
// ferait osciller a chaque envoi refuse.
function toggleVote() {
    if (!bannerNet.send({ t: 'vote' })) return;
    myVote = !myVote;
    renderVote();
}

// Compteur du vote de redemarrage. Reconstruit depuis le snapshot, comme tout
// le reste : un arrivant voit le vote en cours et non un compteur a zero.
function renderVote() {
    const el = leaderboardState.voteEl;
    if (!el) return;

    const tally = worldState.vote || [0, 0];
    const count = tally[0] || 0;
    const total = tally[1] || 0;

    // Seul spectateur : le bouton relance a lui tout seul, un compteur « 0/1 »
    // n'apprendrait rien.
    const label = el.querySelector('.leaderboard-vote-count');
    if (label) label.textContent = total > 1 ? `${count}/${total}` : '';

    el.classList.toggle('is-voted', myVote);
    el.title = myVote
        ? 'Annuler le vote de redemarrage'
        : 'Voter le redemarrage (grand prix remis a zero)';
}

function initLeaderboard() {
    leaderboardState.container = document.getElementById('race-leaderboard');
    if (!leaderboardState.container) return;

    leaderboardState.container.innerHTML = '';
    leaderboardState.slots = [];

    if (!leaderboardState.bound) {
        leaderboardState.bound = true;
        leaderboardState.container.addEventListener('click', onLeaderboardClick);
    }

    const camera = document.createElement('div');
    camera.className = 'leaderboard-pp leaderboard-camera visible';
    camera.title = 'Vue par defaut';
    camera.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M4 7h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z"/>' +
        '<path d="M15 11.2l5-2.7v7l-5-2.7z"/></svg>';
    leaderboardState.container.appendChild(camera);
    leaderboardState.cameraEl = camera;

    // Pause, entre la camera et le vote. Elle porte ses deux icones d'un coup,
    // barres et triangle : c'est le CSS qui montre celle de l'etat courant, ce
    // qui evite de reconstruire du balisage a chaque clic.
    const pause = document.createElement('div');
    pause.className = 'leaderboard-pp leaderboard-pause visible';
    pause.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<g class="ico-pause"><path d="M8 5h3v14H8zM13 5h3v14h-3z"/></g>' +
        '<g class="ico-play"><path d="M9 5l10 7-10 7z"/></g></svg>';
    leaderboardState.container.appendChild(pause);
    leaderboardState.pauseEl = pause;

    // Vote de redemarrage, tout a gauche. Le compteur est pose par
    // renderVote() : ici on ne construit que la coquille.
    const vote = document.createElement('div');
    vote.className = 'leaderboard-pp leaderboard-vote visible';
    vote.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>' +
        '<span class="leaderboard-vote-count"></span>';
    leaderboardState.container.appendChild(vote);
    leaderboardState.voteEl = vote;

    updateFocusMarks();
    renderPause();
    renderVote();

    const totalKarts = GAME_CONFIG.resources.characters.length;
    for (let i = 0; i < totalKarts; i++) {
        const slot = document.createElement('div');
        slot.className = 'leaderboard-slot';
        slot.dataset.slotIndex = i;
        leaderboardState.container.appendChild(slot);
        leaderboardState.slots.push(slot);
    }
}

function ensurePPEl(kart) {
    if (!leaderboardState.container) return null;
    if (ppEls[kart.id]) return ppEls[kart.id];

    const ppDiv = document.createElement('div');
    ppDiv.className = 'leaderboard-pp';
    ppDiv.dataset.kartId = kart.id;

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
    img.alt = kart.charName;
    // ppStarRainbow, 0,4 s.
    alignAnimationPhase(img, 400);
    ppDiv.appendChild(img);

    ppEls[kart.id] = ppDiv;

    leaderboardState.container.appendChild(ppDiv);

    setTimeout(() => {
        ppDiv.classList.add('visible');
    }, 50);

    return ppDiv;
}

function applyLeaderboardPosition(kartId, newPosition, prevPosition) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('overtaking', 'dropping');

    if (prevPosition !== -1 && prevPosition !== newPosition) {
        if (newPosition < prevPosition) {
            ppElement.classList.add('overtaking');
        } else {
            ppElement.classList.add('dropping');
        }

        ppAnimating[kartId] = true;
        setTimeout(() => {
            ppElement.classList.remove('overtaking', 'dropping');
            ppAnimating[kartId] = false;
            positionPPInSlot(kartId, newPosition);
        }, 400);
    } else {
        positionPPInSlot(kartId, newPosition);
    }
}

function positionPPInSlot(kartId, slotIndex) {
    const ppElement = ppEls[kartId];
    if (!ppElement || slotIndex >= leaderboardState.slots.length) return;

    const slotWidth = cachedIsMobile ? 32 : 46;
    const totalSlots = leaderboardState.slots.length;
    const reversedIndex = (totalSlots - 1) - slotIndex;
    const xPos = reversedIndex * slotWidth;

    ppElement.style.top = '0px';
    ppElement.style.left = `${xPos}px`;
    ppSlots[kartId] = slotIndex;
}

function triggerPPHitAnimation(kartId) {
    const ppElement = ppEls[kartId];
    if (!ppElement) return;

    ppElement.classList.remove('hit');
    void ppElement.offsetWidth;
    ppElement.classList.add('hit');

    setTimeout(() => {
        ppElement.classList.remove('hit');
    }, 600);
}

// A tenir en phase avec la transition de .is-down dans smk-banner.css.
const CURTAIN_FALL_MS = 700;

// Duree minimale du rideau baisse, descente comprise : sans plancher, il
// repartirait vers le haut avant d'avoir fini de tomber.
const CURTAIN_MIN_MS = 1400;

// laps/2 a 4 existent dans les assets mais ne sont pas affiches.
const LAKITU_SPRITES = [
    ['start', 1], ['start', 2], ['start', 3], ['start', 4],
    ['laps', 'final'],
    ['finish', 1], ['finish', 2], ['finish', 3]
];

// Hauteur du sprite de Lakitu et sa position au-dessus de la route.
const LAKITU_HEIGHT = { pc: 120, mobile: 82 };
const LAKITU_BOTTOM = 32;

// Periode du damier rouge/blanc de la bordure de route, en unites monde : la
// bande se repete tous les 80px (repeating-linear-gradient, smk-banner.css).
const ROAD_PATTERN_WIDTH = 80;

// Les animations CSS decoratives sont calees sur l'horloge du serveur via un
// animation-delay negatif : deux navigateurs qui creent le meme element a des
// instants differents jouent malgre tout la meme phase. Sans ca, le rebond des
// karts et l'arc-en-ciel de l'etoile differeraient d'un spectateur a l'autre.
// `prop` sert aux animations portees par un pseudo-element, qui n'accepte aucun
// style inline : la phase se pose alors en variable CSS sur le parent, que la
// regle lit dans son `animation-delay`.
function alignAnimationPhase(el, cycleMs, prop) {
    const delay = `${-(getGameTime() % cycleMs)}ms`;
    if (prop) el.style.setProperty(prop, delay);
    else el.style.animationDelay = delay;
}

// Les elements crees avant que l'horloge du serveur ne soit connue portent une
// phase calee sur l'heure locale, donc fausse. Elle ne se corrigerait jamais
// d'elle-meme : un sprite garde son animation-delay tant qu'il existe.
function realignAnimations() {
    for (const id in kartEls) alignAnimationPhase(kartEls[id].img, 300);
    for (const id in ppEls) {
        const img = ppEls[id].firstChild;
        if (img) alignAnimationPhase(img, 400);
    }
    const sunEl = worldState.sun && worldState.sun.element;
    if (sunEl) alignAnimationPhase(sunEl, 2400, '--sun-phase');
}

const boxEls = [];
const pipeEls = [];

function initScene() {
    cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return;

    refreshLayoutMetrics();
    initLeaderboard();

    const finishLineEl = document.querySelector('.layer-finish-line');
    if (finishLineEl) {
        worldState.finishLine = { element: finishLineEl, worldX: WORLD.finishLineX };
    }

    const sunEl = document.querySelector('.layer-sun');
    if (sunEl) {
        // sunGlow, 2,4 s. Portee par `.layer-sun::after`, d'ou la variable.
        alignAnimationPhase(sunEl, 2400, '--sun-phase');
        // Solidaire du fond (bgCameraX), pas de la route.
        worldState.sun = { element: sunEl, worldX: WORLD.sunX };
    }

    cachedBg = document.querySelector('.layer-scrolling-bg');
    cachedFg = document.querySelector('.layer-scrolling-fg');
    cachedGround = document.querySelector('.layer-ground');
    const _bannerElSeason = document.getElementById('bannerSection');
    cachedIsSummerBanner = !!_bannerElSeason && _bannerElSeason.dataset.season === 'summer';

    if (GAME_CONFIG.debugMode) initDebugHUD();
}

// Vide la scene sans toucher au decor : c'est ce qu'on affiche quand le serveur
// est injoignable. Pas de course locale, pas de karts fantomes fige a l'ecran —
// le bandeau continue simplement de defiler.
function clearScene() {
    // On efface la scene que le gel tenait a l'ecran : la garder figee sur une
    // piste vide n'aurait plus rien a montrer, et le clic de reprise arriverait
    // sur une image morte. Le lien coupe leve donc la pause de lui-meme.
    if (racePaused) {
        racePaused = false;
        renderPause();
    }

    worldState.karts = [];
    worldState.kartsById = {};
    worldState.items = [];
    worldState.itemBoxes = [];
    worldState.finishOrder = [];
    worldState.gp = null;
    worldState.sign = null;
    worldState.vision = null;
    domDirty = true;
    reconcileDom();
    renderResults();
    renderGrandPrix();
}

// Date de depart de la course en cours. Un `hello` peut arriver pour deux
// raisons tres differentes : une simple reprise (retour d'onglet, reconnexion),
// ou une course entierement neuve — redemarrage manuel, ou relance apres un
// arret faute de spectateurs. Seul `t0` les distingue.
let currentRaceT0 = null;

// Une course neuve retire les personnages au sort et remet les identifiants
// d'objets a 1. Les elements DOM sont indexes par identifiant et leur sprite
// n'est pose qu'a la creation : sans ce menage, le kart 3 garderait le visage
// du personnage precedent. La reconciliation ne verrait rien a corriger, les
// identifiants n'ayant pas bouge.
function wipeSceneElements() {
    focusedKartId = null;
    lastFocusCameraX = null;
    // Le depart se regarde de nouveau en plan large, et l'historique des plans
    // ne vaut plus rien : les personnages ont ete retires au sort.
    raceDirector.reset();
    // Le cartouche mesure une vitesse par ecarts de distance : son repere ne
    // vaut plus rien quand les compteurs repartent de zero.
    resetFocusHud();

    if (lakituEls) {
        lakituEls.wrapper.remove();
        lakituEls = null;
    }
    resultsShown = -1;
    gpShown = '';
    myVote = false;

    for (const id in kartEls) {
        kartEls[id].wrapper.remove();
        delete kartEls[id];
    }
    for (const id in itemEls) {
        itemEls[id].remove();
        delete itemEls[id];
    }
    for (const id in ppEls) removePPEl(id);

    while (boxEls.length) boxEls.pop().remove();
    while (pipeEls.length) pipeEls.pop().remove();
}

function isNewRace(hello) {
    return hello.t0 !== currentRaceT0;
}

// Construit la scene a partir du `hello`. Rien n'est invente ici : identites,
// geometrie du monde et etat courant viennent tous du serveur.
function buildWorldFromHello(hello) {
    WORLD = hello.world;

    if (isNewRace(hello)) wipeSceneElements();
    currentRaceT0 = hello.t0;

    worldState.karts = hello.karts.map(entry => ({
        id: entry.id,
        charName: entry.char,
        // Son gabarit, tire de son sprite par le serveur : `body.x`/`body.y`
        // sont sa demi-emprise reelle — ce que la carte de debug dessine — et
        // `body.scale` le rapport de son dessin a celui du kart de reference.
        // Un serveur qui ne l'enverrait pas laisse le repli commun prendre le
        // relais, et tous les karts retrouvent la meme longueur.
        body: entry.body || null,
        worldX: 0,
        yPercent: WORLD.roadMinY,
        totalDistance: 0,
        state: 'grid',
        stopped: false,
        isInvincible: false,
        finished: false,
        rank: entry.id + 1,
        hitEndTime: 0,
        heldItem: null
    }));

    worldState.kartsById = {};
    for (const kart of worldState.karts) worldState.kartsById[kart.id] = kart;

    worldState.itemBoxes = hello.boxes.map(box => ({ worldX: box.x, y: box.y, active: true }));
    // Un circuit sans obstacle n'envoie pas de liste : elle vaut alors vide.
    worldState.pipes = (hello.pipes || []).map(pipe => ({
        worldX: pipe.x, y: pipe.y, kind: pipe.kind || 'green'
    }));
    worldState.items = [];

    if (worldState.finishLine) worldState.finishLine.worldX = WORLD.finishLineX;
    if (worldState.sun) worldState.sun.worldX = WORLD.sunX;

    applyState(hello.snapshot, null, 0);
    domDirty = true;
    reconcileDom();

    // La carte de debug se rebatit ICI, et pas seulement au demarrage.
    //
    // `initScene` tourne avant que la connexion ne parte : au moment ou elle
    // appelait `initDebugHUD`, il n'y avait ni kart, ni boite, ni tuyau, et le
    // monde valait encore `OFFLINE_WORLD`. La carte se construisait donc vide et
    // le restait — `updateDebugHUD` cherchait des elements qui n'avaient jamais
    // ete crees, en silence. C'est pour ca qu'elle ne montrait qu'un cadre et la
    // fenetre de camera.
    //
    // Une course neuve change les tuyaux et les boites : la reconstruire a
    // chaque `hello` est aussi ce qui la garde juste d'un circuit a l'autre.
    if (GAME_CONFIG.debugMode) initDebugHUD();
}

function getItemVisualConfig(itemType) {
    switch (itemType) {
        case 'greenShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.greenShell.widthMobile : GAME_CONFIG.visuals.greenShell.width,
                src: imageCache['greenShell_1'] ? imageCache['greenShell_1'].src : GAME_CONFIG.resources.paths.greenShell(1),
                holdPosition: 'behind'
            };
        case 'redShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.redShell.widthMobile : GAME_CONFIG.visuals.redShell.width,
                src: imageCache['redShell_1'] ? imageCache['redShell_1'].src : GAME_CONFIG.resources.paths.redShell(1),
                holdPosition: 'behind'
            };
        case 'banana':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.banana.widthMobile : GAME_CONFIG.visuals.banana.width + 4,
                src: imageCache['banana'] ? imageCache['banana'].src : GAME_CONFIG.resources.paths.banana,
                holdPosition: 'behind'
            };
        // Les triples n'ont pas de sprite propre : ils reprennent celui de
        // l'objet qu'ils larguent. Ce cas ne sert qu'aux appels directs, le
        // rendu de l'orbite interrogeant deja le type enfant.
        case 'tripleBanana':
            return Object.assign(getItemVisualConfig('banana'), { holdPosition: 'orbit' });
        case 'tripleGreenShell':
            return Object.assign(getItemVisualConfig('greenShell'), { holdPosition: 'orbit' });
        case 'tripleRedShell':
            return Object.assign(getItemVisualConfig('redShell'), { holdPosition: 'orbit' });
        case 'blueShell':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.blueShell.widthMobile : GAME_CONFIG.visuals.blueShell.width,
                src: imageCache['blueShell_1'] ? imageCache['blueShell_1'].src : GAME_CONFIG.resources.paths.blueShell(1),
                holdPosition: 'hands'
            };
        // Le souffle n'a pas de sprite : il est dessine en CSS, et sa taille
        // vient du rayon reellement utilise par le serveur.
        case 'blueBlast':
            return { size: WORLD.blastRadius * 2, src: null, holdPosition: 'behind' };
        case 'shroom':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.shroom.widthMobile : GAME_CONFIG.visuals.shroom.width,
                src: imageCache['shroom'] ? imageCache['shroom'].src : GAME_CONFIG.resources.paths.shroom,
                holdPosition: 'hands'
            };
        case 'star':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.star.widthMobile : GAME_CONFIG.visuals.star.width,
                src: imageCache['star'] ? imageCache['star'].src : GAME_CONFIG.resources.paths.star,
                holdPosition: 'hands'
            };
        case 'lightning':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.lightning.widthMobile : GAME_CONFIG.visuals.lightning.width,
                src: GAME_CONFIG.resources.paths.lightning,
                holdPosition: 'hands'
            };
        case 'bill':
            return {
                size: cachedIsMobile ? GAME_CONFIG.visuals.bill.widthMobile : GAME_CONFIG.visuals.bill.width,
                src: imageCache['bill_1'] ? imageCache['bill_1'].src : GAME_CONFIG.resources.paths.bill(1),
                holdPosition: 'hands'
            };
        default:
            return { size: 32, src: '', holdPosition: 'behind' };
    }
}

// Ou se pose l'objet TENU EN MAIN, en ecart au bord gauche du sprite. Du dessin
// et rien d'autre : en main, un objet n'a aucune emprise — il ne protege de rien
// et ne blesse personne tant qu'il n'est pas passe au trainage. Il peut donc se
// caler a l'oeil, et plus serre sur mobile ou le kart est plus petit.
//
// L'objet TRAINE n'a volontairement pas son pendant ici : sa place est une
// position du monde, pas un reglage de rendu. Voir `heldBehindX`.
//
// Recalculé à chaque frame (pas figé à l'attribution) pour suivre un
// changement de breakpoint pendant que l'objet est tenu.
function getHandsItemRenderOffset() {
    const r = GAME_CONFIG.offsets.render.heldItemHands;

    return {
        offset: cachedIsMobile ? r.x.mobile : r.x.pc,
        yShift: cachedIsMobile ? r.yShift.mobile : r.yShift.pc
    };
}

function createHeldItemElement(itemType, holdPosition) {
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');

    const itemDiv = document.createElement('div');
    itemDiv.style.position = 'absolute';
    itemDiv.style.pointerEvents = 'none';

    const visual = getItemVisualConfig(itemType);
    itemDiv.style.width = `${visual.size}px`;

    // Pose par son MILIEU, comme tous les corps de la scene : `worldX` est un
    // centre pour le moteur — ses hitboxes sont des ecarts entre centres — et
    // un element pose par son coin gauche se retrouve une demi-largeur trop a
    // droite de l'emprise qui le fait toucher. Le souffle de la bleue etait
    // seul a le faire ; ce qui valait pour lui vaut pour tout le monde.
    itemDiv.style.marginLeft = `${-visual.size / 2}px`;

    // Ancre au sol une fois pour toutes : la profondeur passe par la
    // transformation posee a chaque image (cf. depthToY), et non plus par un
    // `bottom` en pourcentage qui relancait la mise en page a chaque fois.
    itemDiv.style.bottom = '0px';

    // La demi-largeur reste attachee a l'element : elle sert a replacer un
    // objet TENU, qui se cale sur la silhouette du kart et non sur un centre.
    // La relire ici evite de reconstruire une config par objet a chaque frame.
    itemDiv._halfW = visual.size / 2;

    // Le souffle de la bleue est un element sans image, anime en CSS.
    if (!visual.src) {
        itemDiv.classList.add('blue-blast');

        const wave = document.createElement('div');
        wave.className = 'blue-blast-wave';
        itemDiv.appendChild(wave);

        cachedContainer.appendChild(itemDiv);
        return { div: itemDiv, img: null };
    }

    const img = document.createElement('img');
    img.style.width = '100%';
    img.src = visual.src;

    if (holdPosition === 'hands') {
        itemDiv.classList.add('held-item-bouncing');
        alignAnimationPhase(img, 300);
    }

    itemDiv.appendChild(img);
    cachedContainer.appendChild(itemDiv);
    return { div: itemDiv, img: img };
}

// Les carapaces tournent sur elles-memes. La frame est derivee du temps de jeu
// plutot que stockee, comme le tete-a-queue : rien a maintenir, et les trois
// orbes ne peuvent pas se desynchroniser entre eux. Rend null pour un objet
// sans animation, la banane par exemple.
function getOrbitFrameSrc(childType, gameNow) {
    if (childType !== 'greenShell' && childType !== 'redShell') return null;

    const frame = (Math.floor(gameNow / WORLD.shellAnimSpeed) % 3) + 1;
    const cached = imageCache[`${childType}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths[childType](frame);
}

// Un objet en orbite reste visible sur toute sa rotation : quand sa phase le
// place au loin, il passe simplement sous le z-index du kart et c'est le
// sprite, opaque, qui l'occulte. Il reapparait donc progressivement de part et
// d'autre du pilote au lieu de s'effacer d'un coup.
//
// La bascule se joue aux extremites laterales de l'ellipse (sin change de signe
// quand cos vaut +/-1), la ou l'objet est justement hors de la silhouette du
// kart : le changement d'ordre y passe inapercu.
function renderOrbitItems(kart, rx, gameNow) {
    const held = kart.heldItem;
    const orbit = WORLD.orbit;

    // L'orbite tourne autour du kart, donc autour de `rx` : les objets se
    // posent par leur milieu et le kart est centre sur sa position. Il n'y a
    // plus rien a recentrer — ce calcul valait du temps ou les deux etaient
    // ancres par leur coin gauche, avec deux largeurs differentes a rattraper.
    const cx = rx;

    const d = GAME_CONFIG.offsets.render.orbitDrop;
    const drop = cachedIsMobile ? d.mobile : d.pc;
    const kartZ = getZIndex(kart.yPercent);
    const animSrc = getOrbitFrameSrc(held.childType, gameNow);

    for (let i = 0; i < held.orbs.length; i++) {
        const orb = held.orbs[i];
        const el = itemEls[orb.id];
        if (!el) continue;

        if (animSrc) {
            const img = el.firstChild;
            if (img && img.getAttribute('src') !== animSrc) img.src = animSrc;
        }

        const angle = held.orbitAngle + orb.phase;
        const sin = Math.sin(angle);
        const by = kart.yPercent + sin * orbit.radiusY;

        // getZIndex suit la profondeur reelle, ce qui garde l'objet bien
        // ordonne vis-a-vis des autres karts. Mais son arrondi entier peut
        // l'egaler au kart porteur quand sin frole 0 : a egalite c'est l'ordre
        // du DOM qui tranche, et l'objet scintillerait devant/derriere. D'ou
        // l'ecart d'au moins un cran force du bon cote.
        const bz = (sin > 0) ? Math.min(getZIndex(by), kartZ - 1)
                             : Math.max(getZIndex(by), kartZ + 1);

        el.style.display = 'block';
        // Y positif = vers le bas : l'orbite entiere descend de `drop`, et la
        // profondeur de l'orbe se plie dans la meme transformation.
        el.style.transform = `translate3d(${cx + Math.cos(angle) * orbit.radiusX}px, ${depthToY(by) + drop}px, 0)`;
        if (el.style.zIndex != bz) el.style.zIndex = bz;
    }
}

function hideOrbitItems(kart) {
    const held = kart.heldItem;
    for (let i = 0; i < held.orbs.length; i++) {
        const el = itemEls[held.orbs[i].id];
        if (el) el.style.display = 'none';
    }
}

// itemEls n'a pas d'entree pour l'id de groupe d'un objet en orbite, les acces
// generiques a itemEls[heldItem.id] sont donc des no-op sur ces types : ce
// wrapper est le seul chemin qui masque reellement un bouclier.
function hideHeldItem(kart) {
    if (!kart.heldItem) return;
    if (kart.heldItem.holdPosition === 'orbit') {
        hideOrbitItems(kart);
        return;
    }
    const el = itemEls[kart.heldItem.id];
    if (el) el.style.display = 'none';
}

// ---------------------------------------------------------------------------
// Rideau de depart et etat de la connexion
//
// Le rideau ne se leve que sur une scene complete : images decodees, `hello`
// recu, et deux snapshots en tampon — avec un seul, l'interpolation demarre a
// vide et la premiere seconde saccade.
//
// L'indicateur dit au spectateur ce qu'il regarde : une course en direct
// (point vert) ou le decor seul, faute de connexion (point rouge).
// ---------------------------------------------------------------------------
const bannerLink = {
    curtainEl: null,
    statusEl: null,
    labelEl: null,
    msEl: null,
    leaderboardEl: null,

    // Derniere latence mesuree, ou null quand il n'y a rien a montrer : hors
    // ligne, un chiffre fige decrirait un lien qui n'existe plus.
    pingMs: null,

    // Le rideau se leve quand les deux verrous sont ouverts : les images
    // decodees, et le flux en etat de fournir une scene — soit deux snapshots
    // en tampon, soit la certitude qu'il n'y aura pas de course.
    gates: { assets: false, stream: false },
    loweredAt: 0,

    open(gate) {
        this.gates[gate] = true;
        if (!this.gates.assets || !this.gates.stream) return;

        // Sans plancher, le rideau clignoterait entre deux courses.
        const shown = Date.now() - this.loweredAt;
        if (shown < CURTAIN_MIN_MS) {
            setTimeout(() => this.raiseCurtain(), CURTAIN_MIN_MS - shown);
            return;
        }

        this.raiseCurtain();
    },

    init() {
        this.curtainEl = document.getElementById('race-curtain');
        this.statusEl = document.getElementById('race-status');
        this.labelEl = this.statusEl ? this.statusEl.querySelector('.race-status-label') : null;
        this.msEl = this.statusEl ? this.statusEl.querySelector('.race-status-ms') : null;
        this.leaderboardEl = document.getElementById('race-leaderboard');
    },

    lowerCurtain() {
        this.loweredAt = Date.now();
        if (this.curtainEl) this.curtainEl.classList.add('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.add('is-veiled');
    },

    raiseCurtain() {
        if (this.curtainEl) this.curtainEl.classList.remove('is-down');
        if (this.leaderboardEl) this.leaderboardEl.classList.remove('is-veiled');

        // L'ecran de demarrage (index.html) attend ce signal pour se dissiper :
        // la page se decouvre quand la scene est prete a etre regardee, pas
        // avant. Emis a chaque levee, mais il n'est ecoute qu'une fois.
        document.dispatchEvent(new CustomEvent('race:ready'));
    },

    setStatus(state) {
        if (!this.statusEl) return;
        this.statusEl.classList.remove('is-connecting', 'is-online', 'is-offline');
        this.statusEl.classList.add(`is-${state}`);
        if (this.labelEl) {
            this.labelEl.textContent = state === 'online' ? 'online'
                                     : state === 'offline' ? 'offline'
                                     : 'connexion';
        }
        // La latence n'accompagne que l'etat en direct : elle survivrait sinon
        // a la coupure qu'elle est censee documenter.
        if (state !== 'online') this.pingMs = null;
        this.renderPing();
    },

    // Le dernier aller-retour, pas le meilleur : celui que garde bannerNet sert
    // a caler l'horloge, ou une mesure propre vaut mieux qu'une recente. Ici on
    // decrit le lien tel qu'il est maintenant, ralentissements compris.
    setPing(ms) {
        this.pingMs = ms;
        if (this.statusEl && this.statusEl.classList.contains('is-online')) this.renderPing();
    },

    renderPing() {
        if (!this.msEl) return;
        this.msEl.textContent = this.pingMs === null ? '' : `${Math.round(this.pingMs)} ms`;
    }
};

// ---------------------------------------------------------------------------
// Reconciliation du DOM avec l'etat du monde
//
// Regle : l'etat fait foi, les evenements ne sont que de la decoration. A
// chaque nouvel etat recu, le DOM est aligne dessus — ce qui manque est cree,
// ce qui ne correspond plus a rien est supprime. Aucun element visible ne doit
// dependre d'un evenement qu'il aurait fallu voir passer.
//
// C'est ce qui rend affichable une course deja commencee : un spectateur qui
// arrive a la 187e seconde n'a vu aucun `kartSpawned`, aucun `spawnHeldItem`,
// aucun `starOn`, et doit pourtant voir la scene complete et juste. Meme chose
// apres une micro-coupure, ou un evenement peut simplement s'etre perdu.
// ---------------------------------------------------------------------------

// ── La longueur d'un kart, a l'ecran ────────────────────────────────────────
//
// Elle n'est plus la meme pour tous : chaque personnage est dessine au prorata
// de son PNG, et son emprise l'est du meme rapport. Le serveur envoie ce
// rapport dans son `hello` (`kart.body.scale`), calcule une seule fois a partir
// des mesures des fichiers — le client ne le deduit pas, il l'applique, comme
// pour toute autre constante du monde.
//
// 1 pendant un vol de bill : le sprite affiche n'est plus celui du personnage,
// et le bill a une emprise a lui, la meme quel que soit son porteur. Le laisser
// varier donnerait huit bills de tailles differentes pour une seule hitbox.
function kartDrawScale(kart) {
    if (kart.isBill) return 1;
    return (kart.body && kart.body.scale) || 1;
}

// Demi-longueur DESSINEE, en px. `worldX` est le CENTRE du kart — c'est ce que
// dit le moteur, dont toutes les hitboxes sont des ecarts entre centres — et
// l'element se pose par son coin gauche : il faut reculer d'autant pour que le
// dessin tombe sur l'emprise qui le fait toucher.
//
// Tout ce qui se cale sur la SILHOUETTE et non sur la position — l'objet en
// main, l'orbite, les eclairs de l'orage — part de ce meme bord gauche et suit
// donc le kart quelle que soit sa longueur.
function kartDrawHalfWidth(kart) {
    const base = cachedIsMobile ? GAME_CONFIG.rendering.kartWidth.mobile
                                : GAME_CONFIG.rendering.kartWidth.pc;
    return base * kartDrawScale(kart) / 2;
}

function ensureKartEl(kart) {
    let els = kartEls[kart.id];
    if (els) return els;

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.classList.add('kart-container-moving');
    wrapper.style.zIndex = getZIndex(kart.yPercent);

    // La longueur du dessin, en rapport au kart de reference. Une variable CSS
    // et non une largeur en px : c'est la feuille de style qui connait la
    // largeur de base, et elle n'est pas la meme sur mobile — la poser ici en
    // pixels obligerait a la recalculer a chaque changement d'appareil.
    //
    // Elle repasse a 1 pendant un vol de bill, ou le sprite n'est plus celui du
    // personnage : le bill a une emprise a lui, la meme pour tous les porteurs,
    // et son dessin se cale dessus (cf. `.kart-bill` en CSS).
    wrapper.style.setProperty('--kart-length', kartDrawScale(kart));

    // Intercalaire dédié au rapetissement de l'éclair : il porte une transition,
    // que le miroir du tête-à-queue ne doit surtout pas subir.
    const scaler = document.createElement('div');
    scaler.classList.add('kart-scaler');

    // Intercalaire dédié au miroir : snesBounce occupe déjà `transform`
    // sur l'img, on ne peut pas y empiler un scaleX(-1).
    const sprite = document.createElement('div');
    sprite.classList.add('kart-sprite');

    const img = document.createElement('img');
    img.src = GAME_CONFIG.resources.paths.char(kart.charName);
    img.classList.add('kart-static-png');
    // snesBounce (0,15 s en alternate = cycle de 0,3 s) et starRainbow (0,3 s).
    alignAnimationPhase(img, 300);

    sprite.appendChild(img);
    scaler.appendChild(sprite);
    wrapper.appendChild(scaler);
    cachedContainer.appendChild(wrapper);

    // `spinFrame` decrit ce que cet element affiche : il vit donc avec lui, et
    // non dans l'etat du kart, qui est reconstruit a chaque `hello`. Sinon le
    // rendu croirait n'avoir rien a changer et laisserait le sprite fige sur
    // une image de tete-a-queue. 0 correspond au sprite pose ci-dessus.
    els = { wrapper: wrapper, scaler: scaler, sprite: sprite, img: img, spinFrame: 0, billOn: false, billFrame: 0 };
    kartEls[kart.id] = els;

    return els;
}

function ensureItemEl(itemId, itemType, holdPosition) {
    let el = itemEls[itemId];
    if (el) return el;
    el = createHeldItemElement(itemType, holdPosition).div;
    itemEls[itemId] = el;
    return el;
}

function ensureBoxEl(box, index) {
    if (boxEls[index]) return boxEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const size = cachedIsMobile ? GAME_CONFIG.visuals.box.sizeMobile : GAME_CONFIG.visuals.box.sizePC;
    const el = document.createElement('div');
    el.classList.add('item-box');
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    // Centree sur sa position, comme le tuyau et comme les karts : la zone de
    // ramassage (hitboxes.itemBox, +/-10) est centree sur `worldX`, une boite
    // posee par son coin gauche se ramasserait a 21 px de la ou elle est vue.
    el.style.marginLeft = `${-size / 2}px`;
    el.style.zIndex = getZIndex(box.y);

    cachedContainer.appendChild(el);
    boxEls[index] = el;
    return el;
}

// Le tuyau est ancre par sa base a sa profondeur, comme un kart, et centre sur
// sa position : la hitbox du serveur l'est aussi, et un element pose par son
// bord gauche s'arreterait une demi-largeur trop loin. Le recentrage se pose
// une fois ici, comme pour les karts, les boites et les objets — aucun corps ne
// le refait a chaque frame.
function ensurePipeEl(pipe, index) {
    if (pipeEls[index]) return pipeEls[index];

    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    // Du serveur, et de lui seul : c'est cette taille qui a servi a calculer
    // l'emprise du tuyau, les deux ne peuvent donc plus diverger. Le repli du
    // GAME_CONFIG ne sert qu'au decor hors ligne.
    //
    // Posee en variables et non en pixels : le retrecissement mobile du DESSIN
    // vit dans la feuille de style, comme celui du kart (cf.
    // `.kart-container-moving`). En calculant ici des pixels, il faudrait les
    // refaire a chaque changement d'appareil — et un tuyau, une fois cree, n'est
    // jamais recree.
    const size = WORLD.pipeDraw || OFFLINE_WORLD.pipeDraw;
    const el = document.createElement('div');
    el.classList.add('pipe');
    el.style.setProperty('--pipe-w', size.w);
    el.style.setProperty('--pipe-h', size.h);
    el.style.zIndex = getZIndex(pipe.y);

    // Le dessin vit dans un enfant, et non sur l'element place. Le defilement
    // pose une `transform` a chaque frame sur le parent ; une animation CSS sur
    // la meme propriete l'emporterait dans la cascade et figerait le tuyau a
    // l'ecran pendant tout son sursaut.
    const sprite = document.createElement('div');
    sprite.classList.add('pipe-sprite');

    // La couleur, et c'est tout ce qu'elle fait. Elle vit sur le sprite et non
    // sur l'element place : le parent porte le defilement et l'etat (le
    // sursaut), l'enfant porte le dessin. Le vert est le defaut de
    // `.pipe-sprite`, donc un tuyau sans couleur s'affiche quand meme.
    if (pipe.kind === 'red') sprite.classList.add('pipe-red');

    el.appendChild(sprite);

    // Le sursaut se joue en ajoutant une classe. Sans ce retrait a la fin, un
    // second passage d'etoile ne rejouerait rien. L'evenement remonte de
    // l'enfant anime jusqu'ici.
    el.addEventListener('animationend', () => el.classList.remove('pipe-shaken'));

    cachedContainer.appendChild(el);
    pipeEls[index] = el;
    return el;
}

// Un objet peut exister a trois endroits : libre sur la piste, tenu par un
// kart, ou en orbite autour de lui (auquel cas ce sont les orbes qui portent
// les ids, pas le groupe). Tout ce qui n'est dans aucun des trois est un
// orphelin : element laisse par un objet detruit, ou reliquat d'une course
// precedente. Sans ce balayage, chaque reconnexion fuirait quelques divs.
function reconcileItems() {
    const expected = {};

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        expected[item.id] = true;

        // L'element a ete cree quand l'objet etait encore en main, donc avec le
        // rebond. Une fois lance, il n'y a plus rien pour le retirer : sans
        // cette ligne, une banane sautille au sol.
        ensureItemEl(item.id, item.type, 'behind').classList.remove('held-item-bouncing');
    }

    for (let i = 0; i < worldState.karts.length; i++) {
        const held = worldState.karts[i].heldItem;
        if (!held) continue;

        if (held.holdPosition === 'orbit') {
            for (let o = 0; o < held.orbs.length; o++) {
                expected[held.orbs[o].id] = true;
                ensureItemEl(held.orbs[o].id, held.childType, 'orbit');
            }
        } else {
            expected[held.id] = true;
            ensureItemEl(held.id, held.type, held.holdPosition);
        }
    }

    for (const id in itemEls) {
        if (expected[id]) continue;
        itemEls[id].remove();
        delete itemEls[id];
    }
}

// Le classement se reconstruit de zero : un arrivant doit voir les huit photos
// deja rangees dans l'ordre, sans avoir vu le moindre depassement. Les karts
// encore `pending` n'y figurent pas — ils ne sont pas entres en course.
function reconcileLeaderboard() {
    for (let i = 0; i < worldState.karts.length; i++) {
        const kart = worldState.karts[i];

        ensurePPEl(kart);

        const slot = kart.rank - 1;
        if (!ppAnimating[kart.id] && ppSlots[kart.id] !== slot) {
            positionPPInSlot(kart.id, slot);
        }
    }

    for (const id in ppEls) {
        if (!worldState.kartsById[id]) removePPEl(id);
    }

    updateFocusMarks();
}

function removePPEl(kartId) {
    const el = ppEls[kartId];
    if (!el) return;
    el.remove();
    delete ppEls[kartId];
    delete ppSlots[kartId];
    delete ppAnimating[kartId];
}

// Le halo d'etoile est un etat, pas un evenement : `starOn` / `starOff` ne sont
// que les instants ou il bascule, invisibles pour qui arrive entre les deux.
function reconcileStar(kart) {
    const on = !!kart.isInvincible;
    const els = kartEls[kart.id];
    if (els) els.wrapper.classList.toggle('star-active', on);
    const pp = ppEls[kart.id];
    if (pp) pp.classList.toggle('pp-star-active', on);
}

// Le rapetissement est un etat, pas une animation : il se lit dans le snapshot
// et se pose en classe. La transition CSS fait le reste, a l'aller comme au
// retour — un arrivant en cours de malus voit un kart deja petit, sans a-coup.
function reconcileShrink(kart) {
    const els = kartEls[kart.id];
    if (!els) return;
    els.scaler.style.setProperty('--kart-scale', kart.isShrunk ? WORLD.shrinkScale : 1);

    // L'ecrasement se pose sur le meme calque, et les deux se multiplient : un
    // kart peut etre petit ET aplati, ou aplati mais deja regrossi, les deux
    // comptes a rebours etant independants.
    //
    // Contrairement au rapetissement, l'ampleur est ecrite en CSS et non
    // transmise : la taille du petit est une valeur de gameplay — elle decide de
    // qui passe sous qui — alors qu'un kart aplati a exactement la meme emprise
    // qu'avant. Ce n'est plus que du dessin.
    els.scaler.classList.toggle('is-flat', !!kart.isFlat);

    // La carte de debug suit le rapetissement. L'emprise a vraiment maigri, pas
    // seulement le dessin (cf. `kartHalfExtents` cote moteur) : une carte qui
    // continuerait de montrer la boite pleine mentirait sur le seul point
    // qu'elle sert a verifier — ou un kart touche, et ou il passe.
    //
    // Ecrit au CHANGEMENT seulement : cette fonction passe a chaque image et
    // pour chaque kart, et une mesure du DOM par kart et par image pour un
    // etat qui bouge deux fois en dix secondes serait payee cher.
    if (!GAME_CONFIG.debugMode || !kart.body) return;
    const shrink = kart.isShrunk ? WORLD.shrinkScale : 1;
    if (els.debugShrink === shrink) return;
    els.debugShrink = shrink;
    const mark = document.getElementById(`debug-kart-${kart.id}`);
    if (mark) sizeEntity(mark, { x: kart.body.x * shrink, y: kart.body.y * shrink });
}

function reconcileDom() {
    for (let i = 0; i < worldState.karts.length; i++) ensureKartEl(worldState.karts[i]);

    for (const id in kartEls) {
        if (worldState.kartsById[id]) continue;
        kartEls[id].wrapper.remove();
        delete kartEls[id];
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) ensureBoxEl(worldState.itemBoxes[i], i);
    while (boxEls.length > worldState.itemBoxes.length) boxEls.pop().remove();

    for (let i = 0; i < worldState.pipes.length; i++) ensurePipeEl(worldState.pipes[i], i);
    while (pipeEls.length > worldState.pipes.length) pipeEls.pop().remove();

    reconcileItems();
    reconcileLeaderboard();

    for (let i = 0; i < worldState.karts.length; i++) {
        reconcileStar(worldState.karts[i]);
        reconcileShrink(worldState.karts[i]);
    }
}

// Les evenements ne creent et ne detruisent plus rien : ils ne declenchent que
// des animations ponctuelles, qu'un spectateur arrive en retard peut rater sans
// que sa scene en soit fausse. Tout le reste est deduit de l'etat par
// reconcileDom(). Les types non listes ici (kartSpawned, spawnHeldItem,
// removeHeldItem, killItem, launchItem, starOn, starOff) n'ont donc plus
// d'effet propre.
function applyEvent(ev) {
    switch (ev.type) {
        case 'kartHit': {
            triggerPPHitAnimation(ev.kartId);
            break;
        }
        // Un pipe traverse par une etoile : il sursaute, et se remet en place.
        // Purement decoratif, et invisible dans le snapshot — le tuyau est au
        // meme endroit avant et apres. Un arrivant en retard le rate sans que sa
        // scene en soit fausse.
        case 'pipeShaken': {
            const el = pipeEls[ev.pipeIndex];
            if (el) {
                el.classList.remove('pipe-shaken');
                // Force le navigateur a reprendre l'animation depuis le debut :
                // sans cette lecture, retirer puis remettre la classe dans la
                // meme frame ne relance rien.
                void el.offsetWidth;
                el.classList.add('pipe-shaken');
            }
            break;
        }
        case 'leaderboardPosition': {
            // Le glissement n'a de sens que si la photo etait deja quelque part.
            if (ppEls[ev.kartId]) applyLeaderboardPosition(ev.kartId, ev.newPosition, ev.prevPosition);
            break;
        }
    }
}

// Dérivé uniquement de l'état physique (state + hitEndTime) : aucun timer de
// rendu à maintenir, donc rien qui puisse désynchroniser du reste de la course.
// Le kart boucle kartSpin.turns fois sur la fraction durationRatio du malus,
// puis reste sur side-right jusqu'à ce qu'il reparte.
function getSpinFrameIndex(kart, gameNow) {
    if (kart.state !== 'hit') return 0;

    const hitDuration = WORLD.hitDuration;
    const spinDuration = hitDuration * GAME_CONFIG.kartSpin.durationRatio;
    const elapsed = gameNow - (kart.hitEndTime - hitDuration);
    if (elapsed <= 0 || elapsed >= spinDuration) return 0;

    const frameCount = GAME_CONFIG.kartSpin.frames.length;
    return Math.floor((elapsed / spinDuration) * GAME_CONFIG.kartSpin.turns * frameCount) % frameCount;
}

function applyKartSpinFrame(kart, els, frameIndex) {
    const frame = GAME_CONFIG.kartSpin.frames[frameIndex];
    els.img.src = getKartFrameSrc(kart.charName, frame.dir);
    els.sprite.classList.toggle('kart-mirrored', frame.mirror);
}

// Orage de l'eclair. Deux mecaniques distinctes dans le meme calque :
//
//  - l'assombrissement est **derive du temps**, recalcule a chaque frame depuis
//    les trois dates du snapshot. C'est ce qui garantit qu'un spectateur arrive
//    en plein orage trouve le ciel au bon niveau de noir, et le voie se lever au
//    meme instant que tout le monde ;
//  - les eclairs sont une animation ponctuelle, jouee une fois au passage de la
//    frappe. Un arrivant en retard les rate, et c'est sans consequence : la
//    scene reste juste sans eux.
//
// Trois traits, dessines en SVG. Le cadre fait 40x120, les bolts sont etires
// verticalement par le CSS jusqu'au bas du ciel.
//
// Chaque trace se termine **a droite** de son point de depart : les karts vont
// vers la droite, un eclair qui derive vers la gauche donne l'impression de
// tomber derriere eux. Les ancres sont decalees dans le meme sens, pour que la
// pointe touche le sol devant le kart plutot que dans son sillage.
// `tip` est l'abscisse ou le trait touche le sol, dans le repere du viewBox :
// ce n'est pas l'ancre, puisque chaque trace derive vers la droite.
const STORM_VIEWBOX_W = 40;
const STORM_BOLTS = [
    { left: 22, tip: 29, path: 'M12 0 L24 42 L13 47 L29 120' },
    { left: 54, tip: 34, path: 'M10 0 L22 38 L11 44 L34 120' },
    { left: 83, tip: 31, path: 'M14 0 L26 46 L15 51 L31 120' }
];

// Largeur des traits, miroir de .storm-bolt en CSS : l'ecart se calcule en
// pixels de conteneur, il lui faut la meme mesure que le rendu.
const STORM_BOLT_W = { pc: 60, mobile: 40 };

// Marge entre la pointe et le bord du kart epargne.
const STORM_BOLT_CLEARANCE = 8;

let stormEls = null;

function ensureStormEls() {
    if (stormEls) return stormEls;

    const wrapper = document.querySelector('.game-content-wrapper');
    if (!wrapper) return null;

    const layer = document.createElement('div');
    layer.className = 'storm-layer';
    layer.setAttribute('aria-hidden', 'true');

    const dim = document.createElement('div');
    dim.className = 'storm-dim';
    layer.appendChild(dim);

    const bolts = document.createElement('div');
    bolts.className = 'storm-bolts';

    STORM_BOLTS.forEach(spec => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'storm-bolt');
        svg.setAttribute('viewBox', '0 0 40 120');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.left = `${spec.left}%`;

        // Deux traits sur le meme chemin : le large porte la lueur jaune, le fin
        // le coeur blanc. Un seul trait donnerait une barre plate.
        const glow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        glow.setAttribute('d', spec.path);
        glow.setAttribute('class', 'storm-bolt-glow');

        const core = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        core.setAttribute('d', spec.path);
        core.setAttribute('class', 'storm-bolt-core');

        svg.appendChild(glow);
        svg.appendChild(core);
        bolts.appendChild(svg);
    });

    layer.appendChild(bolts);

    const flash = document.createElement('div');
    flash.className = 'storm-flash';
    layer.appendChild(flash);

    wrapper.appendChild(layer);

    stormEls = { layer: layer, bolts: bolts, flash: flash, struckFor: 0 };
    return stormEls;
}

// Le lanceur traverse son propre orage indemne : le trait qui viserait sa
// position est ecarte juste assez pour tomber a cote. Au plus un est concerne,
// les ancres etant trop espacees pour qu'un meme kart en couvre deux.
function placeStormBolts(els, shooterId, screenWidth) {
    const svgs = els.bolts.children;
    const boltW = cachedIsMobile ? STORM_BOLT_W.mobile : STORM_BOLT_W.pc;
    // Le milieu du kart EST sa position : le sprite y est centre, comme sa
    // hitbox. `keepOut` ci-dessous s'en deduit — la demi-largeur DE CE KART,
    // qui n'est pas la meme pour tous depuis que le dessin suit le sprite, plus
    // la marge de confort.
    const shooter = (shooterId === null || shooterId === undefined)
        ? null : worldState.kartsById[shooterId];
    const shooterCx = shooter
        ? getScreenPosition(shooter.worldX, renderCameraX, screenWidth)
        : null;

    for (let i = 0; i < STORM_BOLTS.length && i < svgs.length; i++) {
        const spec = STORM_BOLTS[i];
        const svg = svgs[i];
        svg.style.display = '';

        let anchor = (spec.left / 100) * screenWidth;

        if (shooterCx !== null) {
            const tipOffset = (spec.tip / STORM_VIEWBOX_W) * boltW - boltW / 2;
            const keepOut = kartDrawHalfWidth(shooter) + STORM_BOLT_CLEARANCE;

            if (Math.abs(anchor + tipOffset - shooterCx) < keepOut) {
                const half = boltW / 2;
                const before = shooterCx - keepOut - tipOffset;
                const after = shooterCx + keepOut - tipOffset;
                const beforeFits = before - half > 0;
                const afterFits = after + half < screenWidth;

                // On decale du cote ou le trait etait deja ; l'autre sert de
                // repli quand celui-la sort de l'ecran.
                if (beforeFits && (anchor <= shooterCx || !afterFits)) {
                    anchor = before;
                } else if (afterFits) {
                    anchor = after;
                } else {
                    // Nulle part ou tomber : plutot pas de trait du tout.
                    svg.style.display = 'none';
                    continue;
                }
            }
        }

        svg.style.left = `${(anchor / screenWidth) * 100}%`;
    }
}

function renderStorm(gameNow, screenWidth) {
    const storm = worldState.storm;

    if (!storm) {
        if (stormEls && stormEls.layer.style.display !== 'none') {
            stormEls.layer.style.display = 'none';
            stormEls.bolts.classList.remove('storm-firing');
            stormEls.flash.classList.remove('storm-firing');
            stormEls.struckFor = 0;
        }
        return;
    }

    const els = ensureStormEls();
    if (!els) return;

    const startedAt = storm[0];
    const strikeAt = storm[1];
    const until = storm[2];

    // Le ciel se charge jusqu'a la frappe, tient, puis se degage sur la fin.
    // Avec strikeAt a zero la premiere branche ne sert pas : le noir est pose
    // d'un coup, sur la frame meme ou les eclairs partent. Elle reste la pour
    // qu'un `strikeAt` non nul redonne un ciel qui se charge.
    const STORM_CLEAR_MS = 700;
    let level;
    if (gameNow < strikeAt) {
        const build = Math.max(1, strikeAt - startedAt);
        level = (gameNow - startedAt) / build;
    } else if (gameNow > until - STORM_CLEAR_MS) {
        level = (until - gameNow) / STORM_CLEAR_MS;
    } else {
        level = 1;
    }
    level = Math.max(0, Math.min(1, level));

    els.layer.style.display = 'block';
    els.layer.style.opacity = level.toFixed(3);

    // Une seule fois par orage, au passage de la frappe. Le retrait/reflow/repose
    // est ce qui relance une animation CSS deja jouee : sans lui, un second
    // orage dans la meme course laisserait le ciel noir sans le moindre eclair.
    if (gameNow >= strikeAt && els.struckFor !== strikeAt) {
        els.struckFor = strikeAt;
        placeStormBolts(els, storm[3], screenWidth);
        els.bolts.classList.remove('storm-firing');
        els.flash.classList.remove('storm-firing');
        void els.bolts.offsetWidth;
        els.bolts.classList.add('storm-firing');
        els.flash.classList.add('storm-firing');
    }
}

// Lakitu est ancre sur la ligne de depart : c'est la camera qui le fait entrer
// et sortir du cadre, et le serveur qui decide du panneau qu'il tient.
let lakituEls = null;

function ensureLakituEl() {
    if (lakituEls) return lakituEls;
    if (!cachedContainer) cachedContainer = document.getElementById('karts-container');
    if (!cachedContainer) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'lakitu';

    const img = document.createElement('img');
    wrapper.appendChild(img);
    cachedContainer.appendChild(wrapper);

    lakituEls = { wrapper: wrapper, img: img, key: null, height: '' };
    return lakituEls;
}

function lakituSrc(group, frame, gameNow) {
    // Le drapeau s'anime a partir du temps : le serveur n'envoie que le groupe.
    if (group === 'finish') {
        frame = (Math.floor(gameNow / WORLD.flagAnimSpeed) % 3) + 1;
    }
    const cached = imageCache[`lakitu_${group}_${frame}`];
    return cached ? cached.src : GAME_CONFIG.resources.paths.lakitu(group, frame);
}

function renderLakitu(gameNow, screenWidth) {
    const els = ensureLakituEl();
    if (!els) return;

    const sign = worldState.sign;
    if (!sign) {
        els.wrapper.style.display = 'none';
        return;
    }

    const rx = getScreenPosition(WORLD.finishLineX, renderCameraX, screenWidth);
    const margin = GAME_CONFIG.rendering.bufferZone;
    if (rx < -margin || rx > screenWidth + margin) {
        els.wrapper.style.display = 'none';
        return;
    }

    const src = lakituSrc(sign[0], sign[1], gameNow);
    if (els.key !== src) {
        els.key = src;
        els.img.src = src;
    }

    els.wrapper.style.display = 'block';

    // `height` est une propriete de mise en page : on ne la reecrit que lorsque
    // l'appareil a change de gabarit, pas soixante fois par seconde.
    const h = `${cachedIsMobile ? LAKITU_HEIGHT.mobile : LAKITU_HEIGHT.pc}px`;
    if (els.height !== h) {
        els.height = h;
        els.wrapper.style.height = h;
    }
    // Centre sur la ligne : la moitie de largeur gagnee compte sur mobile.
    //
    // Sa profondeur passe par la meme conversion que les corps de la piste : il
    // survole le bitume, et doit donc rester colle a lui quand le cadre change
    // de hauteur. En pourcentage de scene il aurait derive vers le haut.
    els.wrapper.style.transform =
        `translate3d(${rx}px, ${depthToY(LAKITU_BOTTOM)}px, 0) translateX(-50%)`;
}

let resultsEl = null;
let resultsShown = -1;
let gpEl = null;
// Empreinte du tableau affiche, pour ne le reconstruire qu'a un vrai changement.
let gpShown = '';
// Anime le tableau du grand prix en trois temps : arrivee de la course, gains
// qui montent dans le cumul, puis remise en ordre sur le general. `null` hors
// animation en cours.
let gpAnim = null;

// Pause de lecture avant que les scores ne bougent, duree du compteur qui
// fait monter le cumul, pause avant le remaniement, puis duree du glissement
// vers l'ordre general (voir aussi la transition CSS de .race-gp-row). Le
// tout tient sous resultsDelayMs, avec de la marge pour admirer le resultat
// une fois les lignes rangees.
const GP_COUNT_DELAY_MS = 2200;
const GP_COUNT_DURATION_MS = 2600;
const GP_REORDER_DELAY_MS = 350;

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

// Reconstruit entierement depuis `finishOrder` : un spectateur qui arrive en
// plein classement le voit en entier, sans avoir assiste aux arrivees.
function renderResults() {
    if (!resultsEl) resultsEl = document.getElementById('race-results');
    if (!resultsEl) return;

    // Il accompagne les arrivees, puis s'efface : le tableau des scores prend
    // le relais et les deux ensemble surchargeraient la scene.
    const order = worldState.finishOrder || [];
    const visible = order.length > 0 && worldState.phase !== 'results';

    resultsEl.classList.toggle('is-visible', visible);
    if (!visible) {
        resultsShown = 0;
        resultsEl.innerHTML = '';
        return;
    }

    if (resultsShown === order.length) return;
    resultsShown = order.length;

    resultsEl.innerHTML = '';
    order.forEach((kartId, index) => {
        const kart = worldState.kartsById[kartId];
        if (!kart) return;

        const entry = document.createElement('div');
        entry.className = 'race-result';

        const rank = document.createElement('span');
        rank.className = 'race-result-rank';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
        img.alt = kart.charName;

        entry.appendChild(rank);
        entry.appendChild(img);
        resultsEl.appendChild(entry);
    });
}

// Tableau des scores du grand prix, au centre de la scene pendant la phase
// 'results'. Reconstruit entierement depuis le snapshot : un spectateur qui se
// connecte pendant le tableau le voit rempli, sans rien savoir des courses
// precedentes.
//
// Poser le tableau ne fait que la premiere image, l'ordre d'arrivee de la
// course qui vient de finir. Le passage au cumul puis au classement general
// est anime image par image par stepGrandPrixAnimation, appelee a chaque
// frame independamment de l'arrivee des snapshots.
function renderGrandPrix(gameNow) {
    if (!gpEl) gpEl = document.getElementById('race-gp');
    if (!gpEl) return;

    const gp = worldState.gp;
    const visible = !!gp && worldState.phase === 'results';

    gpEl.classList.toggle('is-visible', visible);
    gpEl.setAttribute('aria-hidden', visible ? 'false' : 'true');

    if (!visible) {
        gpShown = '';
        gpAnim = null;
        gpEl.innerHTML = '';
        return;
    }

    const round = gp[0];
    const racePoints = gp[1] || [];
    const totalPoints = gp[2] || [];

    // Le tableau ne bouge plus une fois pose : on ne le reconstruit que si son
    // contenu a change, sinon chaque frame recreerait huit images.
    const stamp = round + '|' + racePoints.join(',') + '|' + totalPoints.join(',');
    if (gpShown === stamp) return;
    gpShown = stamp;

    const total = (WORLD && WORLD.gpRaces) || round;
    const isFinal = round >= total;

    gpEl.innerHTML = '';
    gpEl.classList.toggle('is-final', isFinal);

    const title = document.createElement('div');
    title.className = 'race-gp-title';
    title.textContent = isFinal ? 'CLASSEMENT FINAL' : `COURSE ${round} / ${total}`;
    gpEl.appendChild(title);

    const rows = document.createElement('div');
    rows.className = 'race-gp-rows';

    // Premiere image du tableau : l'ordre d'arrivee de la course qui vient de
    // finir, pas encore le general. Un spectateur qui se connecte pendant
    // l'animation retombe sur ses pieds : il manque juste le compteur.
    const arrivalOrder = worldState.finishOrder.length
        ? worldState.finishOrder
        : worldState.karts.map(kart => kart.id);

    const entries = arrivalOrder
        .map(id => worldState.kartsById[id])
        .filter(Boolean);

    const animRows = [];

    entries.forEach((kart, index) => {
        const gained = racePoints[kart.id] || 0;
        const target = totalPoints[kart.id] || 0;
        // Le cumul affiche part d'avant cette course : c'est lui qui monte
        // jusqu'au total pendant que le tableau est a l'ecran.
        const base = target - gained;

        const row = document.createElement('div');
        row.className = 'race-gp-row';

        const rank = document.createElement('span');
        rank.className = 'race-gp-rank';
        rank.textContent = index + 1;

        const img = document.createElement('img');
        img.src = GAME_CONFIG.resources.paths.pp(kart.charName);
        img.alt = kart.charName;

        const name = document.createElement('span');
        name.className = 'race-gp-name';
        name.textContent = kart.charName;

        const gainedEl = document.createElement('span');
        gainedEl.className = 'race-gp-gained';
        gainedEl.textContent = gained > 0 ? `+${gained}` : '';

        const scoreEl = document.createElement('span');
        scoreEl.className = 'race-gp-total';
        scoreEl.textContent = base;

        row.appendChild(rank);
        row.appendChild(img);
        row.appendChild(name);
        row.appendChild(gainedEl);
        row.appendChild(scoreEl);
        rows.appendChild(row);

        animRows.push({
            id: kart.id, row, rankEl: rank, gainedEl, scoreEl,
            base, target, gained, finishIndex: index
        });
    });

    gpEl.appendChild(rows);

    gpAnim = {
        rowsEl: rows,
        rows: animRows,
        startAt: gameNow,
        phase: 'count',
        reorderAt: 0
    };
}

// Bascule les lignes de l'ordre d'arrivee vers le general, en rejouant le
// deplacement plutot qu'en le faisant apparaitre d'un coup (technique FLIP :
// position relevee avant le reordonnancement, puis rejouee depuis la ou
// chaque ligne se trouvait).
function settleGrandPrixReorder(anim) {
    const before = new Map();
    anim.rows.forEach(entry => before.set(entry.id, entry.row.getBoundingClientRect()));

    const standings = anim.rows.slice().sort((a, b) => {
        const diff = b.target - a.target;
        // A egalite de points, la course qui vient de finir departage.
        return diff !== 0 ? diff : a.finishIndex - b.finishIndex;
    });

    standings.forEach((entry, index) => {
        anim.rowsEl.appendChild(entry.row);
        entry.rankEl.textContent = index + 1;
    });

    standings.forEach(entry => {
        const after = entry.row.getBoundingClientRect();
        const dy = before.get(entry.id).top - after.top;
        if (!dy) return;

        entry.row.style.transition = 'none';
        entry.row.style.transform = `translateY(${dy}px)`;
        // Force le reflow : sans lui le navigateur fusionnerait les deux
        // changements de style et sauterait la transition.
        entry.row.getBoundingClientRect();
        entry.row.style.transition = '';
        entry.row.style.transform = '';
    });

    anim.rows = standings;
}

// Fait vivre le tableau du grand prix image par image, independamment de
// l'arrivee des snapshots serveur (10 Hz) : un compteur ou un glissement
// cales sur ce rythme saccaderait.
function stepGrandPrixAnimation(gameNow) {
    const anim = gpAnim;
    if (!anim || anim.phase === 'done') return;

    const elapsed = gameNow - anim.startAt;

    if (anim.phase === 'count') {
        if (elapsed < GP_COUNT_DELAY_MS) return;

        const t = Math.min(1, (elapsed - GP_COUNT_DELAY_MS) / GP_COUNT_DURATION_MS);
        const eased = easeOutCubic(t);
        anim.rows.forEach(entry => {
            // Le total se remplit et le gain se vide au meme rythme : c'est le
            // meme point qui se deplace de l'un vers l'autre, un transfert.
            const filled = Math.round(lerp(entry.base, entry.target, eased));
            entry.scoreEl.textContent = filled;

            const remaining = entry.target - filled;
            entry.gainedEl.textContent = remaining > 0 ? `+${remaining}` : '';
        });

        if (t >= 1) {
            anim.rows.forEach(entry => entry.row.classList.add('is-settled'));
            anim.phase = 'settled';
            anim.reorderAt = gameNow + GP_REORDER_DELAY_MS;
        }
        return;
    }

    if (anim.phase === 'settled' && gameNow >= anim.reorderAt) {
        settleGrandPrixReorder(anim);
        anim.phase = 'done';
    }
}

function renderState(gameNow, screenWidth, frameMs) {
    const renderMargin = GAME_CONFIG.rendering.bufferZone;

    // Avant la camera de rendu : elle suit le kart choisi ici, et le faire
    // apres afficherait une image de retard a chaque changement de plan.
    raceDirector.update(gameNow);
    updateRenderCamera();
    updateFocusHud(frameMs);

    if (domDirty) {
        domDirty = false;
        reconcileDom();
        renderResults();
        renderGrandPrix(gameNow);
        renderVote();
    }

    // Hors du bloc ci-dessus : le compteur et le glissement vers le general
    // doivent avancer a chaque frame, pas seulement quand un snapshot arrive.
    stepGrandPrixAnimation(gameNow);

    renderLakitu(gameNow, screenWidth);
    renderStorm(gameNow, screenWidth);

    // Les trois calques de decor sont des textures, pas des elements places :
    // ils ne passent pas par getScreenPosition et doivent donc appliquer le
    // meme recentrage a la main. Le bord gauche de la fenetre, c'est le centre
    // moins la moitie de la largeur visible.
    const halfView = screenWidth / 2;

    if (cachedBg) {
        // Été : parallaxe, moitié vitesse.
        const bgX = cachedIsSummerBanner ? renderBgCameraX : renderCameraX;
        scrollLayer(cachedBg, halfView - bgX, bgScroll);
    } else {
        cachedBg = document.querySelector('.layer-scrolling-bg');
    }

    if (cachedFg) {
        // Décor de premier plan (été uniquement) : même vitesse que la route.
        const fgX = (renderCameraX - halfView) % WORLD.width;
        scrollLayer(cachedFg, -fgX, fgScroll);
    } else {
        cachedFg = document.querySelector('.layer-scrolling-fg');
    }

    if (cachedGround) {
        // Bordure de route : la bande est un motif de 80px ancre sur le monde,
        // il suffit de la decaler du reste de la division. Modulo positif, un
        // reste negatif donnerait une valeur CSS invalide.
        //
        // Pas de rattrapage a la `scrollLayer` ici : le pas EST la periode du
        // motif, la bande est donc elargie d'exactement un motif et le decalage
        // tient toujours dans [-80, 0]. La variable alimente une `transform` et
        // non plus un `background-position` (cf. `.layer-ground::before`) — un
        // pseudo-element n'accepte pas de style inline, d'ou la variable.
        const roadX = (((renderCameraX - halfView) % ROAD_PATTERN_WIDTH) + ROAD_PATTERN_WIDTH) % ROAD_PATTERN_WIDTH;
        cachedGround.style.setProperty('--road-offset', `${-roadX}px`);
    } else {
        cachedGround = document.querySelector('.layer-ground');
    }

    if (worldState.finishLine && worldState.finishLine.element) {
        const rx = getScreenPosition(worldState.finishLine.worldX, renderCameraX, screenWidth);
        worldState.finishLine.element.style.transform = `translate3d(${rx}px, 0, 0)`;
    }

    if (worldState.sun && worldState.sun.element) {
        // Solidaire du fond, pas de la route.
        const sx = getScreenPosition(worldState.sun.worldX, renderBgCameraX, screenWidth);
        worldState.sun.element.style.transform = `translate3d(${sx}px, 0, 0)`;
    }

    const boxesLen = worldState.itemBoxes.length;
    const floatY = Math.sin(gameNow * GAME_CONFIG.rendering.boxFloat.speed) * GAME_CONFIG.rendering.boxFloat.amplitude;
    for (let i = 0; i < boxesLen; i++) {
        const box = worldState.itemBoxes[i];
        const el = boxEls[i];
        if (!el) continue;
        if (!box.active) { el.style.display = 'none'; continue; }

        const rx = getScreenPosition(box.worldX, renderCameraX, screenWidth);
        if (rx > -renderMargin && rx < screenWidth + renderMargin) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, ${depthToY(box.y) + floatY}px, 0)`;
        } else {
            el.style.display = 'none';
        }
    }

    for (let i = 0; i < worldState.pipes.length; i++) {
        const pipe = worldState.pipes[i];
        const el = pipeEls[i];
        if (!el) continue;

        const rx = getScreenPosition(pipe.worldX, renderCameraX, screenWidth);

        if (rx > -renderMargin && rx < screenWidth + renderMargin) {
            el.style.display = 'block';
            el.style.transform = `translate3d(${rx}px, ${depthToY(pipe.y)}px, 0)`;
        } else {
            el.style.display = 'none';
        }
    }

    // La demi-largeur du sprite se lit maintenant par kart (`kartDrawHalfWidth`)
    // et non plus une fois pour toutes : deux personnages n'ont pas la meme
    // longueur, et c'est bien ce que leurs emprises disent.
    //
    // Ou se tient un objet TRAINE, en ecart au centre de son porteur. C'est une
    // position du monde, publiee par le serveur : le moteur teste l'emprise de
    // l'objet a `worldX + heldBehindX`, et la carte de debug la dessine la.
    // Meme valeur sur toutes les machines, contrairement aux ecarts de dessin.
    const wBoxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;
    const heldBehindX = (wBoxes.heldBehindX !== undefined)
        ? wBoxes.heldBehindX : OFFLINE_WORLD.hitboxes.heldBehindX;

    const kartsLen = worldState.karts.length;
    for (let i = 0; i < kartsLen; i++) {
        const kart = worldState.karts[i];
        const els = kartEls[kart.id];
        if (!els) continue;
        const wrapper = els.wrapper;

        if (kart.state === 'hit') {
            if (kart.stopped) {
                if (!wrapper.classList.contains('kart-stopped')) wrapper.classList.add('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.add('item-stopped');
            } else {
                wrapper.classList.remove('kart-stopped');
                if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
            }
        } else {
            wrapper.classList.remove('kart-stopped');
            if (kart.heldItem && itemEls[kart.heldItem.id]) itemEls[kart.heldItem.id].classList.remove('item-stopped');
        }

        const rx = getScreenPosition(kart.worldX, renderCameraX, screenWidth);
        const spriteX = rx - kartDrawHalfWidth(kart);
        const isVisibleNow = (rx > -renderMargin && rx < screenWidth + renderMargin);

        if (isVisibleNow) {
            wrapper.style.display = 'block';
            wrapper.style.transform = `translate3d(${spriteX}px, ${depthToY(kart.yPercent)}px, 0)`;

            const zVal = (GAME_CONFIG.rendering.zIndexBase - kart.yPercent) | 0;
            if (wrapper.style.zIndex != zVal) wrapper.style.zIndex = zVal;

            // Pendant le vol, le sprite du personnage cede la place au bill : plus
            // de tete-a-queue, plus de miroir, plus de rebond. `spinFrame` est
            // remis a -1 pour qu'au retour la frame courante soit forcement vue
            // comme un changement et le personnage repose.
            if (kart.isBill) {
                if (!els.billOn) {
                    els.billOn = true;
                    els.sprite.classList.remove('kart-mirrored');
                    els.wrapper.classList.add('kart-bill');
                    els.spinFrame = -1;
                    // Le bill se dessine sur l'emprise du bill, pas sur celle du
                    // personnage : sa largeur CSS se compte en pourcentage du
                    // conteneur, qu'on ramene donc a la reference le temps du vol.
                    els.wrapper.style.setProperty('--kart-length', 1);
                }

                // Trois images, cadencees par le temps de jeu comme les carapaces :
                // rien a memoriser, et deux bills en vol restent en phase.
                const billFrame = (Math.floor(gameNow / WORLD.billAnimSpeed) % 3) + 1;
                if (els.billFrame !== billFrame) {
                    els.billFrame = billFrame;
                    const cached = imageCache[`bill_${billFrame}`];
                    els.img.src = cached ? cached.src : GAME_CONFIG.resources.paths.bill(billFrame);
                }
            } else {
                if (els.billOn) {
                    els.billOn = false;
                    els.billFrame = 0;
                    els.wrapper.classList.remove('kart-bill');
                    els.wrapper.style.setProperty('--kart-length', kartDrawScale(kart));
                }

                // Le choc contre un pipe ne touche PAS au sprite. Le kart garde
                // la pose qu'il avait, et le choc se lit entierement dans ce
                // qu'il fait : l'arret net, le recul, la glissade sur le cote.
                //
                // La pose de face qu'il prenait avant se lisait mal — elle
                // arrivait sur une frame et repartait sur une autre, sans que
                // rien dans le mouvement ne l'annonce, et un kart qui reculait
                // face a la route donnait l'impression d'un bug plutot que d'un
                // choc. Ce que le joueur entend et voit trembler vient de
                // l'evenement `kartBumped`, pas d'ici — le drapeau `kart.bumped`
                // du snapshot ne pilote donc plus rien au rendu.
                //
                // Ne reste ici que le tete-a-queue, qui lui a bien ses frames a
                // jouer.
                const spinFrame = getSpinFrameIndex(kart, gameNow);
                if (els.spinFrame !== spinFrame) {
                    els.spinFrame = spinFrame;
                    applyKartSpinFrame(kart, els, spinFrame);
                }
            }

            if (kart.heldItem && kart.heldItem.holdPosition === 'orbit') {
                renderOrbitItems(kart, rx, gameNow);
            } else if (kart.heldItem) {
                const hel = itemEls[kart.heldItem.id];
                if (hel) {
                    hel.style.display = 'block';

                    // Un objet passe de la main au trainage pendant sa vie :
                    // le rebond suit, il n'appartient qu'a l'objet tenu en main.
                    const inHands = kart.heldItem.holdPosition === 'hands';
                    hel.classList.toggle('held-item-bouncing', inHands);

                    // Deux objets tenus, deux natures, deux placements.
                    //
                    // EN MAIN, l'objet n'a pas d'emprise : rien ne le teste, il
                    // ne protege de rien. Sa place est du dessin pur, calee sur
                    // la silhouette — d'ou le depart au bord gauche du sprite,
                    // ou ces ecarts ont ete regles, plus la demi-largeur de
                    // l'objet puisqu'il se pose par son milieu.
                    //
                    // TRAINE, il a une emprise, et c'est tout l'interet : elle
                    // encaisse la carapace qui arrive, et elle blesse le
                    // poursuivant qui la touche. Le moteur la teste a
                    // `worldX + heldBehindX` — une position du monde. La
                    // dessiner ailleurs, c'est montrer une banane a cote de
                    // celle qui touche : un kart lui roule dessus sans rien
                    // prendre, et se fait cueillir par du vide un peu plus loin.
                    let hx, hy;
                    if (inHands) {
                        const hOffset = getHandsItemRenderOffset();
                        hx = spriteX + hOffset.offset + (hel._halfW || 0);
                        hy = hOffset.yShift;
                    } else {
                        hx = rx + heldBehindX;
                        hy = 0;
                    }
                    // `hy` monte l'objet par rapport a son porteur ; la
                    // profondeur du porteur s'y ajoute, dans la meme
                    // transformation.
                    hel.style.transform = `translate3d(${hx}px, ${depthToY(kart.yPercent) - hy}px, 0)`;
                    const itemZ = inHands ? zVal + 1 : zVal;
                    if (hel.style.zIndex != itemZ) hel.style.zIndex = itemZ;
                }
            }
        } else {
            wrapper.style.display = 'none';
            hideHeldItem(kart);
        }
    }

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];
        const el = itemEls[item.id];
        if (!el) continue;

        if (item.type === 'greenShell' || item.type === 'redShell' || item.type === 'blueShell') {
            const img = el.firstChild;
            if (img) {
                const cached = imageCache[`${item.type}_${item.currentFrame}`];
                const src = cached ? cached.src : GAME_CONFIG.resources.paths[item.type](item.currentFrame);
                if (img.getAttribute('src') !== src) img.src = src;
            }
        }

        const rx = getScreenPosition(item.worldX, renderCameraX, screenWidth);
        const isVisible = (rx > -renderMargin && rx < screenWidth + renderMargin);
        if (isVisible) {
            el.style.display = 'block';
            // `hop` souleve l'objet sans toucher a sa profondeur de piste : une
            // banane en cloche passe au-dessus, elle ne change pas de couloir.
            // Les deux se somment dans la transformation, le sol reste a zero.
            el.style.transform = `translate3d(${rx}px, ${depthToY(item.y) - item.hop}px, 0)`;
            // Le souffle passe devant tout le monde : il doit recouvrir les
            // karts qu'il emporte.
            const zVal = item.type === 'blueBlast'
                ? GAME_CONFIG.rendering.zIndexBase + 60
                : (GAME_CONFIG.rendering.zIndexBase - item.y) | 0;
            if (el.style.zIndex != zVal) el.style.zIndex = zVal;
        } else {
            el.style.display = 'none';
        }
    }
}

// ---------------------------------------------------------------------------
// Reception : horloge, tampon, interpolation
//
// Le client ne simule rien. Il recoit des snapshots dates en temps serveur, les
// empile, et affiche en permanence un instant leger retard — assez pour avoir
// toujours deux snapshots a interpoler. C'est ce retard, et lui seul, qui rend
// le mouvement fluide malgre une diffusion a 10 Hz.
// ---------------------------------------------------------------------------

// Retard de rendu : deux intervalles de diffusion (100 ms a 10 Hz). C'est la
// tolerance a la gigue du reseau. En dessous d'un intervalle il n'y a rien a
// interpoler ; juste au-dessus, le moindre snapshot en retard fait tomber le
// rendu sur son dernier etat connu — la scene se fige puis saute, ce qui ne se
// distingue pas d'une chute de framerate. A reajuster si SEND_HZ change.
const RENDER_DELAY_MS = 200;

const BUFFER_KEEP_MS = 3000;

// Vitesse de rattrapage de l'horloge, en millisecondes par frame. A 60 images
// par seconde, 1 ms par frame absorbe 60 ms d'ecart en une seconde : assez
// rapide pour suivre une derive reelle, assez lent pour ne pas se voir.
const CLOCK_SLEW_MS_PER_FRAME = 1;

// Au-dela, ce n'est plus une derive mais un decrochage — retour d'un onglet
// endormi, changement de reseau. On se recale d'un coup, quitte a sauter.
const CLOCK_JUMP_THRESHOLD_MS = 1000;

function stepClock() {
    const drift = targetClockOffset - serverClockOffset;
    if (drift === 0) return;

    if (Math.abs(drift) > CLOCK_JUMP_THRESHOLD_MS) {
        serverClockOffset = targetClockOffset;
        return;
    }

    serverClockOffset += Math.max(-CLOCK_SLEW_MS_PER_FRAME,
                                  Math.min(CLOCK_SLEW_MS_PER_FRAME, drift));
}

// Assez rapproche pour que la latence affichee decrive le lien du moment : a
// 30 s, le chiffre restait fige une demi-minute et ne disait plus rien d'une
// coupure passagere. Le cout est nul a cote du flux de snapshots — un objet de
// deux champs — et l'horloge y gagne : ses huit mesures couvrent desormais une
// fenetre courte, donc recente.
const PING_INTERVAL_MS = 5000;

// Duree de vie d'une mesure d'horloge. Sans peremption, la meilleure mesure
// jamais faite gagne pour toujours — y compris apres que l'horloge locale a
// change sous nos pieds.
const CLOCK_SAMPLE_TTL_MS = 120000;
// Doit valoir exactement PROTOCOL_VERSION dans raceEngine/protocol.js. Le
// serveur l'annonce dans son `hello` et le client refuse tout ce qui ne
// correspond pas : mieux vaut le decor seul qu'une scene interpretee de
// travers. Les deux se modifient donc ensemble, jamais l'un sans l'autre.
const PROTOCOL_VERSION = 10;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Une coupure d'une seconde ne merite pas d'annoncer une panne au visiteur ;
// deux echecs de suite, si.
const OFFLINE_AFTER_ATTEMPTS = 2;

// Interpolation sur un monde qui boucle : entre x=3830 et x=20, le chemin court
// fait 30 unites vers la droite, pas 3810 vers la gauche. Interpoler
// naivement ferait traverser toute la carte a l'envers a chaque tour.
function lerpWrapped(from, to, t, width) {
    let delta = to - from;
    if (delta > width / 2) delta -= width;
    else if (delta < -width / 2) delta += width;

    let value = from + delta * t;
    if (value < 0) value += width;
    if (value >= width) value -= width;
    return value;
}

function lerp(from, to, t) {
    return from + (to - from) * t;
}

// Ecrit un tuple de kart dans le miroir local. Les champs continus sont
// interpoles, les champs discrets (etat, rang, objet tenu) sont pris sur le
// snapshot de depart : les faire apparaitre en avance donnerait un halo ou un
// tete-a-queue avant le fait.
function writeKart(kart, ta, tb, t) {
    if (tb) {
        kart.worldX = lerpWrapped(ta[1], tb[1], t, WORLD.width);
        kart.yPercent = lerp(ta[2], tb[2], t);
        kart.totalDistance = lerp(ta[3], tb[3], t);
    } else {
        kart.worldX = ta[1];
        kart.yPercent = ta[2];
        kart.totalDistance = ta[3];
    }

    const flags = ta[4];
    kart.state = (flags & 1) ? 'grid' : ((flags & 2) ? 'hit' : 'running');
    kart.stopped = !!(flags & 4);
    kart.isInvincible = !!(flags & 8);
    kart.finished = !!(flags & 16);
    kart.isShrunk = !!(flags & 32);
    kart.isBill = !!(flags & 64);
    kart.bumped = !!(flags & 128);
    kart.isFlat = !!(flags & 256);
    kart.rank = ta[5];

    // Un serveur qui ne date pas le malus (`hitEnd` absent) ne doit pas priver
    // le kart de sa toupie : on la cale alors sur l'instant ou l'etat 'hit' est
    // apparu. Approximatif pour un arrivant, juste pour tous les autres.
    if (kart.state === 'hit') {
        kart.hitEndTime = ta[11] || kart.hitEndTime || (getGameTime() + WORLD.hitDuration);
    } else {
        kart.hitEndTime = 0;
    }

    kart.bumpEndTime = kart.bumped ? (ta[12] || kart.bumpEndTime || 0) : 0;

    if (ta[6] === null) {
        kart.heldItem = null;
        return;
    }

    const held = (kart.heldItem && kart.heldItem.id === ta[6]) ? kart.heldItem : {};
    held.id = ta[6];
    held.type = ta[7];
    held.holdPosition = ta[8];

    if (ta[8] === 'orbit') {
        held.childType = ta[7];
        held.orbitAngle = ta[9];
        // Les phases sont figees a la creation de l'orbite et reparties
        // regulierement : le serveur n'a pas a les transmettre.
        held.orbs = ta[10].map((id, i) => ({ id: id, phase: (i * 2 * Math.PI) / WORLD.orbit.count }));
    }

    kart.heldItem = held;
}

// Applique un etat au miroir local. `b` absent = pas d'interpolation, on colle
// au snapshot `a` — c'est le cas du premier `hello` et des rattrapages.
// Structures reutilisees d'une frame a l'autre. `applyState` tourne soixante
// fois par seconde : tout ce qu'elle allouerait deviendrait du dechet a
// ramasser, et le ramassage se voit sur mobile — de petites pauses regulieres,
// exactement ce qu'on prend pour une chute de framerate.
const nextKartTuples = new Map();
const nextItemTuples = new Map();
const itemMirrors = new Map();

// Vrai quand la structure de la scene a pu changer, c'est-a-dire uniquement a
// l'arrivee d'un nouveau snapshot. Entre deux, rien ne peut apparaitre ni
// disparaitre : reconcilier a chaque frame reviendrait a refaire six fois le
// meme travail pour rien.
let lastAppliedSnapshot = null;
let domDirty = true;

function applyState(a, b, t) {
    worldState.cameraX = b ? lerpWrapped(a.cx, b.cx, t, WORLD.width) : a.cx;
    worldState.bgCameraX = b ? lerpWrapped(a.bx, b.bx, t, WORLD.width) : a.bx;

    const fresh = a !== lastAppliedSnapshot;
    if (fresh) {
        lastAppliedSnapshot = a;
        domDirty = true;
    }

    nextKartTuples.clear();
    if (b) for (const tuple of b.k) nextKartTuples.set(tuple[0], tuple);

    for (const tuple of a.k) {
        const kart = worldState.kartsById[tuple[0]];
        if (kart) writeKart(kart, tuple, b ? nextKartTuples.get(tuple[0]) : null, t);
    }

    // Le releve de decision de l'IA. Il ne s'interpole pas — c'est une suite
    // d'etats, pas une position — et il ne sert qu'au HUD de debug : un client
    // qui l'ignore affiche exactement la meme course.
    if (a.ai) {
        for (let i = 0; i < a.k.length; i++) {
            const kart = worldState.kartsById[a.k[i][0]];
            if (kart) kart.ai = a.ai[i] || 0;
        }
    }

    // La VUE du kart suivi, quand elle a ete demandee. Elle ne s'interpole pas
    // plus que le releve de decision, et pour une raison plus forte : c'est un
    // BALAYAGE, pris a un instant, valable jusqu'au suivant. Interpoler entre
    // deux balayages inventerait une vue intermediaire que le kart n'a jamais
    // eue — exactement le genre de reconstitution que ce fichier s'interdit.
    //
    // Elle est lue sur le snapshot AFFICHE et non sur le dernier recu : la carte
    // doit dire ce que le kart voyait a l'image qu'on regarde.
    if (fresh) worldState.vision = a.vw || null;

    nextItemTuples.clear();
    if (b) for (const tuple of b.i) nextItemTuples.set(tuple[0], tuple);

    worldState.items.length = 0;
    for (const tuple of a.i) {
        let item = itemMirrors.get(tuple[0]);
        if (!item) {
            item = { id: tuple[0], type: tuple[1], worldX: 0, y: 0, currentFrame: 1, hop: 0, rising: false };
            itemMirrors.set(tuple[0], item);
        }

        const to = b ? nextItemTuples.get(tuple[0]) : null;
        item.type = tuple[1];
        item.worldX = to ? lerpWrapped(tuple[2], to[2], t, WORLD.width) : tuple[2];
        item.y = to ? lerp(tuple[3], to[3], t) : tuple[3];
        item.currentFrame = tuple[4];
        item.hop = to ? lerp(tuple[5] || 0, to[5] || 0, t) : (tuple[5] || 0);
        // Pas d'interpolation : c'est un etat, pas une position. Entre deux
        // instantanes il vaut celui de gauche, comme tout ce qui bascule.
        item.rising = !!tuple[6];

        worldState.items.push(item);
    }

    // Les identifiants d'objets ne sont jamais reutilises : sans ce menage, la
    // table grossirait indefiniment sur une course qui dure. Une seule fois par
    // snapshot suffit.
    if (fresh && itemMirrors.size > worldState.items.length) {
        for (const id of itemMirrors.keys()) {
            if (!nextItemTuples.has(id) && !worldState.items.some(item => item.id === id)) {
                itemMirrors.delete(id);
            }
        }
    }

    for (let i = 0; i < worldState.itemBoxes.length; i++) {
        worldState.itemBoxes[i].active = a.b[i] === 1;
    }

    worldState.phase = a.ph;
    worldState.leaderLap = a.lp;
    worldState.sign = a.sg;
    worldState.storm = a.st || null;
    worldState.finishOrder = a.fo;
    worldState.gp = a.gp || null;
    worldState.vote = a.vt || [0, 0];
}

const bannerNet = {
    ws: null,
    buffer: [],
    attempts: 0,
    hidden: false,
    ready: false,
    gotHello: false,
    wasOffline: false,
    pendingHello: null,
    rebuildTimer: null,
    reconnectTimer: null,
    pingTimer: null,
    rttSamples: [],

    url() {
        // Jamais `wss://` en dur : en local le site est en clair, et l'erreur ne
        // se verrait qu'a l'execution.
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws/race`;
    },

    connect() {
        if (this.ws) return;

        if (this.attempts === 0) bannerLink.setStatus('connecting');

        let ws;
        try {
            ws = new WebSocket(this.url());
        } catch (err) {
            this.onDisconnected();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.attempts = 0;
            this.rttSamples = [];
            // Trois mesures rapprochees : l'ecart d'horloge se stabilise en une
            // seconde au lieu d'attendre le premier ping periodique.
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
            this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
        };

        ws.onmessage = event => this.onMessage(event.data);
        ws.onclose = () => this.onDisconnected();
        ws.onerror = () => { try { ws.close(); } catch (err) { /* deja fermee */ } };
    },

    onMessage(raw) {
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch (err) {
            return;
        }

        if (msg.t === 'pong') {
            this.onPong(msg);
            return;
        }

        if (msg.t === 'hello') {
            if (msg.protocol !== PROTOCOL_VERSION) {
                // Version incompatible : mieux vaut le decor seul qu'une scene
                // interpretee de travers.
                console.warn(`banner : protocole ${msg.protocol} non gere`);
                this.giveUp();
                return;
            }
            // Course neuve alors qu'une autre etait a l'ecran : le rideau tombe
            // d'abord, la scene n'est refaite qu'une fois qu'il est en bas.
            // Sinon la nouvelle grille apparait derriere un rideau a mi-hauteur.
            if (isNewRace(msg) && this.ready) {
                this.ready = false;
                this.gotHello = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();

                this.pendingHello = msg;
                clearTimeout(this.rebuildTimer);
                this.rebuildTimer = setTimeout(() => {
                    if (this.pendingHello) this.applyHello(this.pendingHello);
                }, CURTAIN_FALL_MS);
                return;
            }

            // Retour apres coupure : la scene est deja vide, rien a cacher.
            if (this.wasOffline) {
                this.wasOffline = false;
                bannerLink.gates.stream = false;
                bannerLink.lowerCurtain();
            }

            this.applyHello(msg);
            return;
        }

        if (msg.t === 's' && this.gotHello) {
            this.buffer.push(msg);
            // Les evenements ne sont que des animations ponctuelles : les jouer
            // sur une scene figee ferait bouger le classement d'une course
            // arretee. Les rater est sans consequence — reconcileDom() rebatit
            // tout depuis l'etat a la reprise.
            if (msg.ev && !racePaused) for (const ev of msg.ev) applyEvent(ev);

            const cutoff = getGameTime() - BUFFER_KEEP_MS;
            while (this.buffer.length > 2 && this.buffer[0].ts < cutoff) this.buffer.shift();

            // Le rideau ne se leve qu'avec deux snapshots en main : avec un
            // seul, l'interpolation demarre a vide et la premiere seconde
            // saccade.
            if (!this.ready && this.buffer.length >= 2) {
                this.ready = true;
                bannerLink.setStatus('online');
                bannerLink.open('stream');
            }
        }
    },

    applyHello(msg) {
        this.pendingHello = null;
        this.buffer = [];
        this.gotHello = true;
        buildWorldFromHello(msg);
        this.buffer.push(msg.snapshot);
        // Le service ne garde pas trace du kart suivi d'une connexion a l'autre.
        // Sans ce rappel, la carte de debug se vidait apres chaque reconnexion
        // et apres chaque course neuve, sans que rien ne le dise.
        requestVision();
    },

    // Renvoie false si le lien est coupe : l'appelant garde alors son etat
    // inchange plutot que d'afficher une action qui n'est jamais partie.
    send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
        this.ws.send(JSON.stringify(msg));
        return true;
    },

    ping() {
        this.send({ t: 'ping', c: Date.now() });
    },

    // On garde la meilleure mesure plutot que la moyenne : un aller-retour
    // rapide est forcement moins deforme par les files d'attente qu'un lent.
    onPong(msg) {
        const now = Date.now();
        const rtt = now - msg.c;
        const offset = msg.s + rtt / 2 - now;

        this.rttSamples.push({ rtt: rtt, offset: offset, at: now });
        bannerLink.setPing(rtt);

        // Une mesure vieille de plusieurs minutes decrit peut-etre une horloge
        // qui n'existe plus : un appareil qui sort de veille resynchronise
        // souvent la sienne sur le reseau. La garder reviendrait a laisser son
        // faible aller-retour l'emporter indefiniment, et le rendu resterait
        // cale sur l'ancienne heure — une course coherente, mais decalee de
        // celle que tout le monde regarde.
        this.rttSamples = this.rttSamples
            .filter(sample => now - sample.at < CLOCK_SAMPLE_TTL_MS)
            .slice(-8);

        let best = this.rttSamples[0];
        for (const sample of this.rttSamples) if (sample.rtt < best.rtt) best = sample;

        targetClockOffset = best.offset;

        // Premiere mesure : on se cale d'un coup, il n'y a encore rien a
        // secouer. Les elements deja crees portent en revanche une phase
        // d'animation calee sur l'heure locale, donc fausse : c'est le seul
        // moment ou il faut les reprendre.
        if (!clockCalibrated) {
            clockCalibrated = true;
            serverClockOffset = targetClockOffset;
            realignAnimations();
        }
    },

    setHidden(hidden) {
        this.hidden = hidden;
        this.buffer = [];

        if (!hidden) {
            // L'horloge locale a pu etre resynchronisee pendant la mise en
            // veille, et le tampon est de toute facon perime. On repart de zero
            // sur l'estimation : la prochaine mesure sera adoptee telle quelle
            // au lieu d'etre rejointe en douceur, puisqu'il ne s'agit pas d'une
            // derive mais d'un saut.
            this.rttSamples = [];
            clockCalibrated = false;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ t: 'vis', hidden: hidden }));
        }

        if (!hidden) {
            this.ping();
            setTimeout(() => this.ping(), 400);
            setTimeout(() => this.ping(), 1200);
        }
    },

    onDisconnected() {
        this.ws = null;
        this.ready = false;
        this.gotHello = false;
        this.buffer = [];
        this.pendingHello = null;
        clearTimeout(this.rebuildTimer);

        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        this.attempts++;
        if (this.attempts >= OFFLINE_AFTER_ATTEMPTS) {
            this.wasOffline = true;
            bannerLink.setStatus('offline');
            bannerLink.open('stream');
            clearScene();
        }

        const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.attempts - 1), RECONNECT_MAX_MS);
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
    },

    // Abandon definitif : protocole incompatible. Reessayer ne servirait qu'a
    // tenir une connexion inutile ouverte.
    giveUp() {
        this.wasOffline = true;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; }
        bannerLink.setStatus('offline');
        bannerLink.open('stream');
        clearScene();
    },

    // Choisit les deux snapshots qui encadrent l'instant a afficher.
    frameFor(renderTime) {
        const buffer = this.buffer;
        if (buffer.length === 0) return null;

        for (let i = buffer.length - 1; i > 0; i--) {
            const a = buffer[i - 1];
            const b = buffer[i];
            if (a.ts <= renderTime && renderTime <= b.ts) {
                const span = b.ts - a.ts;
                return { a: a, b: b, t: span > 0 ? (renderTime - a.ts) / span : 0 };
            }
        }

        // Hors tampon : soit le reseau a decroche et on affiche le dernier etat
        // connu, soit l'horloge est en retard et on affiche le plus ancien.
        const last = buffer[buffer.length - 1];
        if (renderTime > last.ts) return { a: last, b: null, t: 0 };
        return { a: buffer[0], b: null, t: 0 };
    }
};

// Quelques compteurs, assez legers pour rester en place : ils distinguent une
// saccade venue du reseau (le rendu attend un snapshot en retard, `gel` monte)
// d'une saccade venue de la machine (le framerate baisse sans gel).
const perf = { frames: 0, stalls: 0, fps: 0, windowStart: 0, windowFrames: 0 };

function trackFrame(timestamp, stalled) {
    perf.frames++;
    if (stalled) perf.stalls++;

    if (!perf.windowStart) perf.windowStart = timestamp;
    perf.windowFrames++;

    const span = timestamp - perf.windowStart;
    if (span >= 1000) {
        perf.fps = Math.round((perf.windowFrames * 1000) / span);
        perf.windowStart = timestamp;
        perf.windowFrames = 0;
    }
}

function animate(timestamp) {
    // Course figee : plus rien n'est lu du tampon ni repeint, la scene reste sur
    // sa derniere image. La boucle, elle, continue de tourner — c'est par elle
    // qu'on repartira au clic suivant. L'horloge ne se rattrape pas davantage :
    // corriger une derive sur une scene arretee ne se verrait pas, et le premier
    // stepClock() de la reprise s'en chargera, d'un saut s'il le faut.
    if (racePaused) {
        lastFrameTime = timestamp;
        animationId = requestAnimationFrame(animate);
        return;
    }

    stepClock();

    // Les dimensions viennent du cache, tenu a jour par `resize` : les lire ici
    // forcerait un recalcul de mise en page a chaque image. Un cache vide ne se
    // voit qu'au demarrage, quand le decor n'etait pas encore mesurable.
    if (!viewMetrics.containerWidth) refreshLayoutMetrics();

    if (viewMetrics.containerWidth) {
        // ── La largeur de monde visible EST la largeur du conteneur ──────
        //
        // `getScreenPosition` rend un ecart en px de MISE EN PAGE dans ce
        // conteneur, et c'est la que les `translate3d` se posent : un px de
        // monde y vaut un px de conteneur, sur mobile comme sur PC. La moitie
        // de cette largeur est donc le centre du cadre, celui ou se pose le
        // kart suivi.
        //
        // Elle etait divisee par `mobileScale` sur mobile, et le compte etait
        // fait deux fois. Le retrecissement mobile ne se joue pas ici : la
        // feuille de style donne a `.game-content-wrapper` 166.67 % de largeur
        // AVANT de le reduire de 0.6 (cf. la media query 768px). Le conteneur
        // mesure donc deja les 1/0.6 de largeur en question, et `offsetWidth`
        // les rend — la division les appliquait une seconde fois.
        //
        // Ce que ca donnait : le centre du cadre etait calcule a 1.39 fois la
        // largeur du hero au lieu de 0.83, soit 83 % du conteneur. Invisible
        // camera libre — la scene defile, un decalage constant ne se lit pas —
        // mais un kart suivi se posait colle au bord droit au lieu du milieu.
        // Les traits d'orage, repartis sur cette meme largeur, tombaient pour
        // la plupart hors du cadre. La carte de debug, elle, lisait deja la
        // largeur sans la diviser : c'est elle qui avait raison.
        const screenWidth = viewMetrics.containerWidth;

        const gameNow = getGameTime();

        // On affiche un instant deja passe, le temps d'avoir les deux snapshots
        // qui l'encadrent. Sans ce retard, rien a interpoler.
        const renderTime = gameNow - RENDER_DELAY_MS;
        const frame = bannerNet.frameFor(renderTime);

        // Un couple sans second terme, c'est un rendu hors tampon : la scene se
        // fige sur le dernier etat connu jusqu'au prochain snapshot.
        trackFrame(timestamp, !!frame && !frame.b);

        if (frame) {
            applyState(frame.a, frame.b, frame.t);
        } else if (!bannerNet.ready) {
            // Hors ligne : aucune course, mais le decor continue de defiler.
            const elapsed = lastFrameTime ? (timestamp - lastFrameTime) / 1000 : 0;
            const advance = WORLD.roadPPS * Math.min(elapsed, 0.1);
            worldState.cameraX = (worldState.cameraX + advance) % WORLD.width;
            worldState.bgCameraX = (worldState.bgCameraX + advance / 2) % WORLD.width;
        }

        // Duree de l'image, bornee : un onglet revenu au premier plan rend un
        // premier ecart de plusieurs secondes, dont personne n'a rien a faire.
        const frameMs = lastFrameTime ? Math.min(timestamp - lastFrameTime, 100) : 0;

        // Les positions affichees sont celles de `renderTime` : la toupie, les
        // frames de carapace et la levitation des boites doivent suivre la meme
        // horloge, sinon elles avancent 120 ms devant la scene.
        renderState(renderTime, screenWidth, frameMs);
    }

    lastFrameTime = timestamp;

    if (GAME_CONFIG.debugMode) updateDebugHUD();
    updateAiHud();
    animationId = requestAnimationFrame(animate);
}

// ── La carte de debug ───────────────────────────────────────────────────
//
// Une portion de piste vue de dessus : l'abscisse est la longueur, l'ordonnee la
// PROFONDEUR. Elle ne portait que l'abscisse jusqu'ici, tous les karts alignes
// sur une meme rangee — ce qui suffisait a suivre un classement et ne pouvait
// rien dire de la vue, dont tout se joue en profondeur : l'ombre portee,
// l'alignement d'une ligne de tir, la largeur d'un passage.
//
// Ce qui s'y dessine vient du serveur et de lui seul (cf. `visionTuple`). Le
// client ne refait aucun calcul de perception : il place ce qu'on lui donne.
//
// ── Pourquoi une FENETRE et non le tour entier ───────────────────────────
//
// Elle a porte un tour complet, et c'est ce qui la rendait illisible des qu'on y
// a dessine les corps a leur taille. Un tour fait 3840 px de long pour 126 px de
// profondeur : 30 : 1. Un cadre de 800 x 140 en fait 6 : 1. Les deux axes ne
// partageaient donc pas la meme echelle — un facteur 5.3 — et aucune forme n'y
// ressemblait a elle-meme : les karts, larges de trois fois leur profondeur,
// s'y dressaient plus hauts que larges, et les tuyaux devenaient des oeufs
// verticaux.
//
// Mettre les deux axes a la meme echelle SANS rien changer d'autre n'etait pas
// une sortie : un tour entier sur 800 px ne laisse que 22 px de bande de
// profondeur, ou un kart mesure un pixel de haut. On ne peut pas avoir le tour
// entier et des formes justes.
//
// La carte montre donc une FENETRE, centree sur le kart observe, et elle la
// dessine a l'ECHELLE 1 : un pixel de monde pour un pixel de carte. Un kart y
// occupe les 60 x 18 px qu'il occupe au sol dans le jeu, un tuyau ses 67 x 20.
// Rien n'est reduit, donc rien n'est a corriger de tete en lisant.
//
// Ca coute deux choses, et les deux sont assumees. La carte prend toute la
// hauteur de la piste — une bonne centaine de pixels de page. Et la fenetre ne
// vaut plus que la largeur du cadre, soit moins que ce que le kart percoit :
// une partie de son champ sort du dessin. Ce qu'on perd — la position sur le
// tour, le bout du cone — se lit ailleurs ; ce qu'on gagne est qu'une distance
// mesuree a l'ecran est la vraie distance.

// La profondeur, dans le SENS DE LA SCENE : le fond de piste en haut, le bord
// proche en bas, comme la banniere le montre (`bottom: yPercent%`). L'inverser
// ferait lire la carte a l'envers de ce qu'on voit juste au-dessus, et une carte
// qui contredit la scene coute plus qu'elle ne rapporte.
//
// Les extremites sont rentrees de quelques pour cent : les marques sont centrees
// sur leur point, et pile au bord elles seraient coupees en deux par le cadre.
const DEPTH_PAD = 7;

function depthPct(y) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 50;
    const t = (y - lo) / (hi - lo);
    const inner = 100 - DEPTH_PAD * 2;
    return Math.max(0, Math.min(100, DEPTH_PAD + (1 - t) * inner));
}

// ── La taille des marques ───────────────────────────────────────────────
//
// ── La fenetre ──────────────────────────────────────────────────────────
//
// Ce que la carte montre du monde : le bord gauche et la largeur, en px de
// monde. Recalcules a chaque image — la fenetre suit le kart observe.
let mapView = { start: 0, span: 1 };

let mapHudHeight = 0;

// Combien de px de monde vaut UNE unite de profondeur, ici et maintenant.
//
// Le moteur n'a pas cette constante et n'en veut pas : la banniere n'a pas la
// meme hauteur sur mobile et sur PC, et une valeur en dur serait fausse d'un
// cote (§6.1 du document de migration). Elle se mesure donc la ou la scene la
// definit — un kart se pose a `bottom: yPercent%` de son conteneur, donc une
// unite de profondeur vaut un centieme de la hauteur de ce conteneur.
//
// C'est la seule facon d'avoir une carte a l'echelle : sans ce nombre, les deux
// axes n'ont aucune unite commune et « meme echelle » ne veut rien dire.
function depthToWorldPx() {
    // Mesuree par `refreshLayoutMetrics()`, jamais ici : cette fonction est
    // appelee depuis le rendu, et `depthToY()` s'en sert pour placer chaque
    // corps. Une lecture du DOM a cet endroit serait la pire de toutes.
    //
    // ── Pourquoi la bande roulable, et non la scene ni l'asphalte ────
    //
    // Une unite vaut la hauteur de la PISTE divisee par sa longueur en unites.
    // Rien d'autre — ni la scene, qui a grandi quand la bordure mordait sur le
    // decor ; ni l'asphalte, qui deborde derriere la piste depuis que les karts
    // du fond posaient leurs roues sur cette bordure.
    //
    // Les trois ont rendu le meme nombre pendant longtemps, et c'est ce qui
    // rendait la confusion invisible : 35 % d'une scene de 360 px, une piste de
    // 35 unites, une unite a 1 % de la scene. Chaque fois que le cadre bouge
    // sans que la piste change de longueur, la coincidence se defait un peu
    // plus — et lire la mauvaise hauteur pose les karts a cote du bitume.
    const band = WORLD.roadMaxY - WORLD.roadMinY;
    const h = viewMetrics.roadBandHeight;
    // Repli : la valeur PC, celle que `bodies.depthPx` pose en config moteur et
    // dont descendent l'aplatissement du kart et la rondeur du tuyau.
    return (h > 0 && band > 0) ? h / band : 3.6;
}

// Largeur de la bande d'arrivee, en px de monde.
//
// Mesuree sur l'element du decor plutot que recopiee ici : c'est le CSS qui la
// decide (`.layer-finish-line`), et une copie finirait par mentir le jour ou il
// change. Meme principe que `depthToWorldPx()` — la scene est la reference.
//
// La mesure se prend dans `refreshLayoutMetrics()`, avec les autres : c'est une
// largeur de MISE EN PAGE, prise avant la mise a l'echelle mobile du conteneur,
// donc bien une largeur en px de MONDE — la meme unite que `finishLineX`. Elle
// se remesure a chaque changement de fenetre, le CSS ne donnant pas la meme
// bande sur mobile et sur PC.
function finishBandWidth() {
    // Repli sur la valeur du CSS, le temps que le decor soit mesurable.
    return cachedFinishBand > 0 ? cachedFinishBand : 60;
}

// Recentre la fenetre et remet le cadre a l'echelle.
//
// ── L'echelle est UN, et c'est elle la donnee ────────────────────────────
//
// Un pixel de monde vaut un pixel de carte. Rien n'est reduit, rien n'est
// etire : un kart mesure sur la carte exactement les 60 x 18 px qu'il occupe au
// sol dans le jeu, et un tuyau ses 67 x 20. C'est cher en place — la bande de
// profondeur prend a elle seule toute la hauteur de la piste — et c'est le prix
// pour que ce qu'on lit soit ce qui est.
//
// Tout le reste en decoule, dans cet ordre :
//
//   la LARGEUR du cadre  se choisit en CSS, aussi large que la page le permet ;
//   la FENETRE           vaut exactement cette largeur, puisque l'echelle est 1 ;
//   la HAUTEUR du cadre  vaut la profondeur de piste, pour la meme raison.
//
// C'est l'inverse de ce que faisait la version precedente, qui fixait la
// fenetre sur la portee de vue et en deduisait une echelle. Elle tenait tout le
// champ du kart dans le cadre, mais a 0.58 : les corps y faisaient la moitie de
// leur taille. Ici le champ deborde — 2400 px de portee pour une fenetre qui
// vaut la largeur de l'ecran — et c'est assume : mieux vaut voir une partie a
// sa taille que tout en miniature.
function updateMapView(hud) {
    const vis = WORLD.vision;

    // Largeur prise dans le cache, jamais relue ici : `clientWidth` tombe apres
    // les ecritures de style de `renderState`, et le navigateur doit alors
    // recalculer toute la mise en page pour repondre. La carte etait le premier
    // outil fausse par la mesure qu'elle declenchait.
    //
    // Sans mesure, on retombe sur le tour entier — le cadrage d'avant la
    // fenetre. Ca ne dure que le temps du premier `initDebugHUD()`.
    const frame = viewMetrics.hudWidth || WORLD.width;
    const span = Math.max(1, Math.min(frame, WORLD.width));

    // Le kart observe fait le centre — c'est sa vue qu'on lit. Sans lui, la
    // camera : c'est le seul point de vue qui reste.
    let centre = renderCameraX;
    if (focusedKartId !== null) {
        const watched = worldState.kartsById[focusedKartId];
        if (watched) centre = watched.worldX;
    }

    // Le cadre penche du cote ou le kart REGARDE : il voit 1400 px devant lui
    // pour 1000 derriere. A echelle 1 la fenetre ne tient plus tout le champ, et
    // ce qu'on sacrifie alors doit etre l'arriere — c'est devant que le kart va.
    // Le decalage reste le demi-ecart des deux portees, borne au quart de la
    // fenetre pour que le kart lui-meme ne se retrouve jamais sur un bord.
    const quarter = span / 4;
    let bias = vis ? (vis.rangeFront - vis.rangeBack) / 2 : 0;
    if (bias > quarter) bias = quarter;
    if (bias < -quarter) bias = -quarter;

    mapView.span = span;
    mapView.start = centre - span / 2 + bias;

    // Echelle 1 : la bande vaut la profondeur de piste, en pixels de monde.
    //
    // Pas d'arrondi. Le cadre porte `DEPTH_PAD` % de marge en haut et en bas, et
    // arrondir sa hauteur au pixel decale la bande utile d'autant — les corps
    // ressortaient 0.3 % trop hauts, ce qui n'est rien a l'oeil mais suffit a ne
    // plus etre l'echelle 1 qu'on annonce.
    const band = (WORLD.roadMaxY - WORLD.roadMinY) * depthToWorldPx();
    const height = band / ((100 - DEPTH_PAD * 2) / 100);

    // Ecrite seulement quand elle change : la poser a chaque image forcerait un
    // recalcul de mise en page soixante fois par seconde pour rien.
    if (height > 0 && height !== mapHudHeight) {
        mapHudHeight = height;
        hud.style.height = `${height.toFixed(2)}px`;
    }
}

// Ou tombe un point du monde dans la fenetre, en px de monde depuis son bord
// gauche. Le tour boucle : ce qui PRECEDE la fenetre doit donc se lire en
// negatif, et non a l'autre bout du monde, sans quoi un corps qui entre par la
// gauche serait confondu avec un corps qui sort par la droite. La ligne
// d'arrivee cesse alors d'etre une couture — elle defile comme le reste.
function mapOffset(worldX) {
    const w = WORLD.width;
    let d = worldX - mapView.start;
    if (w > 0) {
        d = ((d % w) + w) % w;
        // Le partage se fait au milieu de ce qui RESTE hors du cadre, et non au
        // demi-tour : la fenetre peut couvrir plus de la moitie d'un tour, et
        // basculer a w/2 renverrait alors sa propre moitie droite du cote des
        // negatifs — les corps y disparaitraient en plein cadre.
        if (d > (w + mapView.span) / 2) d -= w;
    }
    return d;
}

// Vrai quand un point tombe dans le cadre. Ce qui n'y est pas ne se dessine
// pas : une marque repliee sur un bord mentirait sur une position.
function inMapView(pct) {
    return pct >= 0 && pct <= 100;
}

// Un corps se dessine a son emprise reelle, et non en pastille de taille fixe.
// Les deux axes portant la meme echelle, une largeur et une profondeur s'y
// comparent enfin : un tuyau est visiblement plus large qu'un kart, et la zone
// de ramassage d'une boite visiblement etroite le long de la piste pour la
// profondeur qu'elle couvre.

function spanXPct(halfX) {
    return (halfX * 2 / mapView.span) * 100;
}

// La profondeur ne dispose que de la bande interieure, celle que `depthPct`
// remplit : les marges du cadre n'en font pas partie.
function spanYPct(halfY) {
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    if (!(hi > lo)) return 0;
    return (halfY * 2 / (hi - lo)) * (100 - DEPTH_PAD * 2);
}

// Pose une marque a sa taille reelle. `round` pour le seul corps qui l'est.
function sizeEntity(el, half) {
    el.style.width = `${spanXPct(half.x)}%`;
    el.style.height = `${spanYPct(half.y)}%`;
    el.style.borderRadius = half.round ? '50%' : '0';
}

// Un segment du monde ramene a la fenetre et coupe a ses bords. `len` signe —
// negatif pour un regard vers l'arriere. Rend [] quand il tombe entierement
// dehors.
//
// Il rendait jusqu'a DEUX morceaux, du temps ou la carte portait un tour
// complet : un cone qui franchissait la ligne d'arrivee repartait par la
// gauche. La fenetre supprime cette couture — elle ne fait jamais le tour, donc
// un segment y est d'un seul tenant.
function worldSegments(from, len) {
    const span = mapView.span;

    let a = mapOffset(len < 0 ? from + len : from);
    let b = a + Math.abs(len);

    if (b <= 0 || a >= span) return [];
    if (a < 0) a = 0;
    if (b > span) b = span;

    return [[(a / span) * 100, ((b - a) / span) * 100]];
}

function xPct(worldX) {
    return (mapOffset(worldX) / mapView.span) * 100;
}

// Une bande horizontale : un morceau de monde sur une tranche de profondeur.
function bandHtml(cls, from, len, loY, hiY, title) {
    const top = depthPct(loY);
    const bottom = depthPct(hiY);
    const y = Math.min(top, bottom);
    const h = Math.max(Math.abs(bottom - top), 1.5);

    return worldSegments(from, len).map(seg =>
        `<div class="${cls}" style="left:${seg[0].toFixed(3)}%;width:${seg[1].toFixed(3)}%;` +
        `top:${y.toFixed(2)}%;height:${h.toFixed(2)}%;"${title ? ` title="${title}"` : ''}></div>`
    ).join('');
}

// Un trait de profondeur, sur toute la largeur de la carte.
function ruleHtml(cls, y, title) {
    return `<div class="${cls}" style="top:${depthPct(y).toFixed(2)}%;"${title ? ` title="${title}"` : ''}></div>`;
}

// Une OMBRE : un trapeze au sol, entre deux ecarts au kart, avec sa propre
// profondeur a chaque bout. Elle s'elargit en s'eloignant de l'oeil et s'arrete
// net — c'est tout le modele de la vue a la troisieme personne, et c'est ce
// qu'on vient regarder sur la carte.
//
// Le rectangle qui la porte couvre son enveloppe ; `clip-path` y taille le
// trapeze. Coupee au bord du cadre, elle voit ses profondeurs se reinterpoler a
// la coupe — sans quoi le morceau visible porterait la largeur du bout reste
// dehors.
function shadowHtml(from, to, loA, hiA, loB, hiB) {
    // Un coup d'oeil arriere projette l'ombre dans le sens des x decroissants :
    // les deux bouts arrivent alors dans l'ordre inverse. On remet le proche a
    // gauche AVEC ses profondeurs, sans quoi le trapeze se dessine a l'envers —
    // large pres de l'oeil, etroit au loin.
    if (to < from) {
        const x = from; from = to; to = x;
        const l = loA; loA = loB; loB = l;
        const h = hiA; hiA = hiB; hiB = h;
    }

    const span = to - from;

    // Bornee a la piste : au-dela elle ne cache plus rien de reel, et un
    // trapeze qui deborde de dix fois la hauteur ecrase le dessin.
    const clampY = y => Math.max(WORLD.roadMinY - 1, Math.min(WORLD.roadMaxY + 1, y));

    const at = x => {
        const t = (span === 0) ? 0 : (x - from) / span;
        return [clampY(loA + (loB - loA) * t), clampY(hiA + (hiB - hiA) * t)];
    };

    // Coupee aux bords de la fenetre, et les profondeurs se reinterpolent a la
    // coupe : sans ca, le morceau visible porterait la largeur du bout reste
    // dehors. C'est le meme travail qu'avant, mais sur les bords du cadre et non
    // plus sur la ligne d'arrivee — la fenetre ne fait jamais le tour, donc une
    // ombre n'y est plus qu'en un seul morceau.
    const view = mapView.span;
    const head = mapOffset(from);

    let x0 = from;
    let x1 = to;
    if (head < 0) x0 = from - head;
    if (head + span > view) x1 = from + (view - head);

    if (x1 <= x0) return '';

    const a = at(x0);
    const b = at(x1);

    const left = ((head + (x0 - from)) / view) * 100;
    const width = ((x1 - x0) / view) * 100;

    // Les quatre coins, en pourcentage de la boite : haut-gauche, haut-droit,
    // bas-droit, bas-gauche.
    const yTopA = depthPct(a[1]);
    const yBotA = depthPct(a[0]);
    const yTopB = depthPct(b[1]);
    const yBotB = depthPct(b[0]);

    const top = Math.min(yTopA, yTopB);
    const bot = Math.max(yBotA, yBotB);
    const h = Math.max(bot - top, 0.5);
    const pc = y => (((y - top) / h) * 100).toFixed(2);

    return `<div class="dv-shadow" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%;` +
           `top:${top.toFixed(2)}%;height:${h.toFixed(2)}%;` +
           `clip-path:polygon(0% ${pc(yTopA)}%,100% ${pc(yTopB)}%,` +
           `100% ${pc(yBotB)}%,0% ${pc(yBotA)}%);"></div>`;
}

// COUPE POUR L'INSTANT. Passer a true rend le faisceau, rien d'autre a
// toucher : le dessin ne depend que du releve de vue, deja transmis, et son CSS
// (`.dv-rays`) est reste en place.
const SHOW_RAY_FAN = false;

// Le FAISCEAU, trace depuis l'oeil — le point de vue a la troisieme personne,
// en arriere du kart (`vision.eye.back`).
//
// C'est de la que tout le modele d'occlusion se mesure : `shadowHides` ne
// compare pas des profondeurs mais des PENTES rapportees a l'oeil, et un angle
// mort n'est rien d'autre que la projection d'un corps depuis ce point. Les
// trapezes poses au sol le montraient deja, mais amputes de leur sommet : rien
// ne disait POURQUOI ils ont cette forme, ni qu'ils appartiennent tous au meme
// faisceau. Les rayons rendent le sommet.
//
// Deux familles de traits, et elles ne disent pas la meme chose :
//
//   rayons de BORD    jusqu'aux deux rives, au bout de la portee. Ils donnent
//                     l'ouverture du faisceau meme quand rien ne masque.
//   rayons d'ARETE    deux par corps solide, passant par ses flancs. Ce sont
//                     eux qui bornent son ombre — les prolonger jusqu'a l'oeil
//                     montre que le trapeze EST une projection, et pas une
//                     bande posee a la main.
//
// En SVG et non en div : un trait oblique se decrit par deux points, la ou une
// boite aurait demande une rotation et un `clip-path` par rayon.
function rayFanHtml(v, dir, lo, hi) {
    const span = mapView.span;

    // Tous les points se reperent PAR RAPPORT A L'OEIL, jamais chacun pour soi.
    // Le tour boucle, et deux `mapOffset` independants peuvent tomber de part et
    // d'autre de la couture : le rayon traverserait alors la carte entiere.
    const eyeOff = mapOffset(v.x - v.eyeBack * dir);
    const px = dw => (((eyeOff + dw) / span) * 100).toFixed(3);
    const py = y => depthPct(y).toFixed(2);

    // Un point a `look` du kart est a `look + eyeBack` de l'oeil, du cote
    // balaye. C'est la seule conversion du dessin, et elle vaut pour tout.
    const reach = look => (look + v.eyeBack) * dir;

    const x0 = px(0);
    const y0 = py(v.y);
    const ray = (cls, look, y) =>
        `<line class="${cls}" x1="${x0}%" y1="${y0}%" ` +
        `x2="${px(reach(look))}%" y2="${py(y)}%" />`;

    const lines = [ray('dv-ray dv-ray-edge', v.range, lo),
                   ray('dv-ray dv-ray-edge', v.range, hi)];

    // `sh[1]` est le bout de l'ombre, `sh[4]`/`sh[5]` ses deux profondeurs la —
    // donc exactement les deux points ou aboutissent les rayons rasants.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[4]));
        lines.push(ray('dv-ray dv-ray-graze', sh[1], sh[5]));
    }

    return `<svg class="dv-rays" width="100%" height="100%">${lines.join('')}</svg>`;
}

// Un point pose a un endroit precis du monde. Hors fenetre, il ne se dessine
// pas : replie sur un bord, il mentirait sur une position.
function pinHtml(cls, worldX, y, label) {
    const left = xPct(worldX);
    if (!inMapView(left)) return '';
    return `<div class="${cls}" style="left:${left.toFixed(3)}%;top:${depthPct(y).toFixed(2)}%;"` +
           `${label ? ` title="${label}"` : ''}></div>`;
}

// Le dessin de la vue, refait a chaque releve neuf — un balayage tourne douze
// fois par seconde, l'affichage soixante, et redessiner entre deux ne montrerait
// rien de plus.
//
// La fenetre, elle, DEFILE : le meme releve ne tombe pas au meme endroit d'une
// image a l'autre. Le cadrage entre donc dans ce qui declenche un redessin, au
// meme titre que le releve. L'oublier fige la couche de vision en place pendant
// que la piste glisse dessous.
let visionDrawn = null;
let visionDrawnAt = null;
let visionNote = '';

function renderVisionLayer() {
    const layer = document.getElementById('debug-vision');
    if (!layer) return;

    const v = worldState.vision;

    // ── Pourquoi il n'y a rien a dessiner, quand il n'y a rien a dessiner ──
    //
    // Un `return` muet est precisement ce qui a laisse cette carte vide sans
    // que personne ne s'en apercoive : elle se construisait avant la connexion,
    // ne trouvait aucun kart, et n'en disait rien. On ne refait pas la meme
    // faute pour la couche de vision — chaque cause a sa phrase, et elle
    // s'affiche a la place du dessin.
    let note = '';
    if (!WORLD.vision) {
        // Le `hello` ne porte pas les distances de vue : le service tourne sur
        // une version anterieure du protocole. Recharger la page n'y changera
        // rien, c'est le moteur qu'il faut relancer.
        note = 'service de course a redemarrer (hello sans bloc vision)';
    } else if (focusedKartId === null) {
        note = 'aucun kart suivi — clique un kart dans le classement';
    } else if (!v) {
        note = `vue demandee pour le kart ${focusedKartId}, rien recu`;
    }

    if (note) {
        if (note !== visionNote) {
            visionNote = note;
            visionDrawn = null;
            layer.innerHTML = `<div class="dv-note">${note}</div>`;
        }
        return;
    }

    visionNote = '';
    if (v === visionDrawn && mapView.start === visionDrawnAt) return;
    visionDrawn = v;
    visionDrawnAt = mapView.start;

    const cfg = WORLD.vision;
    const dir = v.scanBack ? -1 : 1;
    const lo = WORLD.roadMinY;
    const hi = WORLD.roadMaxY;
    const html = [];

    // 1. LE CHAMP. Jusqu'ou porte CE balayage-la, dans le sens ou il a eu lieu.
    //    La portee vient du serveur : elle n'est pas la meme devant et derriere,
    //    et la choisir ici serait deja une deduction.
    html.push(bandHtml('dv-cone', v.x, v.range * dir, lo, hi,
        `${v.scanBack ? 'arriere' : 'avant'} ${v.range}px`));

    // 1 bis. LES ANGLES MORTS. Ce que les corps solides jettent au sol depuis
    //    la camera de poursuite. Chacun s'elargit en s'eloignant et S'ARRETE :
    //    la ou il s'arrete, le kart revoit la piste. C'est la lecture qui
    //    manquait — un trou noir dans le champ vert, avec un bord.
    for (let i = 0; i < v.shadows.length; i++) {
        const sh = v.shadows[i];
        html.push(shadowHtml(v.x + sh[0] * dir, v.x + sh[1] * dir,
                             sh[2], sh[3], sh[4], sh[5]));
    }

    // 1 ter. LE FAISCEAU. D'ou partent ces ombres, et pourquoi elles ont cette
    //    forme. Pose apres elles pour que les rayons se lisent PAR-DESSUS le
    //    noir : c'est le trait qui explique la tache, pas l'inverse.
    //
    //    Coupe pour l'instant — cf. `SHOW_RAY_FAN`.
    if (SHOW_RAY_FAN) html.push(rayFanHtml(v, dir, lo, hi));

    // 2. LA LIGNE DE TIR qu'on partage : la portee du danger latent, sur la
    //    seule bande ou l'alignement compte. Hors de cette bande, un porteur ne
    //    peut rien contre le kart et se decaler ne veut rien dire.
    html.push(bandHtml('dv-press', v.x, cfg.pressureRange * dir,
        v.y - cfg.clear, v.y + cfg.clear, `alignement ±${cfg.clear}`));

    // 3. LA VOIE : plus large que le degagement, et elle doit l'etre — les deux
    //    corps bougent en profondeur pendant le temps avant impact.
    html.push(ruleHtml('dv-lane', v.y - cfg.threatLane, 'voie'));
    html.push(ruleHtml('dv-lane', v.y + cfg.threatLane, 'voie'));

    // 4. CE QUI FERME UN PASSAGE. C'est la lecture la plus utile de la carte :
    //    un couloir libre est un trou entre deux barres. Un mur dur — un tuyau —
    //    ne se franchit pas, le reste se paie.
    for (let i = 0; i < v.spans.length; i++) {
        const s = v.spans[i];
        html.push(bandHtml(s[4] ? 'dv-span dv-hard' : 'dv-span', v.x, s[2],
            s[0], s[1], `${s[4] ? 'mur' : 'corps'} a ${Math.round(s[2])}px`));
    }

    // 5. CE QUE LE MOTEUR A RETENU. Chaque marque est une decision de la vue,
    //    pas une entite de la scene : c'est l'ecart entre les deux qu'on cherche.
    if (v.threat) {
        html.push(ruleHtml('dv-threat', v.threat[2],
            `menace ${v.threat[1]} · ${v.threat[3] < 0 ? 'jamais' : v.threat[3] + 'ms'}`));
    }
    if (v.pressure) {
        html.push(ruleHtml('dv-carrier', v.pressure[0],
            v.pressure[2] ? 'porteur derriere' : 'porteur devant'));
    }
    if (v.pipe) {
        const pipe = worldState.pipes[v.pipe[0]];
        if (pipe) html.push(pinHtml('dv-pin dv-pin-pipe', pipe.worldX, pipe.y, 'tuyau qui barre'));
    }
    if (v.box) html.push(pinHtml('dv-pin dv-pin-box', v.x + v.box[1], v.box[0], 'boite visee'));
    if (v.red) html.push(pinHtml('dv-pin dv-pin-red', v.x - v.red[0], v.red[1],
        `rouge derriere ×${v.red[3]}`));

    // 6. LA CONSIGNE. La profondeur que le kart REJOINT, s'il a un plan. Une vue
    //    sans le geste qu'elle a produit ne se juge pas.
    if (v.plan) html.push(ruleHtml('dv-plan', v.plan[3], `${v.plan[0]}${v.plan[4] ? ' (approx.)' : ''}`));

    // 7. L'OEIL. Il n'est PAS sur le kart : la camera le suit de `eyeBack`
    //    pixels, du cote oppose au regard, et c'est de la que partent toutes
    //    les ombres ci-dessus. La voir a sa place est la moitie de ce qui rend
    //    le dessin comprehensible.
    const eyePct = xPct(v.x - v.eyeBack * dir);
    if (inMapView(eyePct)) {
        html.push(`<div class="dv-eye${v.scanBack ? ' dv-eye-back' : ''}" ` +
                  `style="left:${eyePct.toFixed(3)}%;` +
                  `top:${depthPct(v.y).toFixed(2)}%;"></div>`);
    }
    html.push(bandHtml('dv-eyelink', v.x, -v.eyeBack * dir, v.y, v.y, 'recul de camera'));

    layer.innerHTML = html.join('');
}

function initDebugHUD() {
    let hud = document.getElementById('debug-hud');
    if (!hud) {
        hud = document.createElement('div');
        hud.id = 'debug-hud';
        document.body.appendChild(hud);
    }
    hud.innerHTML = '';
    hud.style.display = 'block';
    // La hauteur se recalcule : `updateMapView` ne la reecrit que lorsqu'elle
    // change, et le cadre vient d'etre vide.
    mapHudHeight = 0;
    visionDrawnAt = null;

    // La couche de vision passe en premier : elle est le fond sur lequel les
    // entites se lisent, jamais l'inverse.
    const vision = document.createElement('div');
    vision.id = 'debug-vision';
    hud.appendChild(vision);
    visionDrawn = null;

    // La ligne d'arrivee defile comme le reste : la fenetre bouge, elle ne
    // reste pas a une fraction fixe du cadre. Sa position se pose donc a chaque
    // image, avec celle des corps.
    const finishLine = document.createElement('div');
    finishLine.className = 'debug-entity debug-finish';
    finishLine.id = 'debug-finish';
    hud.appendChild(finishLine);

    // Chaque corps se dessine a son emprise, et le serveur seul la connait. Un
    // vieux serveur qui ne l'enverrait pas laisse le repli hors ligne prendre le
    // relais : la carte reste juste plutot que de disparaitre.
    const hitboxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;

    // Les tuyaux : ils ne bougent pas dans le MONDE, mais la fenetre si. Leur
    // emprise se pose une fois — elle ne change jamais — et leur position a
    // chaque image, comme celle des karts. C'est le corps le plus structurant de
    // la piste, le seul qu'on ne traverse pas.
    worldState.pipes.forEach((pipe, i) => {
        const dPipe = document.createElement('div');
        dPipe.className = 'debug-entity debug-pipe';
        dPipe.id = `debug-pipe-${i}`;
        dPipe.style.top = `${depthPct(pipe.y)}%`;
        sizeEntity(dPipe, hitboxes.pipe);
        hud.appendChild(dPipe);
    });

    worldState.itemBoxes.forEach((box, i) => {
        const dBox = document.createElement('div');
        dBox.className = 'debug-entity debug-itembox';
        dBox.id = `debug-box-${i}`;
        dBox.style.top = `${depthPct(box.y)}%`;
        sizeEntity(dBox, hitboxes.itemBox);
        hud.appendChild(dBox);
    });

    worldState.karts.forEach(kart => {
        const dKart = document.createElement('div');
        dKart.className = 'debug-entity debug-kart';
        dKart.id = `debug-kart-${kart.id}`;
        dKart.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';
        // Son emprise a lui, pas celle du kart de reference : c'est tout
        // l'interet de la carte que d'y voir un long et un court n'occuper ni
        // la meme longueur ni la meme profondeur.
        sizeEntity(dKart, kart.body || hitboxes.kart);
        hud.appendChild(dKart);
    });

    // Les objets vont et viennent : leur couche se reecrit a chaque image, elle
    // ne se peuple pas ici.
    const items = document.createElement('div');
    items.id = 'debug-items';
    hud.appendChild(items);

    // Ce que la banniere montre, dans la fenetre. Un seul element : la carte ne
    // fait plus le tour du monde, donc ce rectangle ne peut plus se couper en
    // deux morceaux comme il le fallait du temps du tour complet.
    const camView = document.createElement('div');
    camView.className = 'debug-camera-view';
    camView.id = 'debug-camera-view';
    hud.appendChild(camView);

    const leaderboard = document.createElement('div');
    leaderboard.id = 'debug-leaderboard';
    leaderboard.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 10px 15px;
        border-radius: 8px;
        font-family: monospace;
        font-size: 14px;
        z-index: 9999;
        min-width: 200px;
    `;

    const title = document.createElement('div');
    title.style.cssText = 'font-weight: bold; margin-bottom: 8px; text-align: center; border-bottom: 1px solid #555; padding-bottom: 5px;';
    title.innerText = '🏁 Classement';
    leaderboard.appendChild(title);

    const list = document.createElement('div');
    list.id = 'debug-leaderboard-list';
    leaderboard.appendChild(list);

    document.body.appendChild(leaderboard);
    // Le cadre vient d'apparaitre : on prend sa largeur maintenant, une fois,
    // plutot qu'a chaque image depuis updateMapView().
    refreshLayoutMetrics();
}

// Les objets, redessines d'un bloc a chaque image.
//
// Ils ne peuvent pas etre poses une fois comme les tuyaux : ils naissent, se
// consomment et disparaissent en pleine course. Plutot qu'un pool d'elements a
// tenir a jour, la couche se reecrit — c'est le meme parti que `renderVisionLayer`,
// et pour la meme raison : moins d'etat, donc moins de facons d'etre faux.
//
// ── Qui a une hitbox, et laquelle ────────────────────────────────────────
//
// Une carapace et une banane partagent la meme emprise, et c'est celle que le
// serveur envoie. Deux exceptions, et elles se DESSINENT au lieu d'etre
// passees sous silence, parce qu'un objet inoffensif au milieu de la piste est
// precisement ce qu'on vient verifier :
//
//   la bleue      survole tout. Elle n'entre dans aucune passe de collision, ni
//                 contre les karts, ni contre les objets. Son souffle, lui, a
//                 un rayon qui CROIT pendant 300 ms — une emprise fixe ne sait
//                 pas le dire, et l'avancement n'est pas transmis. Les deux se
//                 marquent donc « sans emprise » plutot que d'etre inventes.
//   la cloche     une banane lobee n'a pas de hitbox tant qu'elle MONTE
//                 (`item.rising`). Elle la retrouve au sommet, pas a
//                 l'atterrissage.
//
// ── Les objets TRAINES ───────────────────────────────────────────────────
//
// Un objet tenu derriere son porteur n'est pas dans `worldState.items` : il vit
// dans `kart.heldItem`, et pourtant il a bel et bien une emprise — la passe de
// collision la teste a `kart.worldX + heldBehindX`, a la profondeur du kart.
// C'est elle qui fait du trainage un BOUCLIER : la carapace qui arrive s'y
// consume au lieu d'atteindre le kart.
//
// Sans lui la carte mentait par omission, et sur le cas le plus utile a
// verifier : un kart qui traine parait nu, alors qu'il porte devant lui — pardon,
// derriere lui — de quoi encaisser un tir.
//
// Il menace aussi : la meme passe le teste contre chaque kart en course, et
// celui qui le touche part en tete-a-queue — l'objet est consomme au passage.
// Un poursuivant colle a un kart qui traine prend donc reellement quelque
// chose, et c'est bien ce que la carte doit montrer.
function renderItemLayer() {
    const layer = document.getElementById('debug-items');
    if (!layer) return;

    const boxes = WORLD.hitboxes || OFFLINE_WORLD.hitboxes;
    const half = boxes.item || OFFLINE_WORLD.hitboxes.item;
    const behindX = (boxes.heldBehindX !== undefined)
        ? boxes.heldBehindX : OFFLINE_WORLD.hitboxes.heldBehindX;

    const w = spanXPct(half.x).toFixed(3);
    const h = spanYPct(half.y).toFixed(3);
    const html = [];

    const mark = (cls, worldX, y, title, sized) => {
        const left = xPct(worldX);
        if (!inMapView(left)) return;
        html.push(`<div class="${cls}" style="left:${left.toFixed(3)}%;` +
                  `top:${depthPct(y).toFixed(2)}%;${sized ? `width:${w}%;height:${h}%;` : ''}" ` +
                  `title="${title}"></div>`);
    };

    for (let i = 0; i < worldState.items.length; i++) {
        const item = worldState.items[i];

        const blue = item.type === 'blueShell' || item.type === 'blueBlast';
        const inert = blue || item.rising;

        // Sans emprise, il reste un point : on marque OU il est, sans lui
        // preter une boite qu'il n'a pas.
        const cls = 'dv-item' + (inert ? ' dv-item-inert' : '')
            + (item.type === 'banana' ? ' dv-item-banana' : '');

        mark(cls, item.worldX, item.y,
             `${item.type}${inert ? ' — sans emprise' : ''}`, !inert);
    }

    // Les objets traines, pris sur leur porteur. Meme emprise qu'un objet
    // largue — c'est la meme constante qui les teste — mais une autre couleur :
    // celui-ci encaisse, il ne blesse pas.
    for (let k = 0; k < worldState.karts.length; k++) {
        const kart = worldState.karts[k];
        const held = kart.heldItem;
        if (!held || held.holdPosition !== 'behind') continue;

        mark('dv-item dv-item-held', kart.worldX + behindX, kart.yPercent,
             `${held.type} traine — bouclier`, true);
    }

    layer.innerHTML = html.join('');
}

// Pose une marque a son abscisse dans la fenetre, ou l'efface si elle en sort.
// Rend true quand elle est visible, pour que l'appelant s'epargne le reste.
function placeInView(el, worldX) {
    if (!el) return false;

    const left = xPct(worldX);
    if (!inMapView(left)) {
        el.style.display = 'none';
        return false;
    }

    el.style.display = '';
    el.style.left = `${left.toFixed(3)}%`;
    return true;
}

function updateDebugHUD() {
    const hud = document.getElementById('debug-hud');
    if (!hud) return;

    // Meme cache que la boucle. C'est ici que la lecture faisait le plus de
    // degats : elle tombait APRES les ecritures de style de `renderState`, donc
    // le navigateur devait recalculer toute la mise en page pour y repondre —
    // le HUD faussait ainsi la mesure qu'il affiche.
    const screenWidth = viewMetrics.containerWidth || window.innerWidth;

    // Le cadrage d'abord : tout ce qui suit se place dedans.
    updateMapView(hud);

    const camMain = document.getElementById('debug-camera-view');

    // La fenetre de camera ne se dessine que lorsqu'elle est LIBRE, c'est-a-dire
    // quand on ne suit personne.
    //
    // Collee a un kart, elle ne dit plus rien : elle est centree sur lui par
    // construction, elle suit son point sans jamais s'en ecarter, et elle
    // recouvre d'un aplat rouge exactement la zone qu'on vient regarder — le
    // champ de vision et ses angles morts. Le seul moment ou sa position
    // s'apprend est celui ou elle avance toute seule.
    if (camMain) {
        // camera = centre de la vue : le bord gauche est a mi-largeur en arriere.
        const seg = (focusedKartId === null)
            ? worldSegments(renderCameraX - screenWidth / 2, screenWidth)
            : [];

        if (seg.length) {
            camMain.style.display = 'block';
            camMain.style.left = `${seg[0][0].toFixed(3)}%`;
            camMain.style.width = `${seg[0][1].toFixed(3)}%`;
        } else {
            camMain.style.display = 'none';
        }
    }

    // Les corps fixes du monde defilent maintenant sous la fenetre : leur
    // abscisse se repose a chaque image, et ce qui sort du cadre disparait
    // plutot que de s'ecraser sur un bord.
    // La ligne d'arrivee est une BANDE, pas un trait : elle occupe toute la
    // profondeur de piste sur `finishBandWidth()` px de long. Elle se pose par
    // son bord GAUCHE et non par son centre, parce que c'est ainsi que le decor
    // la place — et surtout parce que le tour se compte exactement la
    // (`finishLineX` dans la boucle de course), pas au milieu de la bande.
    //
    // Elle passe par `worldSegments` et non par `placeInView` : large de 60 px,
    // elle peut n'etre qu'a moitie dans le cadre, et il faut la couper plutot
    // que la faire disparaitre.
    const finishEl = document.getElementById('debug-finish');
    if (finishEl) {
        const seg = worldSegments(WORLD.finishLineX, finishBandWidth());
        if (seg.length) {
            finishEl.style.display = '';
            finishEl.style.left = `${seg[0][0].toFixed(3)}%`;
            finishEl.style.width = `${seg[0][1].toFixed(3)}%`;
        } else {
            finishEl.style.display = 'none';
        }
    }
    for (let i = 0; i < worldState.pipes.length; i++) {
        placeInView(document.getElementById(`debug-pipe-${i}`), worldState.pipes[i].worldX);
    }
    for (let i = 0; i < worldState.itemBoxes.length; i++) {
        placeInView(document.getElementById(`debug-box-${i}`), worldState.itemBoxes[i].worldX);
    }

    // Ce que le kart suivi n'a PAS vu au dernier balayage. C'est la moitie
    // manquante de la carte : sans elle, un kart qui ignore une banane et un
    // kart qui ne la voit pas se dessinent pareil.
    const v = worldState.vision;
    const hidden = v ? v.hidden : null;

    worldState.karts.forEach(kart => {
        const el = document.getElementById(`debug-kart-${kart.id}`);
        if (el) {
            if (!placeInView(el, kart.worldX)) return;
            el.style.top = `${depthPct(kart.yPercent)}%`;
            // Translucides comme le reste des marques : a taille reelle les
            // corps se recouvrent, et un aplat opaque effacerait le tuyau
            // contre lequel un kart est justement en train de se cogner.
            el.style.backgroundColor = (kart.state === 'hit')
                ? 'rgba(255, 64, 64, 0.75)'
                : 'rgba(64, 96, 255, 0.75)';
            if (kart.state === 'grid') el.style.backgroundColor = 'rgba(150, 150, 150, 0.7)';
            el.innerText = GAME_CONFIG.resources.initials[kart.charName] || '?';

            // Meme convention de signe que le moteur : un kart s'identifie en
            // negatif dans les releves de vue.
            const masked = !!hidden && hidden.indexOf(-1 - kart.id) !== -1;
            el.classList.toggle('is-masked', masked);
            el.classList.toggle('is-watched', v ? v.id === kart.id : false);
        }
    });

    renderItemLayer();
    renderVisionLayer();

    const leaderboardList = document.getElementById('debug-leaderboard-list');
    if (leaderboardList) {
        // Meme reference que la physique : rollItem() mesure l'ecart au premier
        // via totalDistance, jamais via worldX. Trier ici sur autre chose
        // afficherait des ecarts incoherents avec le tirage d'items.
        const sortedKarts = [...worldState.karts]
            .sort((a, b) => b.totalDistance - a.totalDistance);

        const leader = sortedKarts[0] || null;

        leaderboardList.innerHTML = sortedKarts.map((kart, index) => {
            const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`;
            const name = kart.charName.charAt(0).toUpperCase() + kart.charName.slice(1);
            // Le nombre de tours n'est pas diffuse : il se deduit de la
            // distance parcourue, qui l'est. Affiche en base 1 : on est dans
            // le tour 1 des le depart, comme sur le panneau de Lakitu.
            const laps = Math.floor(kart.totalDistance / WORLD.width) + 1;
            const gap = (leader && leader.id !== kart.id)
                ? `${Math.round(leader.totalDistance - kart.totalDistance)}px`
                : '\u2014';
            return `<div style="padding: 3px 0; ${index === 0 ? 'color: gold;' : ''}">${medal} ${name} <span style="float: right; color: #aaa;">T${laps} \u00B7 ${gap}</span></div>`;
        }).join('');
    }
}

// La course continue sans nous. Il n'y a donc rien a « reprendre » : au retour,
// on jette le tampon devenu faux, on recale l'horloge, et le serveur renvoie un
// `hello` complet — un onglet qui revient est un arrivant comme un autre.
function handleVisibilityChange() {
    if (document.hidden) {
        if (animationId) cancelAnimationFrame(animationId);
        animationId = null;
        bannerNet.setHidden(true);
        return;
    }

    bannerNet.setHidden(false);

    if (!animationId) animationId = requestAnimationFrame(animate);
}

function initSnow() {
    const banner = document.querySelector('.hero.smk-snes-banner');
    if (!banner) return;

    let snowContainer = document.querySelector('.snow-container');
    if (!snowContainer) {
        snowContainer = document.createElement('div');
        snowContainer.className = 'snow-container';
        const gameWrapper = banner.querySelector('.game-content-wrapper');
        if (gameWrapper) {
            gameWrapper.appendChild(snowContainer);
        } else {
            banner.appendChild(snowContainer);
        }
    }

    const snowflakeCount = cachedIsMobile ? 50 : 100;
    const containerHeight = snowContainer.offsetHeight || 360;
    const containerWidth = snowContainer.offsetWidth || 1200;

    for (let i = 0; i < snowflakeCount; i++) {
        createFallingSnowflake(snowContainer, containerHeight, containerWidth);
    }

    const landedCount = cachedIsMobile ? 15 : 30;
    for (let i = 0; i < landedCount; i++) {
        createLandedSnowflake(snowContainer, containerWidth);
    }
}

function createFallingSnowflake(container, containerHeight, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake falling';

    const size = Math.random() * 3 + 2;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    const maxDrift = WORLD.roadPPS * (containerHeight / 80);
    const maxDriftPercent = (maxDrift / containerWidth) * 100;
    const startX = Math.random() * (110 + maxDriftPercent) - 10;
    snowflake.style.left = `${startX}%`;

    // Un flocon s'arrete SUR le bitume, jamais au-dessus : la borne haute de sa
    // chute est le bord haut de la piste, la part de scene occupee par le ciel.
    // Elle etait recopiee a la main (0.65, l'ancien decoupage 65/35) et pointait
    // dans le vide des que le cadre a grandi sans que la piste s'allonge. Elle
    // se mesure maintenant, comme tout le reste de la profondeur.
    const skyPart = (containerHeight > 0 && viewMetrics.groundHeight > 0)
        ? 1 - (viewMetrics.groundHeight / containerHeight)
        : 0.65;
    const fallEndPercent = skyPart + Math.random() * Math.max(0, 0.95 - skyPart);
    const fallHeight = containerHeight * fallEndPercent;

    const fallSpeed = 80 + Math.random() * 70;
    const duration = fallHeight / fallSpeed;
    snowflake.style.animationDuration = `${duration}s`;

    snowflake.style.animationDelay = `${Math.random() * duration}s`;

    const driftDistance = -(WORLD.roadPPS * duration);
    snowflake.style.setProperty('--snow-drift', driftDistance);
    snowflake.style.setProperty('--snow-fall-height', fallHeight);

    container.appendChild(snowflake);
}

function createLandedSnowflake(container, containerWidth) {
    const snowflake = document.createElement('div');
    snowflake.className = 'snowflake landed';

    const size = Math.random() * 1.5 + 1.5;
    snowflake.style.width = `${size}px`;
    snowflake.style.height = `${size}px`;

    // Une PROFONDEUR de piste, comme n'importe quel corps de la scene : le
    // flocon pose est sur le bitume. Ecrite en pourcentage de scene, elle
    // remontait dans le ciel des que le cadre grandissait sans que la piste
    // s'allonge. Elle ne passe pas par `depthToY` parce que l'animation de
    // derive occupe deja la `transform` de l'element.
    const depth = Math.random() * 32 + 1;
    snowflake.style.bottom = `${(depth * depthToWorldPx()).toFixed(1)}px`;

    const zIndex = (GAME_CONFIG.rendering.zIndexBase - depth) | 0;
    snowflake.style.zIndex = zIndex;

    snowflake.style.left = `${80 + Math.random() * 40}%`;

    const driftDistance = -containerWidth * 1.5;
    const driftDuration = (containerWidth * 1.5) / WORLD.roadPPS;

    snowflake.style.setProperty('--drift-distance', driftDistance);
    snowflake.style.animationDuration = `${driftDuration}s`;

    snowflake.style.animationDelay = `${Math.random() * driftDuration}s`;

    snowflake.addEventListener('animationend', () => {
        snowflake.remove();
        createLandedSnowflake(container, containerWidth);
    });

    container.appendChild(snowflake);
}

// ---------------------------------------------------------------------------
// Outils de developpement — a retirer a la fin de la migration.
//
//   bannerDev.wipeDom()    efface tout le DOM du banner. La frame suivante doit
//                          le reconstruire a partir du seul snapshot courant :
//                          c'est le test de l'arrivant, joue en direct.
//   bannerDev.offline()    coupe la connexion pour de bon (mode degrade).
//   bannerDev.reconnect()  relance la connexion.
//   bannerDev.curtain(b)   baisse (true) ou leve (false) le rideau.
//   bannerDev.status(s)    force l'indicateur : connecting | online | offline.
//   bannerDev.clock()      ecart d'horloge estime avec le serveur.
//   bannerDev.realise(b)   allume (true) ou coupe (false) la realisation.
//   bannerDev.plateau()    les notes de la realisation, du plus filmable au
//                          moins : c'est avec ce classement qu'on regle
//                          DIRECTOR_WEIGHTS en regardant la course.
// ---------------------------------------------------------------------------
const bannerDev = {
    wipeDom() {
        if (cachedContainer) cachedContainer.innerHTML = '';
        if (leaderboardState.container) leaderboardState.container.innerHTML = '';

        boxEls.length = 0;
        pipeEls.length = 0;
        for (const id in kartEls) delete kartEls[id];
        for (const id in itemEls) delete itemEls[id];
        for (const id in ppEls) delete ppEls[id];
        for (const id in ppSlots) delete ppSlots[id];
        for (const id in ppAnimating) delete ppAnimating[id];

        initLeaderboard();
        domDirty = true;
        return 'DOM efface : la frame suivante doit tout reconstruire';
    },

    offline() {
        bannerNet.giveUp();
        return 'connexion coupee : decor seul, pastille rouge';
    },

    realise(on) {
        raceDirector.setAuto(on !== false);
        return raceDirector.auto ? 'realisation automatique' : 'camera manuelle';
    },

    plateau() {
        const gameNow = getGameTime();
        const scan = directorScan(gameNow);
        return worldState.karts
            .map(kart => ({
                kart: kart.charName,
                note: Math.round(directorScore(kart, scan, gameNow)),
                plan: kart.id === focusedKartId ? '<< a l\'ecran' : ''
            }))
            .sort((a, b) => b.note - a.note);
    },

    reconnect() {
        bannerNet.attempts = 0;
        bannerNet.connect();
        return 'reconnexion demandee';
    },

    curtain(down) {
        if (down) bannerLink.lowerCurtain(); else bannerLink.raiseCurtain();
        return down ? 'rideau baisse' : 'rideau leve';
    },

    status(state) {
        bannerLink.setStatus(state);
        return `etat affiche : ${state}`;
    },

    stats() {
        return {
            fps: perf.fps,
            frames: perf.frames,
            gel: perf.stalls,
            part_gelee: `${((perf.stalls / (perf.frames || 1)) * 100).toFixed(1)} %`,
            tampon: bannerNet.buffer.length,
            retard_de_rendu: `${RENDER_DELAY_MS} ms`
        };
    },

    clock() {
        const last = bannerNet.buffer[bannerNet.buffer.length - 1];
        const renderTime = getGameTime() - RENDER_DELAY_MS;

        return {
            ecart: `${Math.round(serverClockOffset)} ms`,
            cible: `${Math.round(targetClockOffset)} ms`,
            derive: `${Math.round(targetClockOffset - serverClockOffset)} ms`,
            mesures: bannerNet.rttSamples.map(s => `${s.rtt} ms`),
            tampon: bannerNet.buffer.length,
            // Ecart entre l'instant affiche et le dernier etat recu. Doit valoir
            // a peu pres -RENDER_DELAY_MS : franchement positif, le client rend
            // un futur qu'il n'a pas ; tres negatif, il rend un passe.
            retard: last ? `${Math.round(renderTime - last.ts)} ms` : 'aucun snapshot'
        };
    }
};

window.bannerDev = bannerDev;

// Au-dela de ce delai on ouvre le verrou des assets meme s'il en manque : mieux
// vaut un sprite qui arrive en retard qu'un banner masque.
const ASSETS_TIMEOUT_MS = 2500;

// Filet de securite : quoi qu'il arrive — serveur muet, images bloquees — le
// rideau se leve. Un bandeau cache est le seul echec vraiment visible.
const CURTAIN_FAILSAFE_MS = 5000;

document.addEventListener('DOMContentLoaded', () => {
    bannerLink.init();
    bannerLink.lowerCurtain();
    bannerLink.setStatus('connecting');

    Promise.race([
        preloadImages(),
        new Promise(resolve => setTimeout(resolve, ASSETS_TIMEOUT_MS))
    ]).then(() => bannerLink.open('assets'));

    setTimeout(() => bannerLink.raiseCurtain(), CURTAIN_FAILSAFE_MS);

    initScene();
    const _bannerEl = document.getElementById('bannerSection');
    if (!_bannerEl || _bannerEl.dataset.season === 'winter') initSnow();

    // La connexion part tout de suite, en parallele du chargement des images :
    // c'est elle qui met le plus de temps a fournir une scene affichable.
    bannerNet.connect();

    animate(0);

    const fadeElements = document.querySelectorAll('.fade-in');
    fadeElements.forEach(el => setTimeout(() => el.classList.add('visible'), 100));
    document.addEventListener('visibilitychange', handleVisibilityChange);
});
