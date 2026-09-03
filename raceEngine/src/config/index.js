// Constantes de simulation du banner SMK.
//
// L'etat du monde, jamais son apparence. Les constantes purement visuelles
// (chemins d'assets, tailles en px, z-index, breakpoint mobile) vivent dans
// `frontEnd/static/js/banner/config.js` et ne doivent jamais remonter ici : le
// navigateur ne charge plus ce fichier, seul le service `race` le lit.
//
// La configuration est decoupee par domaine, un fichier par domaine, et recollee
// ici. Un fragment ne connait pas les autres : ce sont des litteraux, sans
// reference croisee. Les seules valeurs calculees sont posees a la fin, par
// `deriveBodies`, qui a besoin de l'objet entier.

import bodies, { deriveBodies } from './bodies.js';
import world from './world.js';
import driving from './driving.js';
import items from './items.js';
import pipes from './pipes.js';
import vision from './vision.js';
import ai from './ai.js';

export default deriveBodies({
    ...bodies,
    ...world,
    ...driving,
    ...items,
    ...pipes,
    ...vision,
    ...ai,
});
