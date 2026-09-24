#!/usr/bin/env python3
"""Redimensionne les sprites de course des karts a leur gabarit Mario Kart 8
Deluxe, et les ecrit la ou le banner les sert.

    python3 scripts/resize-karts.py
    python3 scripts/sprite-metrics.py      # puis recopier le bloc imprime

La taille d'un kart ne se regle nulle part dans le code : le moteur MESURE les
PNG (scripts/sprite-metrics.py -> `bodies.sprite` de
raceEngine/src/config/bodies.js) et en tire la longueur dessinee et l'emprise.
Changer la taille d'un kart, c'est donc changer son fichier — et c'est ce qui
garde la hitbox fiable : elle decrit toujours ce qui est dessine.

Source et sortie
    assets-src/karts/<perso>/        les originaux, JAMAIS modifies
    frontEnd/static/img/<perso>/<perso>-asset-anime/   ce que sert le site

Le script repart toujours des originaux : le relancer donne les memes
fichiers, et un sprite n'est jamais redimensionne deux fois. Pour retoucher un
dessin, c'est l'original qu'on edite, puis on relance.

Le facteur
    Un par personnage, dans FACTEUR ci-dessous, tire des mesures MK8D (chaque
    personnage sur le meme kart). Tous les sprites SNES partagent le meme
    chassis (112 px de large au ras des roues) : c'est lui que le facteur met a
    l'echelle, et le personnage suit.

Le plus proche voisin, et rien d'autre : il ne fait que reprendre des pixels
existants. Le sprite garde sa palette et ses bords francs, et la surface
dessinee (`px`, qui porte la profondeur de l'emprise) reste comparable d'un
kart redimensionne a un kart d'origine. Un filtre lissant creerait des pixels
de bord semi-transparents, comptes pleins par sprite-metrics.py : il gonflerait
en silence l'emprise des seuls karts touches.

Aucune dependance, comme sprite-metrics.py dont on reprend le decodeur.
"""

import importlib.util
import os
import shutil
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets-src', 'karts')
IMG = os.path.join(ROOT, 'frontEnd', 'static', 'img')

# Le facteur applique a chaque original. Les mesures MK8D (L x H, en cm sur un
# ecran 27 pouces, chaque personnage sur le meme kart) en sont la base :
#
#   bowser 10.2 x 13.5   dk    10.0 x 11.4   yoshi 9.2 x 10.2   birdo 9.2 x 11.8
#   mario   9.2 x  9.3   luigi  9.2 x  9.9   daisy 9.2 x  8.5   peach 9.2 x  9.0
#   toad    7.7 x  8.1   koopa  7.2 x  8.3
#
# 9.2 est la largeur du gabarit moyen, dont les sprites restent a leur taille
# d'origine. Le chassis etant le meme sur tous les sprites SNES, `L / 9.2` le met
# a l'echelle MK8D. Ce premier calage, pose sur la seule largeur, laissait les
# petits trop petits : ils sont recales sur la largeur ET la hauteur. Birdo est
# une retouche a l'oeil, les mesures le donnant juste.
FACTEUR = {
    'bowser': 10.2 / 9.2,
    'dk':     10.0 / 9.2 * 0.95,   # a l'oeil : 5 % sous sa largeur MK8D
    'mario':  1,
    'birdo':  0.95,         # a l'oeil : un cran plus massive que ses voisins
    'luigi':  1,
    'yoshi':  1,
    'peach':  1,
    'daisy':  1,
    'toad':   0.86,         # largeur + hauteur (L seule donnait 0.837)
    'koopa':  0.86,         # largeur + hauteur (L seule donnait 0.783)
}

DIRECTIONS = ['side-right', 'front-right', 'front', 'back-right', 'back']

_spec = importlib.util.spec_from_file_location(
    'sprite_metrics', os.path.join(ROOT, 'scripts', 'sprite-metrics.py'))
_metrics = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_metrics)
read_png = _metrics.read_png


def chunks(data):
    """Les chunks d'un PNG, par type (le premier de chaque)."""
    out = {}
    pos = 8
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        out.setdefault(kind, data[pos + 8:pos + 8 + length])
        pos += 12 + length
    return out


def chunk(kind, body):
    crc = zlib.crc32(kind + body) & 0xffffffff
    return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', crc)


def resize(path, factor):
    """Le PNG `path` redimensionne au plus proche voisin, en octets.

    Chaque pixel cible reprend le pixel source sous son CENTRE : les rangees
    et colonnes perdues (ou doublees) se repartissent regulierement au lieu de
    s'accumuler d'un cote.
    """
    data = open(path, 'rb').read()
    w, h, color, channels, px, _ = read_png(path)
    nw, nh = round(w * factor), round(h * factor)
    stride = w * channels

    rows = []
    for y in range(nh):
        sy = min(h - 1, int((y + 0.5) * h / nh))
        line = px[sy * stride:(sy + 1) * stride]
        out = bytearray()
        for x in range(nw):
            sx = min(w - 1, int((x + 0.5) * w / nw)) * channels
            out += line[sx:sx + channels]
        rows.append(b'\x00' + bytes(out))

    # L'en-tete garde tout de l'original sauf les dimensions ; la palette et
    # la transparence d'un PNG a palette sont reprises telles quelles.
    header = chunks(data)
    ihdr = bytearray(header[b'IHDR'])
    ihdr[0:8] = struct.pack('>II', nw, nh)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', bytes(ihdr))
    for kind in (b'PLTE', b'tRNS'):
        if kind in header:
            png += chunk(kind, header[kind])
    png += chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
    png += chunk(b'IEND', b'')
    return png, (w, h), (nw, nh)


def main():
    missing = [n for n in FACTEUR for d in DIRECTIONS
               if not os.path.exists(os.path.join(SRC, n, f'{n}-{d}.png'))]
    if missing:
        for n in sorted(set(missing)):
            print(f'original manquant : assets-src/karts/{n}/', file=sys.stderr)
        return 1

    for name, factor in FACTEUR.items():
        dest_dir = os.path.join(IMG, name, f'{name}-asset-anime')
        os.makedirs(dest_dir, exist_ok=True)
        sizes = []
        for d in DIRECTIONS:
            src = os.path.join(SRC, name, f'{name}-{d}.png')
            dest = os.path.join(dest_dir, f'{name}-{d}.png')
            if factor == 1:
                # Gabarit de reference : l'original tel quel, octet pour
                # octet, plutot qu'un reencodage qui n'apporterait rien.
                shutil.copyfile(src, dest)
                w, h = read_png(src)[:2]
                sizes.append(f'{w}x{h}')
                continue
            png, _, (nw, nh) = resize(src, factor)
            with open(dest, 'wb') as f:
                f.write(png)
            sizes.append(f'{nw}x{nh}')
        print(f'{name:7s} x{factor:.3f}  ' + '  '.join(sizes))
    return 0


if __name__ == '__main__':
    sys.exit(main())
