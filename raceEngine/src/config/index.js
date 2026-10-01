// Constantes de simulation du banner, un fichier par domaine (l'apparence est
// dans frontEnd/static/js/banner/config.js). Les valeurs derivees sont
// calculees a la fin par `deriveBodies`.

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
