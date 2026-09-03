// Protocole serveur → client du banner.
//
// Regle qui gouverne tout ce fichier : LE SNAPSHOT FAIT FOI. Un spectateur qui se
// connecte a la 187e seconde n'a vu passer aucun evenement et doit pourtant
// afficher une scene complete et juste — les evenements ne servent qu'a jouer des
// animations.
//
// Avant d'ajouter un element visuel cote client : un arrivant peut-il le deduire
// du seul snapshot ? Si non, c'est ici qu'il manque un champ.

const PROTOCOL_VERSION = 11;

// Champ de bits de l'etat d'un kart. Compact parce qu'il part dix fois par
// seconde a chaque spectateur.
const FLAG_GRID = 1;      // sur la grille, avant le coup d'envoi
const FLAG_HIT = 2;       // percute -> tete-a-queue
const FLAG_STOPPED = 4;   // immobilise apres impact -> sprite fige
const FLAG_STAR = 8;      // etoile active -> halo
const FLAG_FINISHED = 16; // a franchi la ligne -> tour d'honneur
const FLAG_SHRUNK = 32;   // rapetisse par l'eclair -> sprite reduit
const FLAG_BILL = 64;     // transforme en Bill Ball -> sprite remplace
const FLAG_BUMPED = 128;  // arrete net par un pipe : arret et recul, sprite inchange
const FLAG_FLAT = 256;    // ecrase par un kart reste grand -> sprite aplati

// Le releve de decision, pour le HUD de debug : ce que le kart VOIT et ce qu'il
// en FAIT, en un seul entier. Rien ici ne pilote le rendu — un client qui
// l'ignore affiche exactement la meme course.
//
// Il part toujours, et c'est un choix : un releve disponible sur demande
// obligerait a redemarrer le service pour observer un comportement qu'on vient de
// voir. A huit karts et dix envois par seconde, un entier ne pese rien.
//
// Les deux tables voyagent DANS le `hello` (`world.ai`) : le client recoit un
// indice ET l'ordre qui lui donne son sens, puis traduit la cle en libelle.
// Inserer un etat au milieu ne decale donc rien.
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
    // derriere lui — sans avoir besoin de l'avoir deja lache.
    //
    // C'etait le seul danger que le releve ne disait pas : on voyait un kart se
    // ranger sans savoir pourquoi, et surtout on ne pouvait pas voir qu'il ne se
    // rangeait pas. Il porte le souvenir autant que la vue — le HUD doit dire ce
    // sur quoi le kart DECIDE.
    if (sight.pressure && !sight.pressureBack) v |= 1 << 12;

    return v;
}

// La vue elle-meme, pour la carte de debug. L'entier `aiTuple` dit ce que le kart
// a RETENU, pas ce qu'il a regarde ni ce qu'une ombre lui a cache — et c'est
// precisement la que se logent les erreurs de perception.
//
// Il part SUR DEMANDE (`{t:'watch', id}`) et non dans le snapshot : celui-ci est
// serialise une fois pour tous, ce releve pese cent fois l'entier de decision, et
// il ne sert qu'au spectateur qui a ouvert la carte. Personne ne regarde : pas un
// octet de plus.
//
// La regle du fichier tient quand meme — le client ne DEDUIT rien, tout ce qui se
// dessine est ici. Convention de signe habituelle : un kart en negatif (`-1 -
// id`), un objet a partir de 1.
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

    // Les ombres, resolues ICI en profondeurs plutot qu'envoyees en pentes : une
    // projection refaite cote client est une projection qui peut diverger.
    //
    // Chaque ombre est un trapeze au sol — [debut, fin] en ecart au kart, et les
    // deux profondeurs a chaque bout, car elle s'ELARGIT en s'eloignant de
    // l'oeil.
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
        // `sight.back`, qui bascule a la cadence de l'affichage : dessiner
        // l'autre ferait pointer le cone dans le sens ou le contenu n'a pas ete
        // releve.
        id: kart.id,
        back: sight.back ? 1 : 0,
        scanBack: sight.scanBack ? 1 : 0,
        range: Math.round(sight.scanRange),
        at: Math.round(sight.at),

        // D'ou part le regard. Le client a la position du kart, mais interpolee :
        // la faire servir d'origine decalerait tout le dessin d'une demi-frame.
        x: round(kart.worldX, 2),
        y: round(kart.yPercent, 2),

        spans: spans,
        hidden: hidden,
        shadows: shadows,

        // Le recul de la camera, pour la poser sur la carte : elle n'est pas sur
        // le kart, et c'est visible — les ombres partent d'un point qui n'est pas
        // lui.
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

