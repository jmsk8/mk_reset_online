// Les quelques fonctions numeriques partagees.
// <- raceEngine/src/engine/math.js

#pragma once

#include <cmath>

namespace engine {

inline double clamp(double v, double lo, double hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

inline double lerp(double a, double b, double t) {
    return a + (b - a) * t;
}

// L'arrondi de JAVASCRIPT, et non celui de la libm. `Math.round` arrondit la
// moitie vers +INFINI ; `std::round` l'arrondit a l'oppose de zero. Les deux ne
// different que sur les negatifs exactement a .5 — mais `cx`, `dx`, `threatY` et
// les ombres passent en negatif, et le client verrait alors un pixel d'ecart
// sans qu'aucune erreur ne soit levee (plan §5.4).
inline double js_round(double v) {
    return std::floor(v + 0.5);
}

// Arrondi a N decimales, comme le `round(v, d)` de protocol.js : ce qui part
// dans le snapshot n'a pas besoin de la precision d'un double, et les chiffres
// en trop coutent de la bande passante dix fois par seconde.
inline double round_to(double v, int decimals) {
    double factor = 1;
    for (int i = 0; i < decimals; i++) factor *= 10;
    return js_round(v * factor) / factor;
}

} // namespace engine
