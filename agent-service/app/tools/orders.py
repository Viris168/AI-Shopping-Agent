"""Orders and returns. create_return is confirm-first."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_client import seg
from app.tools.registry import Tool, ToolContext, ToolOutput, card

SUMMARY_FIELDS = ("orderNumber", "status", "placedAt", "total", "itemCount", "carrier",
                  "trackingNumber", "shippedAt", "deliveredAt", "returnEligible", "returnDeadline")
ITEM_FIELDS = ("orderItemId", "productId", "name", "quantity", "unitPrice")


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def _pick(d: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    return {k: d.get(k) for k in keys}


class NoInput(_Input):
    pass


async def list_orders(_: NoInput, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", "orders", auth=ctx.auth, conversation_id=ctx.conversation_id
    )
    orders = data if isinstance(data, list) else data.get("items", [])
    return ToolOutput({"orders": [_pick(o, SUMMARY_FIELDS) for o in orders]},
                      card("order_list", orders) if orders else None)


class GetOrder(_Input):
    orderNumber: str = Field(min_length=1, max_length=40, description="e.g. ORD-1001")


async def get_order(args: GetOrder, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", f"orders/{seg(args.orderNumber)}", auth=ctx.auth,
        conversation_id=ctx.conversation_id,
    )
    model = _pick(data, (*SUMMARY_FIELDS, "subtotal", "discount", "shipping", "couponCode"))
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
         NoInput, list_orders, requires_auth=True),
    Tool("get_order",
         "One order with items (including orderItemId), tracking, return eligibility and deadline.",
         GetOrder, get_order, requires_auth=True),
    Tool("create_return",
         "Request a return. Requires shopper confirmation. Call get_order first to get "
         "orderItemIds and check returnEligible.",
         CreateReturn, create_return, requires_auth=True, confirm=True,
         summarize=_describe_return),
]
