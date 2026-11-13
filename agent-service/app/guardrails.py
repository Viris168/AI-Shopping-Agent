"""Input limits, rate limits, token budgets and output checks (AGENT.md §6)."""

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import HTTPException
from redis.asyncio import Redis

from app import telemetry
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
        # One MULTI: the key is created with its TTL before it's counted, so a crash between
        # commands can't leave a counter that never expires (and blocks that user for good).
        async with self._redis.pipeline(transaction=True) as pipe:
            pipe.set(key, 0, ex=60, nx=True)
            pipe.incr(key)
            _, count = await pipe.execute()
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


def suspect_facts(reply: str, tool_texts: list[str], shopper_text: str = "") -> list[str]:
    """Prices or percentages in the reply that no tool returned this turn (rule 5). Ones the
    shopper wrote themselves ("is there 50% off?") don't count. Logged and counted for the
    AgentSuspectFacts alert. The reply has already streamed by then, so this measures; it
    doesn't block."""
    seen = " ".join([*tool_texts, shopper_text]).replace(" ", "")
    suspects = [m for m in _MONEY_OR_PERCENT.findall(reply) if m.replace(" ", "") not in seen]
    if suspects:
        log.warning("suspect_fact: %s", suspects)
        telemetry.suspect_replies.add(1)
    return suspects


# Coupon-shaped: 3+ letters then digits, one word (STAFF100, save20). Not sizes (US10, M),
# order numbers (ORD-1001) or product IDs (OUT-005). Model numbers like IPX7 that a tool
# returned are allowed (SessionState.note_codes).
_CODE = re.compile(r"\b[A-Za-z]{3,15}\d{1,4}\b")
_TLDS = (
    "com|net|org|info|biz|io|co|app|dev|shop|store|online|site|link|xyz|top|club|click|me|ly|"
    "us|uk|eu|de|fr|ru|cn|in|au|ca|example|test|local"
)
_LINK = re.compile(
    r"\bhttps?://[^\s<>\"'`)\]]+"
    r"|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:" + _TLDS + r")\b(?::\d{2,5})?"
    r"(?:/[^\s<>\"'`)\]]*)?",
    re.IGNORECASE,
)
# Characters a link or code can be made of: the end of streamed text that's still one of those
# may be cut mid-word, so it waits for the next delta. Other text (spaces, CJK) streams at once.
_TAIL = re.compile(r"[A-Za-z0-9:/._~%?#=&+@-]*\Z")
CODE_REMOVED = "[code removed]"
LINK_REMOVED = "[link removed]"


def code_tokens(text: str) -> set[str]:
    """Coupon-like words in `text`, upper-cased."""
    return {m.upper() for m in _CODE.findall(text)}


class OutputGuard:
    """Removes coupon-like codes and links the store didn't vouch for from the model's reply,
    as it streams (CLAUDE.md rules 5 and 6). Planted text in product, FAQ, order or memory data
    can talk the model into repeating a code or a phishing link; this doesn't depend on the
    model saying no every time.

    `codes`: codes the store confirmed this conversation (SessionState.known_codes; shared,
    so codes a tool confirms mid-turn count from the next round). `hosts`: link hosts, each
    also allowing its subdomains."""

    def __init__(self, hosts: list[str], codes: list[str]) -> None:
        self._hosts = tuple(h.lower() for h in hosts)
        self._codes = codes
        self._held = ""
        self.removed: list[str] = []

    def _host_ok(self, link: str) -> bool:
        url = link if "://" in link else f"http://{link}"
        try:
            host = (urlsplit(url).hostname or "").lower()
        except ValueError:
            return False
        return any(host == h or host.endswith("." + h) for h in self._hosts)

    def redact(self, text: str, count: bool = True) -> str:
        """`count=False` re-applies it (to the stored message) without counting again."""
        def link(m: re.Match[str]) -> str:
            if self._host_ok(m.group()):
                return m.group()
            if count:
                self._note("link")
            return LINK_REMOVED

        def code(m: re.Match[str]) -> str:
            if m.group().upper() in self._codes:
                return m.group()
            if count:
                self._note("code")
            return CODE_REMOVED

        # Links first, so a code inside a removed link isn't counted twice.
        parts = _LINK.split(text)
        links = [link(m) for m in _LINK.finditer(text)]
        out = []
        for i, part in enumerate(parts):
            out.append(_CODE.sub(code, part))
            if i < len(links):
                out.append(links[i])
        return "".join(out)

    def _note(self, kind: str) -> None:
        self.removed.append(kind)
        telemetry.output_redactions.add(1, {"kind": kind})

    def feed(self, text: str) -> str:
        """The part of the stream so far that is safe to send; the rest waits for more."""
        buf = self._held + text
        cut = _TAIL.search(buf)
        start = cut.start() if cut else len(buf)
        self._held = buf[start:]
        return self.redact(buf[:start])

    def flush(self) -> str:
        """What's still held, at the end of a model call."""
        held, self._held = self._held, ""
        return self.redact(held)
