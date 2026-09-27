#!/usr/bin/env python3
"""Dessine la banniere d'automne : le fond qui defile lentement et le premier
plan qui suit la route.

    python3 scripts/banner-autumn.py                     # ecrit les deux PNG
    python3 scripts/banner-autumn.py --preview DOSSIER   # + apercus composes
    python3 scripts/banner-autumn.py --theme desert --out assets-src/banners/automne-desert

Trois themes, qui ne changent que le decor (arbres identiques) :
    france   ciel abricot, forets lointaines, pres verts — celui du site
    bleu     le meme sous un ciel bleu, sans forets
    desert   le premier jet, ciel orange et collines rousses, garde pour memoire.
             Il prend les arbres actuels : le premier jet tel quel est dans
             assets-src/banners/automne-desert/.

Sortie : frontEnd/static/img/banners/autumn/
    index-banner-autumn.png             le fond (moitie de la vitesse de la route)
    index-banner-autumn-midground.png   le second plan (trois quarts)
    index-banner-autumn-foreground.png  le premier plan (vitesse de la route)

Les trois font 3840 x 285, comme ceux de l'ete : banner.css les etire sur la
hauteur du ciel et les repete en X, la bande doit donc boucler sans couture.
Tout ce qui est dessine ici est enroule modulo la largeur.

Le fond part de index-banner-defaut.png : memes collines, memes ovales de
nuages, au pixel pres. Seules les couleurs changent, et le ciel recoit de gros
nuages. Nuages et premier plan sont dessines a 2x (un pixel « SNES » = 2 x 2
pixels d'image) ; le premier plan porte trois arbres : un chene orange, un
bouleau dore, un erable rouge. Le second plan, sur son propre calque, un rang
des memes arbres plus petits, qui glissent derriere eux.

Le dessin est deterministe (graines fixes) : relancer donne les memes fichiers.
Pour retoucher, on change les tables ci-dessous et on relance.
"""
import argparse
import math
import random
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BANNERS = ROOT / 'frontEnd/static/img/banners'
SRC = BANNERS / 'index-banner-defaut.png'
OUT = BANNERS / 'autumn'

W, H = 3840, 285
LW, LH = W // 2, 143          # le canevas « SNES », agrandi 2x a la fin
N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))

# Couleurs de la banniere par defaut, qui sert de gabarit.
D_HILL = (159, 231, 119)
D_GROUND = (181, 248, 134)
BLACK = (0, 0, 0)

# ── Themes ──────────────────────────────────────────────────────────────────
# Les couleurs du decor. Les arbres, les clotures et les feuilles n'en dependent
# pas : ce sont eux qui disent l'automne.
THEMES = {
    'france': {
        # Un orange doux, abricot plutot que feu : celui du premier jet, en moins marque.
        'SKY_STOPS': [(0.0, (234, 150, 102)), (0.5, (244, 180, 130)),
                      (0.85, (250, 206, 160)), (1.0, (253, 222, 184))],
        'HILLS': [(118, 172, 82), (180, 102, 62), (166, 168, 72)],   # vert, roux, vert-jaune
        'OVAL_FILL': (255, 244, 228),
        'FIELD': [(134, 186, 92), (118, 168, 80)],
        'CLOUD': {'outline': (192, 124, 110), 'shadow': (226, 166, 150),
                  'low': (244, 204, 186), 'body': (255, 234, 216), 'rim': (255, 248, 238)},
        'BANK': {'top': (255, 232, 204), 'body': (250, 216, 182)},
        'BAND': {'edge': (56, 104, 40), 'edge_alt': (78, 128, 46), 'top': (112, 166, 64),
                 'top_alt': (96, 148, 56), 'ground': (100, 150, 58), 'stripe': (118, 168, 68),
                 'leaves': 0.08},
        'HAZE': ((252, 218, 176), 0.24),
        'FOREST': True,
        'BACK_TREES': [('erable', 240, 0.50), ('chene', 470, 0.55), ('bouleau', 560, 0.50),
                       ('erable', 800, 0.46), ('bouleau', 1010, 0.55), ('chene', 1230, 0.50),
                       ('erable', 1335, 0.55), ('chene', 1565, 0.46), ('bouleau', 1745, 0.50)],
    },
    'bleu': {     # le ciel bleu du 27/09 au matin, sans forets

        'SKY_STOPS': [(0.0, (62, 132, 210)), (0.5, (104, 168, 226)),
                      (0.85, (152, 200, 238)), (1.0, (188, 222, 244))],
        'HILLS': [(118, 172, 82), (196, 122, 64), (166, 168, 72)],   # vert, roux, vert-jaune
        'OVAL_FILL': (255, 255, 255),
        'FIELD': [(134, 186, 92), (118, 168, 80)],
        'CLOUD': {'outline': (112, 140, 188), 'shadow': (174, 196, 228),
                  'low': (214, 228, 246), 'body': (246, 250, 255), 'rim': (255, 255, 255)},
        'BANK': {'top': (236, 244, 252), 'body': (214, 232, 248)},
        'BAND': {'edge': (56, 104, 40), 'edge_alt': (78, 128, 46), 'top': (112, 166, 64),
                 'top_alt': (96, 148, 56), 'ground': (100, 150, 58), 'stripe': (118, 168, 68),
                 'leaves': 0.08},
        'HAZE': ((188, 222, 244), 0.24),
        'FOREST': False,
        'BACK_TREES': [('erable', 240, 0.42), ('chene', 470, 0.46), ('bouleau', 560, 0.42),
                       ('erable', 800, 0.38), ('bouleau', 1010, 0.46), ('chene', 1230, 0.42),
                       ('erable', 1335, 0.46), ('chene', 1565, 0.38), ('bouleau', 1745, 0.42)],
    },
    'desert': {
        'SKY_STOPS': [(0.0, (222, 104, 56)), (0.45, (242, 146, 74)),
                      (0.8, (252, 186, 100)), (1.0, (255, 212, 138))],
        'HILLS': [(200, 96, 46), (214, 150, 52), (172, 110, 62)],   # rouille, ocre, brun
        'OVAL_FILL': (255, 240, 214),
        'FIELD': [(214, 150, 66), (196, 128, 54)],
        'CLOUD': {'outline': (190, 100, 72), 'shadow': (232, 152, 114),
                  'low': (248, 194, 148), 'body': (255, 226, 188), 'rim': (255, 247, 228)},
        'BANK': {'top': (255, 222, 164), 'body': (252, 204, 140)},
        'BAND': {'edge': (112, 98, 36), 'edge_alt': (138, 120, 44), 'top': (176, 150, 60),
                 'top_alt': (150, 128, 48), 'ground': (166, 108, 58), 'stripe': (186, 128, 70),
                 'leaves': 0.05},
        'HAZE': ((255, 212, 138), 0.0),
        'FOREST': False,
        'BACK_TREES': [],       # le premier jet n'avait pas de second rang
    },
}


