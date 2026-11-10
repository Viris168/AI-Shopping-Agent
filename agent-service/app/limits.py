"""Spend limits against abuse (PLAN-19 M7).

The per-conversation token budget (guardrails.TokenBudget) stops one runaway chat, but a bot can
start a new conversation every time. These limits are per shopper and for the whole store, in
money, and checked before each turn:

- **Store per day** (`DAILY_SPEND_CAP_USD`): from 80%, guests are paused ("sign in to keep
  chatting"); at 100% the assistant is off for everyone until UTC midnight.
- **Per shopper per day:** signed-in user, or IP for guests (`DAILY_SPEND_USER_USD`,
  `DAILY_SPEND_GUEST_USD`).
- **Per conversation** (`CONVERSATION_SPEND_USD`).
- **New conversations per hour** per shopper (`NEW_CONVERSATIONS_PER_HOUR_*`), so opening fresh
  chats doesn't reset anything.

Spend is the estimate from `MODEL_PRICES`, kept in Redis as integer micro-dollars (rule 7) under
`spend:<UTC day>:...`; without prices, only the token budget and message rate apply. If Redis is
unreadable, turns go ahead (the provider balance is the backstop) and a warning is logged.
"""

import logging
import time
from dataclasses import dataclass
from typing import Literal

from redis.asyncio import Redis

from app import telemetry
from app.auth import Auth
from app.config import Settings

log = logging.getLogger(__name__)

DAY_S = 86_400
GUEST_PAUSE_SHARE = 0.8  # of the store's daily cap
Limit = Literal["store_daily", "guests_paused", "shopper_daily", "conversation", "new_chats"]

# What the shopper is told. The widget shows its own (translated) text by `X-Limit`; these are for
# other clients and logs.
MESSAGES: dict[Limit, str] = {
    "store_daily": "The assistant is unavailable right now.",
    "guests_paused": "The assistant is busy right now. Please sign in to keep chatting.",
    "shopper_daily": "You've reached today's limit for the assistant. Please try again tomorrow, "
                     "or contact us.",
    "conversation": "This conversation has reached its limit. Please start a new chat tomorrow, "
                    "or contact us.",
    "new_chats": "You've started a lot of chats in the last hour. Please continue in your "
                 "current chat, or try again later.",
}
STATUS: dict[Limit, int] = {
    "store_daily": 503, "guests_paused": 429, "shopper_daily": 429, "conversation": 429,
    "new_chats": 429,
}


@dataclass
class LimitHit:
    limit: Limit

    @property
    def status(self) -> int:
        return STATUS[self.limit]

    @property
    def message(self) -> str:
        return MESSAGES[self.limit]


def _micro(usd: float) -> int:
    return round(usd * 1_000_000)


def _day(now: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(now))


def shopper_key(auth: Auth, ip: str | None) -> str:
    return f"user:{auth.user_id}" if auth.user_id else f"ip:{ip or 'unknown'}"


class SpendLimits:
    def __init__(self, settings: Settings, redis: Redis) -> None:
        self._s = settings
        self._redis = redis

    def _keys(self, conversation_id: str, shopper: str, now: float) -> tuple[str, str, str]:
        day = _day(now)
        return (f"spend:{day}:store", f"spend:{day}:{shopper}", f"spend:conv:{conversation_id}")

    async def store_closed(self, now: float | None = None) -> bool:
        """The store's daily cap is used up (the widget hides itself; /v1/config)."""
        if not self._s.daily_spend_cap_usd:
            return False
        try:
            raw = await self._redis.get(f"spend:{_day(now or time.time())}:store")
        except Exception:
            log.warning("spend unreadable from redis; not enforcing the daily cap")
            return False
        return int(raw or 0) >= _micro(self._s.daily_spend_cap_usd)

    async def check_turn(
        self, conversation_id: str, auth: Auth, ip: str | None, now: float | None = None
    ) -> LimitHit | None:
        """The first limit this turn would break, or None. Called before the model runs."""
        now = now or time.time()
        store_key, shopper_key_, conv_key = self._keys(conversation_id, shopper_key(auth, ip), now)
        try:
            raw = await self._redis.mget(store_key, shopper_key_, conv_key)
        except Exception:
            log.warning("spend unreadable from redis; not enforcing spend limits")
            return None
        store, shopper, conv = (int(v or 0) for v in raw)
        cap = _micro(self._s.daily_spend_cap_usd)
        daily = _micro(self._s.daily_spend_guest_usd if auth.is_guest
                       else self._s.daily_spend_user_usd)
        hit: Limit | None = None
        if cap and store >= cap:
            hit = "store_daily"
        elif cap and auth.is_guest and store >= cap * GUEST_PAUSE_SHARE:
            hit = "guests_paused"
        elif daily and shopper >= daily:
            hit = "shopper_daily"
        elif self._s.conversation_spend_usd and conv >= _micro(self._s.conversation_spend_usd):
            hit = "conversation"
        if hit:
            self._count(hit, auth)
            return LimitHit(hit)
        return None

    async def new_conversation(
        self, auth: Auth, ip: str | None, now: float | None = None
    ) -> LimitHit | None:
        """Count a new conversation; a LimitHit when the shopper started too many this hour."""
        limit = (self._s.new_conversations_per_hour_guest if auth.is_guest
                 else self._s.new_conversations_per_hour_user)
        if not limit:
            return None
        hour = int((now or time.time()) // 3600)
        key = f"newconv:{hour}:{shopper_key(auth, ip)}"
        try:
            count = await self._redis.incr(key)
            if count == 1:
                await self._redis.expire(key, 3600)
        except Exception:
            log.warning("conversation count unreadable from redis; not enforcing it")
            return None
        if count > limit:
            self._count("new_chats", auth)
            return LimitHit("new_chats")
        return None

    async def add(
        self, conversation_id: str, auth: Auth, ip: str | None, usd: float,
        now: float | None = None,
    ) -> None:
        """Add a turn's estimated cost to the store, shopper and conversation totals."""
        micro = _micro(usd)
        if micro <= 0:
            return
        now = now or time.time()
        store_key, shopper_key_, conv_key = self._keys(conversation_id, shopper_key(auth, ip), now)
        try:
            async with self._redis.pipeline(transaction=False) as pipe:
                for key in (store_key, shopper_key_):
                    pipe.incrby(key, micro)
                    pipe.expire(key, 2 * DAY_S)
                pipe.incrby(conv_key, micro)
                pipe.expire(conv_key, self._s.session_ttl_s)
                results = await pipe.execute()
        except Exception:
            log.warning("spend not recorded in redis for %s", conversation_id)
            return
        store_total = int(results[0])
        cap = _micro(self._s.daily_spend_cap_usd)
        if cap:
            for share, name in ((GUEST_PAUSE_SHARE, "store_daily_80"), (1.0, "store_daily_100")):
                if store_total - micro < cap * share <= store_total:
                    log.warning("daily spend crossed %d%% of the cap", int(share * 100))
                    telemetry.limit_hits.add(1, {"limit": name, "kind": "store"})

    @staticmethod
    def _count(limit: Limit, auth: Auth) -> None:
        telemetry.limit_hits.add(1, {"limit": limit, "kind": "guest" if auth.is_guest else "user"})
