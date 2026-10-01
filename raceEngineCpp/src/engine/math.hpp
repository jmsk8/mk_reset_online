// Fonctions numeriques partagees.
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

// Arrondi de JavaScript (moitie vers +infini), different de `std::round` sur
// les negatifs a .5.
inline double js_round(double v) {
    return std::floor(v + 0.5);
}

// Arrondi a N decimales, comme `round(v, d)` de protocol.js.
inline double round_to(double v, int decimals) {
    double factor = 1;
    for (int i = 0; i < decimals; i++) factor *= 10;
    return js_round(v * factor) / factor;
}

} // namespace engine
