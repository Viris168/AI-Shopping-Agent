"""Redis cache for public tool results (PLAN-18 step 1).

Only tools that read shop-wide data opt in (`Tool.cache_ttl_s`); login-only tools never do, so a
cached result can't hold one shopper's data. Best effort: if Redis fails, the tool runs as usual.

Runtime controls, no redeploy needed:
- `SET flag:cache_enabled 0` turns the cache off on every replica.
- `INCR cache:tool:gen` drops every cached result at once (e.g. after re-seeding the catalog).
"""

import hashlib
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast

from pydantic import BaseModel
from redis.asyncio import Redis

from app import telemetry

log = logging.getLogger(__name__)

FLAG_CACHE = "flag:cache_enabled"
GENERATION = "cache:tool:gen"
# Free-text fields: case and spacing don't change the result, so "Rain  Jacket" hits "rain jacket".
_TEXT_FIELDS = ("q",)

Fetch = Callable[[], Awaitable[tuple[dict[str, Any], dict[str, Any] | None, bool]]]


def cache_key(tool: str, args: BaseModel, generation: str | None) -> str:
    data = args.model_dump(mode="json", exclude_none=True)
    for name in _TEXT_FIELDS:
        if isinstance(data.get(name), str):
            data[name] = " ".join(data[name].lower().split())
    digest = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()
    return f"cache:tool:{generation or 0}:{tool}:{digest}"


def _flag_off(raw: str | None) -> bool:
    return raw is not None and raw.strip().lower() in ("0", "false", "off")


class ToolCache:
    def __init__(self, redis: Redis, enabled: bool = True) -> None:
        self._redis = redis
        self._enabled = enabled

    async def get_or_fetch(
        self, tool: str, args: BaseModel, ttl_s: int, fetch: Fetch
    ) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
        """(for_model, card, is_error) from the cache, or from `fetch` and then stored.
        Errors and empty results are never stored."""
        if not self._enabled:
            return await fetch()
        try:
            # decode_responses=True (main.py), so values are str.
            flag, generation = cast(
                list[str | None], await self._redis.mget(FLAG_CACHE, GENERATION)
            )
            if _flag_off(flag):
                return await fetch()
            key = cache_key(tool, args, generation)
            raw = await self._redis.get(key)
        except Exception:
            log.warning("tool_cache_unavailable %s", tool)
            return await fetch()

        if raw is not None:
            telemetry.tool_cache.add(1, {"tool": tool, "result": "hit"})
            hit = json.loads(raw)
            return hit["for_model"], hit["card"], False

        telemetry.tool_cache.add(1, {"tool": tool, "result": "miss"})
        for_model, card, is_error = await fetch()
        if not is_error and _has_content(for_model):
            try:
                await self._redis.set(
                    key, json.dumps({"for_model": for_model, "card": card}), ex=ttl_s
                )
            except Exception:
                log.warning("tool_cache_write_failed %s", tool)
        return for_model, card, is_error


def _has_content(for_model: dict[str, Any]) -> bool:
    """False for empty searches ("items": [], "results": []), so new stock shows up at once."""
    for name in ("items", "results", "categories"):
        if name in for_model and not for_model[name]:
            return False
    return True
