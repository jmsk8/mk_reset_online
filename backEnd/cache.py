from __future__ import annotations

import time
from typing import Any

from constants import CACHE_TTL_SECONDS

_cache_store: dict[str, tuple[Any, float]] = {}


def get_cached(key: str, ttl: int = CACHE_TTL_SECONDS) -> Any | None:
    if key in _cache_store:
        data, ts = _cache_store[key]
        if time.time() - ts < ttl:
            return data
        del _cache_store[key]
    return None


def set_cached(key: str, data: Any) -> None:
    _cache_store[key] = (data, time.time())


def invalidate_cache() -> None:
    _cache_store.clear()
