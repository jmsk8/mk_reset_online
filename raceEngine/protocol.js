'use strict';

// Protocole serveur → client du banner.
//
// Regle qui gouverne tout ce fichier : **le snapshot fait foi**. Un spectateur
// qui se connecte a la 187e seconde n'a vu passer aucun evenement, et doit
// pourtant afficher une scene complete et juste. Donc tout ce qui est visible a
// l'ecran doit se trouver dans le snapshot — jamais seulement dans un
// evenement. Les evenements ne servent qu'a jouer des animations.
//
// Corollaire pratique : avant d'ajouter un element visuel cote client, se
// demander « un arrivant peut-il le deduire du seul snapshot ? ». Si non, c'est
// ici qu'il manque un champ.

const PROTOCOL_VERSION = 10;

// Champ de bits de l'etat d'un kart. Compact parce qu'il part dix fois par
// seconde a chaque spectateur (voir §6.7 du document de migration).
const FLAG_GRID = 1;      // sur la grille, avant le coup d'envoi
const FLAG_HIT = 2;       // percute -> tete-a-queue
const FLAG_STOPPED = 4;   // immobilise apres impact -> sprite fige
const FLAG_STAR = 8;      // etoile active -> halo
const FLAG_FINISHED = 16; // a franchi la ligne -> tour d'honneur
const FLAG_SHRUNK = 32;   // rapetisse par l'eclair -> sprite reduit
const FLAG_BILL = 64;     // transforme en Bill Ball -> sprite remplace
const FLAG_BUMPED = 128;  // arrete net par un pipe : arret et recul, sprite inchange
const FLAG_FLAT = 256;    // ecrase par un kart reste grand -> sprite aplati

// ── Le releve de decision, pour le HUD de debug ──────────────────────────
//
// Ce que le kart VOIT et ce qu'il en FAIT, en un seul entier par kart.
//
// Il part toujours, et c'est un choix : le fichier pose en regle que le
// snapshot fait foi, et un releve qui ne serait la que sur demande obligerait a
// redemarrer le service pour observer un comportement qu'on vient de voir. A
// huit karts et dix envois par seconde, un entier tient dans quelques dizaines
// d'octets — moins que le tableau des points, qui voyage pour la meme raison.
//
// Rien ici ne pilote le rendu : c'est une observation, jamais un etat de jeu.
// Un client qui l'ignore affiche exactement la meme course.
// L'ORDRE de ces deux tables est le contrat : le client n'envoie pas les mots,
// il lit l'indice et affiche son propre libelle. Les tables jumelles sont dans
// `smk-banner.js`, sous le meme nom. Y inserer une valeur au milieu decale tout
// l'affichage en silence — on ajoute a la fin, ou on incremente
// PROTOCOL_VERSION.
const AI_STATES = ['cruising', 'pipe', 'dodging', 'safety', 'giveWay', 'aiming'];
const AI_DANGERS = ['', 'carrier', 'ram', 'shot'];

function aiTuple(cfg, kart, now) {
    const sight = kart.sight;
    const plan = kart.plan;
    if (!sight) return 0;

    let v = Math.max(0, AI_STATES.indexOf(kart.aiState));

    // Ce qu'il a dans le dos, tant que le souvenir tient. Meme peremption que
    // celle qui pilote le comportement, sans quoi l'affichage dirait autre chose
    // que ce que le kart croit.
    const fresh = (now - sight.dangerAt) <= cfg.vision.pressureMemoryMs;
    const danger = fresh ? AI_DANGERS.indexOf(sight.dangerKind) : 0;
    v |= (danger > 0 ? danger : 0) << 4;

    if (sight.back) v |= 1 << 6;
    if (now < kart.brakeUntil) v |= 1 << 7;
    if (kart.shieldHold && kart.heldItem) v |= 1 << 8;
    if (sight.redBehindCount > 1) v |= 1 << 9;

    // La menace de DEVANT que la table de cout a retenue — celle qui commande,
    // s'il y en a une.
    const kind = plan && plan.threatId ? plan.kind : '';
    v |= (kind === 'spin' ? 1 : 0) << 10;
    if (sight.pipeIndex >= 0) v |= 1 << 11;

    // Le porteur qu'on SUIT : quelqu'un devant, dans l'axe, avec de quoi finir
    // derriere lui — et il n'a pas besoin de l'avoir deja lache pour compter.
    //
    // C'etait le seul danger que le releve ne disait pas. La ligne « derriere »
    // ne parle que de l'arriere, et le bit precedent ne s'allume que pour une
    // menace DEJA LANCEE : on voyait donc un kart se ranger sans savoir
    // pourquoi, et surtout on ne pouvait pas voir qu'il ne se rangeait pas.
    //
    // Il porte le souvenir autant que la vue (cf. `sight.frontAt`), et c'est
    // voulu : le HUD doit dire ce sur quoi le kart DECIDE, pas ce que le
    // dernier balayage a ramene.
    if (sight.pressure && !sight.pressureBack) v |= 1 << 12;

    return v;
}

