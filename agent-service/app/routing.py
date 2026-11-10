"""Model routing (PLAN-19 M5): simple turns on the fast model, the rest on the main model.

Provider prompt caches are per model, so a conversation moves from fast to main at most once
and then stays there (`Session.model_tier`): switching back and forth would re-send the whole
history uncached to the main model each time, which costs more than routing saves.

A turn starts on the main model when code (not a model) sees it needs one: a return, a person,
money (coupons, discounts, disputes), safety or legal topics, a frustrated shopper, or an open
Confirm card. Otherwise it starts on the fast model, which sees the same prompt and tools; if it
calls a tool in `MAIN_ONLY_TOOLS`, stops early or errors, its response is dropped unseen and the
round goes to the main model (app/loop.py). After a tool in `MAIN_AFTER_TOOLS` runs, the main
model writes the reply: order and cart records carry free text (item names, carrier, tracking)
where planted instructions can sit, and on the red team the fast model repeated them to warn the
shopper in about 1 run in 3 (R-INJ-05/06/08), against the rule not to repeat them at all.

Rollout (PLAN-19 M6): with MODEL_ROUTING_ENABLED, each conversation joins a group once, from a
hash of its ID: `routed` if its bucket (0–99) is below ROUTING_PERCENT (Redis
`flag:routing_percent` overrides), else `control` (always the main model). The group is kept in
the session, so moving the percentage never switches an open conversation's model, and metrics
carry it (`agent.routing_group`) so the two groups can be compared. Redis `flag:model_routing 0`
puts every turn on the main model at once ("off"), whatever the group.
"""

import hashlib
import logging
import re
from typing import Literal

from redis.asyncio import Redis

from app.config import Settings
from app.playbooks import INTENTS
from app.sessions import Session

log = logging.getLogger(__name__)

FLAG_ROUTING = "flag:model_routing"
FLAG_PERCENT = "flag:routing_percent"
Tier = Literal["fast", "main"]
Group = Literal["routed", "control", "off"]

# Confirm-first, money, or changes to what the assistant remembers.
MAIN_ONLY_TOOLS = frozenset({
    "apply_coupon", "create_return", "create_support_ticket", "forget_memory",
})

_MONEY = re.compile(
    r"\b(coupons?|promo\w*|discounts?|vouchers?|deals?|sales?|codes?|cheaper deal|price match\w*|"
    r"refund\w*|charged?|chargebacks?|dispute\w*|fraud\w*|scam\w*|staff|vip)\b"
    r"|\d+\s?%|\b[A-Z]{3,}\d{1,3}\b",  # 50%, WELCOME10
    re.IGNORECASE,
)
_SENSITIVE = re.compile(
    r"\b(lawyers?|sue|legal|court|injur\w*|hurt|unsafe|danger\w*|allerg\w*|recall\w*|"
    r"angry|annoy\w*|frustrat\w*|ridiculous|terrible|useless|worst|unacceptable|"
    r"remember|forget|memory)\b",
    re.IGNORECASE,
)
# Their results hold order or cart free text: the main model writes the reply after them.
MAIN_AFTER_TOOLS = frozenset({
    "list_orders", "get_order", "view_cart", "add_to_cart", "update_cart_item",
    "remove_cart_item", "get_product",
})

# Playbook intents that end in a confirm-first tool.
_MAIN_INTENTS = ("returns", "handoff")


def route(message: str | None, session: Session) -> tuple[Tier, str]:
    """(tier, reason) for this turn, decided before any model call."""
    if session.model_tier == "main":
        return "main", "sticky"
    if message is None:
        return "main", "event"  # a Confirm follow-up
    if session.state.pending_action:
        return "main", "pending_confirm"
    for name in _MAIN_INTENTS:
        if INTENTS[name].search(message):
            return "main", f"intent:{name}"
    if _MONEY.search(message):
        return "main", "money"
    if _SENSITIVE.search(message):
        return "main", "sensitive"
    return "fast", "simple"


def bucket(conversation_id: str) -> int:
    """0–99, fixed per conversation."""
    return int(hashlib.sha256(conversation_id.encode()).hexdigest(), 16) % 100


class Router:
    def __init__(self, settings: Settings, redis: Redis | None) -> None:
        self._settings = settings
        self._redis = redis

    async def group(self, session: Session) -> Group:
        """This conversation's group, assigned on first use and then kept in the session."""
        if not self._settings.model_routing_enabled:
            return "off"
        raw_flag: object = None
        raw_percent: object = None
        if self._redis is not None:
            try:
                # decode_responses=True (main.py), so values are str.
                raw_flag, raw_percent = await self._redis.mget(FLAG_ROUTING, FLAG_PERCENT)
            except Exception:
                log.warning("routing flags unreadable from redis; using the env settings")
        if isinstance(raw_flag, str) and raw_flag.strip().lower() in ("0", "false", "off"):
            return "off"
        if session.routing_group in ("routed", "control"):
            return session.routing_group  # type: ignore[return-value]
        percent = self._settings.routing_percent
        if isinstance(raw_percent, str) and raw_percent.strip().isdigit():
            percent = min(int(raw_percent), 100)
        group: Group = "routed" if bucket(session.id) < percent else "control"
        session.routing_group = group
        return group
