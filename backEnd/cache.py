from __future__ import annotations

import os
import tempfile
import threading
import time
from collections import OrderedDict
from typing import Any

from constants import CACHE_TTL_SECONDS

# Borne dure du cache. Une entrée n'est purgée qu'à la LECTURE d'une clé
# périmée : sans plafond, un jeu de clés pilotable depuis internet ferait
# grossir le dict jusqu'à l'OOM. L'ordre d'insertion sert d'approximation LRU.
CACHE_MAX_ENTRIES = 200

_cache_store: OrderedDict[str, tuple[Any, float]] = OrderedDict()

# Les workers gunicorn sont threadés depuis le 2026-09-17 : ce dict est désormais
# partagé. Sans ce verrou, `get_cached` peut supprimer une clé qu'un autre thread
# vient de purger -- et le `popitem` de `set_cached` vider un cache déjà vide.
# Les deux lèvent KeyError, donc une 500 intermittente, sur un chemin dont
# l'intérêt est justement d'être invisible.
#
# Un verrou global, et non un par clé : les sections critiques tiennent en
# quelques opérations de dict et un `stat()` sur tmpfs (_last_invalidation), sans
# aucun appel réseau ni requête SQL. La contention reste négligeable devant
# l'aller-retour Postgres que ce cache évite.
_verrou = threading.Lock()

_INVALIDATION_MARKER = os.path.join(tempfile.gettempdir(), "mkreset_cache_invalidated_at")


def _last_invalidation() -> float:
    try:
        return os.path.getmtime(_INVALIDATION_MARKER)
    except OSError:
        return 0.0


def get_cached(key: str, ttl: int = CACHE_TTL_SECONDS) -> Any | None:
    with _verrou:
        if key in _cache_store:
            data, ts = _cache_store[key]
            if time.time() - ts < ttl and ts >= _last_invalidation():
                _cache_store.move_to_end(key)
                return data
            _cache_store.pop(key, None)
    return None


def set_cached(key: str, data: Any) -> None:
    with _verrou:
        _cache_store[key] = (data, time.time())
        _cache_store.move_to_end(key)
        while len(_cache_store) > CACHE_MAX_ENTRIES:
            _cache_store.popitem(last=False)


def invalidate_cache() -> None:
    with _verrou:
        _cache_store.clear()
    try:
        with open(_INVALIDATION_MARKER, "w") as f:
            f.write(str(time.time()))
        os.utime(_INVALIDATION_MARKER, None)
    except OSError:
        pass