// ── La vue elle-meme, pour la carte de debug ────────────────────────────
//
// L'entier `aiTuple` dit ce que le kart a RETENU. Il ne dit pas ce qu'il a
// regarde, ni jusqu'ou, ni ce que l'ombre d'un autre lui a cache — et c'est
// precisement la que se logent les erreurs de perception : un kart qui ignore
// une banane et un kart qui ne la voit pas produisent le meme releve.
//
// ── Pourquoi ceci ne part pas dans le snapshot ──────────────────────────
//
// Le snapshot est serialise UNE FOIS pour tous les spectateurs, et c'est ce qui
// rend le service tenable. Ce releve-ci pese cent fois l'entier de decision —
// les spans a eux seuls font une vingtaine d'entrees — et ne sert qu'a un
// spectateur sur mille, celui qui a ouvert la carte. Le diffuser a tout le monde
// pour qu'un seul le lise serait payer la dette de tous pour l'outil d'un seul.
//
// Il part donc SUR DEMANDE, pour le kart demande (`{t:'watch', id}`), et le
// service ne paie une seconde serialisation que pour les connexions qui l'ont
// demande. Personne ne regarde : rien ne change, pas un octet.
//
// La regle du fichier tient quand meme, et c'est l'essentiel : le client ne
// DEDUIT rien. Tout ce qui se dessine est ici, releve tel que le moteur l'a
// arrete au dernier balayage.
//
// Convention de signe, la meme que partout : un kart s'identifie en negatif
// (`-1 - id`), un objet a partir de 1.
function visionTuple(kart) {
    const sight = kart.sight;
    if (!sight) return null;

    const spans = [];
    for (let i = 0; i < sight.spanCount; i++) {
        const s = sight.spans[i];
        // [profondeur basse, haute, ecart signe, portee, dur, tuyau]
        spans.push([
            round(s.lo, 2), round(s.hi, 2), round(s.dx, 1),
            Math.round(s.reach), s.hard ? 1 : 0, s.pipeIndex
        ]);
    }

    const hidden = [];
    for (let i = 0; i < sight.hiddenCount; i++) hidden.push(sight.hiddenIds[i]);

    // Les ombres, resolues ICI en profondeurs plutot qu'envoyees en pentes. Le
    // client aurait a refaire la projection sinon, et une projection refaite est
    // une projection qui peut diverger — c'est la regle du fichier.
    //
    // Chaque ombre est un trapeze au sol : [debut, fin] en ecart au kart, et les
    // deux profondeurs a chaque bout. Deux bouts, parce qu'elle s'ELARGIT en
    // s'eloignant de l'oeil — c'est la moitie du modele.
    const shadows = [];
    for (let i = 0; i < sight.shadowCount; i++) {
        const from = sight.shadowFrom[i];
        const to = sight.shadowTo[i];
        shadows.push([
            round(from - sight.eyeBack, 1),
            round(to - sight.eyeBack, 1),
            round(sight.eyeY + sight.shadowLo[i] * from, 2),
            round(sight.eyeY + sight.shadowHi[i] * from, 2),
            round(sight.eyeY + sight.shadowLo[i] * to, 2),
            round(sight.eyeY + sight.shadowHi[i] * to, 2)
        ]);
    }

    return {
        // Le kart observe, et l'etat de son regard AU MOMENT DU BALAYAGE. Pas
        // `sight.back`, qui bascule a la cadence de l'affichage : ce qui a
        // rempli cette vue est `scanBack`, et dessiner l'autre ferait pointer le
        // cone dans le sens ou le contenu n'a pas ete releve.
        id: kart.id,
        back: sight.back ? 1 : 0,
        scanBack: sight.scanBack ? 1 : 0,
        range: Math.round(sight.scanRange),
        at: Math.round(sight.at),

        // D'ou part le regard. Le client a bien la position du kart, mais
        // interpolee : la faire servir d'origine decalerait tout le dessin d'une
        // demi-frame par rapport a ce qui a ete percu.
        x: round(kart.worldX, 2),
        y: round(kart.yPercent, 2),

        spans: spans,
        hidden: hidden,
        shadows: shadows,

        // Le recul de la camera, pour la poser sur la carte. Elle n'est pas sur
        // le kart, et c'est visible : les ombres partent d'un point qui n'est
        // pas lui.
        eyeBack: Math.round(sight.eyeBack),

        // Ce que la marche a retenu, dans l'ordre ou le pilotage le lit.
        threat: sight.threatId
            ? [sight.threatId, sight.threatKind, round(sight.threatY, 2),
               (sight.threatTtc === Infinity ? -1 : Math.round(sight.threatTtc))]
            : null,
        pipe: (sight.pipeIndex >= 0) ? [sight.pipeIndex, Math.round(sight.pipeDist)] : null,
        pipeAhead: (sight.pipeAheadIndex >= 0)
            ? [sight.pipeAheadIndex, Math.round(sight.pipeAheadDist)] : null,
        pressure: sight.pressure
            ? [round(sight.pressureY, 2), sight.pressureId, sight.pressureBack ? 1 : 0]
            : null,
        red: (sight.redBehindDist >= 0)
            ? [Math.round(sight.redBehindDist), round(sight.redBehindY, 2),
               sight.redBehindId, sight.redBehindCount]
            : null,
        box: (sight.boxDist >= 0) ? [round(sight.boxY, 2), Math.round(sight.boxDist)] : null,

        // Et le plan qui commande, parce qu'une vue sans la decision qu'elle a
        // produite ne se juge pas : c'est l'ecart entre les deux qu'on cherche.
        plan: kart.plan && kart.plan.threatId
            ? [kart.plan.kind, kart.plan.threatId, round(kart.plan.threatY, 2),
               round(kart.plan.laneY, 2), kart.plan.coarse ? 1 : 0]
            : null
    };
}

