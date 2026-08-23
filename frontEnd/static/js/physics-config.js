// Constantes de simulation du banner SMK.
//
// Tout ce qui est ici est lu par physics.js et par lui seul : c'est l'etat du
// monde, pas son apparence. Les constantes purement visuelles (chemins d'assets,
// tailles en px, z-index, breakpoint mobile) vivent dans GAME_CONFIG, en tete de
// smk-banner.js, et ne doivent jamais remonter ici.
//
// Ce fichier est destine a devenir la configuration du serveur de course
// autoritatif (voir docs/MIGRATION_BANNER_WSS.md) : le client n'en gardera
// qu'une poignee de valeurs, recues du serveur au moment de la connexion.
// Wrapper UMD identique a celui de physics.js, pour etre chargeable tel quel
// par le navigateur comme par Node.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    } else {
        root.BannerPhysicsConfig = api;
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    return {
        characterStats: {
            mario:  { topSpeed: 510, acceleration: 1.0,  handling: 1.0,  weight: 1.0  },
            luigi:  { topSpeed: 505, acceleration: 1.05, handling: 1.05, weight: 0.95 },
            peach:  { topSpeed: 495, acceleration: 1.15, handling: 1.2,  weight: 0.8  },
            toad:   { topSpeed: 490, acceleration: 1.3,  handling: 1.3,  weight: 0.7  },
            yoshi:  { topSpeed: 500, acceleration: 1.1,  handling: 1.15, weight: 0.85 },
            bowser: { topSpeed: 530, acceleration: 0.7,  handling: 0.7,  weight: 1.4  },
            dk:     { topSpeed: 525, acceleration: 0.75, handling: 0.8,  weight: 1.3  },
            koopa:  { topSpeed: 485, acceleration: 1.25, handling: 1.25, weight: 0.75 }
        },
        world: {
            width: 7680,
            finishLineX: 1440,
            sunX: 1920,
            // A mi-tour de la ligne.
            itemBoxX: 5280,
            itemBoxCount: 4
        },
        road: {
            minY: 0,
            maxY: 30,
            laneTolerance: 12,
            edgeSafetyMargin: 2,
            overtakeMargin: 5,
            wanderMargin: 8
        },
        physics: {
            smoothingFactor: 5,
            pushForce: 0.5,
            collisionBounceY: 10,
        },
        speeds: {
            roadPPS: 250,

            momentumMinRatio: 0.78,
            momentumChangeSpeed: 0.25,
            momentumDriftMin: 3000,
            momentumDriftMax: 7000,
            accelerationRate: 150,

            projectileSpeed: 750,
            redShellSpeed: 700,
            redShellTrackingSpeed: 8,

            shroomBoost: 250,
            shroomDuration: 1500,

            starSpeedMultiplier: 1.4,
            // Duree fixe, identique quel que soit le rang.
            starDuration: 7500,

            returnLane: 20,
            shellVertical: 1.5
        },
        offsets: {
            // Lu par la physique. Valeurs uniques (PC = mobile) pour des collisions
            // reproductibles quel que soit l'appareil.
            world: {
                heldItemBehind: -50,
                shellSpawn: 50
            },
        },
        delays: {
            hitDecelDuration: 1500,
            hitPauseDuration: 500,
            boxRespawn: 1000,
            itemGrant: 3000,
            bananaLife: 40000,
            invincibilityOwnItem: 2000,
            invincibilityAfterHit: 2000,
            throwDelayAfterHit: 1000,
            spawnMin: 150,
            spawnMax: 800
        },
        // Objets retires du jeu. Un type liste ici voit son poids force a 0 dans
        // tous les paliers, sans qu'il faille toucher aux tableaux ci-dessous : le
        // reste du palier est renormalise automatiquement. Pour desactiver un objet,
        // ajouter simplement son nom ici, par exemple :
        //     disabledItems: ['tripleRedShell', 'star']
        // Les trois triples sont en place et testes, mais mis de cote pour le
        // moment : vider cette liste suffit a les remettre en jeu.
        disabledItems: ['tripleBanana', 'tripleGreenShell', 'tripleRedShell'],
        // Objets en orbite : `count` exemplaires tournent autour du kart et servent
        // de bouclier, `child` etant l'objet reellement largue a chaque activation.
        // Ajouter une entree ici suffit a creer un nouveau triple.
        orbitItems: {
            tripleBanana:     { child: 'banana' },
            tripleGreenShell: { child: 'greenShell' },
            tripleRedShell:   { child: 'redShell' }
        },
        // Geometrie commune a toutes les orbites. Lu par la physique : rayons en
        // coordonnees monde (px pour radiusX, pourcentage de route pour radiusY)
        // donc identiques PC et mobile, la mise a l'echelle mobile s'appliquant
        // deja au conteneur entier.
        orbit: {
            count: 3,
            orbitSpeed: 2.6,
            radiusX: 62,
            radiusY: 3.2,
            dropIntervalMin: 1200,
            dropIntervalMax: 3500
        },
        // Chaque ligne somme a 100, les poids se lisent donc directement en %.
        // Les triples sont des objets defensifs, ils pesent en tete et en milieu de
        // peloton et s'effacent a l'arriere ou champignon et etoile prennent le
        // relais. Le triple rouge, le plus offensif, culmine en milieu de peloton.
        itemDistribution: {
            leaderTier: { weights: { banana: 55, tripleBanana: 10, greenShell: 25, tripleGreenShell: 10, redShell: 0,  tripleRedShell: 0,  shroom: 0,  star: 0  } },
            // Seuils d'etoile, cales sur les bornes de paliers ci-dessous : T4
            // s'ouvre a 2000 et T5 a 3000, si bien qu'un kart entrant dans un
            // palier porteur d'etoile y a droit immediatement, sans fenetre morte.
            starMinDistTop: 3000,
            starMinDistMid: 2000,
            tiers: [
                { maxDistance: 500,   weights: { banana: 35, tripleBanana: 12, greenShell: 25, tripleGreenShell: 12, redShell: 8,  tripleRedShell: 8,  shroom: 0,  star: 0  } },
                { maxDistance: 1000,  weights: { banana: 12, tripleBanana: 10, greenShell: 18, tripleGreenShell: 12, redShell: 26, tripleRedShell: 12, shroom: 10, star: 0  } },
                { maxDistance: 2000,  weights: { banana: 8,  tripleBanana: 7,  greenShell: 8,  tripleGreenShell: 7,  redShell: 22, tripleRedShell: 8,  shroom: 40, star: 0  } },
                { maxDistance: 3000,  weights: { banana: 0,  tripleBanana: 3,  greenShell: 3,  tripleGreenShell: 4,  redShell: 8,  tripleRedShell: 2,  shroom: 55, star: 25 } },
                { maxDistance: 4000,  weights: { banana: 0,  tripleBanana: 0,  greenShell: 0,  tripleGreenShell: 0,  redShell: 5,  tripleRedShell: 0,  shroom: 45, star: 50 } }
            ]
        },
        ai: {
            holdItemMin: 500, holdItemMax: 8000,
            detectionRange: 250, dodgeIntensityMin: 20, dodgeIntensityMax: 50,
            overtakeDetectionRange: 120, overtakeMinDistance: 12, overtakeSideSpeed: 10,
            boxDetectionRange: 400, boxSeekIntensity: 25,
            wanderIntervalMin: 2000, wanderIntervalMax: 6000,
            wanderDurationMin: 500, wanderDurationMax: 1500, wanderSpeed: 4
        },
        hitboxes: {
            kartVsKart: { x: 60, y: 5 },
            itemVsKart: { x: 40, y: 5 },
            // itemVsKart.y elargi de radiusY : l'objet oscille en profondeur avec
            // son orbite, ce supplement lui rend la meme tolerance effective qu'un
            // objet pose (5) pour une victime qui roule sur la meme voie.
            orbitItemVsKart: { x: 40, y: 8 },
            itemBox: { x: 10, y: 8 }
        },

        // Deroulement d'une course. Durees en millisecondes, distances en
        // unites monde.
        race: {
            laps: 5,

            // Duree totale du decompte = countdownHoldMs + 2 * lightIntervalMs.
            countdownHoldMs: 3000,
            lightIntervalMs: 1500,

            // Le client masque Lakitu des que la ligne sort de sa fenetre, dont
            // il est seul a connaitre la largeur. Ce delai n'est qu'un
            // garde-fou : sans lui, le feu vert reparaitrait a chaque passage
            // de la ligne, toutes les quinze secondes.
            goSignMs: 5000,

            // Lakitu etant ancre sur la ligne, le panneau n'est vu que si la
            // camera passe devant pendant ce delai.
            finalSignMs: 6000,

            resultsDelayMs: 7000,
            // Au-dela, les karts encore en piste sont classes d'office.
            maxRaceMs: 180000,

            // Deux lignes paralleles filant en diagonale : `lanes` donne leur
            // profondeur de depart, `laneSlope` ce que chaque rang y ajoute.
            //
            // Profondeur totale = backOffset + 3 * rowGap + colStagger. A tenir
            // avec parkStartOffset dans les ~600 unites visibles d'un
            // telephone, sinon le fond de grille sort du cadre.
            grid: {
                backOffset: 115,
                rowGap: 110,
                colStagger: 55,
                lanes: [0.2, 0.58],
                laneSlope: 0.05
            },

            // Le reste des tirages est un depart rate.
            startTurboChance: 0.8,
            startNormalChance: 0.1,
            turboBoostMs: 1200,
            failStallMs: 1000,

            finishedSpeedRatio: 0.6,

            // Ecart a la ligne de la camera garee. Elle designe le centre de la
            // vue : negatif place la ligne a droite du centre, positif a gauche.
            parkStartOffset: 0,
            parkFinishOffset: -150,

            // Pire cas : la camera vient de depasser la ligne et doit refaire un
            // tour complet du monde avant l'arrivee du leader. A recalculer si
            // world.width, roadPPS ou la vitesse des karts changent.
            cameraApproachDistance: 5400,
            cameraMaxCatchupRatio: 3
        },

        // Cadence d'animation des carapaces, en ms par frame. Lu par la physique :
        // c'est elle qui fait avancer `currentFrame`, le client ne fait que
        // afficher la frame courante.
        itemAnim: {
            greenShell: { animSpeed: 100 },
            redShell: { animSpeed: 100 }
        }
    };
});
