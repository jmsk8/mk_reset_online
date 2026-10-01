#!/usr/bin/env python3
"""Détoure Mario bâtisseur et assemble son coup de marteau pour la page de
maintenance (nginx/maintenance/page.html).

    python3 scripts/mario-builder.py

Source et sortie
    assets-src/mario-builder/1-3.png        originaux, jamais modifiés
    assets-src/mario-builder/bloc.png       bloc du sol, opaque
    frontEnd/static/img/mario-builder/
        1.png, 2.png, 3.png                 les mêmes, détourés
        marteau.png                         les trois poses en bande, calées
        bloc.png                            le bloc, recopié

Taille et nombre de blocs, vitesse du marteau : variables CSS de la page.

Poses, dans l'ordre du coup : 2 marteau levé, 1 élan, 3 frappe.

Détourage : le fond bleu uni (#00ACFF) est retiré par remplissage depuis les
bords, sans tolérance. Le script échoue s'il reste du fond enfermé dans le
dessin.

Calage : chaque pose est recadrée au plus près, puis alignée en bas et sur le
bord gauche de la semelle du pied d'appui (ANCRE, relevé sur chaque original).

Plus proche voisin partout : aucun pixel n'est recalculé.
"""
from collections import deque
from pathlib import Path

from PIL import Image

RACINE = Path(__file__).resolve().parent.parent
SOURCE = RACINE / "assets-src" / "mario-builder"
SORTIE = RACINE / "frontEnd" / "static" / "img" / "mario-builder"

FOND = (0, 172, 255)

# Ordre de la bande = ordre du coup de marteau.
POSES = ["2.png", "1.png", "3.png"]

# Bord gauche de la semelle du pied d'appui, sur la dernière rangée.
ANCRE = {"1.png": 77, "2.png": 38, "3.png": 42}


def detourer(chemin):
    im = Image.open(chemin).convert("RGBA")
    w, h = im.size
    px = im.load()
    vus = set()
    file = deque([(x, y) for x in range(w) for y in (0, h - 1)]
                 + [(x, y) for y in range(h) for x in (0, w - 1)])
    while file:
        x, y = file.popleft()
        if (x, y) in vus or not (0 <= x < w and 0 <= y < h):
            continue
        if px[x, y][:3] != FOND:
            continue
        vus.add((x, y))
        px[x, y] = (0, 0, 0, 0)
        file.extend([(x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)])
    restes = sum(1 for x in range(w) for y in range(h)
                 if px[x, y][3] and px[x, y][:3] == FOND)
    if restes:
        raise SystemExit(f"{chemin.name} : {restes} px de fond enfermés dans le dessin")
    return im


def verifier_ancre(nom, im):
    """La semelle doit commencer exactement à ANCRE sur la dernière rangée."""
    px = im.load()
    y = im.height - 1
    x = ANCRE[nom]
    if px[x, y][3] == 0 or (x > 0 and px[x - 1, y][3] != 0):
        raise SystemExit(f"{nom} : la semelle ne commence plus en x={x}, "
                         "revoir ANCRE après retouche de l'original")


def main():
    SORTIE.mkdir(parents=True, exist_ok=True)
    images = {}
    for nom in POSES:
        im = detourer(SOURCE / nom)
        verifier_ancre(nom, im)
        im.save(SORTIE / nom, optimize=True)
        images[nom] = im

    # Cadre commun : l'ancre de chaque pose tombe au même x, les bas alignés.
    gauche = max(ANCRE[n] for n in POSES)
    largeur = max(gauche - ANCRE[n] + images[n].width for n in POSES)
    hauteur = max(images[n].height for n in POSES)

    bande = Image.new("RGBA", (largeur * len(POSES), hauteur), (0, 0, 0, 0))
    for i, nom in enumerate(POSES):
        im = images[nom]
        bande.paste(im, (i * largeur + gauche - ANCRE[nom], hauteur - im.height))
    bande.save(SORTIE / "marteau.png", optimize=True)
    print(f"marteau.png : {len(POSES)} poses de {largeur} x {hauteur}")

    # Bloc recopié via Pillow : la sortie ne dépend que du script.
    bloc = Image.open(SOURCE / "bloc.png").convert("RGBA")
    bloc.save(SORTIE / "bloc.png", optimize=True)
    print(f"bloc.png : {bloc.width} x {bloc.height}")


if __name__ == "__main__":
    main()
