// Distances et positions sur un circuit qui boucle.
// Rien ici ne connait ni kart ni objet : ce sont des mesures sur l'axe de la
// piste, et elles valent pour n'importe quel corps pose dessus.

function getShortestDistance(cfg, fromX, toX) {
    const w = cfg.world.width;
    let diff = fromX - toX;
    if (diff < -w * 0.5) diff += w;
    if (diff > w * 0.5) diff -= w;
    return diff;
}

// Ecart au premier, mesure en distance restante : deux karts partis de
// rangs differents n'ont pas la meme distance a couvrir, comparer leurs
// compteurs bruts placerait la pole en dernier au premier virage.
function remainingDistance(kart) {
    return kart.finishDistance - kart.totalDistance;
}

// Distance a parcourir vers l'avant pour aller de `from` a `to`. La camera
// ne recule jamais : le decor defilerait a l'envers.
function forwardDistance(cfg, from, to) {
    let d = to - from;
    if (d < 0) d += cfg.world.width;
    return d;
}

// Position de la camera face a la ligne. La camera designe le centre de la
// vue, donc un ecart negatif place la ligne a droite du centre.
function parkPosition(cfg, offset) {
    let x = cfg.world.finishLineX + offset;
    if (x < 0) x += cfg.world.width;
    if (x >= cfg.world.width) x -= cfg.world.width;
    return x;
}

// Le projectile a-t-il croise cette profondeur pendant le pas ?
//
// Comparer la seule position d'arrivee suffisait tant qu'une carapace
// derivait a peine. Depuis qu'elle peut traverser la piste en trois pas, il
// faut regarder le segment parcouru : sinon elle passe d'un cote a l'autre
// d'un kart entre deux images, sans jamais avoir ete a sa hauteur.
function crossedDepth(item, targetY, tolerance) {
    const from = item.prevY;
    const to = item.y;
    const lo = (from < to ? from : to) - tolerance;
    const hi = (from > to ? from : to) + tolerance;
    return targetY > lo && targetY < hi;
}

export {
    crossedDepth,
    forwardDistance,
    getShortestDistance,
    parkPosition,
    remainingDistance,
};
