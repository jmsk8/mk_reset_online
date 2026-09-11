// <- raceEngine/src/config/bodies.js : deriveBodies().
//
// Port fidele de la LOI des corps. Rien ne se regle corps par corps : chaque
// emprise se deduit de la taille reelle du sprite, mesuree par
// `scripts/sprite-metrics.py`. Toucher un nombre ici sans toucher le JS fait
// diverger les deux moteurs sur ce qui touche quoi.

#include "config/config.hpp"

#include <stdexcept>
#include <string>

namespace config {

namespace {

// Le kart de REFERENCE : la moyenne du plateau, sur les deux mesures. Seul
// choix qui laisse les valeurs d'avant intactes au centre.
struct Reference {
    double w = 0;
    double px = 0;
};

Reference average_sprite(const KartStatsCfg& stats) {
    Reference ref;
    if (stats.characters.empty()) return ref;

    double sumW = 0;
    double sumPx = 0;
    for (const CharacterSpec& c : stats.characters) {
        sumW += c.spriteW;
        sumPx += c.spritePx;
    }
    ref.w = sumW / static_cast<double>(stats.characters.size());
    ref.px = sumPx / static_cast<double>(stats.characters.size());
    return ref;
}

} // namespace

void derive_bodies(Config& cfg) {
    BodiesCfg& b = cfg.bodies;

    // Un personnage non mesure roulerait a la taille moyenne du plateau sans que
    // rien ne le dise. `spritePx` est verifie a part : oublie, la profondeur
    // vaudrait NaN, et une comparaison contre NaN est toujours fausse — le kart
    // traverserait tout le monde sans qu'aucune erreur ne soit levee.
    for (const CharacterSpec& c : cfg.kartStats.characters) {
        if (!(c.spriteW > 0) || !(c.spritePx > 0)) {
            throw std::runtime_error("bodies.sprite.kart : " + c.name
                + " n'a pas de mesure complete (w, h, px). Relancer "
                "`python3 scripts/sprite-metrics.py` et recopier le bloc.");
        }
    }

    const Reference ref = average_sprite(cfg.kartStats);

    // Combien de px de demi-emprise vaut un px de sprite. Facteur unique, karts
    // compris : deux corps dessines a la meme echelle touchent a la meme echelle.
    const double perPx = (b.kartDraw * b.fill * 0.5) / ref.w;

    // La profondeur du kart de REFERENCE, et de lui seul — dernier endroit ou
    // `flatten` sert. Les autres s'en ecartent au prorata de leur SURFACE, pas
    // de leur longueur.
    const double refHalfY = (ref.w * perPx) / (b.flatten * b.depthPx);

    const auto bodyOf = [&](double w, double px) {
        KartBody body;
        // La LONGUEUR : la largeur du fichier, a l'echelle du monde.
        body.x = w * perPx;
        // La LARGEUR : la surface dessinee, rapportee a celle du corps moyen.
        // C'est le volume qui parle, pas l'encombrement.
        body.y = refHalfY * (px / ref.px);
        // Ce que le DESSIN doit faire de plus ou de moins que le kart de
        // reference. Sans unite : le client le multiplie par sa propre largeur,
        // qui vaut moins sur mobile. Il ne suit QUE la longueur.
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

    // Le tuyau passe par la meme regle, a une reserve pres : sa profondeur se
    // prend sur sa longueur — UN TUYAU EST ROND, d'ou la division par `depthPx`
    // seule. Il ne passe pas par `flatten`, qui n'est pas une loi de la nature
    // mais un choix de jeu : un kart a une emprise plus plate que sa silhouette
    // pour que rouler cote a cote reste jouable. Un obstacle immobile n'a rien
    // a negocier.
    const double pipeHalfX = b.pipeDraw * b.pipeFill * 0.5;
    cfg.pipe.hitbox = { pipeHalfX, pipeHalfX / b.depthPx };
    cfg.pipe.drawW = b.pipeDraw;
    // La hauteur suit les proportions du fichier, elle ne se regle pas : un
    // tuyau etire ou tasse ne ressemblerait plus a son emprise.
    cfg.pipe.drawH = b.pipeDraw * b.spritePipeH / b.spritePipeW;

    // Les ecarts entre CENTRES du kart de reference. Ce sont les distances de
    // PERCEPTION et de validation de piste, la ou une seule mesure vaut pour
    // tout le plateau.
    cfg.hitboxes.kartVsKart = { b.ref.x * 2, b.ref.y * 2 };
    cfg.hitboxes.kartVsPipe = {
        cfg.pipe.hitbox.x + b.ref.x,
        cfg.pipe.hitbox.y + b.ref.y
    };

    // Et l'objet, pour la meme raison. Ces sommes etaient posees a la main,
    // calees sur une demi-carrosserie de 30 : elles rognaient en silence la
    // part de l'objet des que la carrosserie changeait.
    cfg.hitboxes.itemVsKart = {
        b.item.x + b.ref.x,
        b.item.y + b.ref.y
    };

    // Le DEGAGEMENT de la vision : l'ecart au-dela duquel on passe a cote.
    // Derive pour la meme raison que les sommes ci-dessus.
    cfg.vision.clear = cfg.hitboxes.itemVsKart.y + cfg.vision.marginItem;
}

bool set_kart_count(Config& cfg, int requested) {
    // Bornes du plan §3 : de 1 a 12. Au-dela de 8 personnages, `world.cpp`
    // recycle le roster — ce n'est pas a cette fonction de le savoir.
    if (requested < 1 || requested > 12) return false;
    cfg.kartCount = requested;
    return true;
}

} // namespace config
