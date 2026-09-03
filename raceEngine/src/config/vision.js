// La vue : jusqu'ou un kart regarde, ce qui lui bouche la vue, ce qu'il en
// retient.

export default {
    // Un kart ne reagit qu'a ce qu'il voit, ne regarde qu'un cote a la fois, et
    // un corps solide lui bouche la vue. Ce qu'il FAIT de ce qu'il voit se regle
    // dans `ai`.
    vision: {
        // Portee du regard, en px de monde. Identique pour tout le plateau :
        // personne ne voit plus loin que son voisin, seul le SENS du regard
        // varie.
        //
        // L'avant vaut `pipe.seeDistance` — inutile de voir un objet au-dela de
        // l'obstacle qui commande deja la trajectoire. Au-dela de 1400 les karts
        // slaloment pour des murs qu'ils n'atteindront jamais.
        range: { front: 1400, back: 1000 },

        // Bande de profondeur ou un objet est tenu pour etant sur la route, donc
        // a surveiller. Plus large que le DEGAGEMENT (`hitboxes.itemVsKart.y` +
        // `ai.crossDodgeMargin` = 7) : kart et objet bougent pendant le temps
        // avant impact, et une esquive doit commencer avant d'etre pile dans
        // l'axe. La resserrer au degagement rend les objets traines inevitables.
        threatLane: 12,

        // Periode du balayage. Inutile de percevoir a la cadence de l'affichage :
        // le reflexe le plus court du plateau dure 224 ms. La phase est decalee
        // par `kart.id`, donc un ou deux karts balayent par frame. Le pilotage,
        // lui, reste a cadence pleine — `steer` est un filtre, le
        // sous-echantillonner ferait trembler le volant.
        scanIntervalMs: 80,

        // Seuls les corps solides masquent : kart, bill, tuyau. Un objet au sol
        // ferme un passage, il n'aveugle pas.
        //
        // Le kart regarde depuis LA CAMERA qui le suit, pas depuis son pare-brise
        // : l'IA et le spectateur voient alors la meme chose, et une ombre cesse
        // d'etre infinie. Un corps de hauteur Hk vu d'un oeil a hauteur H et
        // distance D porte son ombre sur `D * Hk / (H - Hk)` ; les hauteurs
        // n'apparaissent que par ce rapport, d'ou `run`.
        eye: {
            // Recul de la camera derriere le kart, en px monde. Il fixe l'ECHELLE
            // de l'occlusion : un corps a `look` px du kart est a `look + back`
            // de l'oeil, d'ou la largeur de son ombre (`1 / de`) et sa portee
            // (`de * run`). La forme du cone n'en depend pas, seulement la
            // longueur. A 0, un corps colle redevient un mur.
            back: 125,

            // Longueur de l'ombre, en fraction de la distance a l'oeil. C'est la
            // hauteur de camera dite par son seul effet visible : `H / Hk = 1 +
            // 1/run`. La MONTER baisse l'occlusion.
            //
            //     0 vue de dessus, plus rien ne masque
            //     0.35 camera a pres de quatre hauteurs de kart
            //     1 deux hauteurs : l'ombre double la distance
            //
            // Une seule valeur pour tous les corps. Un tuyau est plus haut et
            // devrait porter plus loin ; le jour ou ca se voit, c'est une
            // propriete par corps.
            run: 0.35
        },

        // Multiplie la demi-profondeur reelle du corps, en largeur seulement. A 1
        // l'ombre part exactement du gabarit — la projection depuis l'oeil
        // produit deja l'elargissement avec la distance, le doubler le compterait
        // deux fois.
        shadowGain: 1.0,

        // Une rouge arrive dans l'axe et par l'arriere, donc masquee par le kart
        // qu'elle suit : soumise a l'occlusion, elle serait inevitable. Dans le
        // jeu d'origine c'est le son qui previent. Le tirage d'inattention
        // (`ai.dodgeMissChance`) garde sa part de hasard.
        seeHomingThroughCover: true,

        // Regarder derriere SUBSTITUE la vue arriere a la vue avant : le kart y
        // gagne ce qui le rattrape et y perd le trafic devant.
        //
        // Les tuyaux echappent a la regle — un pilote connait son circuit. Le
        // coup d'oeil retire la perception du TRAFIC, pas la memoire du DECOR.
        //
        // Cadence a laquelle il se demande s'il regarde derriere.
        glanceIntervalMs: 1150,

        // Combien de temps la tete reste tournee, tire au sort. Il faut de quoi
        // CONSTATER : un objet qui rattrape n'existe que pendant le coup d'oeil.
        // Le tirage desynchronise aussi les retours de tete. Pendant ce temps le
        // trafic devant n'existe pas — monter le maximum rend les karts plus surs
        // derriere et plus betes devant.
        glanceDurationMin: 500,
        glanceDurationMax: 1200,

        // Probabilite de tourner la tete, par place. Le premier n'a plus que
        // l'arriere a surveiller ; le peloton a tout devant lui a jouer ; le
        // dernier n'a personne derriere.
        backChance: { leader: 0.30, pack: 0.10, last: 0.04 },

        // Il vient de traverser une zone de boites : celui qui le suit vient
        // peut-etre d'y prendre de quoi le toucher. La fenetre s'ouvre au PASSAGE
        // de la zone et non a la reception de l'objet — il y a `delays.itemGrant`
        // (3 s) entre les deux, et les objets triples ne passent pas par le meme
        // chemin.
        //
        // Ne s'ajoute pas a `backChance` : la remplace quand elle est plus haute
        // (cf. `updateGlance`).
        backChanceBox: { leader: 0.50, pack: 0.30, last: 0.10 },
        boxGlanceMs: 4000,

        // Il a VU le danger ; la surveillance tient tant que le souvenir est
        // frais (`pressureMemoryMs`). Remplace les precedentes plutot que de s'y
        // ajouter.
        //
        // A calibrer sur l'attente moyenne d'un coup d'oeil — `glanceIntervalMs /
        // chance` — et non sur le seul intervalle : a 0.40 elle valait 2875 ms,
        // plus long que la memoire, et le kart oubliait ce qui le suivait.
        backChanceDanger: { leader: 0.70, pack: 0.65, last: 0.65 },

        // Une etoile ou un bill arrive derriere. La seule des quatre qui ne
        // demande pas d'avoir deja regarde : les autres se nourrissent d'une
        // observation, or on n'observe l'arriere qu'en s'y etant tourne (cf.
        // `ramNoise`).
        //
        // Meme justification que `seeHomingThroughCover` : dans le jeu d'origine,
        // ces deux-la s'ENTENDENT. Ca fait tourner la tete, rien de plus —
        // occlusion, reflexe et inattention s'appliquent ensuite, et le kart peut
        // voir l'etoile et la prendre quand meme. Meme valeur pour le dernier :
        // le bruit ne depend pas du rang.
        backChanceRam: { leader: 0.85, pack: 0.85, last: 0.85 },

        // Quelqu'un qui PEUT vous atteindre sans avoir rien lance : derriere, un
        // kart qui peut tirer vers l'avant ; devant, un kart qui porte de quoi
        // laisser tomber. Deux predicats distincts (`isArmedForward`,
        // `isTrailable`) — une banane ne menace que celui qui SUIT, une carapace
        // en orbite que celui qui PRECEDE.
        //
        // Ca ne devient jamais une esquive : juste se ranger hors de l'axe. Ce
        // qui l'empeche de degenerer en zigzag est la condition d'ALIGNEMENT,
        // posee dans le moteur — tout le monde porte quelque chose, presque
        // personne n'est dans la ligne.
        //
        // Distance au-dela de laquelle une ligne de tir ne se partage plus,
        // bornee par `range` du cote regarde.
        pressureRange: 700,

        // Duree de vie du souvenir d'un danger, des deux cotes. Sans elle le kart
        // oublierait la carapace entre deux coups d'oeil : le tirage n'a jamais
        // lieu PENDANT un coup d'oeil, donc au moment ou il tombe la tete est
        // deja revenue devant.
        //
        // Elle sert aussi la duree de garde en bouclier (`ai.shield`). A tenir
        // au-dessus de `glanceIntervalMs / backChanceDanger` (1770 ms), et non du
        // seul intervalle.
        pressureMemoryMs: 3500,

        // On se retourne franchement quand c'est SOI qui prepare un tir arriere :
        // viser dans le peloton demande de le regarder. C'est ce qui rend le tir
        // arriere jouable pour celui qui le recoit — le coup d'oeil du tireur lui
        // laisse le temps de se decaler. Porte sur la CADENCE du coup d'oeil, pas
        // sur sa probabilite.
        aimGlanceGain: 2.0,

        // Duree de vie du RELEVE : la profondeur vue pendant le coup d'oeil, sur
        // laquelle le tireur se recale ensuite. Viser de memoire, c'est viser ou
        // l'autre ETAIT — de la vient la chance du poursuivant. A tenir bien sous
        // `ai.aimLeadMs` (1300), sinon le releve se perime avant la fin de la
        // visee.
        aimMemoryMs: 900,

        // C'EST LE REGLAGE DU DOSAGE. A 1 plus personne ne prend de carapace dans
        // le dos et la moitie du jeu d'objets ne sert plus ; a 0 les karts
        // restent colles derriere une verte jusqu'a ce qu'elle parte.
        //
        //   retryMs  delai avant de retenter apres un refus — le danger est reste.
        //   holdMs   duree du decalage.
        //   speed    douceur du geste, bien sous `ai.dodgeIntensityMin` : c'est ce
        //            qui distingue une precaution d'une esquive a l'oeil.
        safety: {
            chance: 0.5,
            retryMs: 900,
            holdMs: 2000,
            speed: 14
        },

        // Contre une ROUGE, se decaler ne sert a rien : elle se recale sur la
        // profondeur de sa cible huit fois plus vite qu'un kart ne se deplace. La
        // seule parade est de cesser d'etre la CIBLE — se faire doubler.
        //
        //     `chance` une rouge derriere lui, assez pres. `chanceRival` deux :
        //     laisser passer la premiere, c'est se retrouver devant la seconde.
        //     Petite chance quand meme, faute de mieux. `range` au-dela, le
        //     porteur a le temps de changer d'avis. `brakeFactor` le seul frein
        //     du moteur qui serve une INTENTION et non une urgence, d'ou sa
        //     douceur. Sans lui, celui qui suit ne double jamais et le kart reste
        //     range pour rien.
        //
        // Rien ne se declenche sans avoir REGARDE DERRIERE : c'est ce qui en fait
        // une decision de pilote et non une omniscience.
        giveWay: {
            chance: 0.35,
            chanceRival: 0.10,
            range: 450,
            retryMs: 900,
            holdMs: 1600,
            speed: 14,
            brakeMs: 900,
            brakeFactor: 0.90
        },

        // Une decision prise ne se defait pas parce que le regard s'est porte
        // ailleurs : elle tient jusqu'a son echeance, ou jusqu'a ce que le kart
        // CONSTATE que la menace est passee. `holdAfterMs` s'ajoute au temps
        // avant impact pour poser l'echeance.
        holdAfterMs: 500,

        // Recalcul de trajectoire : a chaque intervalle, une chance de reprendre
        // le placement avec la perception fraiche. Rate, la revision est
        // repoussee d'un intervalle.
        reviewIntervalMs: 400,
        reviewChance: 0.5,

        // Tirage sur cet intervalle. Il ne rend pas les karts meilleurs, il les
        // rend DIFFERENTS : a cadence fixe, huit karts qui voient la meme piste
        // rejouent la meme decision au meme instant et finissent en file
        // indienne. A 1 / 1, cadence fixe.
        reviewJitterMin: 0.6, reviewJitterMax: 1.6,

        // Ce que coute un choc, en millisecondes perdues : la monnaie commune qui
        // arbitre entre deux dangers, au score `cout / temps restant`.
        // L'arbitrage vaut EN CONTINU et pas seulement a la decision — sinon une
        // menace qui reste en vue repousse l'echeance de son plan jusqu'a
        // l'impact.
        //
        //     spin delays.hitDecelDuration + delays.hitPauseDuration
        //     pipe pipe.bumpMs + pipe.recoilMs, plus 90 px de recul
        //     kart une bousculade : elle deplace sans stopper, et le corps peut
        //           s'ecarter seul — d'ou le prix le plus bas des trois corps.
        //     edge le prix d'un FROLEMENT de mur, pas d'un raclage prolonge. Trop
        //           haut, tout couloir de bord devient inatteignable.
        //
        // L'ORDRE compte plus que les valeurs exactes : spin > pipe > kart >
        // edge.
        cost: { spin: 2000, pipe: 850, kart: 300, edge: 80 },

        // Ce que coute de viser un couloir ou d'autres sont deja engages. Un
        // couloir se choisit jusqu'a 1100 px, distance a laquelle aucun kart
        // n'etait visible : chacun decidait comme s'il etait seul en piste, et le
        // tas se formait dans un trou pendant que l'autre restait vide.
        //
        //     `distance` jusqu'ou un kart devant compte comme occupant le passage.
        //                Au-dela il l'aura franchi avant nous.
        //     `cost` ce que vaut un kart pile dans le couloir vise. Il se CUMULE :
        //                aucun seuil n'est ecrit, la note monte avec la foule.
        //
        // A 0, chacun redevient seul en piste.
        crowd: { distance: 560, cost: 200 },

        // Ou se mettre en profondeur. Une note en millisecondes, meme monnaie que
        // `cost` : ce qu'on RISQUE a un endroit, plus ce que coute d'y aller. Cf.
        // `laneRisk` / `chooseLane`.
        place: {
            // Ce que pese un detour face a un risque. A 1, une seconde de
            // braquage vaut une seconde perdue en choc : le kart traverse la
            // piste pour eviter un tete-a-queue (2000 ms), pas pour un frottement
            // de bord (80). C'est ce qui produit « pas de danger, pas de virage »
            // sans qu'aucune regle ne le dise.
            detour: 1.0,

            // Chance de retenir l'option qu'on vient de regarder. Le kart descend
            // le classement des couloirs et s'arrete a chaque marche avec cette
            // probabilite : le meilleur 75 fois sur 100, le deuxieme 19, le
            // troisieme 5. Une erreur reste une option qui existait, jamais un
            // mur. A 1 le kart est parfait — c'est l'interrupteur du banc.
            chance: 0.75,

            // Confort qu'on aimerait garder autour de chaque corps, au-dela de sa
            // hitbox. Ce ne sont pas des refus : les entamer coute, en proportion
            // de ce qu'on entame. Fondues dans les hitboxes, elles faisaient
            // refuser un passage de 3.1 unites qui n'en valait plus que 1.1 — le
            // kart ignorait qu'il y avait un trou.
            margin: { pipe: 1.5, item: 2, kart: 1 },

            // Imprecision d'un kart, en unites de profondeur par unite de volant
            // (cf. `laneSlop`). Elle gonfle chaque obstacle pour ce kart-la
            // seulement : c'est ce qui distingue « le passage est trop petit » de
            // « le kart est trop imprecis pour ce passage ». A 8 : ~0.8 pour
            // koopa, ~1.6 pour bowser, donc un couloir de 3.1 unites est jouable
            // pour l'un et refuse a l'autre. A 0, tous se croient chirurgicaux.
            slop: 8,

            // Ce que vaut une boite, en millisecondes gagnees. Seul terme negatif
            // de la note : une occasion, pas un risque. A 400 le kart longe le
            // bord pour une boite mais ne traverse ni devant un tuyau (850) ni
            // devant une carapace (2000) — cet arbitrage ne s'ecrit nulle part,
            // il tombe de l'ordre des couts. A 0, il ignore les boites qui ne
            // sont pas sur sa ligne.
            boxBonus: 400,

            // Ce qu'un nouveau couloir doit gagner pour qu'on lache celui qu'on
            // suit. Sans seuil, le kart repartait dans l'autre sens a mi-parcours
            // — ce qui se voit exactement comme un manque d'agilite : il n'etait
            // pas lent, il faisait deux fois la moitie du chemin. A 0, il
            // reconsidere tout a chaque reprise.
            commit: 150,

            // Ce que coute d'entamer TOUT le confort d'un corps sans toucher sa
            // limite dure, en fraction du cout de contact. A 1, froler un tuyau
            // se notait comme le percuter, et le passage serre etait toujours
            // battu par le grand contournement — y compris quand le kart etait
            // deja dedans.
            //
            // La limite dure est un fait (`laneRisk` y rend l'infini), la marge
            // un CONFORT, et l'imprecision du kart est deja comptee a part
            // (`slop`).
            graze: 0.35,

            // Ce que vaut un deplacement REPORTE face au meme fait tout de suite.
            // Un mur plus lointain ne coute pas un choc : il coute d'avoir a en
            // sortir plus tard, sous un horizon plus court et dans un trafic qui
            // aura bouge. Le majorer fait preferer, a prix egal, le couloir qui
            // degage AUSSI la suite.
            //
            // A 1 le kart s'engage trop ; au-dela de 3 il redevient frileux et
            // cesse de prendre la ligne haute.
            debt: 2
        },

        // Menaces deja jugees que le kart garde en tete. Un seul emplacement
        // suffit tant qu'une menace en chasse une autre pour de bon ; deux qui
        // alternent en urgence — une banane et une verte — refaisaient le tirage
        // de reflexe a chaque bascule.
        memorySlots: 4,

        // Duree de vie d'un verdict, comptee depuis la DERNIERE fois que la
        // menace a ete vue : ce qui se perime est l'absence, pas l'observation.
        // Sans elle, une verte jugee « pas vue » le restait ses dix rebonds
        // durant. Un peu au-dela de `ai.threatWindowMs` (900) plus `holdAfterMs`
        // (500).
        memoryMs: 1500
    },
};
