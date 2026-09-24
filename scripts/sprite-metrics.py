#!/usr/bin/env python3
"""Mesure les sprites du banner et reimprime le bloc `bodies.sprite` de
raceEngine/src/config/bodies.js.

Trois nombres par kart :

  w, h     le cadre de la pose de course (`side-right`). Les sprites sont
           detoures au plus juste, donc la largeur du fichier est la longueur
           du corps.
  wheels   la largeur ROUE A ROUE, lue sur le sprite de dos (`back`) : la
           rangee la plus large de la bande des roues, les WHEELS_BAND du bas.
           C'est elle qui porte la profondeur d'un kart. Ce qui touche, c'est le
           kart, pas son pilote : un personnage large d'epaules, les bras leves
           ou tres haut ne roule pas sur une voie plus large.

Aucune dependance : les assets sont des PNG a palette avec un chunk tRNS, que
ni `file` ni un coup d'oeil aux en-tetes ne savent compter. Le decodeur tient
en cinquante lignes, c'est moins cher qu'une bibliotheque a installer.

    python3 scripts/sprite-metrics.py
"""

import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMG = os.path.join(ROOT, 'frontEnd', 'static', 'img')

# L'ordre est celui de la configuration : celui de kartStats.characters, qui
# est aussi l'ordre du tirage du roster. La sortie se colle telle quelle.
KARTS = ['bowser', 'dk', 'mario', 'birdo', 'luigi', 'yoshi', 'peach', 'daisy', 'toad', 'koopa']

# Le plateau dont la moyenne fait le kart de reference : `bodies.referenceKarts`
# dans raceEngine/src/config/bodies.js, fige sur les huit d'origine. Les ratios
# imprimes plus bas sont pris contre lui, comme le fait le moteur.
REFERENCE = ['bowser', 'dk', 'mario', 'luigi', 'yoshi', 'peach', 'toad', 'koopa']

# La bande des roues, en part de la hauteur du sprite de dos, comptee depuis sa
# derniere rangee dessinee. Les roues y tiennent sur tout le plateau — de
# 96 px de haut (toad) a 140 (bowser) — et le personnage n'y descend pas : au-dessus,
# la largeur retombe sur les epaules ou le dossier.
WHEELS_BAND = 0.20

CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def read_png(path):
    """Rend (largeur, hauteur, type de couleur, canaux, pixels, tRNS)."""
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        raise ValueError(f'{path} : ce n\'est pas un PNG')

    idat = b''
    trns = None
    width = height = depth = color = None

    pos = 8
    while pos < len(data):
        length = struct.unpack('>I', data[pos:pos + 4])[0]
        kind = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        if kind == b'IHDR':
            width, height, depth, color = struct.unpack('>IIBB', chunk[:10])
            if depth != 8:
                raise ValueError(f'{path} : {depth} bits par canal, seul 8 est gere')
            if chunk[12] != 0:
                raise ValueError(f'{path} : entrelace, non gere')
        elif kind == b'IDAT':
            idat += chunk
        elif kind == b'tRNS':
            trns = chunk
        pos += 12 + length

    channels = CHANNELS[color]
    stride = width * channels
    raw = zlib.decompress(idat)

    # Defiltrage ligne a ligne : c'est tout ce qui separe un IDAT des pixels.
    out = bytearray()
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        kind = raw[pos]
        pos += 1
        line = bytearray(raw[pos:pos + stride])
        pos += stride
        if kind == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 255
        elif kind == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif kind == 3:
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif kind == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 255
        elif kind != 0:
            raise ValueError(f'{path} : filtre {kind} inconnu')
        out += line
        prev = line

    return width, height, color, channels, bytes(out), trns


def alpha_of(w, color, channels, px, trns):
    """La fonction qui rend l'alpha du pixel (x, y)."""
    def alpha(x, y):
        o = (y * w + x) * channels
        if color == 6:
            return px[o + 3]
        if color == 4:
            return px[o + 1]
        if color == 3:             # palette : l'alpha vit dans tRNS
            i = px[o]
            return trns[i] if trns and i < len(trns) else 255
        return 255                 # aucun canal alpha : tout est dessine
    return alpha


def drawn_pixels(path):
    """Le cadre et le nombre de pixels dont l'alpha n'est pas nul."""
    w, h, color, channels, px, trns = read_png(path)
    alpha = alpha_of(w, color, channels, px, trns)
    drawn = sum(1 for y in range(h) for x in range(w) if alpha(x, y))
    return w, h, drawn


def wheel_span(path):
    """La largeur roue a roue : la rangee la plus large de la bande des roues.

    La bande part de la derniere rangee DESSINEE, pas du bord du fichier : un
    sprite peut garder quelques rangees vides sous ses roues (bowser de dos).
    """
    w, h, color, channels, px, trns = read_png(path)
    alpha = alpha_of(w, color, channels, px, trns)

    spans = []
    for y in range(h):
        xs = [x for x in range(w) if alpha(x, y)]
        spans.append(xs[-1] - xs[0] + 1 if xs else 0)

    bottom = max(y for y in range(h) if spans[y])
    band = max(1, round(h * WHEELS_BAND))
    return max(spans[bottom - band + 1:bottom + 1])


def main():
    missing = []
    karts = []
    for name in KARTS:
        side = os.path.join(IMG, name, f'{name}-asset-anime', f'{name}-side-right.png')
        back = os.path.join(IMG, name, f'{name}-asset-anime', f'{name}-back.png')
        lost = [p for p in (side, back) if not os.path.exists(p)]
        if lost:
            missing += lost
            continue
        w, h, _ = drawn_pixels(side)
        karts.append((name, w, h, wheel_span(back)))

    pipe_path = os.path.join(IMG, 'decor', 'pipe-green.png')
    pipe = drawn_pixels(pipe_path) if os.path.exists(pipe_path) else None
    if pipe is None:
        missing.append(pipe_path)

    if missing:
        for path in missing:
            print(f'introuvable : {path}', file=sys.stderr)
        return 1

    pad = max(len(n) for n, _, _, _ in karts) + 1
    print('            sprite: {')
    print('                kart: {')
    for i, (name, w, h, wheels) in enumerate(karts):
        comma = ',' if i < len(karts) - 1 else ''
        print(f'                    {(name + ":").ljust(pad)} '
              f'{{ w: {w:3d}, h: {h:3d}, wheels: {wheels:3d} }}{comma}')
    print('                },')
    print(f'                pipe: {{ w: {pipe[0]}, h: {pipe[1]} }}')
    print('            },')

    # De quoi relire le tableau sans refaire les divisions de tete.
    ref = [k for k in karts if k[0] in REFERENCE]
    mean_w = sum(k[1] for k in ref) / len(ref)
    mean_wheels = sum(k[3] for k in ref) / len(ref)
    print(f'\n// moyenne du plateau de reference ({len(ref)} karts) : '
          f'longueur {mean_w:.2f} px, roue a roue {mean_wheels:.2f} px',
          file=sys.stderr)
    for name, w, h, wheels in sorted(karts, key=lambda k: -k[3]):
        print(f'//   {name:7s} {w:3d} x {h:3d}  roue a roue {wheels:3d}  '
              f'longueur x{w / mean_w:.4f}  profondeur x{wheels / mean_wheels:.4f}',
              file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