def use_theme(name):
    """Pose les couleurs du theme en globales, lues par tout le dessin."""
    globals().update(THEMES[name])


use_theme('france')

FENCE = {'outline': (63, 39, 22), 'post': (90, 58, 34),
         'top': (150, 112, 63), 'bottom': (122, 82, 48)}
LEAVES = [(206, 58, 36), (234, 128, 38), (244, 194, 66), (168, 62, 30)]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def sky_color(y, horizon=235):
    # Paliers de 3 lignes, comme le degrade de l'ete : un degrade HDMA de SNES.
    t = min(1.0, (y // 3 * 3) / horizon)
    for (t0, c0), (t1, c1) in zip(SKY_STOPS, SKY_STOPS[1:]):
        if t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0))
    return SKY_STOPS[-1][1]


def components(mask, w, h):
    """Composantes 4-connexes d'un masque [y][x] -> liste de listes de (x, y)."""
    seen = [[False] * w for _ in range(h)]
    out = []
    for y0 in range(h):
        for x0 in range(w):
            if not mask[y0][x0] or seen[y0][x0]:
                continue
            comp, q = [], deque([(x0, y0)])
            seen[y0][x0] = True
            while q:
                x, y = q.popleft()
                comp.append((x, y))
                for dx, dy in N4:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            out.append(comp)
    return out


def puffs(blobs, rng, wobble):
    """Rend l'union de disques bosseles -> {(x, y): indice du disque devant}.

    Les disques sont peints dans l'ordre : le dernier qui couvre un pixel le
    possede. `wobble` fait onduler le bord (feuillage, pas nuage)."""
    owner = {}
    for i, (bx, by, r) in enumerate(blobs):
        ph = [rng.uniform(0, 2 * math.pi) for _ in range(3)]
        for y in range(int(by - r - 3), int(by + r + 4)):
            for x in range(int(bx - r - 3), int(bx + r + 4)):
                ddx, ddy = x + .5 - bx, y + .5 - by
                ang = math.atan2(ddy, ddx)
                rr = r + wobble * (1.3 * math.sin(5 * ang + ph[0]) + .8 * math.sin(9 * ang + ph[1])
                                   + .5 * math.sin(13 * ang + ph[2]))
                if math.hypot(ddx, ddy) <= rr:
                    owner[(x, y)] = i
    return owner


def is_edge(mask, x, y):
    return any((x + dx, y + dy) not in mask for dx, dy in N4)


# ── Fond ────────────────────────────────────────────────────────────────────

