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
        kartStats: {
            budget: 15,
            minPoints: 0,
            maxPoints: 10,

            mass:  { min: 0.72, max: 1.25 },
            force: { min: 0.85, max: 1.40 },
            grip:  { min: 0.85, max: 1.35 },

            massDragAccel: 0.60,
            accelClamp: { min: 0.75, max: 1.45 },

            massDragAgility: 0.90,
            agilityClamp: { min: 0.60, max: 1.70 },

            speedBase: 450,
            speedPerPower: 110,
            traction: { base: 0.65, gain: 0.70 },

            characters: {
                bowser: { weight: 9, power: 5, handling: 1 },
                dk:     { weight: 8, power: 5, handling: 2 },
                mario:  { weight: 5, power: 5, handling: 5 },
                luigi:  { weight: 4, power: 6, handling: 5 },
                yoshi:  { weight: 4, power: 4, handling: 7 },
                peach:  { weight: 3, power: 6, handling: 6 },
                toad:   { weight: 1, power: 6, handling: 8 },
                koopa:  { weight: 2, power: 4, handling: 9 }
            }
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
            momentumFloor: { base: 0.44, weightGain: 0 },
            momentumChangeSpeed: 0.25,
            momentumDriftMin: 3000,
            momentumDriftMax: 7000,
            accelerationRate: 150,

            projectileSpeed: 880,
            redShellSpeed: 840,
            redShellTrackingSpeed: 8,
            // Choix de cible de la rouge. Ces trois valeurs decrivent une pente,
            // pas un seuil : le classement des candidats se fait dans
            // redShellTargetScore(), cote physique.
            //
            // Plancher dur. En dessous, viser est sans effet : l'objet ne s'arme
            // qu'a `itemArmDistance` (110) du tireur et traverse tout avant. La
            // marge au-dessus de 110 couvre le cas ou la cible freine et vient
            // au-devant de la carapace avant qu'elle soit armee.
            redShellMinTarget: 150,

            // Au-dela, la rouge a tout le temps de se recaler : le candidat vaut
            // son ecart brut. Entre le plancher et ce confort, il reste eligible
            // mais penalise. Ce n'est pas la portee de la rouge, qui est infinie
            // — c'est la distance a partir de laquelle une cible est « facile ».
            redShellComfortTarget: 340,

            // Ce que coute au maximum d'etre au contact, en unites de distance
            // ajoutees a la note d'un candidat colle au plancher. Le monter fait
            // preferer les cibles lointaines et ramene le comportement d'avant ;
            // le baisser fait viser au plus pres a tout prix.
            redShellClosePenalty: 260,

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
        // Distribution des objets. Une seule mecanique pour tout le monde, bleue
        // comprise : cinq mesures normalisees entre 0 et 1 (p rang, d ecart au
        // premier, s etape de course, g ecart au kart de devant, i isolement du
        // peloton) donnent une pression unique :
        //
        //   pression = (rankShare * p + (1 - rankShare) * d)
        //            * (stageBoost.base + stageBoost.gain * s)
        //            * (packBoost.base  + packBoost.gain  * i)
        //
        // Les objets tactiques (banane, verte, rouge, champignon) suivent leurs
        // propres courbes sur p/d/s/g ; les objets puissants (etoile, bill,
        // eclair) ne lisent que la pression, avec un seuil d'ouverture chacun.
        // Ajouter un objet = une entree dans `items`, rien a renormaliser.
        itemDistribution: {
            // Unites monde. Un tour vaut world.width, ~500 u/s : 3500 ~= 7 s de
            // retard, la ou l'echelle sature.
            distanceRef: 3500,
            // Etalement du peloton et ecart au kart de devant, memes unites.
            spreadRef: 4000,
            gapRef: 1200,

            // Part de l'etalement global dans l'isolement, le reste allant a
            // l'ecart local (g).
            spreadShare: 0.65,

            // Part du rang dans la pression, le reste allant a l'ecart au premier.
            rankShare: 0.45,

            // Etape de course, effet leger : x0.85 au depart, x1.15 a l'arrivee.
            // Les verrous `minStage` de chaque objet decident du calendrier.
            stageBoost: { base: 0.85, gain: 0.30 },

            // Peloton, effet fort : x0.55 peloton colle, x1 course eclatee.
            packBoost: { base: 0.48, gain: 0.52 },

            // Poids de l'objet deja recu au ramassage precedent, multiplie par
            // ceci. A 1, neutralise.
            repeatPenalty: 0.4,

            // Profil de chaque objet : une courbe est une liste de facteurs
            // multiplies entre eux (1 quand absent) :
            //
            //   { rise: [a, b], floor: f }   f en a (0 par defaut), 1 en b
            //   { fall: [a, b], depth: p }   1 en a, 1 - p en b (p = 1 par defaut)
            //   { bell: c, width: w }        1 en c, 0 a c - w et c + w
            //
            // Courbes disponibles : `rank` (p), `dist` (d), `stage` (s), `gap` (g).
            // `packBonus` s'applique a tous : poids x (1 + packBonus * (1 - i)).
            //
            // Verrous, facultatifs, poids force a 0 hors condition :
            //   minStage, minRank, lastRanks, minDist, unique
            //
            // Decote, pour toute la course et non le seul porteur :
            //   decay        chaque exemplaire distribue multiplie par ceci le
            //                poids du suivant
            //   regenPerLap  ce que la decote regagne par tour du premier
            items: {
                // --- Objets tactiques -------------------------------------
                // Seuls ceux-la restent non nuls en p = 0 : le premier n'a que
                // banane et verte.

                // Objet de tete : decroit avec le rang, chute avec l'ecart sans
                // s'annuler (depth 0.90 laisse un dixieme du poids).
                banana: {
                    base: 100,
                    rank:  [{ fall: [0, 1], depth: 0.80 }],
                    dist:  [{ fall: [0, 0.50], depth: 0.85 }, { fall: [0.45, 0.75], depth: 0.90 }],
                    stage: [{ fall: [0, 1], depth: 0.25 }],
                    packBonus: 0.30
                },

                // Culmine en deuxieme/troisieme. Meme traitement que la banane
                // a grand ecart.
                greenShell: {
                    base: 95,
                    rank:  [{ rise: [0, 0.30], floor: 0.55 }, { fall: [0.30, 1], depth: 0.55 }],
                    dist:  [{ fall: [0, 0.55], depth: 0.80 }, { fall: [0.50, 0.82], depth: 0.90 }],
                    stage: [{ fall: [0, 1], depth: 0.20 }],
                    packBonus: 0.35
                },

                // Nul pour le premier. Cible le kart de rang superieur, donc
                // `gap` commande ; `dist` ne garde qu'un role de fond.
                redShell: {
                    base: 95,
                    rank:  [{ rise: [0, 0.14] }, { fall: [0.55, 1], depth: 0.45 }],
                    dist:  [{ bell: 0.35, width: 0.72 }],
                    gap:   [{ fall: [0.55, 1.20] }],
                    packBonus: 0.20
                },

                // Seul objet de remontee sans condition d'etape. Plancher d'ecart
                // pour rester present en peloton colle, s'efface a tres grand
                // ecart.
                shroom: {
                    base: 70,
                    rank:  [{ rise: [0, 0.14] }],
                    dist:  [{ rise: [0, 0.45], floor: 0.30 }, { fall: [0.70, 1], depth: 0.55 }],
                    packBonus: 0.45
                },

                // --- Objets puissants -------------------------------------
                // Trois seuils decales sur la meme pression. `minStage` tient le
                // calendrier : rien au tour 1, etoile au tour 2, bill et eclair
                // a partir du tour 3.

                star: {
                    base: 58,
                    power: { open: 0.28, full: 0.66 },
                    minStage: 0.20,
                    minRank: 2
                },

                bill: {
                    base: 34,
                    power: { open: 0.45, full: 0.86 },
                    minStage: 0.40,
                    minRank: 4,
                    minDist: 0.30
                },

                // Tombe sur toute la piste, ne vise personne. Un seul en
                // circulation, jamais pendant un orage. Decote un peu plus
                // severe que la bleue (0.35 contre 0.45).
                lightning: {
                    // Releve pour compenser le reflux ci-dessous : sans ca,
                    // ecreter le dernier tour reduirait le nombre d'orages par
                    // course au lieu de les redistribuer. Cale sur une mesure :
                    // a 24 le banc rendait 0.38 orage par course contre 0.55
                    // avant le reflux, d'ou ce nouveau palier.
                    base: 35,
                    power: { open: 0.58, full: 0.95 },
                    minStage: 0.45,
                    lastRanks: 3,
                    minDist: 0.40,
                    unique: true,
                    decay: 0.35,
                    regenPerLap: 0.25,

                    // Reflux marque : sans lui, pres des deux tiers des orages
                    // tombaient au dernier tour. La profondeur est forte, mais
                    // elle ne mord que sur les 28 derniers pourcents de la
                    // course — avant `from`, rien n'est touche.
                    lateFade: { from: 0.72, to: 1.00, depth: 0.95 }
                },

                // --- Triples (desactives, voir disabledItems) --------------
                // Defensifs : pesent en tete et milieu de peloton, s'effacent a
                // l'arriere.
                tripleBanana: {
                    base: 40,
                    rank:  [{ fall: [0.30, 1], depth: 0.90 }],
                    dist:  [{ fall: [0, 0.55], depth: 0.85 }, { fall: [0.55, 0.90] }],
                    stage: [{ fall: [0, 1], depth: 0.25 }],
                    packBonus: 0.30
                },
                tripleGreenShell: {
                    base: 40,
                    rank:  [{ rise: [0, 0.15], floor: 0.50 }, { fall: [0.35, 0.85] }],
                    dist:  [{ fall: [0, 0.60], depth: 0.80 }, { fall: [0.60, 0.95] }],
                    stage: [{ fall: [0, 1], depth: 0.20 }],
                    packBonus: 0.35
                },
                tripleRedShell: {
                    base: 40,
                    rank:  [{ rise: [0, 0.14] }, { fall: [0.60, 1], depth: 0.60 }],
                    dist:  [{ bell: 0.35, width: 0.55 }],
                    packBonus: 0.20
                }
            }
        },
        // Carapace bleue : tirage a part, joue avant les poids de
        // itemDistribution. Declenchee par l'echappee du premier, pas par
        // l'ecart du tireur.
        //
        //   chance = baseChance * montee(stageWindow)
        //          * (leadFloor + leadGain * echappee) * poids de rang * decote
        blueShell: {
            baseChance: 0.14,

            // Nulle avant, pleine apres : les ecarts des deux premiers tours sont
            // encore ceux de la grille. La borne haute est calee sur le
            // quatrieme tour et non sur l'arrivee, pour que le pic de
            // probabilite tombe la plutot qu'au dernier tour.
            stageWindow: { from: 0.35, to: 0.75 },

            // Reflux de fin de course, meme mecanique que pour l'eclair. Plus
            // doux ici : la bleue penchait moins vers le dernier tour, sa montee
            // n'etant pas portee par la pression mais par l'echappee du premier.
            lateFade: { from: 0.72, to: 1.00, depth: 0.30 },

            // Echappee du premier sur le deuxieme, rapportee a leadRef.
            leadRef: 2200,
            leadFloor: 0.30,
            leadGain: 0.95,

            // Poids par rang ; absent = jamais de bleue.
            rankWeights: { 3: 0.65, 4: 0.65, 5: 1.00, 6: 1.00, 7: 0.75 },

            // Chaque bleue lancee multiplie la chance par `decay`, regagnee
            // ensuite de `regenPerLap` a chaque tour du premier.
            decay: 0.45,
            regenPerLap: 0.30,

            // Garde-fou dur : jamais deux bleues coup sur coup.
            cooldownMs: 12000,

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

        // Eclair : conditions de sortie dans itemDistribution.items.lightning.
        // Ici, seulement ce qui suit le lancer.
        lightning: {
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
            // non, de le sortir derriere lui. Le premier le fait presque
            // toujours : n'ayant personne a viser, son objet vaut mieux comme
            // bouclier que dans sa main. Le dernier a l'inverse n'a personne
            // derriere a tenir a distance, un objet pose ne lui sert a rien.
            trailChance: { leader: 0.92, pack: 0.6, last: 0.45 },

            // Duree pendant laquelle l'objet reste pose derriere, en multiple de
            // trailHoldMin/Max. Le premier le garde bien plus longtemps : c'est
            // sa seule protection, et le relacher tot le laisse a nu jusqu'a la
            // boite suivante — soit la moitie d'un tour.
            trailHoldFactor: { leader: 1.8, pack: 1, last: 1 },

            // Probabilite qu'une carapace parte vers l'arriere, par type et par
            // place. Le dernier n'a personne derriere. Le premier est a 1 et le
            // restera : la physique lui interdit de tirer devant lui, ces
            // valeurs ne font que dire la meme chose au meme endroit que les
            // autres.
            shellBackwardChance: {
                greenShell: { leader: 1, pack: 0.2, last: 0.05 },
                redShell: { leader: 1, pack: 0.05, last: 0 }
            },

            // Banane lancee en cloche devant plutot que lachee derriere.
            bananaLobChance: { leader: 0, pack: 0.2, last: 0.7 },
            trailDelayMin: 400, trailDelayMax: 3000,
            trailHoldMin: 1200, trailHoldMax: 6000,

            // Agressivite : un kart mal place joue ses objets plus vite et les
            // garde moins derriere lui. Rang et ecart comptent ensemble, par
            // moyenne geometrique — dernier dans le peloton, ou deuxieme a une
            // demi-piste, ne suffit pas ; il faut les deux. L'etape de course
            // module ensuite le tout : c'est le temps qui reste pour remonter.
            aggression: {
                // Ecart au premier ou le terme distance sature, meme ordre que
                // les paliers d'objets.
                distanceRef: 3000,

                // Part de l'agressivite qui s'exprime au depart. Elle atteint sa
                // pleine valeur au dernier tour, et ne la depasse jamais : etre
                // dernier ne presse a rien tant qu'il reste quatre tours pour
                // revenir.
                startRatio: 0.3,

                // Delais d'attente et probabilite de trainer l'objet, en
                // fraction de leur valeur normale, pour un kart au maximum de
                // son agressivite.
                hurryRatio: 0.35,
                trailRatio: 0.4
            },
            dodgeIntensityMin: 20, dodgeIntensityMax: 50,

            // Perception : le seuil est un temps avant impact, non une distance.
            // Une carapace de face approche a plus du triple de la vitesse d'une
            // banane — a distance egale, le temps pour reagir n'a rien de
            // comparable. Le plafond evite de s'ecarter d'un objet hors ecran.
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

            // Latence de reflexe, tiree au sort a chaque menace.
            reactionBaseMs: 280,
            reactionJitterMin: 0.8, reactionJitterMax: 1.35,

            // Visee : le kart se recale sur sa cible avant de tirer. La hitbox
            // verticale d'un objet valant 5, une erreur de cet ordre suffit a
            // rater.
            aimLeadMs: 1300,
            aimScanDistance: 900,
            aimErrorMax: 3.5,
            aimSpeed: 12,

            // L'inattention n'est plein tarif que pour une esquive tout juste
            // jouable ; au-dela de dodgeEasyRatio fois la marge necessaire, le
            // tirage ne joue plus.
            dodgeMissChance: 0.1,
            dodgeEasyRatio: 2.5,

            overtakeDetectionRange: 120, overtakeMinDistance: 12, overtakeSideSpeed: 10,
            // Ecart en deca duquel la boite est consideree dans l'axe : le kart
            // tient sa ligne au lieu de la corriger.
            boxDetectionRange: 400, boxSeekIntensity: 25, boxAlignTolerance: 2,
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
        // Grand prix : les courses s'enchainent par blocs de `races`, chacune
        // rapportant les points de `points` selon la place a l'arrivee. Le bloc
        // fini, les scores repartent de zero et la grille est tiree au sort.
        grandPrix: {
            races: 4,
            // Indexe par place d'arrivee, du premier au dernier. Une place
            // au-dela de ce tableau ne rapporte rien : allonger la liste suffit
            // pour un plateau plus grand.
            points: [10, 8, 6, 5, 4, 3, 2, 1]
        },

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

            // La course s'arrete des que ce nombre de karts a franchi la ligne :
            // les retardataires sont classes d'office dans l'ordre ou ils
            // roulent. Attendre le dernier ne montrait qu'un kart seul en piste.
            stopAtFinisher: 7,

            // Duree du tableau des scores : la premiere valeur entre deux
            // courses, la seconde apres la derniere du grand prix, ou il faut
            // le temps de lire le classement general. L'animation du tableau
            // (arrivee -> compteur -> remaniement, cf smk-banner.js) prend
            // deja plus de 5s a elle seule, d'ou la marge laissee ici pour
            // encore admirer le resultat une fois pose.
            resultsDelayMs: 10000,
            finalResultsDelayMs: 20000,

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
