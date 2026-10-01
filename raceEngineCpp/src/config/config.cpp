// <- raceEngine/src/config/bodies.js : deriveBodies().
//
// Chaque emprise se deduit de la taille reelle du sprite
// (`scripts/sprite-metrics.py`). Toute modification doit etre reportee dans le JS.

#include "config/config.hpp"

#include <stdexcept>
#include <string>

namespace config {

namespace {

// Kart de reference : moyenne du plateau d'origine (`referenceKarts`) sur les
// deux mesures.
struct Reference {
    double w = 0;
    double px = 0;
};

Reference average_sprite(const KartStatsCfg& stats, const BodiesCfg& b) {
    Reference ref;
    double sumW = 0;
    double sumPx = 0;
    for (const std::string& name : b.referenceKarts) {
        const CharacterSpec* found = nullptr;
        for (const CharacterSpec& c : stats.characters) {
            if (c.name == name) { found = &c; break; }
        }
        if (!found) {
            throw std::runtime_error("bodies.referenceKarts : " + name
                + " n'est pas dans kartStats.characters.");
        }
        sumW += found->spriteW;
        sumPx += found->spritePx;
    }
    if (b.referenceKarts.empty()) return ref;
    ref.w = sumW / static_cast<double>(b.referenceKarts.size());
    ref.px = sumPx / static_cast<double>(b.referenceKarts.size());
    return ref;
}

} // namespace

void derive_bodies(Config& cfg) {
    BodiesCfg& b = cfg.bodies;

    // Tout personnage doit etre mesure ; sans `spritePx`, la profondeur vaudrait
    // NaN et le kart ne toucherait rien.
    for (const CharacterSpec& c : cfg.kartStats.characters) {
        if (!(c.spriteW > 0) || !(c.spritePx > 0)) {
            throw std::runtime_error("bodies.sprite.kart : " + c.name
                + " n'a pas de mesure complete (w, h, px). Relancer "
                "`python3 scripts/sprite-metrics.py` et recopier le bloc.");
        }
    }

    const Reference ref = average_sprite(cfg.kartStats, b);

    // Px de demi-emprise par px de sprite, commun a tous les corps.
    const double perPx = (b.kartDraw * b.fill * 0.5) / ref.w;

    // Profondeur du kart de reference ; les autres en derivent au prorata de
    // leur surface.
    const double refHalfY = (ref.w * perPx) / (b.flatten * b.depthPx);

    const auto bodyOf = [&](double w, double px) {
        KartBody body;
        // Longueur : largeur du fichier, a l'echelle du monde.
        body.x = w * perPx;
        // Largeur : surface dessinee rapportee a celle du kart de reference.
        body.y = refHalfY * (px / ref.px);
        // Echelle de dessin relative au kart de reference (longueur seule) ;
        // le client la multiplie par sa propre largeur.
        body.scale = w / ref.w;
        return body;
    };

    b.refSpriteW = ref.w;
    b.refSpritePx = ref.px;
    const KartBody refBody = bodyOf(ref.w, ref.px);
    b.ref = { refBody.x, refBody.y };

    cfg.bodiesByCharacter.clear();
    cfg.bodiesByCharacter.reserve(cfg.kartStats.characters.size());
    for (const CharacterSpec& c : cfg.kartStats.characters) {
        cfg.bodiesByCharacter.push_back(bodyOf(c.spriteW, c.spritePx));
    }

    // Tuyau : meme regle, mais rond (profondeur prise sur la longueur) et sans
    // `flatten`, reserve aux karts.
    const double pipeHalfX = b.pipeDraw * b.pipeFill * 0.5;
    cfg.pipe.hitbox = { pipeHalfX, pipeHalfX / b.depthPx };
    cfg.pipe.drawW = b.pipeDraw;
    // Hauteur dessinee : proportions du fichier.
    cfg.pipe.drawH = b.pipeDraw * b.spritePipeH / b.spritePipeW;

    // Ecarts entre centres du kart de reference (perception, validation de
    // piste).
    cfg.hitboxes.kartVsKart = { b.ref.x * 2, b.ref.y * 2 };
    cfg.hitboxes.kartVsPipe = {
        cfg.pipe.hitbox.x + b.ref.x,
        cfg.pipe.hitbox.y + b.ref.y
    };

    // Idem pour l'objet.
    cfg.hitboxes.itemVsKart = {
        b.item.x + b.ref.x,
        b.item.y + b.ref.y
    };

    // Degagement de la vision : ecart au-dela duquel on passe a cote.
    cfg.vision.clear = cfg.hitboxes.itemVsKart.y + cfg.vision.marginItem;
}

bool set_kart_count(Config& cfg, int requested) {
    // De 1 a 12 ; au-dela du roster, `world.cpp` recycle les personnages.
    if (requested < 1 || requested > 12) return false;
    cfg.kartCount = requested;
    cfg.kartCountForced = true;
    return true;
}

} // namespace config