function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
}

function kartFlags(kart) {
    let flags = 0;
    if (kart.state === 'grid') flags |= FLAG_GRID;
    if (kart.state === 'hit') flags |= FLAG_HIT;
    if (kart.stopped) flags |= FLAG_STOPPED;
    if (kart.isInvincible) flags |= FLAG_STAR;
    if (kart.finished) flags |= FLAG_FINISHED;
    if (kart.isShrunk) flags |= FLAG_SHRUNK;
    if (kart.isBill) flags |= FLAG_BILL;
    if (kart.bumped) flags |= FLAG_BUMPED;
    if (kart.isFlat) flags |= FLAG_FLAT;
    return flags;
}

// [id, worldX, yPercent, totalDistance, flags, rank, heldId, heldType,
//  heldHold, orbitAngle, orbIds, hitEnd, bumpEnd]
//
// `heldType` est indispensable : sans lui le client ne peut pas choisir le
// sprite de l'objet tenu, et un arrivant verrait une banane a la place d'une
// carapace. Pour un objet en orbite c'est le type de l'objet enfant qui est
// transmis — c'est le seul dont le rendu a besoin.
//
// `hitEnd` est la fin du malus, en temps serveur. Le tete-a-queue est une
// animation derivee du temps : sans cette date, un arrivant saurait qu'un kart
// est percute mais pas depuis quand, et le ferait tourner a contretemps.
//
// `bumpEnd` joue le meme role pour le choc contre un pipe : le recul se joue au
// debut de l'arret, pas a la fin, et un arrivant doit savoir ou en est le kart
// qu'il trouve immobile contre un tuyau.
function kartTuple(kart) {
    const held = kart.heldItem;
    const orbit = held && held.holdPosition === 'orbit';

    return [
        kart.id,
        round(kart.worldX, 2),
        round(kart.yPercent, 2),
        round(kart.totalDistance, 1),
        kartFlags(kart),
        kart.rank,
        held ? held.id : null,
        held ? (orbit ? held.childType : held.type) : null,
        held ? held.holdPosition : null,
        orbit ? round(held.orbitAngle, 3) : null,
        orbit ? held.orbs.map(o => o.id) : null,
        kart.state === 'hit' ? Math.round(kart.hitEndTime) : null,
        kart.bumped ? Math.round(kart.bumpEndTime) : null
    ];
}

