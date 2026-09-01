#!/usr/bin/env python3
"""Mesure les sprites du banner et reimprime le bloc `bodies.sprite` de
physics-config.js.

Trois nombres par fichier :

  w, h   le cadre. Les sprites sont detoures au plus juste, donc la largeur du
         fichier est la longueur du corps.
  px     la surface dessinee : les pixels dont l'alpha n'est pas nul. C'est
         elle qui porte la profondeur d'un kart — le cadre dit ou s'arrete le
         dessin, la surface dit ce qu'il y a dedans.

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

# L'ordre est celui de physics-config.js : celui de kartStats.characters, du
# plus lourd au plus leger. La sortie se colle telle quelle.
KARTS = ['bowser', 'dk', 'mario', 'luigi', 'yoshi', 'peach', 'toad', 'koopa']

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


def drawn_pixels(path):
    """Le cadre et le nombre de pixels dont l'alpha n'est pas nul."""
    w, h, color, channels, px, trns = read_png(path)

    if color in (0, 2):            # aucun canal alpha : tout est dessine
        return w, h, w * h

    drawn = 0
    for y in range(h):
        row = px[y * w * channels:(y + 1) * w * channels]
        for x in range(w):
            o = x * channels
            if color == 6:
                alpha = row[o + 3]
            elif color == 4:
                alpha = row[o + 1]
            else:                  # palette : l'alpha vit dans tRNS
                i = row[o]
                alpha = trns[i] if trns and i < len(trns) else 255
            if alpha:
                drawn += 1
    return w, h, drawn


def main():
    missing = []
    karts = []
    for name in KARTS:
        path = os.path.join(IMG, name, f'{name}-asset-anime', f'{name}-side-right.png')
        if not os.path.exists(path):
            missing.append(path)
            continue
        karts.append((name,) + drawn_pixels(path))

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
    for i, (name, w, h, drawn) in enumerate(karts):
        comma = ',' if i < len(karts) - 1 else ''
        print(f'                    {(name + ":").ljust(pad)} '
              f'{{ w: {w}, h: {h}, px: {drawn:5d} }}{comma}')
    print('                },')
    print(f'                pipe: {{ w: {pipe[0]}, h: {pipe[1]} }}')
    print('            },')

    # De quoi relire le tableau sans refaire les divisions de tete.
    total = sum(k[3] for k in karts)
    mean = total / len(karts)
    print(f'\n// moyenne du plateau : {mean:.2f} px dessines', file=sys.stderr)
    for name, w, h, drawn in sorted(karts, key=lambda k: -k[3]):
        print(f'//   {name:7s} {w:3d} x {h:3d}  {drawn:6d} px  '
              f'{100 * drawn / (w * h):5.1f} % du cadre  '
              f'x{drawn / mean:.4f} de la moyenne', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
