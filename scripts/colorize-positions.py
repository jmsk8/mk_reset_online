#!/usr/bin/env python3
"""Colorise les chiffres de position (1st a 8th) du banner.

    python3 scripts/colorize-positions.py

Source et sortie
    assets-src/positions/<n>.png       les originaux en gris, JAMAIS modifies
    frontEnd/static/img/pos/<n>.png    ce que sert le site

Les originaux sont dessines en quatre gris : le contour noir (0), l'ombre du
relief (~85), sa face eclairee (~150) et la face du chiffre, blanche (255).
Chaque gris est remplace par la teinte correspondante de la palette -- une
table de correspondance en degrade, pas un filtre de couleur : le modele est
garde a l'identique, les bords restent francs, et chaque teinte est exactement
celle qu'on a choisie. Les gris intermediaires (l'anticrenelage entre deux
niveaux) sont interpoles entre les deux teintes voisines.

La face du chiffre n'est pas unie : elle suit un degrade vertical en trois
teintes, clair en haut et soutenu en bas, comme a l'ecran dans Mario Kart.

Palettes relevees sur des captures du jeu : l'orange du 7th vaut pour toutes
les places de 4 a 8 ; l'or, l'argent et le bronze sont ceux de 1st, 2nd et
3rd. Pour retoucher une couleur, c'est ici qu'on la change, puis on relance.

Aucune dependance, comme resize-karts.py dont on reprend l'encodage.
"""

import importlib.util
import os
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets-src', 'positions')
DEST = os.path.join(ROOT, 'frontEnd', 'static', 'img', 'pos')


def hexa(code):
    return tuple(int(code[i:i + 2], 16) for i in (1, 3, 5))


# contour, ombre, relief, puis la face : haut, milieu, bas.
PALETTES = {
    'or': {
        'contour': hexa('#1c1a14'), 'ombre': hexa('#7a5608'), 'relief': hexa('#b8860e'),
        'face': (hexa('#fff6b4'), hexa('#f6d63c'), hexa('#cc960c')),
    },
    'argent': {
        'contour': hexa('#1c2224'), 'ombre': hexa('#5e6a70'), 'relief': hexa('#9aa6ab'),
        'face': (hexa('#ffffff'), hexa('#e2eaec'), hexa('#b4c0c4')),
    },
    'bronze': {
        'contour': hexa('#2e1e16'), 'ombre': hexa('#6e4430'), 'relief': hexa('#b07852'),
        'face': (hexa('#fbe8d6'), hexa('#efc6a4'), hexa('#d49a70')),
    },
    'orange': {
        'contour': hexa('#1c1a14'), 'ombre': hexa('#8a3e00'), 'relief': hexa('#c8660a'),
        'face': (hexa('#fcb21c'), hexa('#f59a08'), hexa('#ea8600')),
    },
}

PLACES = {1: 'or', 2: 'argent', 3: 'bronze',
          4: 'orange', 5: 'orange', 6: 'orange', 7: 'orange', 8: 'orange'}

# Les gris de l'original, dans l'ordre. Ce sont eux que la palette remplace.
GRIS = (0, 85, 150, 255)

_spec = importlib.util.spec_from_file_location(
    'resize_karts', os.path.join(ROOT, 'scripts', 'resize-karts.py'))
_resize = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_resize)
read_png, chunk = _resize.read_png, _resize.chunk


def melange(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def face_a(palette, t):
    """La teinte de la face a la hauteur relative t (0 en haut, 1 en bas)."""
    haut, milieu, bas = palette['face']
    return melange(haut, milieu, t * 2) if t < 0.5 else melange(milieu, bas, t * 2 - 1)


def teinte(palette, gris, t):
    """La couleur d'un pixel gris `gris`, a la hauteur relative t."""
    arrets = (palette['contour'], palette['ombre'], palette['relief'], face_a(palette, t))
    for i in range(len(GRIS) - 1):
        if gris <= GRIS[i + 1]:
            k = (gris - GRIS[i]) / (GRIS[i + 1] - GRIS[i])
            return melange(arrets[i], arrets[i + 1], k)
    return arrets[-1]


def coloriser(path, palette):
    w, h, color, channels, px, _ = read_png(path)
    if channels != 4:
        raise ValueError(f'{path} : RGBA attendu, {channels} canaux')

    # Le degrade de la face court sur la hauteur DESSINEE, pas sur celle du
    # fichier : les marges transparentes l'ecraseraient sinon vers le milieu.
    lignes = [y for y in range(h)
              if any(px[(y * w + x) * 4 + 3] for x in range(w))]
    haut, bas = lignes[0], lignes[-1]

    rows = []
    for y in range(h):
        t = (y - haut) / max(1, bas - haut)
        out = bytearray()
        for x in range(w):
            i = (y * w + x) * 4
            r, g, b, a = px[i:i + 4]
            if a == 0:
                out += b'\x00\x00\x00\x00'
                continue
            out += bytes(teinte(palette, (r + g + b) / 3, min(1, max(0, t)))) + bytes((a,))
        rows.append(b'\x00' + bytes(out))

    ihdr = chunk(b'IHDR', w.to_bytes(4, 'big') + h.to_bytes(4, 'big') + bytes((8, 6, 0, 0, 0)))
    return (b'\x89PNG\r\n\x1a\n' + ihdr +
            chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b''))


def main():
    manquants = [n for n in PLACES if not os.path.exists(os.path.join(SRC, f'{n}.png'))]
    if manquants:
        for n in manquants:
            print(f'original manquant : assets-src/positions/{n}.png', file=sys.stderr)
        return 1

    os.makedirs(DEST, exist_ok=True)
    for n, nom in PLACES.items():
        png = coloriser(os.path.join(SRC, f'{n}.png'), PALETTES[nom])
        with open(os.path.join(DEST, f'{n}.png'), 'wb') as f:
            f.write(png)
        print(f'{n}  {nom}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
