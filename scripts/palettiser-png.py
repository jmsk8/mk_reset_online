#!/usr/bin/env python3
"""Passe en palette 256 couleurs les PNG RGBA de frontEnd/static/img.

    python3 scripts/palettiser-png.py

A relancer apres resize-karts.py, colorize-positions.py ou mario-builder.py.
Un fichier n'est remplace que si ses pixels transparents restent les memes
(mesures de sprite-metrics.py inchangees), si l'ecart visible reste sous
ECART_MAX et si le resultat est plus leger. Demande Pillow avec libimagequant.
"""

import io
import sys
from pathlib import Path

from PIL import Image, features

IMG = Path(__file__).resolve().parent.parent / 'frontEnd' / 'static' / 'img'
ECART_MAX = 64


def premultiplie(im):
    d = im.tobytes()
    return [(d[i] * d[i + 3] // 255, d[i + 1] * d[i + 3] // 255,
             d[i + 2] * d[i + 3] // 255, d[i + 3]) for i in range(0, len(d), 4)]


def quantifier(im):
    """255 couleurs, plus une entree reservee aux seuls pixels transparents
    (libimagequant y rangerait sinon les pixels presque transparents)."""
    q = im.quantize(255, method=Image.Quantize.LIBIMAGEQUANT, dither=Image.Dither.NONE)
    palette = (q.getpalette('RGBA') + [0] * 1024)[:255 * 4]
    for i in range(3, len(palette), 4):
        palette[i] = max(palette[i], 1)
    indices = bytes(255 if a == 0 else i
                    for i, a in zip(q.tobytes(), im.getchannel('A').tobytes()))
    sortie = Image.frombytes('P', im.size, indices)
    sortie.putpalette(palette + [0, 0, 0, 0], 'RGBA')
    return sortie


def palettiser(chemin):
    """Rend None si le fichier a ete remplace, sinon la raison du refus."""
    im = Image.open(chemin)
    tampon = io.BytesIO()
    quantifier(im).save(tampon, 'PNG', optimize=True)
    rendu = Image.open(io.BytesIO(tampon.getvalue())).convert('RGBA')

    avant, apres = premultiplie(im), premultiplie(rendu)
    if any((a[3] == 0) != (b[3] == 0) for a, b in zip(avant, apres)):
        return 'transparence modifiee'
    ecart = max(max(abs(x - y) for x, y in zip(a, b)) for a, b in zip(avant, apres))
    if ecart > ECART_MAX:
        return f'ecart {ecart}'
    if tampon.tell() >= chemin.stat().st_size:
        return 'pas plus leger'

    chemin.write_bytes(tampon.getvalue())
    return None


def main():
    if not features.check_feature('libimagequant'):
        sys.exit('Pillow doit etre compile avec libimagequant.')

    total_avant = total_apres = 0
    for chemin in sorted(IMG.rglob('*.png')):
        if Image.open(chemin).mode != 'RGBA':
            continue
        nom = chemin.relative_to(IMG)
        taille = chemin.stat().st_size
        refus = palettiser(chemin)
        if refus:
            print(f'  laisse  {nom} ({refus})')
            continue
        total_avant += taille
        total_apres += chemin.stat().st_size
        print(f'  {taille:7} -> {chemin.stat().st_size:7}  {nom}')
    print(f'{total_avant} -> {total_apres} octets')


if __name__ == '__main__':
    main()
