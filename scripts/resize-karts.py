#!/usr/bin/env python3
"""Redimensionne les sprites de course des karts au gabarit Mario Kart 8 Deluxe.

    python3 scripts/resize-karts.py
    python3 scripts/sprite-metrics.py      # puis recopier le bloc imprime

Le moteur mesure les PNG (sprite-metrics.py -> `bodies.sprite` de
raceEngine/src/config/bodies.js) pour en tirer longueur dessinee et emprise :
la taille d'un kart se change dans son fichier.

    assets-src/karts/<perso>/                          originaux, jamais modifies
    frontEnd/static/img/<perso>/<perso>-asset-anime/   sortie servie par le site

Le script repart toujours des originaux. Redimensionnement au plus proche
voisin : pas de pixels semi-transparents, qui fausseraient la mesure de surface
de sprite-metrics.py. Aucune dependance.
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

# Facteur par personnage, tire des mesures MK8D (L x H en cm sur un ecran 27
# pouces, chaque personnage sur le meme kart) :
#
#   bowser 10.2 x 13.5   dk    10.0 x 11.4   yoshi 9.2 x 10.2   birdo 9.2 x 11.8
#   mario   9.2 x  9.3   luigi  9.2 x  9.9   daisy 9.2 x  8.5   peach 9.2 x  9.0
#   toad    7.7 x  8.1   koopa  7.2 x  8.3
#
# 9.2 = largeur du gabarit moyen (sprites gardes a leur taille). Les petits sont
# cales sur la largeur et la hauteur ; dk et birdo sont ajustes a l'oeil.
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

    Chaque pixel cible reprend le pixel source sous son centre.
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
                # Gabarit de reference : copie telle quelle.
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
