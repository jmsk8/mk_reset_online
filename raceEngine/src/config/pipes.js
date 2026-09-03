// Les tuyaux : leur taille, leur emprise, ce qu'ils font a qui les touche.

export default {
    // Le pipe : le seul element du monde de masse infinie. Il ne bouge pas, ne se
    // detruit pas, et ne cede jamais — il se contourne. Il se dessine par un `P`
    // dans tracks/, comme une boite par un `B` ; un `p` en pose un rouge, qui
    // n'est que la meme chose repeinte — rien ici ne connait sa couleur, et rien
    // ne doit.
    pipe: {
        // Aucune constante ne convertit ici la profondeur en pixels, et c'est
        // voulu : le rebond travaille dans un espace normalise — chaque axe
        // divise par son demi-axe — ou les deux unites disparaissent
        // d'elles-memes.

        // L'emprise au sol du tuyau ne se regle plus ici DU TOUT : les deux
        // demi-axes se deduisent de son dessin, qui se deduit de son fichier (cf.
        // `bodies` et `deriveBodies()`).
        //
        //     pipe.hitbox = { x: 21.84, y: 6.07 } // 21.84 px = 6.07 u
        //
        // Ce sont les DEMI-AXES D'UN DISQUE et non les cotes d'une boite : le
        // tuyau est le seul corps rond du moteur, comme il est le seul a se
        // dessiner rond. Une carapace y rebondit sur la normale du point touche,
        // sous un angle qui varie continument le long de l'arc (cf.
        // `bounceItemOffPipe`). `x` est en px de monde, `y` en unites de
        // profondeur.
        //
        // Il coute cher, et il faut le savoir en dessinant un circuit : 9.2 de
        // degagement avec la carrosserie, soit 53 % de la profondeur.
        // `tracks/README.md` en tire la table de placement.
        //
        // Rond sur une piste de 30 unites il en mangerait 68 %, et le placement a
        // deux tuyaux redeviendrait impraticable : `road.maxY` a 35 et ce disque
        // vont ensemble, l'un ne se defait pas sans l'autre.

        // Ce qu'un choc frontal coute a un kart. Bien moins qu'un objet (2000 ms
        // de tete-a-queue) : un mur se croise a chaque tour, un objet non.
        bumpMs: 600,
        // Recul, en pixels de monde et en millisecondes. Il entame aussi la
        // distance parcourue : position et progression restent cousues.
        recoilPx: 90,
        recoilMs: 250,
        // Sursis avant qu'un nouveau choc soit possible. Sans lui, un kart encore
        // au contact rejouerait le choc a chaque pas de simulation.
        immuneMs: 700,
        // Poussee laterale donnee au choc, vers le cote le plus degage. Sans
        // elle, un kart pousse par le peloton resterait plaque contre le tuyau
        // jusqu'a la fin de la course, et le chien de garde du service se
        // contenterait de le constater.
        slideAway: 18,

        // Distance a laquelle un BILL voit un tuyau. Les karts voient par
        // `vision.range`, comme pour tout le reste ; un bill n'a pas de vue — il
        // ne pilote pas, il vole — et c'est la seule chose qu'il lui reste a
        // regarder. A tenir avec `vision.range.front` : un kart n'a aucune raison
        // de voir un mur moins loin qu'un bill.
        seeDistance: 1400,

        // Contournement : le kart choisit un couloir et le rejoint. Le COMMENT se
        // regle avec les autres manoeuvres laterales, dans `ai.steering.pipe`. Ce
        // qui reste ici ne concerne que le trace — ou l'on a le droit de passer,
        // pas comment on y va.

        // Vertes : nombre de rebonds tolere, pipes et bords de piste confondus.
        // Au suivant, la carapace se detruit. C'est aussi ce qui donne enfin une
        // duree de vie a une verte, qui n'en avait aucune.
        maxShellBounces: 10,

        // Integration des projectiles par sous-pas. A 880 px/s et 45 degres, une
        // verte traverse la piste en un dixieme de seconde : en un seul pas de 33
        // ms elle avancerait de 8 unites de profondeur, soit plus que la hitbox
        // d'un kart (5) — elle enjamberait ses victimes sans les toucher. Chaque
        // sous-pas est borne a cette avance.
        maxSubStepY: 1.5,
        maxSubSteps: 12,

        // Marge de degagement apres un rebond, en fraction du rayon. Sans elle,
        // la carapace repart depuis la surface exacte de l'ellipse, y rentre au
        // sous-pas suivant et vibre sur place.
        escapeMargin: 0.06,

        // Passage libre minimal, mesure en positions de CENTRE de kart : la
        // demi-carrosserie est deja dans `kartVsPipe`. Celui-ci demande de la
        // marge, parce qu'un kart arrive rarement pile dans l'axe.
        //
        // A 6, un tuyau pose au milieu de la piste passe des deux cotes ; a 8, ce
        // cas le plus naturel de tous serait refuse.
        //
        // Ce seuil ne concerne PLUS QUE LE CHARGEMENT : le pilotage note les
        // couloirs au lieu de les refuser, et sait emprunter plus serre que 6
        // quand c'est le moins cher. Un circuit qui n'en laisse pas autant est
        // refuse au demarrage — un mur de tuyaux rendrait la course infinissable
        // sans qu'aucune erreur ne soit levee.
        minPassageY: 6
    },
};
