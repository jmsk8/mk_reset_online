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
            // Au tiers du tour depuis la ligne : finishLineX + width / 3.
            // A recalculer si l'une des deux bouge.
            itemBoxX: 4000,
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

            projectileSpeed: 880,
            redShellSpeed: 840,
            redShellTrackingSpeed: 8,
            // Cible trop proche pour qu'un tir ait du sens : la rouge passe a la
            // suivante. Si tout le monde est colle, elle part sans cible.
            redShellMinTarget: 250,

            shroomBoost: 250,
            shroomDuration: 1500,

            starSpeedMultiplier: 1.4,
            // Duree fixe, identique quel que soit le rang.
            starDuration: 7500,

            // Banane lancee en cloche. La hauteur est un decalage de rendu en
            // pixels, sans effet sur la profondeur de piste.
            bananaLobDistance: 900,
            bananaLobDurationMs: 850,
            bananaLobHeight: 105,
            // Forme de l'arc. En dessous de 1, le sommet arrive plus tot et le
            // depart est plus vertical.
            bananaLobRise: 0.62,

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
            // Sursis entre le contact et la disparition : le sprite s'effacait
            // avant qu'on ait vu le choc. Sans danger pendant ce delai.
            itemLingerMs: 80,
            invincibilityAfterHit: 3000,
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
            leaderTier: { weights: { banana: 55, tripleBanana: 10, greenShell: 25, tripleGreenShell: 10, redShell: 0,  tripleRedShell: 0,  shroom: 0,  star: 0,  bill: 0  } },
            // Seuils d'etoile, cales sur les bornes de paliers ci-dessous : T4
            // s'ouvre a 2000 et T5 a 3000, si bien qu'un kart entrant dans un
            // palier porteur d'etoile y a droit immediatement, sans fenetre morte.
            starMinDistTop: 3000,
            starMinDistMid: 2000,
            // Delai d'ouverture de l'etoile, compte depuis le depart : les ecarts
            // du premier bloc d'objets ne veulent encore rien dire, une etoile
            // tiree la deciderait la course avant qu'elle commence.
            starMinRaceMs: 10000,
            tiers: [
                { maxDistance: 500,   weights: { banana: 31, tripleBanana: 12, greenShell: 25, tripleGreenShell: 12, redShell: 12, tripleRedShell: 8,  shroom: 0,  star: 0,  bill: 0  } },
                { maxDistance: 1000,  weights: { banana: 10, tripleBanana: 10, greenShell: 14, tripleGreenShell: 12, redShell: 26, tripleRedShell: 12, shroom: 16, star: 0,  bill: 0  } },
                { maxDistance: 2000,  weights: { banana: 5,  tripleBanana: 7,  greenShell: 8,  tripleGreenShell: 7,  redShell: 22, tripleRedShell: 8,  shroom: 40, star: 3,  bill: 0  } },
                // >>> REGLAGE DE TEST — bill gonfle sur les trois derniers paliers.
                // Valeurs de production a remettre telles quelles :
                //   T4  shroom: 42, star: 28, bill: 5
                //   T5  shroom: 43, star: 40, bill: 12
                //   T6  shroom: 20, star: 60, bill: 20
                { maxDistance: 3000,  weights: { banana: 0,  tripleBanana: 3,  greenShell: 3,  tripleGreenShell: 4,  redShell: 13, tripleRedShell: 2,  shroom: 32, star: 18, bill: 25 } },
                { maxDistance: 3500,  weights: { banana: 0,  tripleBanana: 0,  greenShell: 0,  tripleGreenShell: 0,  redShell: 5,  tripleRedShell: 0,  shroom: 25, star: 20, bill: 50 } },
                // Dernier palier : c'est aussi le repli quand aucune borne ne
                // correspond, il couvre donc tout au-dela de 3500. Un kart
                // decroche a ce point la n'a plus rien a defendre, seule
                // l'etoile le ramene dans la course.
                { maxDistance: 4000,  weights: { banana: 0,  tripleBanana: 0,  greenShell: 0,  tripleGreenShell: 0,  redShell: 0,  tripleRedShell: 0,  shroom: 15, star: 25, bill: 60 } }
                // <<< fin du reglage de test
            ]
        },
        // Carapace bleue. Elle ne sort pas des paliers de distribution : elle a
        // ses propres conditions, et reste rare par construction.
        blueShell: {
            // Ni le peloton de tete, ni le dernier.
            minRank: 5,
            maxRank: 7,

            // La chance court sur toute la course : nulle au depart, elle gagne
            // `chancePerLap` a chaque tour sans depasser `chanceCap`, et chaque
            // bleue lancee la coupe en deux.
            chancePerLap: 0.05,
            chanceCap: 0.15,
            chanceDecay: 2,

            // Trajet en ligne droite au milieu de la piste, au-dessus de tout.
            speed: 1500,
            // Hauteur en vol, puis une fois sur la cible.
            cruiseHop: 72,
            orbitHop: 118,
            catchDistance: 70,
            // Elle file tout droit sans cible, puis se verrouille sur le premier
            // a cette distance. Le verrou est definitif : c'est ce kart qu'elle
            // frappe, meme s'il se fait doubler avant l'impact.
            lockDistance: 800,
            // Au-dela, elle se verrouille sur le premier ou qu'il soit.
            maxCruiseMs: 9000,

            // Un tour autour de la cible, puis surplomb, puis chute.
            orbitTurns: 1,
            orbitMs: 800,
            orbitRadiusX: 85,
            orbitRadiusY: 4,
            hoverMs: 450,
            crashMs: 130,
            // Elle se poste devant le kart avant de plonger, puis pique encore
            // pendant la chute : en 130 ms il parcourt 65 unites, viser sa
            // position exacte reviendrait a lui tomber derriere.
            hoverLead: 48,
            crashLead: 95,

            // Dome qui s'etend depuis le point d'impact : chaque kart est touche
            // a l'instant ou le front l'atteint.
            blastRadiusX: 180,
            blastRadiusY: 8.5,
            blastMs: 300
        },

        // Eclair. Comme la bleue, il ne passe pas par les paliers : c'est l'objet
        // du decroche, pas celui du peloton. Il ne se lance pas sur quelqu'un,
        // il tombe sur toute la piste d'un coup.
        lightning: {
            // Les trois derniers, et seulement s'ils ont vraiment lache prise :
            // 2000 est la borne haute du T3, la condition se lit donc « au moins
            // T4 ». Un fond de peloton encore accroche n'y a pas droit.
            //
            // Cale a 3000 (« au moins T5 »), l'eclair ne sortait jamais : a cet
            // ecart le kart recoit 50 a 80 % de champignon ou d'etoile, soit
            // exactement ce qui le ramene sous le seuil. La fenetre se refermait
            // avant qu'une boite soit ramassee.
            lastRanks: 3,
            minDistance: 2000,
            chance: 0.12,

            // Pas avant ce tour. `leaderLap` compte a partir de 1, la course en
            // fait cinq : l'eclair s'ouvre donc a la mi-course. Les ecarts des
            // deux premiers tours sont encore ceux de la grille, pas ceux d'une
            // course — punir le peloton la-dessus n'aurait rien merite.
            minLap: 3,

            // Rythme de l'orage, en ms depuis le lancer. `strikeAt` est
            // l'instant unique ou tout arrive d'un coup : le ciel bascule dans le
            // noir, les eclairs tombent, et le malus s'applique. A zero, il n'y a
            // donc aucun temps de chargement — c'est une coupure franche, comme
            // la foudre. Le monter reintroduirait un ciel qui se charge avant la
            // frappe, mais l'assombrissement ne serait alors plus simultane des
            // eclairs. Le jour revient sur la fin de `totalMs`.
            strikeAt: 0,
            totalMs: 2600,

            // Malus. La vitesse est divisee et le kart reduit pour toute la duree.
            speedFactor: 0.5,
            scale: 0.5,

            // Duree du rapetissement, interpolee lineairement sur l'ecart au
            // premier. Le leader paie plein tarif, celui qui est deja largue s'en
            // sort vite : l'eclair vient du fond de grille, il n'a pas a enfoncer
            // ceux qui y sont deja. Au-dela de `shrinkFalloffDistance` c'est le
            // minimum pour tout le monde.
            shrinkMsMax: 8000,
            shrinkMsMin: 2000,
            shrinkFalloffDistance: 3500
        },

        // Bill Ball. Ce n'est pas un projectile : le kart lui-meme se transforme
        // et fonce au milieu de la piste, comme l'etoile est un etat et non un
        // objet lance. Tout est reglable ici, rien n'est en dur dans la physique.
        bill: {
            // Vitesse de croisiere, en multiple de la pointe du personnage —
            // meme unite que starSpeedMultiplier, et a garder au-dessus de lui
            // (1.4), sinon le bill se fait rattraper par ce qu'il double.
            //
            // Le baisser rallonge le vol pour de bon, et pas seulement a l'oeil :
            // moins vite veut dire moins de karts doubles par seconde, donc moins
            // de `overtakeCostMs` retires. Vitesse et duree sont liees par la.
            speedMultiplier: 1.65,

            // Marge minimale du bill sur la meilleure pointe qu'un autre objet
            // permet, tous personnages confondus : le multiplicateur ci-dessus
            // ne compare un kart qu'a lui-meme.
            minLeadRatio: 1.08,

            // Duree du vol. Chaque kart double la raccourcit de `overtakeCostMs`,
            // sans jamais tomber sous `minDurationMs` : le bill sert a remonter,
            // pas a prendre la tete et a s'y installer. Mettre `overtakeCostMs` a
            // 0 rend la duree fixe.
            durationMs: 7000,
            overtakeCostMs: 900,
            minDurationMs: 2000,

            // Retour au calme. La vitesse redescend lineairement de la vitesse de
            // croisiere a celle du kart sur cette duree ; le kart a deja repris sa
            // forme, il finit seulement sur son elan.
            slowdownMs: 1000,

            // Recentrage : le bill rejoint le milieu de la piste a cette vitesse,
            // en pourcents de profondeur par seconde, et n'en bouge plus.
            centerSpeed: 25,

            // Ce qu'il balaie au passage, a tenir en face de la taille dessinee.
            //
            // `x` est le long de la piste, le meme axe que la largeur du sprite a
            // l'ecran, et le monde est a l'echelle 1:1 du pixel : `x` vaut donc la
            // demi-largeur dessinee. A 198 % de la largeur d'un kart (soit 198 px),
            // 99 place le front de collision pile au bord du dessin. Toucher a la
            // taille du bill dans .kart-bill sans reporter la moitie ici casse cet
            // accord. Reference : kartVsKart vaut 60 pour un kart de 100 %.
            //
            // `y` est la profondeur de piste, pas la hauteur du sprite : les deux
            // n'ont aucun rapport, la profondeur etant portee par la position du
            // kart et non par son image. Il ne suit donc PAS l'agrandissement.
            // A 11 sur une piste de 30 de profond, le bill part du milieu et
            // balaie de 4 a 26 : les deux bords restent des refuges. Le doubler
            // couvrirait toute la piste et le rendrait inevitable.
            hitbox: { x: 99, y: 11 },

            // Deux bills ne se font aucun degat, mais ils partagent la voie du
            // milieu : ils se bousculent, a cette fraction de la poussee normale.
            // A 0, ils se traverseraient — le seul endroit du jeu ou deux karts
            // s'ignoreraient completement.
            pushFactor: 0.45
        },

        // Objets qu'un kart peut trainer derriere lui.
        trailableItems: ['banana', 'greenShell', 'redShell'],

        ai: {
            holdItemMin: 500, holdItemMax: 8000,

            // Un objet arrive en main, sans hitbox. Le kart decide ensuite, ou
            // non, de le sortir derriere lui.
            trailChance: 0.6,

            // Probabilite qu'une carapace parte vers l'arriere, par type et par
            // place. Le leader n'a personne devant, le dernier personne
            // derriere.
            shellBackwardChance: {
                greenShell: { leader: 0.9, pack: 0.2, last: 0.05 },
                redShell: { leader: 0.95, pack: 0.05, last: 0 }
            },

            // Banane lancee en cloche devant plutot que lachee derriere.
            bananaLobChance: { leader: 0, pack: 0.2, last: 0.7 },
            trailDelayMin: 400, trailDelayMax: 3000,
            trailHoldMin: 1200, trailHoldMax: 6000,
            dodgeIntensityMin: 20, dodgeIntensityMax: 50,

            // Perception : le seuil est un temps avant impact, non une distance.
            // Une carapace de face approche a plus du triple de la vitesse d'une
            // banane — a distance egale, le temps pour reagir n'a rien de
            // comparable. Le plafond evite de s'ecarter d'un objet hors ecran.
            //
            // La fenetre est divisee par le handling : un kart lourd repond plus
            // tard et se deporte moins vite, il lui faut anticiper d'autant.
            threatWindowMs: 900,
            threatMaxDistance: 900,

            // Un objet traine avance a la vitesse de son porteur : le temps
            // avant impact ne dit rien d'utile, c'est une distance de vue qu'il
            // faut. Largement au-dela de la hitbox de 40.
            trailThreatDistance: 260,

            // Accule au bord, un kart ne peut plus s'ecarter du bon cote : il
            // leve le pied. Face a un objet traine, ralentir suffit a ne plus le
            // rattraper.
            edgeBrakeFactor: 0.78,
            edgeBrakeMs: 700,

            // Traversee du mauvais cote : degagement a prendre au-dela de la
            // hitbox, et erreur d'appreciation du temps disponible.
            crossDodgeMargin: 2,
            crossJudgeError: 0.25,

            // Latence de reflexe, inversement proportionnelle au handling et
            // tiree au sort a chaque menace. Un kart peut aussi ne pas voir
            // l'objet, d'autant plus qu'il est lourd a manoeuvrer.
            // Visee : le kart se recale sur sa cible avant de tirer.
            // `aimErrorMax` est divise par le handling — la hitbox verticale
            // d'un objet valant 5, une erreur de cet ordre suffit a rater.
            aimLeadMs: 1300,
            aimScanDistance: 900,
            aimErrorMax: 3.5,
            aimSpeed: 12,

            reactionBaseMs: 280,
            reactionJitterMin: 0.8, reactionJitterMax: 1.35,

            // L'inattention n'est plein tarif que pour une esquive tout juste
            // jouable ; au-dela de dodgeEasyRatio fois la marge necessaire, le
            // tirage ne joue plus.
            dodgeMissChance: 0.1,
            dodgeEasyRatio: 2.5,
            overtakeDetectionRange: 120, overtakeMinDistance: 12, overtakeSideSpeed: 10,
            boxDetectionRange: 400, boxSeekIntensity: 25,
            wanderIntervalMin: 2000, wanderIntervalMax: 6000,
            wanderDurationMin: 500, wanderDurationMax: 1500, wanderSpeed: 4
        },
        // Distance dont un objet doit s'ecarter de son lanceur avant de pouvoir le
    // toucher : protege du lancer, sans immuniser pour autant.
    itemArmDistance: 110,

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
                backOffset: 120,
                rowGap: 155,
                colStagger: 80,
                lanes: [0.13, 0.66],
                laneSlope: 0.045
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

            // Le drapeau a damier sort bien plus tard que le repositionnement de
            // la camera : Lakitu ne se penche qu'a l'approche reelle du premier,
            // soit environ trois secondes avant son passage.
            flagDistance: 1400,

            // La camera n'accelere jamais : elle ne fait que ralentir pour se
            // garer pile quand le leader franchit la ligne, puis s'y bloque.
            //
            // C'est ce qui impose d'ouvrir l'approche deux tours avant la fin :
            // au pire elle doit couvrir un tour complet, soit 7680 unites, et a
            // sa vitesse normale il lui faut 30,7 s — exactement le temps que
            // met le leader a parcourir ces deux tours. A recalculer si
            // world.width, roadPPS ou la vitesse des karts changent.
            cameraApproachDistance: 15400,
            cameraMinSpeedRatio: 0.35,
            cameraMaxCatchupRatio: 1
        },

        // Cadence d'animation des carapaces, en ms par frame. Lu par la physique :
        // c'est elle qui fait avancer `currentFrame`, le client ne fait que
        // afficher la frame courante.
        itemAnim: {
            greenShell: { animSpeed: 100 },
            redShell: { animSpeed: 100 },
            blueShell: { animSpeed: 90 },
            bill: { animSpeed: 70 }
        }
    };
});
