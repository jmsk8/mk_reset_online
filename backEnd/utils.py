from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

# Couleur saisie par un admin (fiche, ligue) ou un joueur (profil). Toujours
# #RRGGBB : la valeur finit dans des attributs style, et rien d'autre qu'une
# couleur ne doit pouvoir y entrer.
RE_COULEUR = re.compile(r'^#[0-9A-Fa-f]{6}$')


def couleur_valide(valeur: Any) -> str | None:
    """La couleur en `#RRGGBB` majuscules, ou None si ce n'en est pas une."""
    if not isinstance(valeur, str) or not RE_COULEUR.match(valeur.strip()):
        return None
    return valeur.strip().upper()


def nombre_fini(valeur: Any, minimum: float, maximum: float,
                min_exclu: bool = False) -> float | None:
    """Le nombre s'il est fini et dans [minimum, maximum], sinon None.

    S-10 (audit du 24/09) : `float()` accepte « nan » et « inf », et le parseur
    JSON de Flask les litteraux NaN et Infinity. Un sigma a NaN, ou un tau, se
    propage au tournoi suivant dans le calcul de TOUS les joueurs, et le moteur
    etant incremental, rien ne permet de recalculer apres coup.

    `min_exclu` : borne basse stricte (un sigma nul n'a pas de sens).
    Un booleen n'est pas un nombre ici, bien que Python le traite comme tel.
    """
    if isinstance(valeur, bool):
        return None
    try:
        x = float(valeur)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(x) or x > maximum or x < minimum or (min_exclu and x == minimum):
        return None
    return x


def slugify(value: str) -> str:
    value = str(value)
    value = unicodedata.normalize('NFKD', value).encode('ascii', 'ignore').decode('ascii')
    value = re.sub(r'[^\w\s-]', '', value).strip().lower()
    value = re.sub(r'[-\s]+', '-', value)
    return value


def generate_unique_slug(cur: Any, nom: str) -> str:
    slug = slugify(nom)
    base_slug = slug
    counter = 1
    while True:
        cur.execute("SELECT id FROM saisons WHERE slug = %s", (slug,))
        if not cur.fetchone():
            break
        slug = f"{base_slug}-{counter}"
        counter += 1
    return slug


def extract_league_number(nom: str) -> int | None:
    match = re.search(r'(\d+)', nom)
    if match:
        return int(match.group(1))
    return None
