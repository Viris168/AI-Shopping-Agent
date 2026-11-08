"""Store policies and FAQ."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.tools.registry import Tool, ToolContext, ToolOutput


class SearchFaq(BaseModel):
    model_config = ConfigDict(extra="forbid")
    q: str = Field(min_length=1, max_length=300)
    topic: Literal["shipping", "returns", "payment", "orders", "account", "warranty"] | None = None


async def search_faq(args: SearchFaq, ctx: ToolContext) -> ToolOutput:
    data = await ctx.client.request(
        "GET", "faq/search", auth=ctx.auth, conversation_id=ctx.conversation_id,
        params=args.model_dump(exclude_none=True),
    )
    results = [
        {"topic": r.get("topic"), "question": r.get("question"), "answer": r.get("answer")}
        for r in data.get("results", [])
    ]
    return ToolOutput({"results": results})


TOOLS = [
    Tool(
        "search_faq",
        "Search store policies and FAQ. Call before answering any policy question.",
        SearchFaq, search_faq,
    ),
]