def cloud_sprite(rng, width, height):
    """Un cumulus a fond plat, en pixels logiques -> {(x, y): couleur}.

    Une rangee de petites bosses posees sur la base, et par-dessus quelques
    grosses, plus hautes au milieu. Chaque bosse de devant garde un liseré
    clair la ou elle passe devant celle de derriere : c'est ce qui la detache,
    comme les touffes des arbres."""
    base = height - 1
    blobs = []
    r0 = height * 0.36
    n = math.ceil((width - 2 * r0) / (1.2 * r0)) + 1    # assez serrees pour se toucher
    for i in range(n):                                  # la rangee du bas
        r = r0 * rng.uniform(0.9, 1.1)
        blobs.append((r0 + i / (n - 1) * (width - 2 * r0), base - r * 0.55, r))
    m = max(2, width // 34)
    for i in range(m):                                  # les dômes
        t = (i + 0.5) / m
        r = height * rng.uniform(0.34, 0.46) * (0.75 + 0.35 * math.sin(math.pi * t))
        cx = width * (0.18 + 0.64 * t) + rng.uniform(-3, 3)
        blobs.append((cx, base - height + r + rng.uniform(0, 3), r))
    # Du haut vers le bas : les bosses basses passent devant.
    blobs.sort(key=lambda b: b[1] - b[2] * 0.1)
    owner = {p: i for p, i in puffs(blobs, rng, 0).items()
             if 0 <= p[0] < width and 0 <= p[1] <= base}
    px = {}
    for (x, y), i in owner.items():
        bx, by, r = blobs[i]
        ny = (y + .5 - by) / r
        t = (base - y) / height
        up = owner.get((x, y - 1))
        if is_edge(owner, x, y):
            c = CLOUD['outline']
        elif (x, y - 2) not in owner or (up is not None and up < i):
            c = CLOUD['rim']
        elif t < 0.12 or (t < 0.18 and (x + y) % 2):
            c = CLOUD['shadow']
        elif ny > 0.5 or t < 0.3 or (ny > 0.35 and (x + y) % 2):
            c = CLOUD['low']
        else:
            c = CLOUD['body']
        px[(x, y)] = c
    return px


def streak_sprite(length):
    """Un long nuage effile, en pixels logiques."""
    px = {}
    for x in range(length):
        t = x / (length - 1)
        thick = 1 + round(2 * math.sin(math.pi * t) ** 0.7)
        for y in range(3 - thick, 3):
            px[(x, y)] = CLOUD['rim'] if y == 3 - thick else CLOUD['low']
    return px


def bank_sprite(rng, width):
    """Le banc de nuages lointains qui court derriere les collines."""
    px = {}
    phase = [rng.uniform(0, 2 * math.pi) for _ in range(3)]
    for x in range(width):
        a = 2 * math.pi * x / width
        top = 7 + 2.2 * math.sin(3 * a + phase[0]) + 1.6 * math.sin(7 * a + phase[1]) \
            + 1.2 * abs(math.sin(19 * a + phase[2]))
        for y in range(int(12 - top), 12):
            px[(x, y)] = BANK['top'] if y == int(12 - top) else BANK['body']
    return px


# Gros nuages : (x logique, y logique, largeur, hauteur, graine). Places a
# l'ecart des ovales du gabarit (verifie au lancement).
CLOUDS = [(40, 6, 150, 40, 1), (560, 30, 110, 32, 2), (870, 2, 146, 44, 3),
          (1300, 22, 124, 34, 4), (1646, 6, 96, 28, 5), (1716, 40, 84, 22, 6),
          (330, 66, 70, 20, 7)]
STREAKS = [(200, 56, 90), (720, 12, 120), (1150, 58, 70), (1450, 8, 110),
           (1800, 26, 80), (480, 16, 60)]


def build_background():
    src = Image.open(SRC).convert('RGB')
    sp = src.load()
    kind = [[0] * W for _ in range(H)]      # 0 ciel, 1 colline, 2 sol, 3 trait
    for y in range(H):
        for x in range(W):
            c = sp[x, y]
            kind[y][x] = 3 if c == BLACK else 1 if c == D_HILL else 2 if c == D_GROUND else 0

    # Le ciel ferme par un trait noir, c'est l'interieur d'un ovale de nuage.
    # Les decorations du defaut (soleil, PUSH B, notes) sont redevenues du ciel.
    open_sky = [[False] * W for _ in range(H)]
    q = deque((x, 0) for x in range(W) if kind[0][x] == 0)
    for x, y in q:
        open_sky[y][x] = True
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            nx %= W
            if 0 <= ny < H and kind[ny][nx] == 0 and not open_sky[ny][nx]:
                open_sky[ny][nx] = True
                q.append((nx, ny))

    out = Image.new('RGB', (W, H))
    op = out.load()
    for y in range(H):
        sky = sky_color(y)
        for x in range(W):
            k = kind[y][x]
            if k == 0:
                op[x, y] = sky if open_sky[y][x] else OVAL_FILL
            elif k == 3:
                op[x, y] = BLACK
            elif k == 2:
                op[x, y] = FIELD[field_band(y)]

    hill_mask = [[kind[y][x] == 1 for x in range(W)] for y in range(H)]
    hills = sorted(components(hill_mask, W, H), key=lambda c: min(p[0] for p in c))
    # Une colline a cheval sur le raccord sort en deux morceaux : celui du bord
    # droit reprend la couleur de celui du bord gauche.
    label = {p: i for i, comp in enumerate(hills) for p in comp}
    color = list(range(len(hills)))
    for y in range(H):
        if (0, y) in label and (W - 1, y) in label:
            color[label[(W - 1, y)]] = color[label[(0, y)]]
    for i, comp in enumerate(hills):
        for x, y in comp:
            op[x, y] = HILLS[color[i] % len(HILLS)]

    # Nuages, dessines a 2x et poses seulement sur le ciel ouvert : ils passent
    # derriere les collines, et on verifie qu'aucun ne touche un ovale.
    ovals = oval_boxes(open_sky, kind)

    def paint(sprite, lx, ly, label):
        for (x, y), c in sprite.items():
            for sy in range(2):
                fy = (ly + y) * 2 + sy
                for sx in range(2):
                    fx = ((lx + x) * 2 + sx) % W
                    if not (0 <= fy < H):
                        continue
                    if any(x0 - 4 <= fx <= x1 + 4 and y0 - 4 <= fy <= y1 + 4
                           for x0, y0, x1, y1 in ovals):
                        raise SystemExit(f'{label} touche un ovale en ({fx}, {fy})')
                    if kind[fy][fx] == 0 and open_sky[fy][fx]:
                        op[fx, fy] = c

    bank = bank_sprite(random.Random(9), LW)
    for (x, y), c in bank.items():           # a ras de l'horizon, sous tout le reste
        for sy in range(2):
            for sx in range(2):
                fx, fy = x * 2 + sx, (106 + y) * 2 + sy
                if fy < H and kind[fy][fx] == 0 and open_sky[fy][fx]:
                    op[fx, fy] = c
    for lx, ly, length in STREAKS:
        paint(streak_sprite(length), lx, ly, f'la trainee x={lx}')
    for lx, ly, cw, ch, seed in CLOUDS:
        paint(cloud_sprite(random.Random(seed), cw, ch), lx, ly, f'le nuage x={lx}')
    if FOREST:
        for (x, y), c in forest_belt().items():
            for sy in range(2):
                fy = y * 2 + sy
                if fy < H:
                    for sx in range(2):
                        op[x * 2 + sx, fy] = c
    return out


# Forets lointaines : des massifs bombes le long de l'horizon, devant les
# collines, separes par des clairieres. Chaque massif est un tas de petites
# couronnes rondes, plus haut en son coeur ; les couronnes du haut passent
# derriere. Teintes d'automne melangees, voilees par la distance.
FOREST_FAMILIES = [   # (clair, moyen, sombre), poids
    (((236, 156, 82), (212, 118, 54), (156, 78, 42)), 3),     # orange
    (((212, 106, 66), (182, 74, 46), (128, 50, 36)), 2),      # rouille
    (((238, 202, 102), (212, 166, 62), (156, 116, 42)), 2),   # or
    (((170, 168, 86), (138, 140, 62), (96, 100, 46)), 2),     # olive
    (((122, 156, 86), (92, 128, 66), (64, 92, 50)), 1),       # vert
]
FOREST_FLOOR = (78, 62, 44)       # le sous-bois, sous les couronnes
FOREST_VEIL = 0.36                # part de la couleur de l'horizon
FOREST_SCALE = 30                 # longueur du motif : plus court, des bois plus petits
FOREST_THRESHOLD = 0.68           # une huitaine de petits bois bas sur la bande
FOREST_HEIGHT = 4                 # hauteur logique du coeur d'un massif, au-dessus de 2 : plat
FOREST_CROWN = (2.0, 3.2)         # rayon logique d'une couronne
FOREST_MIN_WIDTH = 16             # un bois plus etroit ne serait qu'une poussiere
HORIZON_L = 118                   # ligne logique de l'horizon (236 en image)


def looped(x, y, sx, sy, seed):
    """Le bruit de `noise`, rendu periodique sur la largeur de la bande : il
    vaut la meme chose en 0 et en LW, et la foret ne s'arrete pas au raccord."""
    return ((LW - x) * noise(x, y, sx, sy, seed) + x * noise(x - LW, y, sx, sy, seed)) / LW


def forest_belt():
    rng = random.Random(41)
    fams = [f for f, wgt in FOREST_FAMILIES for _ in range(wgt)]

    def family(x):
        # Par plaques, comme une vraie foret : un bois roux, puis un bois dore...
        if rng.random() < 0.2:
            return rng.choice(fams)
        return fams[min(len(fams) - 1, int(looped(x, 7, 26, 1, 43) * len(fams)))]

    horizon = SKY_STOPS[-1][1]
    # Ou pousse la foret, colonne par colonne, sans les bois trop etroits.
    on = [looped(x, 0, FOREST_SCALE, 1, 41) > FOREST_THRESHOLD for x in range(LW)]
    keep = [False] * LW
    x = 0
    while x < LW:
        if on[x] and not on[x - 1]:
            end = x
            while on[end % LW] and end - x < LW:
                end += 1
            if end - x >= FOREST_MIN_WIDTH:
                for xx in range(x, end):
                    keep[xx % LW] = True
        x += 1
    crowns = []
    x = 0.0
    while x < LW:
        n = looped(x, 0, FOREST_SCALE, 1, 41)
        if keep[int(x)]:
            height = 2 + FOREST_HEIGHT * min(1.0, (n - FOREST_THRESHOLD) / 0.12)
            y = HORIZON_L + 2
            while y > HORIZON_L + 2 - height:
                r = rng.uniform(*FOREST_CROWN)
                crowns.append((x + rng.uniform(-1.2, 1.2), y - rng.uniform(0, 1.5), r,
                               family(x)))
                y -= r * rng.uniform(0.9, 1.3)
            x += rng.uniform(1.8, 2.6)
        else:
            x += 4
    crowns.sort(key=lambda c: c[1])            # les plus hautes derriere
    owner = {}
    for i, (cx, cy, r, fam) in enumerate(crowns):
        for y in range(int(cy - r - 1), int(cy + r + 2)):
            for x in range(int(cx - r - 1), int(cx + r + 2)):
                if (x + .5 - cx) ** 2 + (y + .5 - cy) ** 2 <= r * r:
                    owner[(x % LW, y)] = i
    px = {}
    for (x, y), i in owner.items():
        cx, cy, r, fam = crowns[i]
        nx, ny = (x + .5 - cx) / r, (y + .5 - cy) / r
        # Une masse, pas des billes : la lumiere ne touche que le haut des
        # couronnes qui depassent, l'ombre le dessous de celles de devant.
        up = owner.get((x, y - 1))
        below = owner.get((x, y + 1))
        if (below is not None and below > i) or ny > 0.62:
            shade = 2
        elif (up is None or up < i) and ny < -0.25 and nx < 0.5:
            shade = 0
        else:
            shade = 1
        px[(x, y)] = lerp(fam[shade], horizon, FOREST_VEIL)
    # Sous les couronnes du bas, le sous-bois jusqu'au pre : pas de jour entre
    # la foret et le sol.
    floor = lerp(FOREST_FLOOR, horizon, FOREST_VEIL)
    for (x, y) in list(owner):
        if (x, y + 1) not in owner:
            for yy in range(y + 1, HORIZON_L + 3):
                px[(x, yy)] = floor
    return px


def field_band(y):
    # Des bandes qui s'elargissent en approchant : la perspective du champ.
    for start, band in ((238, 0), (241, 1), (245, 0), (250, 1), (257, 0), (266, 1)):
        if y < start:
            return 1 - band
    return 1


def oval_boxes(open_sky, kind):
    mask = [[kind[y][x] == 0 and not open_sky[y][x] for x in range(W)] for y in range(H)]
    return [(min(p[0] for p in c), min(p[1] for p in c), max(p[0] for p in c), max(p[1] for p in c))
            for c in components(mask, W, H)]


# ── Arbres ──────────────────────────────────────────────────────────────────
# Un arbre se construit comme il pousse : un tronc, une charpente de branches
# qui se ramifient, et des bouquets de feuilles au bout. C'est ce qui lui donne
# des trouees, des branches qui se voient, une silhouette qui n'est pas une
# boule. Le tout reste en pixels logiques (2 x 2 a l'image) et en six teintes
# par feuillage : la palette d'une cartouche.
#
# Coordonnees du sprite : pied du tronc en bas au centre, a la ligne `BASE_Y`.
# Les longueurs sont a l'echelle 1 ; `make_tree(nom, k)` les multiplie.
#   trunk    (hauteur, demi-largeur au pied, au sommet, evasement)
#   limbs    angles des branches maitresses (degres, 90 = vers le haut)
#   branch   (longueur, profondeur, raccourcissement, ecart, demi-epaisseur)
#   leaves   (rayon min, rayon max, disques par bouquet) au bout des rameaux
#   stagger  de combien les branches laterales partent plus bas que la centrale
#   leader   un tronc qui monte jusqu'en haut, rameaux le long (le bouleau)
#   palette  de la plus sombre (contour) a la plus claire

BASE_Y = 137

TREES = {
    'chene': {
        'size': (156, 140),
        'trunk': (46, 7.5, 5.0, 5.0),
        'limbs': (152, 118, 84, 50, 24),
        'branch': (27, 3, 0.7, 34, 3.4),
        'leaves': (6.5, 10.5, 5),
        'stagger': 16,
        'palette': [(66, 26, 22), (122, 42, 26), (176, 72, 30), (220, 110, 38),
                    (242, 152, 56), (255, 202, 104)],
        'seed': 11,
    },
    'bouleau': {
        'size': (96, 140),
        'trunk': (120, 4.2, 1.6, 2.0),
        'leader': (24, 100, 7, 15, 25),        # de y, a y, pas, longueur min, max
        'branch': (0, 2, 0.6, 30, 1.1),
        'leaves': (4.5, 7.5, 5),
        'palette': [(80, 54, 20), (146, 98, 24), (198, 146, 32), (232, 190, 50),
                    (248, 218, 96), (255, 242, 166)],
        'seed': 23,
    },
    'erable': {
        'size': (144, 140),
        'trunk': (30, 6.0, 4.6, 4.0),
        'limbs': (150, 118, 88, 58, 30),
        'branch': (24, 3, 0.68, 32, 3.0),
        'leaves': (6.0, 9.5, 5),
        'stagger': 10,
        'palette': [(58, 14, 26), (114, 22, 34), (166, 34, 38), (210, 58, 42),
                    (236, 100, 62), (255, 152, 104)],
        'seed': 37,
    },
}

BARK = {'outline': (46, 28, 18), 'dark': (84, 54, 32), 'mid': (122, 82, 48),
        'light': (160, 114, 70), 'streak': (68, 44, 28)}
BIRCH = {'outline': (70, 66, 66), 'mark': (38, 34, 36), 'light': (242, 238, 228),
         'mid': (206, 200, 190), 'dark': (156, 150, 144)}
BAYER = ((0.0, 0.5), (0.75, 0.25))


def hash01(i, j, seed):
    h = (i * 73856093) ^ (j * 19349663) ^ (seed * 83492791)
    h = (h ^ (h >> 13)) * 1274126177 & 0xffffffff
    return ((h ^ (h >> 16)) & 0xffffff) / 0xffffff


def noise(x, y, sx, sy, seed):
    """Bruit de valeur lisse, maille sx x sy : un grain, pas un semis."""
    fx, fy = x / sx, y / sy
    i, j = math.floor(fx), math.floor(fy)
    tx, ty = fx - i, fy - j
    tx, ty = tx * tx * (3 - 2 * tx), ty * ty * (3 - 2 * ty)
    a = hash01(i, j, seed) + (hash01(i + 1, j, seed) - hash01(i, j, seed)) * tx
    b = hash01(i, j + 1, seed) + (hash01(i + 1, j + 1, seed) - hash01(i, j + 1, seed)) * tx
    return a + (b - a) * ty


def grow(rng, segs, nodes, x, y, ang, length, depth, decay, spread, thick):
    """Une branche, puis ses rameaux. Les bouts portent les bouquets."""
    ex = x + math.cos(math.radians(ang)) * length
    ey = y - math.sin(math.radians(ang)) * length
    segs.append((x, y, ex, ey, thick, max(0.6, thick * 0.7)))
    if depth == 0:
        nodes.append((ex, ey, 1.0))
        return
    if depth <= 2:          # des feuilles aussi le long des rameaux
        nodes.append((x + (ex - x) * 0.6, y + (ey - y) * 0.6, 0.75))
    kids = 2 if rng.random() < 0.65 else 3
    for i in range(kids):
        a = ang + spread * (i - (kids - 1) / 2) + rng.uniform(-10, 10)
        a = min(168.0, max(12.0, a))
        grow(rng, segs, nodes, ex, ey, a, length * decay * rng.uniform(0.85, 1.15),
             depth - 1, decay, spread * 0.95, thick * 0.66)


def paint_segment(img, x0, y0, x1, y1, r0, r1, colorer):
    """Un troncon de bois en capsule, rayon r0 -> r1, colore par `colorer(u, x, y)`
    ou u va de -1 (flanc gauche, eclaire) a 1."""
    dx, dy = x1 - x0, y1 - y0
    ln = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / ln, dx / ln
    if nx > 0 or (nx == 0 and ny > 0):
        nx, ny = -nx, -ny                     # la normale regarde a gauche
    rmax = max(r0, r1)
    for y in range(int(min(y0, y1) - rmax - 1), int(max(y0, y1) + rmax + 2)):
        for x in range(int(min(x0, x1) - rmax - 1), int(max(x0, x1) + rmax + 2)):
            px, py = x + .5 - x0, y + .5 - y0
            t = max(0.0, min(1.0, (px * dx + py * dy) / (ln * ln)))
            r = r0 + (r1 - r0) * t
            ox, oy = px - dx * t, py - dy * t
            if ox * ox + oy * oy <= r * r:
                u = -(ox * nx + oy * ny) / max(r, 0.5)
                img[(x, y)] = colorer(u, x, y, r)


def bark_colorer(birch, seed, marks):
    def colorer(u, x, y, r):
        if birch:
            if abs(u) > 0.72 and r > 1.4:
                return BIRCH['outline']
            if (x, y) in marks:
                return BIRCH['mark']
            return BIRCH['light'] if u < -0.2 else BIRCH['mid'] if u < 0.45 else BIRCH['dark']
        if r < 1.3:                           # un rameau : un trait
            return BARK['dark'] if u > -0.3 else BARK['mid']
        if abs(u) > 0.74:
            return BARK['outline']
        # Ecorce : des stries verticales, allongees, pas des points.
        if noise(x, y, 1.6, 7, seed) < 0.3 and abs(u) < 0.6:
            return BARK['streak']
        return BARK['light'] if u < -0.35 else BARK['mid'] if u < 0.3 else BARK['dark']
    return colorer


def make_tree(name, k=1.0, far=False):
    """-> (pixels {(x, y): couleur}, largeur, hauteur, ligne du pied, (centre, demi-largeur)).

    `far` : l'arbre est au loin. La profondeur se lit au contraste autant qu'a
    la taille : de pres, ombres creusees et lumieres franches, contour net ; au
    loin, valeurs resserrees, grain effacee, contour fondu dans le feuillage."""
    spec = TREES[name]
    rng = random.Random(spec['seed'])
    seed = spec['seed']
    w, h = math.ceil(spec['size'][0] * k), math.ceil(spec['size'][1] * k)
    base = round(BASE_Y * k)
    pal = spec['palette']
    birch = 'leader' in spec
    x0 = w / 2

    # ── Charpente ──
    th, hw0, hw1, flare = (v * k for v in spec['trunk'])
    segs, nodes = [], []
    length, depth, decay, spread, thick = spec['branch']
    lmin, lmax, per = spec['leaves']
    leaf_r = (lmin * k, lmax * k)
    top_y = base - th
    lean = rng.uniform(-2, 2) * k
    if birch:
        y_from, y_to, step, bmin, bmax = spec['leader']
        side = 1
        y = y_to
        while y >= y_from:
            by = y * k
            bx = x0 + lean * (base - by) / th
            a = 90 + side * rng.uniform(38, 62)
            ln = rng.uniform(bmin, bmax) * k * (0.6 + 0.4 * (y - y_from) / (y_to - y_from))
            grow(rng, segs, nodes, bx, by, a, ln, depth, decay, spread, thick * k)
            if y < y_to - 12:
                # Du feuillage sur le tronc lui-meme, en quinconce : il ne
                # doit se voir que par endroits, pas fendre la couronne.
                nodes.append((bx - side * 3 * k, by - 3 * k, 0.85))
            side = -side
            y -= step
        nodes.append((x0 + lean, top_y - 2 * k, 1.0))
    else:
        for a in spec['limbs']:
            # Les laterales partent plus bas que la centrale : pas de parapluie.
            ly = top_y + spec['stagger'] * k * abs(a - 90) / 70 * rng.uniform(0.7, 1.1)
            lx = x0 + lean * (base - ly) / th
            grow(rng, segs, nodes, lx, ly, a + rng.uniform(-6, 6),
                 length * k * rng.uniform(0.85, 1.1), depth, decay, spread, thick * k)

    marks = set()
    if birch:                                  # lenticelles et pied crevasse
        for _ in range(int(40 * k) + 6):
            my = rng.uniform(top_y, base)
            mx = x0 + lean * (base - my) / th + rng.uniform(-hw0, hw0)
            for d in range(rng.randint(1, 3)):
                marks.add((int(mx) + d, int(my)))
        for y in range(int(base - 12 * k), base + 1):
            for x in range(int(x0 - hw0 - 2), int(x0 + hw0 + 3)):
                if noise(x, y, 1.5, 3, seed) < 0.3 + 0.4 * (y - (base - 12 * k)) / (12 * k):
                    marks.add((x, y))
    colorer = bark_colorer(birch, seed, marks)

    img = {}
    for sx0, sy0, sx1, sy1, r0, r1 in segs:
        paint_segment(img, sx0, sy0, sx1, sy1, r0, r1, colorer)
    # Le tronc, evase au pied, par-dessus le depart des branches.
    for y in range(int(top_y) - 1, base + 1):
        t = (base - y) / th
        cx = x0 + lean * t
        hw = hw0 + (hw1 - hw0) * min(1.0, t) + flare * max(0.0, 1 - (base - y) / (7 * k)) ** 2
        for x in range(int(cx - hw - 1), int(cx + hw + 2)):
            u = (x + .5 - cx) / hw
            if abs(u) <= 1:
                img[(x, y)] = colorer(u, x, y, hw)

    # ── Feuillage ──
    # Chaque bouquet : quelques disques autour du bout du rameau. Du fond vers
    # l'avant : les bouquets hauts passent derriere.
    clusters = []
    for nx_, ny_, scale in nodes:
        rad = rng.uniform(*leaf_r) * scale
        disks = [(nx_, ny_, rad)]
        for _ in range(per - 1):
            a = rng.uniform(0, 2 * math.pi)
            d = rad * rng.uniform(0.35, 0.8)
            disks.append((nx_ + math.cos(a) * d, ny_ + math.sin(a) * d * 0.8,
                          rad * rng.uniform(0.5, 0.8)))
        clusters.append((ny_ + rng.uniform(-3, 3), disks))
    clusters.sort(key=lambda c: c[0])
    owner, local = {}, {}
    for ci, (_, disks) in enumerate(clusters):
        for cx, cy, r in disks:
            for y in range(int(cy - r - 1), int(cy + r + 2)):
                for x in range(int(cx - r - 1), int(cx + r + 2)):
                    d = math.hypot(x + .5 - cx, y + .5 - cy)
                    if d <= r and 0 <= y < h:     # en X, le placement enroule
                        depth_in = (r - d) / r
                        if owner.get((x, y)) != ci or depth_in > local[(x, y)][2]:
                            owner[(x, y)] = ci
                            local[(x, y)] = ((x + .5 - cx) / r, (y + .5 - cy) / r, depth_in)

    # Bord effiloche : on ronge le contour et on y pique des pointes de feuilles.
    for (x, y) in [p for p in owner if is_edge(owner, *p)]:
        if noise(x, y, 1.7, 1.7, seed + 5) < 0.36:
            owner.pop((x, y)), local.pop((x, y))
    for (x, y) in list(owner):
        for dx, dy in N4:
            q = (x + dx, y + dy)
            if q not in owner and rng.random() < 0.05:
                owner[q] = owner[(x, y)]
                local[q] = local[(x, y)]
    for p in [p for p in owner if sum((p[0] + dx, p[1] + dy) in owner for dx, dy in N4) <= 1]:
        owner.pop(p), local.pop(p)

    xs = [p[0] for p in owner]
    ys = [p[1] for p in owner]
    gcx, gcy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    grx, gry = max(1, (max(xs) - min(xs)) / 2), max(1, (max(ys) - min(ys)) / 2)
    relief, grain = (0.6, 0.3) if far else (1.35, 0.6)
    level = {}
    for (x, y), ci in owner.items():
        lx, ly, _ = local[(x, y)]
        gx, gy = (x - gcx) / grx, (y - gcy) / gry
        v = (0.5 * -(0.55 * gx + 0.85 * gy) + 0.38 * -(0.55 * lx + 0.85 * ly)) * relief \
            + grain * (noise(x, y, 2.0, 1.8, seed) - 0.5)
        below = owner.get((x, y + 1))
        if below is not None and below > ci:
            v -= 0.32                         # l'ombre d'un bouquet sur celui de derriere
        up = owner.get((x, y - 1))
        if up is not None and up < ci:
            v += 0.15                         # le haut d'un bouquet prend la lumiere
        if hash01(x, y, seed + 9) < 0.05:
            v += 0.35                         # une feuille qui accroche le soleil
        v += (BAYER[y % 2][x % 2] - 0.375) * 0.2
        level[(x, y)] = 5 if v > 0.6 else 4 if v > 0.26 else 3 if v > -0.08 else 2 if v > -0.42 else 1

    # Des branches se devinent dans les creux sombres du feuillage.
    for sx0, sy0, sx1, sy1, r0, r1 in segs:
        if r0 < 1.2 * k:
            continue
        peek = {}
        paint_segment(peek, sx0, sy0, sx1, sy1, r0 * 0.7, r1 * 0.7, lambda *a: BARK['dark'])
        for p in peek:
            if level.get(p, 9) <= 1 and not birch:
                level[p] = 0                  # 0 : du bois, pas une feuille

    for (x, y), lv in level.items():
        if lv == 0:
            img[(x, y)] = BARK['dark']
            continue
        out = [(dx, dy) for dx, dy in N4 if (x + dx, y + dy) not in owner]
        if out:
            # Contour selectif : franc dessous et a droite, adouci cote lumiere.
            shade = any(d in ((0, 1), (1, 0)) for d in out)
            if far:
                img[(x, y)] = pal[max(1, lv - 1)]
            else:
                img[(x, y)] = pal[0] if shade else pal[max(1, lv - 2)]
        else:
            img[(x, y)] = pal[lv]

    # Le feuillage fait de l'ombre au haut du tronc et des branches.
    for (x, y), c in list(img.items()):
        if (x, y) in owner or c in (BARK['outline'], BIRCH['outline'], BIRCH['mark']):
            continue
        if any((x, y - d) in owner for d in range(1, int(6 * k) + 2)):
            img[(x, y)] = {BARK['light']: BARK['mid'], BARK['mid']: BARK['dark'],
                           BIRCH['light']: BIRCH['mid'], BIRCH['mid']: BIRCH['dark']}.get(c, c)

    # Pas de feuilles en l'air : figees dans une image qui defile, elles se
    # lisaient comme des poussieres. Des feuilles qui tombent seraient une
    # animation, pas du decor.
    if far:
        soft = {BARK['outline']: BARK['dark'], BARK['streak']: BARK['dark'],
                BIRCH['outline']: BIRCH['dark']}
        img = {p: soft.get(c, c) for p, c in img.items()}
    return img, w, h, base, (gcx, grx)


# ── Premier plan ────────────────────────────────────────────────────────────

# (arbre, x logique du pied) et (debut, fin) des clotures, sur 1920 unites.
# Les grands arbres, de gauche a droite. Leurs positions ne se reglent pas a la
# main : `spread_front` les espace a intervalles egaux d'apres la largeur reelle
# des couronnes, pour qu'ils ne se chevauchent jamais, quelle que soit l'echelle.
PLACEMENT = ['chene', 'bouleau', 'erable', 'bouleau', 'chene', 'erable', 'bouleau', 'erable']
FIRST_FOOT = 150
FENCES = [(400, 590), (1180, 1380), (1700, 1780)]
BACK_FOOT = 126     # ligne logique ou le second rang touche le pre (252 en image)
FRONT_FOOT = 137    # et le premier plan, dans la bande d'herbe (274, sous la bordure)
FRONT_SCALE = 1.75   # le premier plan deborde un peu par le haut : il est tout pres


def build_foreground():
    rng = random.Random(7)
    layer = {}     # canevas logique, enroule en X

    def put(x, y, c):
        if 0 <= y < LH:
            layer[(x % LW, y)] = c

    # Le second plan : les memes arbres, plus petits, plantes plus haut dans le
    # pre et voiles de la couleur de l'horizon. Sur leur propre calque, qui
    # passe sous celui-ci : ils glissent derriere clotures et grands arbres.
    back, shadows = {}, []
    haze, amount = HAZE
    for name, foot, k in BACK_TREES:
        img, w, h, base, (gcx, grx) = make_tree(name, k, far=True)
        shadows.append((foot - w // 2 + gcx, grx))
        for (x, y), c in img.items():
            ly = BACK_FOOT - base + y
            if 0 <= ly < LH:
                back[((foot - w // 2 + x) % LW, ly)] = lerp(c, haze, amount)

    for a, b in FENCES:
        for x in range(a, b):
            put(x, 119, FENCE['outline'])
            put(x, 120, FENCE['top'])
            put(x, 121, FENCE['top'])
            put(x, 122, FENCE['bottom'])
            put(x, 123, FENCE['bottom'])
            put(x, 124, FENCE['outline'])
        for px in range(a, b - 3, 20):
            for y in range(114, 131):
                for dx, c in enumerate((FENCE['outline'], FENCE['top'], FENCE['post'], FENCE['outline'])):
                    put(px + dx, y, FENCE['outline'] if y == 114 else c)

    sprites = {name: make_tree(name, FRONT_SCALE) for name in TREES}
    front_shadows = []
    for name, foot in spread_front(sprites):
        img, w, h, base, (gcx, grx) = sprites[name]
        front_shadows.append((foot - w // 2 + gcx, grx))
        for (x, y), c in img.items():
            put(foot - w // 2 + x, FRONT_FOOT - base + y, c)
        # Un tas de feuilles au pied, aux couleurs de l'arbre.
        pal = TREES[name]['palette']
        for y in range(134, 140):
            half = 17 * math.sqrt(max(0.0, 1 - ((y - 137.5) / 3.2) ** 2))
            for x in range(int(foot - half), int(foot + half) + 1):
                if rng.random() < 0.6:
                    put(x, y, pal[rng.choice((1, 2, 2, 3, 4))])

    # La bande de sol, a pleine resolution : 24 lignes, de 259 a 282, comme le
    # sable de l'ete. Dessinee en blocs de 2 pour rester dans la grille SNES.
    fg = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    fp = fg.load()
    for ly in range(12):
        for lx in range(LW):
            if ly == 0:
                c = BAND['edge'] if (lx * 7) % 5 else BAND['edge_alt']
            elif ly <= 2:
                c = BAND['top'] if (lx + ly) % 3 else BAND['top_alt']
            else:
                c = BAND['ground']
                if ly in (5, 9) and (lx // 6) % 4 != 0:
                    c = BAND['stripe']
                if rng.random() < BAND['leaves']:
                    c = rng.choice(LEAVES)
            for sy in range(2):
                for sx in range(2):
                    fp[lx * 2 + sx, 259 + ly * 2 + sy] = c + (255,)
    # Touffes d'herbe qui depassent de la bande.
    for lx in range(LW):
        if rng.random() < 0.18:
            for sx in range(2):
                fp[lx * 2 + sx, 257] = BAND['edge'] + (255,)
                fp[lx * 2 + sx, 258] = BAND['edge'] + (255,)

    # L'ombre des grands arbres sur la bande, portee vers la droite (la lumiere
    # vient d'en haut a gauche). Bord tramé, pour rester dans le style.
    for cx, rx in front_shadows:
        cast_shadow(fp, cx * 2 + rx * 0.5, 272, rx * 1.9, 9,
                    lambda x, y, c: tuple(round(v * 0.72) for v in c[:3]) + (255,))

    paint2x(layer, fp)
    mid = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mp = mid.load()
    # Celle du second rang tombe sur le pre du fond, qui defile a une autre
    # vitesse : on la peint de la couleur du pre assombrie, rangee par rangee.
    # Ses bandes etant horizontales, l'ombre ne glisse pas sur lui.
    for cx, rx in shadows:
        cast_shadow(mp, cx * 2 + rx * 0.5, BACK_FOOT * 2 + 1, rx * 1.6, 5,
                    lambda x, y, c: tuple(round(v * 0.88) for v in FIELD[field_band(y)]) + (255,))
    paint2x(back, mp)
    return fg, mid


def spread_front(sprites):
    """-> [(essence, x du pied)] : meme ecart entre toutes les couronnes voisines,
    raccord compris."""
    ext = {}
    for name, (img, w, h, base, _) in sprites.items():
        xs = [x for x, _ in img]
        ext[name] = (min(xs) - w // 2, max(xs) - w // 2)      # bords, relatifs au pied
    widths = sum(ext[n][1] - ext[n][0] for n in PLACEMENT)
    gap = (LW - widths) / len(PLACEMENT)
    if gap < 8:
        raise SystemExit(f'premier plan trop gros : {widths} de couronnes pour {LW}, '
                         'baisser FRONT_SCALE ou retirer un arbre de PLACEMENT')
    out, foot = [], FIRST_FOOT
    for i, name in enumerate(PLACEMENT):
        out.append((name, round(foot)))
        if i + 1 < len(PLACEMENT):
            nxt = PLACEMENT[i + 1]
            foot += ext[name][1] + gap - ext[nxt][0]
    return out


def cast_shadow(px, cx, cy, rx, ry, shade):
    """Ellipse d'ombre au sol, en blocs de 2, bord trame.

    Decidee bloc par bloc, pas pixel par pixel : un pixel seul au bord de
    l'ellipse flottait hors de la grille SNES."""
    for by in range(int(cy - ry) // 2, int(cy + ry) // 2 + 1):
        for bx in range(int(cx - rx) // 2, int(cx + rx) // 2 + 1):
            d = ((bx * 2 + 1 - cx) / rx) ** 2 + ((by * 2 + 1 - cy) / ry) ** 2
            # Trame au bord seulement si l'ombre est assez haute pour la porter :
            # sur trois blocs, elle ne laisse que des pixels detaches.
            if d > 1 or (ry >= 8 and d > 0.62 and (bx + by) % 2):
                continue
            for y in (by * 2, by * 2 + 1):
                for x in (bx * 2, bx * 2 + 1):
                    if 0 <= y < H:
                        xx = x % W
                        px[xx, y] = shade(xx, y, px[xx, y])


def paint2x(layer, px):
    """Pose un canevas logique sur une image, chaque pixel en bloc de 2 x 2."""
    for (x, y), c in layer.items():
        for sy in range(2):
            fy = y * 2 + sy
            if fy < H:
                for sx in range(2):
                    px[x * 2 + sx, fy] = c + (255,)


def to_palette(img, transparent):
    """PNG indexe a palette exacte (les deux dessins tiennent en < 256 teintes)."""
    rgba = img.convert('RGBA')
    colors = sorted({c for _, c in rgba.getcolors(1 << 20) if c[3] == 255})
    assert len(colors) <= 255, len(colors)
    index = {c: i + 1 for i, c in enumerate(colors)}
    out = Image.new('P', rgba.size, 0)
    out.putpalette([0, 0, 0] + [v for c in colors for v in c[:3]])
    src, dst = rgba.load(), out.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            c = src[x, y]
            dst[x, y] = index[c] if c[3] == 255 else 0
    if transparent:
        out.info['transparency'] = 0
    return out


def preview(bg, mid, fg, folder):
    """Ce que voit le PC : 264 px de ciel, puis la route et sa bordure."""
    folder.mkdir(parents=True, exist_ok=True)
    sky = Image.new('RGBA', (W, 264))
    for layer in (bg, mid, fg):
        sky.alpha_composite(layer.convert('RGBA').resize((W, 264), Image.NEAREST))
    full = Image.new('RGBA', (W, 408), (51, 51, 51, 255))
    full.paste(sky, (0, 0))
    for x in range(0, W, 80):
        full.paste((204, 0, 0, 255), (x, 254, x + 40, 264))
        full.paste((255, 255, 255, 255), (x + 40, 254, x + 80, 264))
    for i in range(4):
        full.crop((i * 960, 0, (i + 1) * 960, 408)).save(folder / f'autumn_{i}.png')
    raw = bg.convert('RGBA')
    raw.alpha_composite(mid.convert('RGBA'))
    raw.alpha_composite(fg.convert('RGBA'))
    raw.save(folder / 'autumn_raw.png')


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument('--preview', type=Path, help='dossier ou ecrire des apercus composes')
    ap.add_argument('--theme', choices=THEMES, default='france', help='couleurs du decor')
    ap.add_argument('--out', type=Path, default=OUT, help='dossier de sortie des deux PNG')
    args = ap.parse_args()

    use_theme(args.theme)
    bg = build_background()
    fg, mid = build_foreground()
    args.out.mkdir(parents=True, exist_ok=True)
    to_palette(bg, False).save(args.out / 'index-banner-autumn.png', optimize=True)
    to_palette(fg, True).save(args.out / 'index-banner-autumn-foreground.png', optimize=True)
    if BACK_TREES:      # le theme desert n'a pas de second plan
        to_palette(mid, True).save(args.out / 'index-banner-autumn-midground.png', optimize=True)
    if args.preview:
        preview(bg, mid, fg, args.preview)


if __name__ == '__main__':
    main()
