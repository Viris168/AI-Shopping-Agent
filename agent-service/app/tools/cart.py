"""Cart, coupon and the checkout link. The agent never calls POST /checkout."""

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_client import seg
from app.tools.registry import Tool, ToolContext, ToolOutput, card

ITEM_FIELDS = ("productId", "name", "quantity", "unitPrice", "lineTotal", "inStock")
CART_FIELDS = ("itemCount", "couponCode", "subtotal", "discount", "shipping", "total",
               "freeShippingRemaining")


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def cart_output(data: dict[str, Any]) -> ToolOutput:
    """Formatted money only; the model never sees or computes cents."""
    model = {k: data.get(k) for k in CART_FIELDS}
    model["items"] = [{k: i.get(k) for k in ITEM_FIELDS} for i in data.get("items", [])]
    return ToolOutput(model, card("cart", data))


class NoInput(_Input):
    pass


async def view_cart(_: NoInput, ctx: ToolContext) -> ToolOutput:
    return cart_output(await ctx.client.request(
        "GET", "cart", auth=ctx.auth, conversation_id=ctx.conversation_id
    ))


class AddToCart(_Input):
    productId: str = Field(min_length=1, max_length=64)
    quantity: int = Field(1, ge=1, le=20)


async def add_to_cart(args: AddToCart, ctx: ToolContext) -> ToolOutput:
    return cart_output(await ctx.client.request(
        "POST", "cart/items", auth=ctx.auth, conversation_id=ctx.conversation_id,
        json=args.model_dump(),
    ))


class UpdateCartItem(_Input):
    productId: str = Field(min_length=1, max_length=64)
    quantity: int = Field(ge=0, le=20)


async def update_cart_item(args: UpdateCartItem, ctx: ToolContext) -> ToolOutput:
    if args.quantity == 0:
        return await remove_cart_item(RemoveCartItem(productId=args.productId), ctx)
    return cart_output(await ctx.client.request(
        "PATCH", f"cart/items/{seg(args.productId)}", auth=ctx.auth,
        conversation_id=ctx.conversation_id, json={"quantity": args.quantity},
    ))


class RemoveCartItem(_Input):
    productId: str = Field(min_length=1, max_length=64)


async def remove_cart_item(args: RemoveCartItem, ctx: ToolContext) -> ToolOutput:
    return cart_output(await ctx.client.request(
        "DELETE", f"cart/items/{seg(args.productId)}", auth=ctx.auth,
        conversation_id=ctx.conversation_id,
    ))


class ApplyCoupon(_Input):
    code: str = Field(min_length=1, max_length=40)


async def apply_coupon(args: ApplyCoupon, ctx: ToolContext) -> ToolOutput:
    return cart_output(await ctx.client.request(
        "POST", "cart/coupon", auth=ctx.auth, conversation_id=ctx.conversation_id,
        json={"code": args.code},
    ))


async def checkout_link(_: NoInput, ctx: ToolContext) -> ToolOutput:
    # Payment happens only on the storefront; checkout starts from the cart page.
    url = f"{ctx.settings.storefront_url.rstrip('/')}/cart"
    return ToolOutput({"url": url, "note": "The shopper reviews and pays on this page."},
                      card("checkout_link", {"url": url}))


TOOLS = [
    Tool("view_cart", "The shopper's current cart with items, coupon and totals.",
         NoInput, view_cart, requires_auth=True),
    Tool("add_to_cart",
         "Add a product to the cart. Use the product id from a search or product result.",
         AddToCart, add_to_cart, requires_auth=True),
    Tool("update_cart_item", "Set the quantity of a cart item. 0 removes it.",
         UpdateCartItem, update_cart_item, requires_auth=True),
    Tool("remove_cart_item", "Remove a product from the cart.",
         RemoveCartItem, remove_cart_item, requires_auth=True),
    Tool("apply_coupon", "Apply a coupon code the shopper provided. Never invent codes.",
         ApplyCoupon, apply_coupon, requires_auth=True),
    Tool("checkout_link",
         "Get the link to the storefront checkout page so the shopper can review and pay.",
         NoInput, checkout_link, requires_auth=True),
]