// [id, type, worldX, y, frame, hop] — `frame` porte l'animation des carapaces,
// `hop` la hauteur d'une banane encore en l'air, en pixels de rendu.
function itemTuple(item) {
    return [
        item.id,
        item.type,
        round(item.worldX, 2),
        round(item.y, 2),
        item.currentFrame,
        item.hop ? round(item.hop, 1) : 0,
        // Une banane en cloche n'a PAS de hitbox tant qu'elle monte, et ca ne se
        // devine pas depuis `hop` : celui-ci reste positif a la descente, ou
        // elle touche de nouveau. Le drapeau part donc tel quel, pour la carte
        // de debug — un objet qui traverse un kart sans rien lui faire est
        // exactement ce qu'une carte de hitbox doit pouvoir montrer.
        item.rising ? 1 : 0
    ];
}

// [debut, frappe, fin, lanceur], en temps serveur, ou null hors orage. Les trois
// dates suffisent au client a placer la scene ou qu'il en soit : le ciel
// s'assombrit de `debut` a `frappe`, la foudre tombe a `frappe`, le jour revient
// a `fin`. C'est le minimum pour qu'un spectateur arrive en plein orage le voie
// au bon stade au lieu de le rejouer depuis le debut. Le lanceur suit : c'est le
// seul que la foudre epargne, et le client doit l'epargner aussi.
function stormTuple(state) {
    const storm = state.storm;
    if (!storm) return null;
    return [Math.round(storm.startedAt), Math.round(storm.strikeAt), Math.round(storm.until), storm.shooterId];
}

// [manche, points de la course, points du grand prix]. Les deux tableaux sont
// alignes sur l'ordre de `state.karts`, qui est aussi celui des identifiants et
// celui du `hello` : le client lit la case i pour le kart i, sans avoir a
// transporter les noms a chaque envoi. Les points de la course restent a zero
// tant qu'elle n'est pas close.
function grandPrixTuple(state) {
    return [
        state.gpRound,
        state.karts.map(kart => state.racePoints[kart.charName] || 0),
        state.karts.map(kart => state.gpPoints[kart.charName] || 0)
    ];
}

// [groupe, image]. Le drapeau s'anime cote client : seul le groupe part.
function signTuple(state) {
    if (!state.sign) return null;
    return [state.sign.group, state.sign.group === 'finish' ? null : state.sign.frame];
}

