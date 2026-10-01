from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

# Les couleurs finissent dans des attributs style : format #RRGGBB strict.
RE_COULEUR = re.compile(r'^#[0-9A-Fa-f]{6}$')


def couleur_valide(valeur: Any) -> str | None:
    """La couleur en `#RRGGBB` majuscules, ou None si ce n'en est pas une."""
    if not isinstance(valeur, str) or not RE_COULEUR.match(valeur.strip()):
        return None
    return valeur.strip().upper()


def nombre_fini(valeur: Any, minimum: float, maximum: float,
                min_exclu: bool = False) -> float | None:
    """Le nombre s'il est fini et dans [minimum, maximum], sinon None.

    Rejette NaN, l'infini et les booleens. min_exclu rend la borne basse stricte.
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
