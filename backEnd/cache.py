from __future__ import annotations

import os
import tempfile
import time
from typing import Any

from constants import CACHE_TTL_SECONDS

_cache_store: dict[str, tuple[Any, float]] = {}

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
            return data
        del _cache_store[key]
    return None


def set_cached(key: str, data: Any) -> None:
    _cache_store[key] = (data, time.time())


def invalidate_cache() -> None:
    _cache_store.clear()
    try:
        with open(_INVALIDATION_MARKER, "w") as f:
            f.write(str(time.time()))
        os.utime(_INVALIDATION_MARKER, None)
    except OSError:
        pass