// Les deux cameras pourraient se deduire du temps ecoule ; elles voyagent quand
// meme dans chaque snapshot, contre la certitude qu'aucun spectateur ne verra le
// decor decale.
//
// `vote` est le decompte du vote de redemarrage, [poses, spectateurs]. Il ne
// vient pas de l'etat du monde mais du service, seul a connaitre les
// connexions — d'ou ce parametre plutot qu'une lecture dans `state`. Le
// snapshot etant serialise une fois pour tout le monde, il ne peut porter que
// le total : chaque client se souvient seul de son propre vote.
function buildSnapshot(cfg, state, simTime, vote) {
    return {
        t: 's',
        // Arrondi a la milliseconde : l'horloge de simulation avance par pas de
        // 33,333 ms et traine donc des decimales qui ne servent a rien — le
        // client interpole sur des intervalles de 66 ms.
        ts: Math.round(simTime),
        cx: round(state.cameraX, 2),
        bx: round(state.bgCameraX, 2),
        k: state.karts.map(kartTuple),

        // Le releve de decision. Purement informatif — cf. `aiTuple`.
        ai: state.karts.map(kart => aiTuple(cfg, kart, simTime)),

        i: state.items.map(itemTuple),
        b: state.itemBoxes.map(box => (box.active ? 1 : 0)),

        // L'ordre d'arrivee est dans le snapshot : un spectateur qui se
        // connecte pendant le classement doit le voir en entier.
        ph: state.phase,
        lp: state.leaderLap,
        sg: signTuple(state),
        st: stormTuple(state),
        fo: state.finishOrder,

        // Le grand prix suit le meme principe que l'ordre d'arrivee : un
        // spectateur qui se connecte pendant le tableau des scores doit le voir
        // rempli, sans avoir assiste aux trois courses precedentes.
        gp: grandPrixTuple(state),

        // Meme regle : un arrivant doit voir le vote en cours, pas un compteur
        // a zero qui sauterait au snapshot suivant.
        vt: vote || [0, 0]
    };
}

