"""Store policies and FAQ."""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.tools.registry import Tool, ToolContext, ToolOutput

FAQ_CACHE_S = 600


class SearchFaq(BaseModel):
    model_config = ConfigDict(extra="forbid")
    q: str = Field(
        min_length=1, max_length=300,
        description="The question in English, even when the shopper writes in another language",
    )
    topic: Literal["shipping", "returns", "payment", "orders", "account", "warranty"] | None = None


async def _search(params: dict[str, str], ctx: ToolContext) -> dict[str, Any]:
    data: dict[str, Any] = await ctx.client.request(
        "GET", "faq/search", auth=ctx.auth, conversation_id=ctx.conversation_id, params=params,
    )
    return data


async def search_faq(args: SearchFaq, ctx: ToolContext) -> ToolOutput:
    data = await _search(args.model_dump(exclude_none=True), ctx)
    if args.topic and not data.get("results"):
        # The model's topic guess can hide the answer ("gift cards" is filed under orders).
        data = await _search({"q": args.q}, ctx)
    results = [
        {"topic": r.get("topic"), "question": r.get("question"), "answer": r.get("answer")}
        for r in data.get("results", [])
    ]
    return ToolOutput({"results": results})


TOOLS = [
    Tool(
        "search_faq",
        "Search store policies and FAQ. Call before answering any policy question. "
        "The FAQ is in English: search in English.",
        SearchFaq, search_faq, cache_ttl_s=FAQ_CACHE_S, read_only=True),
]
