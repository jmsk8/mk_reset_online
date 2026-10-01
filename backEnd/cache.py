from __future__ import annotations

import os
import tempfile
import threading
import time
from collections import OrderedDict
from typing import Any

from constants import CACHE_TTL_SECONDS

# Plafond du cache : les entrées périmées ne sont purgées qu'à la lecture.
CACHE_MAX_ENTRIES = 200

_cache_store: OrderedDict[str, tuple[Any, float]] = OrderedDict()

# Les workers gunicorn sont threadés : le dict est partagé entre threads.
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
