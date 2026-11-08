"""Products, categories and recommendations."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_client import seg
from app.tools.registry import Tool, ToolContext, ToolOutput, card

PRODUCT_FIELDS = ("id", "slug", "name", "brand", "category", "price", "inStock", "stock", "rating")


class _Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


def trim_product(p: dict[str, Any]) -> dict[str, Any]:
    out = {k: p[k] for k in PRODUCT_FIELDS if k in p}
    text = p.get("summary") or p.get("description")
    if isinstance(text, str):
        out["description"] = text[:300]
    return out


class SearchProducts(_Input):
    q: str | None = Field(None, max_length=200, description="Keywords, e.g. 'waterproof running shoes'")
    category: str | None = Field(None, max_length=60, description="Category slug from list_categories")
    brand: str | None = Field(None, max_length=60)
    minPriceCents: int | None = Field(None, ge=0)
    maxPriceCents: int | None = Field(None, ge=0)
    inStock: bool | None = None
    sort: Literal["relevance", "price_asc", "price_desc", "rating", "newest"] | None = None
    limit: int = Field(6, ge=1, le=10)


async def search_products(args: SearchProducts, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", "products", auth=ctx.auth, conversation_id=ctx.conversation_id,
        params=args.model_dump(exclude_none=True),
    )
    items = data.get("items", [])
    return ToolOutput(
        {"total": data.get("total", len(items)), "items": [trim_product(p) for p in items]},
        card("product_list", data) if items else None,
    )


class ProductRef(_Input):
    idOrSlug: str = Field(min_length=1, max_length=120)


async def get_product(args: ProductRef, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", f"products/{seg(args.idOrSlug)}", auth=ctx.auth, conversation_id=ctx.conversation_id
    )
    model = trim_product(data)
    if isinstance(data.get("attributes"), dict):
        model["attributes"] = data["attributes"]
    return ToolOutput(model, card("product", data))


async def get_recommendations(args: ProductRef, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", f"products/{seg(args.idOrSlug)}/recommendations",
        auth=ctx.auth, conversation_id=ctx.conversation_id,
    )
    items = data.get("items", [])
    return ToolOutput(
        {"basedOn": data.get("basedOn"), "items": [trim_product(p) for p in items]},
        card("product_list", data) if items else None,
    )


class NoInput(_Input):
    pass


async def list_categories(_: NoInput, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", "categories", auth=ctx.auth, conversation_id=ctx.conversation_id
    )
    return ToolOutput({"categories": data})


TOOLS = [
    Tool(
        "search_products",
        "Search the catalog. Use for any product discovery request. Prices are in cents in filters.",
        SearchProducts, search_products,
    ),
    Tool(
        "get_product",
        "Full details for one product: description, attributes, stock, rating.",
        ProductRef, get_product,
    ),
    Tool(
        "get_recommendations",
        "Similar or complementary products for a given product.",
        ProductRef, get_recommendations,
    ),
    Tool("list_categories", "All product categories with slugs.", NoInput, list_categories),
]
