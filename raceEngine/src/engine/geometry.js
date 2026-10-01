// Distances et positions sur un circuit qui boucle.

function getShortestDistance(cfg, fromX, toX) {
    const w = cfg.world.width;
    let diff = fromX - toX;
    if (diff < -w * 0.5) diff += w;
    if (diff > w * 0.5) diff -= w;
    return diff;
}

// Distance restant a parcourir (les karts ne partent pas tous du meme rang).
function remainingDistance(kart) {
    return kart.finishDistance - kart.totalDistance;
}

// Distance vers l'avant de `from` a `to` (la camera ne recule jamais).
function forwardDistance(cfg, from, to) {
    let d = to - from;
    if (d < 0) d += cfg.world.width;
    return d;
}

// Position de la camera face a la ligne (centre de la vue).
function parkPosition(cfg, offset) {
    let x = cfg.world.finishLineX + offset;
    if (x < 0) x += cfg.world.width;
    if (x >= cfg.world.width) x -= cfg.world.width;
    return x;
}

// Vrai si le projectile a croise cette profondeur pendant le pas (on teste le
// segment parcouru, pas seulement la position d'arrivee).
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
