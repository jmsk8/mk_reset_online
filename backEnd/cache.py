from __future__ import annotations

import os
import tempfile
import time
from collections import OrderedDict
from typing import Any

from constants import CACHE_TTL_SECONDS

# Borne dure du cache. Une entrée n'est purgée qu'à la LECTURE d'une clé
# périmée : sans plafond, un jeu de clés pilotable depuis internet ferait
# grossir le dict jusqu'à l'OOM. L'ordre d'insertion sert d'approximation LRU.
CACHE_MAX_ENTRIES = 200

_cache_store: OrderedDict[str, tuple[Any, float]] = OrderedDict()

_INVALIDATION_MARKER = os.path.join(tempfile.gettempdir(), "mkreset_cache_invalidated_at")


def _last_invalidation() -> float:
    try:
        return os.path.getmtime(_INVALIDATION_MARKER)
    except OSError:
        return 0.0


def get_cached(key: str, ttl: int = CACHE_TTL_SECONDS) -> Any | None:
    if key in _cache_store:
        data, ts = _cache_store[key]
        if time.time() - ts < ttl and ts >= _last_invalidation():
            _cache_store.move_to_end(key)
            return data
        del _cache_store[key]
    return None


def set_cached(key: str, data: Any) -> None:
    _cache_store[key] = (data, time.time())
    _cache_store.move_to_end(key)
    while len(_cache_store) > CACHE_MAX_ENTRIES:
        _cache_store.popitem(last=False)


def invalidate_cache() -> None:
    _cache_store.clear()
    try:
        with open(_INVALIDATION_MARKER, "w") as f:
            f.write(str(time.time()))
        os.utime(_INVALIDATION_MARKER, None)
    except OSError:
        pass