// Envoye une fois par connexion. Contient l'identite des karts, la geometrie du
// monde, et un premier snapshot complet : de quoi construire la scene sans rien
// savoir de ce qui s'est passe avant.
//
// Le client ne garde aucune copie des constantes de simulation : elles arrivent
// toutes ici. C'est ce qui evite qu'un reglage de gameplay change d'un cote
// sans l'autre (§6.9).
function buildHello(cfg, state, simTime, t0, vote) {
    return {
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        serverTime: Date.now(),
        t0: t0,

        world: {
            width: cfg.world.width,
            finishLineX: cfg.world.finishLineX,
            sunX: cfg.world.sunX,
            roadMinY: cfg.road.minY,
            roadMaxY: cfg.road.maxY,
            roadPPS: cfg.speeds.roadPPS,
            // Duree du tete-a-queue : le client en derive la frame a afficher.
            hitDuration: cfg.delays.hitDecelDuration + cfg.delays.hitPauseDuration,
            // Geometrie des objets en orbite, pour les placer autour du kart.
            orbit: {
                count: cfg.orbit.count,
                radiusX: cfg.orbit.radiusX,
                radiusY: cfg.orbit.radiusY
            },
            // Cadence d'animation des carapaces en orbite, derivee du temps.
            shellAnimSpeed: cfg.itemAnim.greenShell.animSpeed,
            // Cadence des trois images du Bill Ball, derivee du temps elle aussi.
            billAnimSpeed: cfg.itemAnim.bill.animSpeed,

            laps: cfg.race.laps,
            // Nombre de courses d'un grand prix, pour l'entete « course N / M ».
            gpRaces: cfg.grandPrix.races,
            flagAnimSpeed: 220,
            // Rayon du souffle de la bleue : le client en tire la taille dessinee,
            // pour que l'effet couvre exactement la zone touchee.
            blastRadius: cfg.blueShell.blastRadiusX,
            // Taille d'un kart rapetisse, en fraction de sa taille normale : le
            // client ne decide pas de l'ampleur d'un malus de gameplay.
            shrinkScale: cfg.lightning.scale,

            // Les emprises REELLES des corps, pour la carte de debug. Elles ne
            // servent qu'a dessiner, comme les distances de vue juste en
            // dessous : une carte qui pose des pastilles de taille fixe ne dit
            // rien des largeurs qui decident du jeu — ni qu'un tuyau est plus
            // large qu'un kart, ni qu'une boite se ramasse sur la moitie de la
            // profondeur de piste.
            //
            // Ce sont des DEMI-emprises, et celles du corps lui-meme. La
            // distinction compte : les valeurs de `cfg.hitboxes` sont des ecarts
            // entre CENTRES, donc deja des sommes de deux corps, et les envoyer
            // telles quelles ferait dessiner des marques deux fois trop grandes.
            hitboxes: {
                // Le kart de REFERENCE — le sprite moyen du plateau. Chaque kart
                // a la sienne, plus longue ou plus courte selon son PNG, et elle
                // voyage avec son identite (`karts[].body` plus bas) : c'est
                // celle-la que la carte dessine. Celle-ci reste le repli, pour
                // un corps sans identite ou un serveur plus ancien.
                kart: {
                    x: cfg.hitboxes.kartVsKart.x / 2,
                    y: cfg.hitboxes.kartVsKart.y / 2
                },
                // Le tuyau porte sa propre emprise, sans rien y sommer — et elle
                // est RONDE : ce sont les demi-axes d'un disque, pas les cotes
                // d'une boite. Le client dessine la forme, pas seulement la
                // taille.
                pipe: {
                    x: cfg.pipe.hitbox.x,
                    y: cfg.pipe.hitbox.y,
                    round: true
                },
                // Un objet au sol ou en vol — carapace, banane. Meme emprise
                // pour tous, et prise DIRECTEMENT dans `bodies.item`.
                //
                // Elle se deduisait par soustraction — `itemVsKart` moins la
                // demi-carrosserie — et c'etait juste tant que la somme et la
                // carrosserie s'accordaient. Une fois la carrosserie derivee du
                // sprite et la somme restee figee, la soustraction rendait ce
                // qui restait : a `fill: 0.75`, une carapace se dessinait quatre
                // fois trop petite. C'est ce qu'on voyait sur la carte, et
                // c'etait fidele — l'incoherence etait dans la config.
                //
                // La bleue n'en a pas et n'apparait pas ici : elle survole tout,
                // et son souffle est un rayon qui CROIT avec le temps — deux
                // choses qu'une emprise fixe ne sait pas dire.
                item: {
                    x: cfg.bodies.item.x,
                    y: cfg.bodies.item.y
                },
                // Ou se tient un objet TRAINE derriere son porteur, en ecart
                // signe au centre du kart. C'est une position et non une
                // emprise, mais elle vit ici parce qu'elle ne sert qu'a la meme
                // chose : placer une hitbox sur la carte.
                //
                // A ne pas confondre avec `offsets.rendering.heldItemBehind`,
                // qui est un decalage de DESSIN et ne vaut pas la meme chose sur
                // mobile. Celui-ci est la valeur du monde, celle que la passe de
                // collision utilise.
                heldBehindX: cfg.offsets.world.heldItemBehind,

                // La boite a objets fait exception et n'est PAS une somme :
                // `itemBox.x` (10) est plus petit que la demi-carrosserie d'un
                // kart (30), ce qu'aucune somme ne permet. C'est une zone de
                // ramassage — l'endroit ou doit passer un CENTRE de kart — et
                // elle se dessine telle quelle.
                itemBox: {
                    x: cfg.hitboxes.itemBox.x,
                    y: cfg.hitboxes.itemBox.y
                }
            },

            // Les distances de la VUE, pour la carte de debug. Elles ne servent
            // qu'a dessiner : le releve de vision (`visionTuple`) porte deja ce
            // que le kart a effectivement percu, et rien ici ne sert a le
            // recalculer. Une portee dessinee est un decor, pas une deduction.
            //
            // Elles voyagent dans le `hello` comme toutes les autres constantes,
            // pour la meme raison : le client n'en garde aucune copie, et un
            // reglage change d'un cote ne peut pas rester faux de l'autre.
            vision: {
                rangeFront: cfg.vision.range.front,
                rangeBack: cfg.vision.range.back,
                pressureRange: cfg.vision.pressureRange,
                // La VOIE : la bande de profondeur ou un objet est sur la route.
                threatLane: cfg.vision.threatLane,
                // Le DEGAGEMENT : l'ecart au-dela duquel on passe a cote. C'est
                // la bande d'alignement du danger latent.
                clear: cfg.hitboxes.itemVsKart.y + cfg.vision.place.margin.item
            },

            // Taille DESSINEE du tuyau, en px de monde. Elle descend du serveur
            // parce que c'est elle qui decide de l'emprise : `pipe.hitbox` en
            // est une fraction fixe (cf. `bodies` en config). La laisser au
            // client rouvrirait la divergence qu'elle vient de fermer — un
            // sprite qui deborde de ce qui arrete un kart.
            //
            // La hauteur suit les proportions du fichier, elle ne se regle pas.
            pipeDraw: {
                w: round(cfg.pipe.draw.w, 2),
                h: round(cfg.pipe.draw.h, 2)
            }
        },

        // L'identite d'un kart, et son gabarit. Les deux voyagent ensemble parce
        // qu'ils viennent de la meme source : son sprite. `body` porte sa
        // demi-emprise reelle — ce que la carte de debug dessine — et `scale` le
        // rapport de son dessin a celui du kart de reference, que le client
        // multiplie par sa propre largeur (qui vaut moins sur mobile).
        //
        // Sans `scale`, le client redessinerait tous les karts a la meme
        // longueur alors que leurs emprises different : le dessin cesserait
        // d'etre la hitbox, ce que ce changement corrige precisement.
        karts: state.karts.map(kart => {
            const body = cfg.bodies.kart[kart.charName] || cfg.bodies.ref;
            return {
                id: kart.id,
                char: kart.charName,
                body: {
                    x: round(body.x, 2),
                    y: round(body.y, 3),
                    scale: round(body.scale, 4)
                }
            };
        }),
        boxes: state.itemBoxes.map(box => ({ x: round(box.worldX, 2), y: round(box.y, 2) })),

        // Les pipes ne bougent ni ne se detruisent : le `hello` suffit, ils
        // n'ont rien a faire dans un snapshot envoye dix fois par seconde.
        // L'ordre est celui de `state.pipes`, et c'est lui que porte l'index
        // d'un evenement `pipeShaken`.
        // `kind` porte la couleur du tuyau, et rien d'autre : le jeu ne la lit
        // pas, mais le decor ne peut pas la deduire — d'ou sa place ici, comme
        // le veut la regle du fichier.
        pipes: state.pipes.map(pipe => ({
            x: round(pipe.worldX, 2),
            y: round(pipe.y, 2),
            kind: pipe.kind || 'green'
        })),

        snapshot: buildSnapshot(cfg, state, simTime, vote)
    };
}