// [id, worldX, yPercent, totalDistance, flags, rank, heldId, heldType, heldHold,
// orbitAngle, orbIds, hitEnd, bumpEnd]
//
// `heldType` est indispensable : sans lui un arrivant verrait une banane a la
// place d'une carapace. Pour une orbite c'est le type de l'objet ENFANT qui part,
// seul utile au rendu.
//
// `hitEnd` et `bumpEnd` sont les fins de malus en temps serveur. Le tete-a-queue
// et le recul sont des animations derivees du temps : sans ces dates, un arrivant
// saurait qu'un kart est touche mais pas depuis quand.
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
        // devine pas depuis `hop`, positif aussi a la descente. Le drapeau part
        // tel quel pour la carte de debug.
        item.rising ? 1 : 0
    ];
}

// [debut, frappe, fin, lanceur] en temps serveur, ou null hors orage. Les trois
// dates suffisent au client a placer la scene ou qu'il en soit, plutot que de
// rejouer l'orage depuis le debut. Le lanceur suit : c'est le seul que la foudre
// epargne.
function stormTuple(state) {
    const storm = state.storm;
    if (!storm) return null;
    return [Math.round(storm.startedAt), Math.round(storm.strikeAt), Math.round(storm.until), storm.shooterId];
}

// [manche, points de la course, points du grand prix]. Les deux tableaux sont
// alignes sur l'ordre de `state.karts`, qui est aussi celui du `hello` : le
// client lit la case i pour le kart i, sans transporter les noms a chaque envoi.
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
// `vote` vient du service et non de l'etat du monde, seul a connaitre les
// connexions. Le snapshot etant serialise une fois pour tous, il ne peut porter
// que le total : chaque client se souvient seul de son propre vote.
function buildSnapshot(cfg, state, simTime, vote) {
    return {
        t: 's',
        // Arrondi a la milliseconde : l'horloge de simulation traine des
        // decimales qui ne servent a rien, le client interpolant sur des
        // intervalles de 66 ms.
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

// Envoye une fois par connexion : l'identite des karts, la geometrie du monde, et
// un premier snapshot complet — de quoi construire la scene sans rien savoir de
// ce qui precede.
//
// Le client ne garde aucune copie des constantes de simulation, elles arrivent
// toutes ici : c'est ce qui evite qu'un reglage change d'un cote sans l'autre.
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

            // Les cles du releve de decision, DANS L'ORDRE des indices envoyes
            // par `aiTuple`. Le client y lit le sens d'un indice au lieu de
            // maintenir une copie de cet ordre.
            ai: { states: AI_STATES, dangers: AI_DANGERS },

            // Les emprises REELLES des corps, pour la carte de debug : une carte
            // qui pose des pastilles de taille fixe ne dit rien des largeurs qui
            // decident du jeu.
            //
            // Ce sont des DEMI-emprises, et celles du corps lui-meme. La
            // distinction compte : les valeurs de `cfg.hitboxes` sont des ecarts
            // entre CENTRES, donc deja des sommes de deux corps.
            hitboxes: {
                // Le kart de REFERENCE. Chaque kart a la sienne, qui voyage avec
                // son identite (`karts[].body`) : celle-ci n'est que le repli.
                kart: {
                    x: cfg.hitboxes.kartVsKart.x / 2,
                    y: cfg.hitboxes.kartVsKart.y / 2
                },
                // Le tuyau porte sa propre emprise, sans rien y sommer — et elle
                // est RONDE : ce sont les demi-axes d'un disque. Le client
                // dessine la forme, pas seulement la taille.
                pipe: {
                    x: cfg.pipe.hitbox.x,
                    y: cfg.pipe.hitbox.y,
                    round: true
                },
                // Un objet au sol ou en vol. Meme emprise pour tous, prise
                // DIRECTEMENT dans `bodies.item` : deduite par soustraction
                // depuis `itemVsKart`, elle rendait ce qui restait une fois la
                // carrosserie derivee du sprite — a `fill: 0.75`, une carapace se
                // dessinait quatre fois trop petite.
                //
                // La bleue n'apparait pas ici : elle survole tout, et son souffle
                // est un rayon qui CROIT avec le temps.
                item: {
                    x: cfg.bodies.item.x,
                    y: cfg.bodies.item.y
                },
                // Ou se tient un objet TRAINE derriere son porteur, en ecart
                // signe au centre. C'est une position et non une emprise, mais
                // elle ne sert qu'a la meme chose : placer une hitbox sur la
                // carte. A ne pas confondre avec
                // `offsets.rendering.heldItemBehind`, qui est un decalage de
                // DESSIN.
                heldBehindX: cfg.offsets.world.heldItemBehind,

                // La boite a objets n'est PAS une somme : `itemBox.x` est plus
                // petit que la demi-carrosserie d'un kart. C'est une zone de
                // ramassage — l'endroit ou doit passer un CENTRE de kart.
                itemBox: {
                    x: cfg.hitboxes.itemBox.x,
                    y: cfg.hitboxes.itemBox.y
                }
            },

            // Les distances de la VUE, pour la carte de debug. Elles ne servent
            // qu'a dessiner — `visionTuple` porte deja ce que le kart a percu.
            // Elles voyagent dans le `hello` comme le reste : le client n'en
            // garde aucune copie.
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
            // parce que c'est elle qui decide de l'emprise (`pipe.hitbox` en est
            // une fraction fixe) : la laisser au client rouvrirait la divergence
            // qu'elle vient de fermer. La hauteur suit les proportions du
            // fichier.
            pipeDraw: {
                w: round(cfg.pipe.draw.w, 2),
                h: round(cfg.pipe.draw.h, 2)
            }
        },

        // L'identite d'un kart, et son gabarit : les deux viennent de la meme
        // source, son sprite. `body` porte sa demi-emprise reelle, `scale` le
        // rapport de son dessin a celui du kart de reference — que le client
        // multiplie par sa propre largeur, qui vaut moins sur mobile. Sans
        // `scale`, tous les karts seraient dessines a la meme longueur alors que
        // leurs emprises different.
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

        // Les tuyaux ne bougent ni ne se detruisent : le `hello` suffit. L'ordre
        // est celui de `state.pipes`, et c'est lui que porte l'index d'un
        // evenement `pipeShaken`. `kind` porte la couleur, que le jeu ne lit pas
        // mais que le decor ne peut pas deduire.
        pipes: state.pipes.map(pipe => ({
            x: round(pipe.worldX, 2),
            y: round(pipe.y, 2),
            kind: pipe.kind || 'green'
        })),

        snapshot: buildSnapshot(cfg, state, simTime, vote)
    };
}

// Seuls ces evenements declenchent quelque chose cote client. Les autres
// decrivent des creations ou des destructions que la reconciliation deduit deja
// du snapshot — les transmettre donnerait deux sources de verite.
//
// `pipeShaken` en fait partie parce qu'il ne se deduit d'aucun snapshot : le
// tuyau est au meme endroit avant et apres, seul le sursaut a eu lieu.
const BROADCAST_EVENTS = new Set(['kartHit', 'leaderboardPosition', 'pipeShaken']);

function filterEvents(events) {
    return events.filter(ev => {
        if (!BROADCAST_EVENTS.has(ev.type)) return false;

        // Le classement est recalcule toutes les 500 ms et emet une position pour
        // chacun des huit karts, meme quand rien n'a bouge. Seul un changement de
        // place merite d'etre transmis — l'arrivee au classement (prevPosition
        // === -1) en est un.
        if (ev.type === 'leaderboardPosition' && ev.newPosition === ev.prevPosition) return false;

        return true;
    });
}

export {
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
