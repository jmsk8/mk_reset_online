// Tuyaux : taille, emprise et effets.

export default {
    // Obstacle fixe et indestructible, dessine dans tracks/ par un carre de `P`
    // (`p` pour un rouge, sans difference de jeu).
    pipe: {
        // Emprise deduite du dessin (`deriveBodies()`) : demi-axes d'un disque
        // (x en px de monde, y en unites de profondeur), environ 53 % de la
        // profondeur avec la carrosserie (voir tracks/README.md).

        // Duree du choc frontal (bien moins qu'un objet).
        bumpMs: 600,
        // Recul en px de monde (deduit aussi de la distance parcourue).
        recoilPx: 90,
        recoilMs: 250,
        // Sursis avant un nouveau choc.
        immuneMs: 700,
        // Poussee laterale vers le cote le plus degage.
        slideAway: 18,

        // Distance a laquelle un bill voit un tuyau (les karts utilisent
        // `vision.range`, a garder coherent).
        seeDistance: 1400,

        // Contournement : voir `ai.steering.pipe`.

        // Vertes : rebonds toleres (tuyaux et bords) avant destruction.
        maxShellBounces: 10,

        // Rouge en chasse : `look` = distance de decision en px, `margin` = jeu
        // au-dela de l'emprise, en fraction du demi-axe de profondeur.
        redShell: { look: 600, margin: 0.25 },

        // Avance maximale en profondeur par sous-pas des projectiles (moins que
        // la hitbox d'un kart).
        maxSubStepY: 1.5,
        // Avance maximale le long de la piste par sous-pas (contre les tuyaux).
        maxSubStepX: 8,
        maxSubSteps: 12,

        // Degagement apres un rebond, en fraction du rayon.
        escapeMargin: 0.06,

        // Passage libre minimal entre tuyaux, en positions de centre de kart,
        // verifie au chargement du circuit.
        minPassageY: 4
    },
};
