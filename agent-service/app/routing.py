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

Off unless MODEL_ROUTING_ENABLED; Redis `flag:model_routing 0` turns it off at runtime.
"""

import logging
import re
from typing import Literal

from redis.asyncio import Redis

from app.config import Settings
from app.playbooks import INTENTS
from app.sessions import Session

log = logging.getLogger(__name__)

FLAG_ROUTING = "flag:model_routing"
Tier = Literal["fast", "main"]

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
    "remove_cart_item",
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


class Router:
    def __init__(self, settings: Settings, redis: Redis | None) -> None:
        self._settings = settings
        self._redis = redis

    async def enabled(self) -> bool:
        """MODEL_ROUTING_ENABLED, unless Redis `flag:model_routing 0` turns it off everywhere."""
        if not self._settings.model_routing_enabled:
            return False
        if self._redis is None:
            return True
        try:
            raw = await self._redis.get(FLAG_ROUTING)
        except Exception:
            log.warning("routing flag unreadable from redis; using MODEL_ROUTING_ENABLED")
            return True
        return not (isinstance(raw, str) and raw.strip().lower() in ("0", "false", "off"))
