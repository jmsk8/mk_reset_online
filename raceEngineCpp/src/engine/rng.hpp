// Le hasard, reproductible.
// <- raceEngine/tools/simulate.js : mulberry32
//
// Le moteur est PUR : `step_physics` ne lit ni l'horloge, ni le hasard global,
// ni l'appareil — tout arrive en parametre. C'est ce qui rend le banc
// d'equilibrage possible, et il faut que ca le reste (architecture.md §6).
//
// Exception a la regle « struct, pas de classe » du plan §4.1ter : ce type
// n'encode aucune regle de gameplay, seulement une mecanique technique.

#pragma once

#include <cstdint>

namespace engine {

class Rng {
public:
    explicit Rng(uint32_t seed = 0x9E3779B9u) : state_(seed) {}

    // mulberry32 : meme suite que le JS a graine egale. La parite flottante bit
    // a bit avec le JS n'est pas un objectif (piege P-5) — mais la SUITE de
    // nombres, elle, l'est : c'est ce qui permet de comparer deux courses.
    double next() {
        state_ += 0x6D2B79F5u;
        uint32_t t = state_;
        t = (t ^ (t >> 15)) * (t | 1u);
        t ^= t + (t ^ (t >> 7)) * (t | 61u);
        return static_cast<double>((t ^ (t >> 14)) >> 0) / 4294967296.0;
    }

    double range(double min, double max) {
        return min + next() * (max - min);
    }

    void reseed(uint32_t seed) { state_ = seed; }

private:
    uint32_t state_;
};

} // namespace engine
