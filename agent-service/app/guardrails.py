"""Input limits, rate limits, token budgets and output checks (AGENT.md §6)."""

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any, Literal

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
# A day's counter outlives its day a little, so it's never dropped while still being added to.
DAILY_TTL_S = 25 * 3600
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
    """Fixed one-minute window per user, or per IP for guests."""

    def __init__(self, redis: Redis, limit_per_min: int) -> None:
        self._redis = redis
        self._limit = limit_per_min

    async def hit(self, user_id: str | None, ip: str | None) -> None:
        key = f"rl:user:{user_id}" if user_id else f"rl:ip:{ip or 'unknown'}"
        count = await self._redis.incr(key)
        if count == 1:
            await self._redis.expire(key, 60)
        if count > self._limit:
            raise HTTPException(429, "You're sending messages too quickly. Please wait a moment.")


def budget_subject(auth_user_id: str | None, ip: str | None) -> str:
    """Who a daily budget is charged to: the shopper, or the IP for guests (like RateLimiter)."""
    return f"user:{auth_user_id}" if auth_user_id else f"ip:{ip or 'unknown'}"


BudgetHit = Literal["conversation", "daily"]


class TokenBudget:
    """Tokens per conversation, and per subject (budget_subject) per UTC day across all their
    conversations: starting a new conversation doesn't reset the daily one. 0 = no daily cap."""

    def __init__(self, redis: Redis, budget: int, ttl_s: int, daily_budget: int = 0) -> None:
        self._redis = redis
        self._budget = budget
        self._ttl = ttl_s
        self._daily = daily_budget

    @staticmethod
    def _daily_key(subject: str) -> str:
        return f"budget:day:{datetime.now(UTC).date().isoformat()}:{subject}"

    async def exhausted(self, conversation_id: str, subject: str | None = None) -> BudgetHit | None:
        """Which budget is used up, or None."""
        keys = [f"budget:{conversation_id}"]
        if subject is not None and self._daily > 0:
            keys.append(self._daily_key(subject))
        used = await self._redis.mget(keys)
        if int(used[0] or 0) >= self._budget:
            return "conversation"
        if len(used) > 1 and int(used[1] or 0) >= self._daily:
            return "daily"
        return None

    async def add(self, conversation_id: str, tokens: int, subject: str | None = None) -> None:
        async with self._redis.pipeline(transaction=True) as pipe:
            key = f"budget:{conversation_id}"
            pipe.incrby(key, tokens)
            pipe.expire(key, self._ttl)
            if subject is not None and self._daily > 0:
                day = self._daily_key(subject)
                pipe.incrby(day, tokens)
                pipe.expire(day, DAILY_TTL_S)
            await pipe.execute()


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
