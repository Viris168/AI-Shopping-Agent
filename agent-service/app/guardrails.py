"""Input limits, rate limits, token budgets and output checks (AGENT.md §6)."""

import json
import logging
import re
from typing import Any

from fastapi import HTTPException
from redis.asyncio import Redis

from app.config import Settings

log = logging.getLogger(__name__)

_TAG = re.compile(r"<[^>]*>")
# Tags only the service writes: button presses, tool output, the per-call context and what it
# holds (rolling summary, session state, long-term memory).
_CONTROL_TAG = re.compile(
    r"<(\s*/?\s*)(event|tool_result|context|conversation_summary|session_state|memory)\b",
    re.IGNORECASE,
)
_MONEY_OR_PERCENT = re.compile(r"[$€£]\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s?%")


def check_message(text: str, settings: Settings) -> str:
    text = text.strip()
    if not text:
        raise HTTPException(422, "Please type a message.")
    if len(text) > settings.max_message_chars:
        raise HTTPException(
            413, f"Messages can be up to {settings.max_message_chars} characters."
        )
    return text


class RateLimiter:
    """Fixed one-minute window per user, or per IP for guests (a lower limit: PLAN-19 M7)."""

    def __init__(self, redis: Redis, limit_per_min: int, guest_limit_per_min: int | None = None
                 ) -> None:
        self._redis = redis
        self._limit = limit_per_min
        self._guest_limit = limit_per_min if guest_limit_per_min is None else guest_limit_per_min

    async def hit(self, user_id: str | None, ip: str | None) -> None:
        key = f"rl:user:{user_id}" if user_id else f"rl:ip:{ip or 'unknown'}"
        count = await self._redis.incr(key)
        if count == 1:
            await self._redis.expire(key, 60)
        if count > (self._limit if user_id else self._guest_limit):
            raise HTTPException(429, "You're sending messages too quickly. Please wait a moment.")


class TokenBudget:
    def __init__(self, redis: Redis, budget: int, ttl_s: int) -> None:
        self._redis = redis
        self._budget = budget
        self._ttl = ttl_s

    async def exhausted(self, conversation_id: str) -> bool:
        used = await self._redis.get(f"budget:{conversation_id}")
        return int(used or 0) >= self._budget

    async def add(self, conversation_id: str, tokens: int) -> None:
        key = f"budget:{conversation_id}"
        await self._redis.incrby(key, tokens)
        await self._redis.expire(key, self._ttl)


def strip_html(value: Any) -> Any:
    if isinstance(value, str):
        return _TAG.sub("", value)
    if isinstance(value, dict):
        return {k: strip_html(v) for k, v in value.items()}
    if isinstance(value, list):
        return [strip_html(v) for v in value]
    return value


def wrap_tool_result(data: Any) -> str:
    """Tool output is data. Tags are stripped first, so nothing inside can close the wrapper."""
    body = json.dumps(strip_html(data), ensure_ascii=False, separators=(",", ":"))
    return f"<tool_result>\n{body}\n</tool_result>"


def defang_control_tags(text: str) -> str:
    """Shopper text can't open or close service tags: a typed <event> is not a button press."""
    return _CONTROL_TAG.sub(r"&lt;\1\2", text)


def suspect_facts(reply: str, tool_texts: list[str]) -> list[str]:
    """Prices or percentages in the reply that no tool returned this turn."""
    seen = " ".join(tool_texts).replace(" ", "")
    suspects = [m for m in _MONEY_OR_PERCENT.findall(reply) if m.replace(" ", "") not in seen]
    if suspects:
        log.warning("suspect_fact: %s", suspects)
    return suspects
