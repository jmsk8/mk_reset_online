// Les corps : ce que chaque kart mesure, et l'emprise qui en decoule. Rien ne se
// regle a la main sauf la LOI — `deriveBodies` en tire les nombres corps par
// corps, a partir de la taille reelle des sprites (`scripts/sprite-metrics.py`).

export function deriveBodies(cfg) {
    const b = cfg.bodies;
    const names = Object.keys(b.sprite.kart);

    // Un personnage non mesure roulerait a la taille moyenne du plateau sans que
    // rien ne le dise. `px` est verifie a part : oublie, la profondeur vaudrait
    // NaN, et une comparaison contre NaN est toujours fausse — le kart
    // traverserait tout le monde sans qu'aucune erreur ne soit levee.
    for (const n of Object.keys(cfg.kartStats.characters)) {
        const sprite = b.sprite.kart[n];
        if (!sprite || !(sprite.w > 0) || !(sprite.px > 0)) {
            throw new Error(`bodies.sprite.kart : ${n} n'a pas de mesure `
                + 'complete (w, h, px). Relancer '
                + '`python3 scripts/sprite-metrics.py` et recopier le bloc.');
        }
    }

    // Le sprite de REFERENCE : la moyenne du plateau, sur les deux mesures. Seul
    // choix qui laisse les valeurs d'avant intactes au centre.
    let sumW = 0;
    let sumPx = 0;
    for (const n of names) {
        sumW += b.sprite.kart[n].w;
        sumPx += b.sprite.kart[n].px;
    }
    const refW = sumW / names.length;
    const refPx = sumPx / names.length;

    // Combien de px de demi-emprise vaut un px de sprite. Facteur unique, karts
    // compris : deux corps dessines a la meme echelle touchent a la meme echelle.
    const perPx = (b.kartDraw * b.fill * 0.5) / refW;

    // La profondeur du kart de REFERENCE, et de lui seul — dernier endroit ou
    // `flatten` sert. Les sept autres s'en ecartent au prorata de leur surface,
    // pas de leur longueur.
    const refHalfY = (refW * perPx) / (b.flatten * b.depthPx);

    const bodyOf = (w, px) => ({
        // La LONGUEUR : la largeur du fichier, a l'echelle du monde.
        x: w * perPx,
        // La LARGEUR : la surface dessinee, rapportee a celle du corps moyen.
        // C'est le volume qui parle, pas l'encombrement.
        y: refHalfY * (px / refPx),
        // Ce que le DESSIN doit faire de plus ou de moins que le kart de
        // reference. Sans unite : le client le multiplie par sa propre largeur,
        // qui vaut moins sur mobile.
        //
        // Il ne suit QUE la longueur — un sprite se dessine a une largeur, sa
        // surface n'a pas son mot a dire ici.
        scale: w / refW
    });

    b.refSpriteW = refW;
    b.refSpritePx = refPx;
    b.ref = bodyOf(refW, refPx);
    b.kart = {};
    for (const n of names) {
        b.kart[n] = bodyOf(b.sprite.kart[n].w, b.sprite.kart[n].px);
    }

    // Le tuyau passe par la meme regle, a une reserve pres : sa longueur DESSINEE
    // ne suit pas l'echelle commune (67.2 au lieu de 84), parce qu'a taille
    // reelle il mangeait trop de piste. C'est un choix de trace, pas une erreur
    // de mesure.
    //
    // Sa profondeur se prend sur sa longueur : UN TUYAU EST ROND, d'ou la
    // division par `depthPx` seule. Il ne passe donc pas par `flatten`, qui n'est
    // pas une loi de la nature mais un choix de jeu — un kart a une emprise plus
    // plate que sa silhouette pour que rouler cote a cote reste jouable. Un
    // obstacle immobile n'a rien a negocier.
    //
    // Ca coute de la piste : c'est pourquoi `road.maxY` est passe de 30 a 35.
    const pipeHalfX = b.pipeDraw * b.pipeFill * 0.5;
    cfg.pipe.hitbox = { x: pipeHalfX, y: pipeHalfX / b.depthPx };
    cfg.pipe.draw = {
        w: b.pipeDraw,
        // La hauteur suit les proportions du fichier, elle ne se regle pas : un
        // tuyau etire ou tasse ne ressemblerait plus a son emprise.
        h: b.pipeDraw * b.sprite.pipe.h / b.sprite.pipe.w
    };

    // Les ecarts entre CENTRES du kart de reference. Ce sont les distances de
    // PERCEPTION et de validation de piste, la ou une seule mesure vaut pour tout
    // le plateau. Ce qui touche vraiment passe par `bodies.kart[nom]` (cf.
    // `kartHalfExtents`).
    cfg.hitboxes.kartVsKart = { x: b.ref.x * 2, y: b.ref.y * 2 };
    cfg.hitboxes.kartVsPipe = {
        x: cfg.pipe.hitbox.x + b.ref.x,
        y: cfg.pipe.hitbox.y + b.ref.y
    };

    // Et l'objet, pour la meme raison. Ces sommes etaient posees a la main,
    // calees sur une demi-carrosserie de 30 : elles rognaient en silence la part
    // de l'objet des que la carrosserie changeait.
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
    kartStats: {
        budget: 15,
        minPoints: 0,
        maxPoints: 10,

        mass:  { min: 0.72, max: 1.25 },
        force: { min: 0.85, max: 1.40 },
        grip:  { min: 0.45, max: 1.32 },

        // Forme de l'axe handling : `grip = lerp(min, max, handling ^
        // gripCurve)`.
        //
        // A 1 l'axe est droit, et tout le monde sauf Koopa se pilote comme un
        // kart maniable. Au-dessus, la courbe s'ecrase par le bas : seuls les
        // gros scores de handling gardent leur grip, et le sommet ne bouge pas.
        //
        // Regler ce couple, c'est deplacer le milieu sans deplacer le haut —
        // `gripCurve` monte, `grip.min` descend, `grip.max` se recale pour que
        // Koopa (le kart de reference) retombe sur son agilite de 1.548. Reperes
        // en agilite Mario / Bowser, a massDragAgility 1.70 :
        //
        //     curve 1.6 min 0.62 max 1.28 -> 0.905 / 0.475 (x3.26)
        //     curve 2.5 min 0.45 max 1.32 -> 0.619 / 0.334 (x4.64)
        //     curve 2.8 min 0.40 max 1.36 -> 0.553 / 0.296 (x5.23)
        //
        // La courbe frappe selon le handling, donc tout le plateau a la fois.
        // Pour viser les lourds en particulier, c'est `massDragAgility`.
        gripCurve: 2.5,

        // Ce que la masse coute a l'acceleration : `acceleration = force / masse
        // ^ massDragAccel`.
        //
        // L'exposant pivote autour de la masse 1, soit le poids moyen : le monter
        // creuse l'ecart des deux cotes a la fois, les legers gagnant autant que
        // les lourds perdent, et Mario ne bouge pas.
        //
        // La plage de masse (0.72 a 1.25) etant etroite, c'est un levier doux :
        // chaque dixieme vaut ~0.05 s aux deux bouts. Au-dela de ~1.5, les lourds
        // deviennent injouables depuis les tuyaux, qui les remettent a l'arret
        // plusieurs fois par tour.
        massDragAccel: 1.75,

        // Garde-fou contre une combinaison de stats absurde, pas un reglage : il
        // ne doit jamais mordre sur le plateau en place, sinon il ecrete en
        // silence l'effet qu'on vient de regler. Le plafond suit l'exposant.
        accelClamp: { min: 0.75, max: 1.85 },

        // Ce que la masse coute a la maniabilite : `agilite = grip / masse ^
        // massDragAgility`. Meme forme que `massDragAccel`, mais l'axe vise est
        // le poids et non la puissance.
        //
        // C'est le levier a poids, la ou `gripCurve` est le levier a handling :
        // il mord surtout aux deux bouts. 1.70 est le plafond pratique — au-dela,
        // Toad repasse devant Koopa et le haut du plateau se reordonne.
        massDragAgility: 1.70,
        // Meme role que `accelClamp` : un garde-fou, pas un reglage. Le plancher
        // suit les deux leviers ci-dessus — a curve 2.5 et massDragAgility 1.70,
        // Bowser tombe a 0.334, la ou l'ancien plancher (0.60) lui aurait rendu
        // en silence deux cinquiemes de la maniabilite qu'on venait de lui
        // retirer.
        agilityClamp: { min: 0.25, max: 1.70 },

        // `cornering = handling ^ cornerGripGain * puissance ^ cornerPowerGain
        //                / poids ^ cornerMassDrag`
        //
        // Elle decide de ce que tourner coute en vitesse (`corner.cost`, et
        // `steerCost` dans le moteur). Trois exposants, un par axe, et ils
        // n'agissent QUE la : regler la tenue en virage d'un lourd ne touche pas
        // a la vitesse a laquelle il tourne, qui reste le domaine de
        // `massDragAgility`. Toute la separation est la.
        //
        // Les valeurs livrees reproduisent exactement `agility * force`, d'ou
        // `cornerMassDrag` egal a `massDragAgility`.

        // LE LEVIER A POIDS. Meme lecture que les autres exposants : il pivote
        // autour de la masse 1, Mario ne bouge pas, les deux bouts s'ecartent
        // symetriquement. C'est un levier d'ECART et non de severite — pour la
        // severite, `corner.cost`.
        //
        // Pas de plafond, et l'effet se calcule de tete : le rapport entre deux
        // karts est multiplie par `(masse_lourd / masse_leger) ^ ecart
        // d'exposant`. De 1.70 a 5.00, le rapport bowser/koopa passe de 4.4x a
        // 15.0x.
        //
        // A 0, le poids ne coute plus rien en virage. CE QUE CA COUTE VRAIMENT NE
        // S'ECRIT PAS ICI : une manoeuvre reelle n'atteint pas le plein braquage.
        // Le banc le mesure, colonne `virage`.
        cornerMassDrag: 5.00,

        // Ce que le handling rabat sur ce cout. A 0, il ne tient plus rien en
        // virage et il ne reste que le poids et la puissance. L'axe est deja
        // courbe en amont par `gripCurve` ; cet exposant se pose par-dessus.
        cornerGripGain: 1.0,

        // Ce que la puissance rabat sur ce cout — un moteur qui pousse fort
        // ramene plus vite le kart dans son elan quand il s'inscrit. Levier doux
        // : la plage de `force` (0.85 a 1.40) ne separe bowser de koopa que de 5
        // %.
        cornerPowerGain: 1.0,

        // `topSpeed = speedBase + speedPerWeight * poids + speedPerPower *
        // puissance`, les deux axes normalises dans [0, 1]. Additif : chaque
        // coefficient se lit directement en px/s gagnes entre un score de 0 et un
        // score de 10.
        //
        // Le poids mene, la puissance suit — c'est ce qui rend le poids payant.
        // Un kart lourd achete sa pointe et la paie deux fois, en acceleration et
        // en maniabilite.
        //
        // L'ENVELOPPE EST LE REGLAGE SENSIBLE DU JEU, et de loin : au banc, la
        // pointe pese environ 0.5 point de taux de victoire par px/s d'ecart
        // entre deux karts. Ne pas elargir `speedPerWeight` sans elargir d'autant
        // ce que la masse coute. Repere : 1 s de temps de course vaut ~4.5 px/s
        // de pointe.
        speedBase: 490,
        speedPerWeight: 35,
        speedPerPower: 10,

        characters: {
            bowser: { weight: 9, power: 5, handling: 1 },
            dk:     { weight: 8, power: 5, handling: 2 },
            mario:  { weight: 5, power: 5, handling: 5 },
            luigi:  { weight: 4, power: 6, handling: 5 },
            yoshi:  { weight: 4, power: 5, handling: 6 },
            peach:  { weight: 3, power: 6, handling: 6 },
            toad:   { weight: 2, power: 5, handling: 8 },
            koopa:  { weight: 2, power: 4, handling: 9 }
        }
    },

    // Les mesures des sprites, et la loi qui en fait des emprises. Ce qui en sort
    // est pose par `deriveBodies()`, en tete de fichier.
    bodies: {
        // Les mesures des fichiers. Rien ne se recopie a la main : `python3
        // scripts/sprite-metrics.py` relit les PNG et reimprime ce bloc tel quel.
        //
        // `w` / `h` sont le cadre. Les sprites etant detoures au plus juste, la
        // largeur du fichier EST la longueur du kart.
        //
        // `px` est la SURFACE DESSINEE, alpha non nul. C'est elle qui porte la
        // PROFONDEUR : le cadre dit ou s'arrete le dessin, la surface ce qu'il y
        // a dedans — un bowser qui remplit 76 % de son cadre n'est pas une peach
        // qui en remplit 61 %. Ce sont des PNG a palette, la transparence vit
        // dans le chunk tRNS : d'ou le script.
        //
        // La pose de course (`side-right`) et elle seule — les autres
        // orientations ne se voient que pendant le tete-a-queue, ou plus rien ne
        // touche. `h` ne sert qu'au tuyau, dont la hauteur est imposee.
        sprite: {
            kart: {
                bowser: { w: 111, h: 124, px: 10451 },
                dk:     { w: 119, h: 124, px: 10497 },
                mario:  { w: 112, h: 119, px:  8718 },
                luigi:  { w: 111, h: 123, px:  8511 },
                yoshi:  { w: 119, h: 122, px:  9655 },
                peach:  { w: 112, h: 124, px:  8425 },
                toad:   { w: 110, h: 120, px:  8278 },
                koopa:  { w: 110, h: 114, px:  7395 }
            },
            pipe: { w: 95, h: 124 }
        },

        // Longueur DESSINEE du kart de reference, en px de monde. Meme valeur que
        // `GAME_CONFIG.rendering.kartWidth.pc` cote client, et meme kart : le
        // client ne recopie rien, il recoit le rapport de chaque personnage a
        // cette reference (`scale`) dans le `hello`.
        kartDraw: 100,

        // Longueur DESSINEE du tuyau, en px de monde. Elle vit ici et non dans le
        // rendu depuis que l'emprise s'en deduit : une largeur de dessin qui
        // decide de ce qui touche est une valeur du monde.
        //
        // 67.2 et non 84 (ce que l'echelle commune donnerait pour un fichier de
        // 95 px) : le tuyau est dessine 20 % plus petit, parce qu'a taille reelle
        // il mangeait trop de piste.
        pipeDraw: 67.2,

        // La part de la longueur dessinee qui touche reellement : un sprite
        // deborde toujours de son chassis — casque, ombre portee, roue avant. La
        // monter fait toucher dans le vide, la baisser fait traverser les
        // silhouettes.
        //
        // Ne vaut que pour les KARTS ; le tuyau a la sienne (`pipeFill`).
        fill: 0.75,

        // Un tuyau porte une COLLERETTE plus large que son fut, et c'est elle qui
        // donne au sprite sa largeur. Le fut — seule partie posee au sol, donc la
        // seule qui arrete un kart — est plus etroit. Un kart n'a pas ce probleme
        // : sa silhouette touche le sol sur toute sa largeur.
        //
        // Ca ne se voyait pas tant que la profondeur du tuyau etait reglee a la
        // main. Depuis qu'elle descend de la longueur, la meme erreur se paie sur
        // les deux axes.
        //
        // 0.65 contre 0.75 : 13.3 % d'emprise en moins sur les deux axes ensemble
        // — le disque reste un disque, il retrecit, et le tuyau cesse de manger
        // plus de la moitie de la piste. Descendre encore ne rouvrirait aucun
        // placement avant 0.49, ou le tuyau mordrait franchement dans son propre
        // sprite.
        pipeFill: 0.65,

        // L'aplatissement d'un corps vu de dessus : combien de px de longueur
        // pour un px de profondeur. Il ne regle plus qu'UNE chose — la profondeur
        // du kart de REFERENCE, donc celle autour de laquelle tout le plateau se
        // distribue.
        //
        // Ce qui ecarte les karts les uns des autres est leur surface dessinee,
        // pas lui : par l'aplatissement seul, bowser et peach auraient la meme
        // largeur a 1 % pres ; par la surface, bowser est 24 % plus profond, ce
        // qui est ce qu'on voit a l'ecran.
        //
        // 3.33 : 1 est la valeur d'origine du jeu. Le tuyau n'y passe plus du
        // tout (il est rond), et c'est ce qui dit ce que `flatten` est vraiment :
        // non pas une projection, mais un choix de jeu qui ne vaut que pour les
        // corps devant pouvoir rouler cote a cote.
        flatten: 10 / 3,

        // Px a l'ecran pour une unite de profondeur de piste : 35 unites pour 126
        // px sur PC. Seule conversion du fichier entre les deux unites du monde.
        //
        // Le client ne la recopie pas : il divise la hauteur de la bande roulable
        // (`--road-band-pct` en CSS) par `maxY - minY`, ce qui redonne 3.6.
        //
        // Elle valait deja 3.6 quand la piste s'arretait a 30 unites pour 108 px
        // : `road.maxY` a change de LONGUEUR et non d'ECHELLE, et tout ce qui se
        // compte en unites garde sa valeur physique.
        //
        // Elle sert a deux choses : comparer une longueur et une profondeur pour
        // le kart de reference (`flatten`), et rendre le tuyau rond
        // (`pipe.hitbox`).
        depthPx: 3.6,

        // Emprise propre d'un objet au sol, reglee a la main et qui le reste :
        // une carapace n'a pas de longueur au sens ou un kart en a une, elle
        // roule et se lit a la profondeur.
        //
        // Elle vit dans `bodies` parce que c'est le seul endroit ou l'on note ce
        // qu'un corps MESURE, par opposition a l'ecart auquel deux corps se
        // touchent. Sans cette distinction, `hitboxes.itemVsKart` etait une SOMME
        // posee a la main : la part de l'objet n'etait que le reste, et fondait a
        // mesure que `fill` montait. Maintenant c'est l'objet qui est regle et la
        // somme qui suit.
        item: { x: 10, y: 2.5 },

        // Ce qu'un objet en ORBITE reclame en plus, en profondeur : il oscille
        // avec sa rotation (`orbit.radiusY`, 3.2), et ce supplement lui rend la
        // meme tolerance effective qu'un objet pose.
        //
        // 3 et non 3.2 : c'est la valeur qui redonne le 8 regle a la main et
        // eprouve depuis.
        orbitSlack: 3
    },

    hitboxes: {
        // Toutes les hitboxes du moteur sont des ecarts entre CENTRES, posees par
        // `deriveBodies()` a partir du kart de REFERENCE :
        //
        //     kartVsKart { x: 60, y: 5 } itemVsKart { x: 40, y: 5 } emprise de
        //     l'objet + demi-carrosserie kartVsPipe { x: 50.16, y: 5.3 } emprise
        //     du tuyau + demi-carrosserie orbitItemVsKart { x: 40, y: 8 }
        //     itemVsKart + `bodies.orbitSlack`
        //
        // Elles servent partout ou une seule mesure doit valoir pour tout le
        // plateau : perception, validation des circuits au chargement. Ce que
        // DEUX karts se donnent a toucher passe par `kartHalfExtents()`, qui
        // somme leurs demi-emprises reelles.
        //
        // Seule la part du tuyau a maigri, jamais celle du kart : rogner les deux
        // ferait passer les karts dans des trous ou ils ne tiennent pas.
        //
        // La boite a objets ne bouge pas et ne doit pas bouger : ce n'est pas une
        // somme de deux corps mais une ZONE DE RAMASSAGE, l'endroit ou doit
        // passer un CENTRE de kart. Un kart plus long ne ramasse pas de plus
        // loin.
        itemBox: { x: 10, y: 8 }
    },
};
