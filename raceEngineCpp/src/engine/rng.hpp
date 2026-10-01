// Hasard reproductible (mulberry32, comme raceEngine/tools/simulate.js). Le
// moteur ne lit ni horloge ni hasard global : tout arrive en parametre.

#pragma once

#include <cstdint>

namespace engine {

class Rng {
public:
    explicit Rng(uint32_t seed = 0x9E3779B9u) : state_(seed) {}

    // Meme suite que le JS a graine egale (la parite flottante bit a bit n'est
    // pas visee).
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
