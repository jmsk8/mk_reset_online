from __future__ import annotations

import re
import unicodedata
from typing import Any


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
