#include "engine/geometry.hpp"

namespace engine {

double get_shortest_distance(const config::Config& cfg, double fromX, double toX) {
    const double w = cfg.world.width;
    double diff = fromX - toX;
    if (diff < -w * 0.5) diff += w;
    if (diff > w * 0.5) diff -= w;
    return diff;
}

double forward_distance(const config::Config& cfg, double from, double to) {
    double d = to - from;
    if (d < 0) d += cfg.world.width;
    return d;
}

double park_position(const config::Config& cfg, double offset) {
    double x = cfg.world.finishLineX + offset;
    if (x < 0) x += cfg.world.width;
    if (x >= cfg.world.width) x -= cfg.world.width;
    return x;
}

double wrap_world_x(const config::Config& cfg, double x) {
    const double w = cfg.world.width;
    if (x >= w) x -= w;
    if (x < 0) x += w;
    return x;
}

} // namespace engine
