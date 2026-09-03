// Les quelques fonctions numeriques que tout le moteur partage.

function shuffleArray(array, rng) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

function randomRange(rng, min, max) {
    return rng() * (max - min) + min;
}

function lerp(min, max, t) {
    return min + (max - min) * t;
}

function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
}

// Distribution des objets : modele documente en tete de `itemDistribution`
// dans src/config/. Ce qui suit n'en est que l'evaluation, aucun
// objet n'est nomme ici.

function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}

// Monte de 0 en `from` a 1 en `to`, plate au-dela des deux bornes.
function ramp(value, from, to) {
    if (to === from) return value < from ? 0 : 1;
    return clamp01((value - from) / (to - from));
}

// Un descripteur illisible vaut 1 plutot que de faire disparaitre l'objet.
function curveFactor(seg, x) {
    if (seg.rise) {
        const floor = seg.floor || 0;
        return floor + (1 - floor) * ramp(x, seg.rise[0], seg.rise[1]);
    }
    if (seg.fall) {
        const depth = (seg.depth === undefined) ? 1 : seg.depth;
        return 1 - depth * ramp(x, seg.fall[0], seg.fall[1]);
    }
    if (seg.bell !== undefined) {
        return Math.max(0, 1 - Math.abs(x - seg.bell) / seg.width);
    }
    return 1;
}

// Produit des facteurs d'une courbe ; absente, elle vaut 1.
function curve(segments, x) {
    if (!segments) return 1;
    let value = 1;
    for (let i = 0; i < segments.length; i++) value *= curveFactor(segments[i], x);
    return value > 0 ? value : 0;
}

export {
    clamp,
    clamp01,
    curve,
    lerp,
    ramp,
    randomRange,
    shuffleArray,
};
