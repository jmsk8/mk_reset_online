// Les objets : lesquels existent, qui les tire, ce qu'ils font.

export default {
    // Objets retires du jeu : un type liste ici voit son poids force a 0 dans
    // tous les paliers, le reste du palier etant renormalise. Les trois triples
    // sont en place et testes — vider cette liste suffit a les remettre en jeu.
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
    // coordonnees monde (px pour radiusX, pourcentage de route pour radiusY) donc
    // identiques PC et mobile, la mise a l'echelle mobile s'appliquant deja au
    // conteneur entier.
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
    // premier, s etape de course, g ecart au kart de devant, i isolement) donnent
    // une pression unique :
    //
    //     pression = (rankShare * p + (1 - rankShare) * d) * (stageBoost.base +
    //              stageBoost.gain * s) * (packBoost.base + packBoost.gain * i)
    //
    // Les objets tactiques (banane, verte, rouge, champignon) suivent leurs
    // propres courbes sur p/d/s/g ; les objets puissants (etoile, bill, eclair)
    // ne lisent que la pression, avec un seuil d'ouverture chacun. Ajouter un
    // objet = une entree dans `items`, rien a renormaliser.
    itemDistribution: {
        // Unites monde. Un tour vaut world.width, ~500 u/s : 3500 ~= 7 s de
        // retard, la ou l'echelle sature.
        distanceRef: 3500,
        // Etalement du peloton et ecart au kart de devant, memes unites.
        spreadRef: 4000,
        gapRef: 1200,

        // Part de l'etalement global dans l'isolement, le reste allant a l'ecart
        // local (g).
        spreadShare: 0.65,

        // Part du rang dans la pression, le reste allant a l'ecart au premier.
        rankShare: 0.45,

        // Etape de course, effet leger : x0.85 au depart, x1.15 a l'arrivee. Les
        // verrous `minStage` de chaque objet decident du calendrier.
        stageBoost: { base: 0.85, gain: 0.30 },

        // Peloton, effet fort : x0.55 peloton colle, x1 course eclatee.
        packBoost: { base: 0.48, gain: 0.52 },

        // Poids de l'objet deja recu au ramassage precedent, multiplie par ceci.
        // A 1, neutralise.
        repeatPenalty: 0.4,

        // Profil de chaque objet. Une courbe est une liste de facteurs multiplies
        // entre eux (1 quand absent) :
        //
        //     { rise: [a, b], floor: f } f en a (0 par defaut), 1 en b
        //     { fall: [a, b], depth: p } 1 en a, 1 - p en b (p = 1 par defaut)
        //     { bell: c, width: w } 1 en c, 0 a c - w et c + w
        //
        // Courbes disponibles : `rank` (p), `dist` (d), `stage` (s), `gap` (g).
        // `packBonus` s'applique a tous : poids x (1 + packBonus * (1 - i)).
        //
        // Verrous facultatifs, poids force a 0 hors condition : minStage,
        // minRank, lastRanks, minDist, unique.
        //
        // Decote, pour toute la course et non le seul porteur : `decay` (chaque
        // exemplaire distribue multiplie par ceci le poids du suivant) et
        // `regenPerLap` (ce que la decote regagne par tour du premier).
        items: {
            // --- Objets tactiques ------------------------------------- Seuls
            // ceux-la restent non nuls en p = 0 : le premier n'a que banane et
            // verte.

            // Objet de tete : decroit avec le rang, chute avec l'ecart sans
            // s'annuler (depth 0.90 laisse un dixieme du poids).
            banana: {
                base: 100,
                rank:  [{ fall: [0, 1], depth: 0.80 }],
                dist:  [{ fall: [0, 0.50], depth: 0.85 }, { fall: [0.45, 0.75], depth: 0.90 }],
                stage: [{ fall: [0, 1], depth: 0.25 }],
                packBonus: 0.30
            },

            // Culmine en deuxieme/troisieme. Meme traitement que la banane a
            // grand ecart.
            greenShell: {
                base: 95,
                rank:  [{ rise: [0, 0.30], floor: 0.55 }, { fall: [0.30, 1], depth: 0.55 }],
                dist:  [{ fall: [0, 0.55], depth: 0.80 }, { fall: [0.50, 0.82], depth: 0.90 }],
                stage: [{ fall: [0, 1], depth: 0.20 }],
                packBonus: 0.35
            },

            // Nul pour le premier. Cible le kart de rang superieur, donc `gap`
            // commande ; `dist` ne garde qu'un role de fond.
            redShell: {
                base: 95,
                rank:  [{ rise: [0, 0.14] }, { fall: [0.55, 1], depth: 0.45 }],
                dist:  [{ bell: 0.35, width: 0.72 }],
                gap:   [{ fall: [0.55, 1.20] }],
                packBonus: 0.20
            },

            // Seul objet de remontee sans condition d'etape. Plancher d'ecart
            // pour rester present en peloton colle, s'efface a tres grand ecart.
            shroom: {
                base: 70,
                rank:  [{ rise: [0, 0.14] }],
                dist:  [{ rise: [0, 0.45], floor: 0.30 }, { fall: [0.70, 1], depth: 0.55 }],
                packBonus: 0.45
            },

            // --- Objets puissants ------------------------------------- Trois
            // seuils decales sur la meme pression. `minStage` tient le calendrier
            // : rien au tour 1, etoile au tour 2, bill et eclair a partir du tour
            // 3.

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

            // Tombe sur toute la piste, ne vise personne. Un seul en circulation,
            // jamais pendant un orage. Decote un peu plus severe que la bleue
            // (0.35 contre 0.45).
            lightning: {
                // Releve pour compenser le reflux ci-dessous : sans ca, ecreter
                // le dernier tour reduirait le nombre d'orages par course au lieu
                // de les redistribuer.
                base: 35,
                power: { open: 0.58, full: 0.95 },
                minStage: 0.45,
                lastRanks: 3,
                minDist: 0.40,
                unique: true,
                decay: 0.35,
                regenPerLap: 0.25,

                // Reflux marque : sans lui, pres des deux tiers des orages
                // tombaient au dernier tour. La profondeur est forte mais ne mord
                // que sur les 28 derniers pourcents.
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

    // Carapace bleue : tirage a part, joue avant les poids de itemDistribution.
    // Declenchee par l'echappee du premier, pas par l'ecart du tireur.
    //
    //     chance = baseChance * montee(stageWindow) * (leadFloor + leadGain *
    //            echappee) * poids de rang * decote
    blueShell: {
        baseChance: 0.14,

        // Nulle avant, pleine apres : les ecarts des deux premiers tours sont
        // encore ceux de la grille. La borne haute est calee sur le quatrieme
        // tour et non sur l'arrivee, pour que le pic de probabilite tombe la
        // plutot qu'au dernier tour.
        stageWindow: { from: 0.35, to: 0.75 },

        // Reflux de fin de course, meme mecanique que pour l'eclair. Plus doux
        // ici : la bleue penchait moins vers le dernier tour, sa montee n'etant
        // pas portee par la pression mais par l'echappee du premier.
        lateFade: { from: 0.72, to: 1.00, depth: 0.30 },

        // Echappee du premier sur le deuxieme, rapportee a leadRef.
        leadRef: 2200,
        leadFloor: 0.30,
        leadGain: 0.95,

        // Poids par rang ; absent = jamais de bleue.
        rankWeights: { 3: 0.65, 4: 0.65, 5: 1.00, 6: 1.00, 7: 0.75 },

        // Chaque bleue lancee multiplie la chance par `decay`, regagnee ensuite
        // de `regenPerLap` a chaque tour du premier.
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
        // Elle file tout droit sans cible, puis se verrouille sur le premier a
        // cette distance. Le verrou est definitif : c'est ce kart qu'elle frappe,
        // meme s'il se fait doubler avant l'impact.
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
        // Ou le souffle se centre, en unites DEVANT le kart vise : la bleue se
        // poste a `hoverLead`, puis pique en avant jusqu'a `crashLead`.
        //
        // Ce sont des placements, pas des compensations : la bleue SUIT sa cible,
        // `updateBlueShell` recalculant sa position depuis `target.worldX` a
        // chaque pas.
        //
        // Le kart de reference a 37.5 unites de demi-longueur, donc a 55 le
        // souffle se centre 17.5 unites devant son pare-chocs — sur le nez. Plus
        // haut, l'explosion se lit comme un tir manque tombe devant le kart.
        // C'est presque le plancher : il ne reste que 7 unites de piquer, en
        // descendre demande de baisser `hoverLead` avec, sinon le mouvement
        // s'inverse.
        //
        // La cible est touchee de toute facon. Ce que ce chiffre decide, c'est
        // QUI D'AUTRE le dome emporte : a 55, sa portee de 180 couvre 235 unites
        // devant la cible et 125 derriere. Le poursuivant colle est plus expose,
        // celui qui s'echappe devant l'est moins.
        hoverLead: 48,
        crashLead: 55,

        // Dome qui s'etend depuis le point d'impact : chaque kart est touche a
        // l'instant ou le front l'atteint.
        blastRadiusX: 180,
        blastRadiusY: 8.5,
        blastMs: 300
    },

    // Eclair : conditions de sortie dans itemDistribution.items.lightning. Ici,
    // seulement ce qui suit le lancer.
    lightning: {
        // Rythme de l'orage, en ms depuis le lancer. `strikeAt` est l'instant
        // unique ou tout arrive d'un coup : le ciel bascule dans le noir, les
        // eclairs tombent, le malus s'applique. A zero il n'y a aucun chargement
        // — une coupure franche, comme la foudre. Le jour revient sur la fin de
        // `totalMs`.
        strikeAt: 0,
        totalMs: 2600,

        // Malus. La vitesse est divisee et le kart reduit pour toute la duree.
        speedFactor: 0.5,
        scale: 0.5,

        // Duree du rapetissement. Le leader paie plein tarif, celui qui est deja
        // largue s'en sort vite : l'eclair vient du fond de grille, il n'a pas a
        // enfoncer ceux qui y sont deja. Les deux bornes sont atteintes quoi
        // qu'on regle en dessous.
        shrinkMsMax: 10000,
        shrinkMsMin: 2000,

        // Ecart au premier a partir duquel on ne paie plus que le minimum.
        shrinkFalloffDistance: 3500,

        // Un kart rapetisse passe SOUS un kart reste normal : il ne se fait pas
        // bousculer, il se fait rouler dessus. Seul contact du jeu ou les deux
        // karts ne s'echangent rien — tout le prix est dans l'etat qui suit.
        //
        // Une etoile ou un bill n'ecrasent pas : ils blessent, et le petit part
        // en tete-a-queue. Ecraser est une affaire de gabarit, pas de puissance.
        //
        // Duree PREVUE et non ferme : l'aplatissement s'arrete a la fin du
        // rapetissement s'il tombe avant — redevenir grand rend sa forme au kart.
        // Mais il ne peut plus tomber a zero, cf. `crushHoldMs`.
        flatMs: 3000,

        // Se faire rouler dessus se voit et se paie, meme au dernier moment :
        // temps FERME, que le rapetissement soit sur le point de finir ou non.
        // Ecrase a deux dixiemes de la fin, le kart etait aplati deux dixiemes —
        // c'est-a-dire pas du tout.
        //
        // Ce que ca renverse : quand le rapetissement devait finir pendant ces
        // 1.5 s, il attend, et le kart retrouve sa taille pleine d'un coup en se
        // relevant. A 0, on retrouve le comportement d'avant.
        crushHoldMs: 1500,

        // Ce que coute d'etre aplati, en facteur de vitesse. Il s'applique
        // par-dessus tout le reste, `speedFactor` compris : un kart a la fois
        // petit et aplati roule a 0.5 * 0.9. Ca ne l'arrete pas — c'est un kart
        // qui traine, pas un kart en panne.
        flatSpeedFactor: 0.9,

        // Ce qui decide entre les deux bornes : la part du RANG face a celle de
        // la DISTANCE, entre 0 et 1.
        //
        // A 0 seul l'ecart compte, et mener ne coute rien de plus qu'etre
        // deuxieme a un cheveu. A 1 seule la place compte, et un premier avec un
        // tour d'avance paie autant qu'un premier talonne.
        //
        // Entre les deux, chaque place gagnee vaut d'office `(shrinkMsMax -
        // shrinkMsMin) * shrinkRankWeight / (places - 1)` de malus, ecart nul ou
        // pas : 400 ms par place a 0.35 et huit karts. Assez pour que mener se
        // paie, trop peu pour effacer un ecart reel.
        shrinkRankWeight: 0.35
    },

    // Bill Ball. Ce n'est pas un projectile : le kart lui-meme se transforme et
    // fonce au milieu de la piste, comme l'etoile est un etat et non un objet
    // lance. Tout est reglable ici, rien n'est en dur dans la physique.
    bill: {
        // Sa vitesse de croisiere et sa montee vivent avec celles des deux autres
        // objets, dans `speeds.boosts.bill` : les trois ne se reglent qu'en les
        // comparant. Ce qui reste ici n'appartient qu'au bill.
        //
        // A savoir : baisser la vitesse rallonge le vol pour de bon. Moins vite
        // veut dire moins de karts doubles par seconde, donc moins de
        // `overtakeCostMs` retires.

        // Marge minimale du bill sur la meilleure pointe qu'un autre objet
        // permet, tous personnages confondus : son multiplicateur ne le compare
        // qu'a lui-meme.
        minLeadRatio: 1.08,

        // Duree du vol. Chaque kart double la raccourcit de `overtakeCostMs`,
        // sans jamais tomber sous `minDurationMs` : le bill sert a remonter, pas
        // a prendre la tete et a s'y installer. Mettre `overtakeCostMs` a 0 rend
        // la duree fixe.
        durationMs: 7000,
        overtakeCostMs: 800,
        minDurationMs: 3000,

        // Retour au calme. La vitesse redescend lineairement de la vitesse de
        // croisiere a celle du kart sur cette duree ; le kart a deja repris sa
        // forme, il finit seulement sur son elan.
        slowdownMs: 1000,

        // Recentrage : le bill rejoint le milieu de la piste a cette vitesse, en
        // pourcents de profondeur par seconde, et n'en bouge plus.
        centerSpeed: 25,

        // Ce qu'il balaie au passage, a tenir en face de la taille dessinee.
        //
        // `x` est le long de la piste, meme axe que la largeur du sprite, et le
        // monde est a l'echelle 1:1 du pixel : `x` vaut donc la demi-largeur
        // dessinee. A 198 % de la largeur d'un kart, 99 place le front de
        // collision pile au bord du dessin — toucher a `.kart-bill` sans reporter
        // la moitie ici casse cet accord.
        //
        // `y` est la profondeur de piste et non la hauteur du sprite : les deux
        // n'ont aucun rapport, et `y` ne suit donc PAS l'agrandissement. A 11, le
        // bill balaie de 4 a 26 sur une piste de 30 : les deux bords restent des
        // refuges. Le doubler le rendrait inevitable.
        hitbox: { x: 99, y: 11 },

        // Degagement pris pour contourner un pipe, au-dela de la hitbox. Le bill
        // ne manoeuvre pas, il devie : juste ce qu'il faut pour passer a cote, et
        // il revient au milieu aussitot apres.
        pipeClearance: 3,

        // Un bill ne fait aucun degat a un autre intouchable — bill ou etoile —
        // mais il partage la voie du milieu avec lui : ils se bousculent, a cette
        // fraction de la poussee normale. A 0 ils se traverseraient, seul endroit
        // du jeu ou deux karts s'ignoreraient completement.
        //
        // C'est le SEUL contact qu'un intouchable ressent.
        pushFactor: 0.45
    },

    // Objets qu'un kart peut trainer derriere lui.
    trailableItems: ['banana', 'greenShell', 'redShell'],

    // Distance dont un objet doit s'ecarter de son lanceur avant de pouvoir le
    // toucher : protege du lancer, sans immuniser pour autant.
    itemArmDistance: 110,

    // Cadence d'animation des carapaces, en ms par frame. Lu par la physique :
    // c'est elle qui fait avancer `currentFrame`, le client ne fait que afficher
    // la frame courante.
    itemAnim: {
        greenShell: { animSpeed: 100 },
        redShell: { animSpeed: 100 },
        blueShell: { animSpeed: 90 },
        bill: { animSpeed: 70 }
    }
};
