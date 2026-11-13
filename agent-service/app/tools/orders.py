"""Orders and returns. create_return is confirm-first."""

from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_client import seg
from app.tools.registry import Tool, ToolContext, ToolOutput, card

SUMMARY_FIELDS = ("orderNumber", "status", "placedAt", "total", "itemCount", "carrier",
                  "trackingNumber", "shippedAt", "deliveredAt", "returnEligible", "returnDeadline")
ITEM_FIELDS = ("orderItemId", "productId", "name", "quantity", "unitPrice")


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


DATE_FIELDS = ("placedAt", "shippedAt", "deliveredAt", "returnDeadline")


def _pick(d: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: d.get(k) for k in keys}


def local_dates(d: dict[str, Any], tz: ZoneInfo) -> dict[str, Any]:
    """The model gets order dates as the store's calendar dates ("2026-12-02"), not UTC
    instants: it would read the UTC date off "2026-12-01T18:00:00Z" while the widget card shows
    the store's (STORE_TZ), and a deadline near midnight came out a day apart."""
    out = dict(d)
    for k in DATE_FIELDS:
        value = out.get(k)
        if isinstance(value, str):
            try:
                out[k] = datetime.fromisoformat(value).astimezone(tz).date().isoformat()
            except ValueError:
                pass  # not a timestamp: pass it on as is
    return out


class NoInput(_Input):
    pass


async def list_orders(_: NoInput, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", "orders", auth=ctx.auth, conversation_id=ctx.conversation_id
    )
    orders = data if isinstance(data, list) else data.get("items", [])
    tz = ctx.settings.tz
    return ToolOutput({"orders": [local_dates(_pick(o, SUMMARY_FIELDS), tz) for o in orders]},
                      card("order_list", orders) if orders else None)


class GetOrder(_Input):
    orderNumber: str = Field(min_length=1, max_length=40, description="e.g. ORD-1001")


async def get_order(args: GetOrder, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", f"orders/{seg(args.orderNumber)}", auth=ctx.auth,
        conversation_id=ctx.conversation_id,
    )
    model = local_dates(
        _pick(data, (*SUMMARY_FIELDS, "subtotal", "discount", "shipping", "couponCode")),
        ctx.settings.tz,
    )
    model["items"] = [_pick(i, ITEM_FIELDS) for i in data.get("items", [])]
    model["returns"] = data.get("returns", [])
    return ToolOutput(model, card("order", data))


class ReturnItem(_Input):
    orderItemId: str = Field(min_length=1, max_length=64)
    quantity: int = Field(ge=1, le=100)


class CreateReturn(_Input):
    orderNumber: str = Field(min_length=1, max_length=40)
    reason: str = Field(min_length=3, max_length=500)
    items: list[ReturnItem] = Field(min_length=1, max_length=50)


async def create_return(args: CreateReturn, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "POST", "returns", auth=ctx.auth, conversation_id=ctx.conversation_id,
        json=args.model_dump(), idempotency_key=ctx.idempotency_key,
    )
    return ToolOutput(_pick(data, ("returnId", "status", "nextSteps")),
                      card("return_created", data))


def _describe_return(args: CreateReturn) -> str:
    count = sum(i.quantity for i in args.items)
    return f"Return {count} item{'s' if count != 1 else ''} from {args.orderNumber} ({args.reason})"


TOOLS = [
    Tool("list_orders", "The shopper's 20 most recent orders with status and totals.",
         NoInput, list_orders, requires_auth=True, read_only=True),
    Tool("get_order",
         "One order with items (including orderItemId), tracking, return eligibility and deadline.",
         GetOrder, get_order, requires_auth=True, read_only=True),
    Tool("create_return",
         "Request a return. Requires shopper confirmation. Call get_order first to get "
         "orderItemIds and check returnEligible. An item named without a count (\"the "
         "T-shirt\") is quantity 1; don't ask how many, the Confirm card shows it.",
         CreateReturn, create_return, requires_auth=True, confirm=True,
         summarize=_describe_return),
]