// Seuls ces evenements declenchent quelque chose cote client : le sursaut de la
// photo a l'impact, et le glissement au classement. Tous les autres decrivent
// des creations ou des destructions, que la reconciliation deduit deja du
// snapshot — les transmettre ne ferait que donner deux sources de verite.
// `pipeShaken` en fait partie parce qu'il ne se deduit d'aucun snapshot : le
// tuyau est au meme endroit avant et apres, seul le sursaut a eu lieu. Le choc
// d'un kart, lui, n'y est pas — il se lit dans son drapeau et sa date de fin.
const BROADCAST_EVENTS = new Set(['kartHit', 'leaderboardPosition', 'pipeShaken']);

function filterEvents(events) {
    return events.filter(ev => {
        if (!BROADCAST_EVENTS.has(ev.type)) return false;

        // Le classement est recalcule toutes les 500 ms et emet une position
        // pour chacun des huit karts, meme quand rien n'a bouge : seize
        // evenements par seconde dont l'immense majorite ne declenche aucune
        // animation. Seul un changement de place merite d'etre transmis —
        // l'arrivee au classement (prevPosition === -1) en est un.
        if (ev.type === 'leaderboardPosition' && ev.newPosition === ev.prevPosition) return false;

        return true;
    });
}

module.exports = {
    PROTOCOL_VERSION,
    FLAG_GRID,
    FLAG_HIT,
    FLAG_STOPPED,
    FLAG_STAR,
    FLAG_FINISHED,
    FLAG_SHRUNK,
    FLAG_BILL,
    FLAG_BUMPED,
    FLAG_FLAT,
    buildHello,
    buildSnapshot,
    visionTuple,
    filterEvents
};
