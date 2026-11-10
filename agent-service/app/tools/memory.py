"""Long-term memory the shopper controls from chat (PLAN-18). Registered only when
MEMORY_ENABLED; saving happens in app/memory.py, never through a model tool call."""

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_client import seg
from app.tools.registry import Tool, ToolContext, ToolOutput


class ForgetMemory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    factId: str = Field(
        min_length=36, max_length=36, description="The id of a fact listed in <memory>"
    )


async def forget_memory(args: ForgetMemory, ctx: ToolContext) -> ToolOutput:
    await ctx.client.request(
        "DELETE", f"memory/facts/{seg(args.factId)}", auth=ctx.auth,
        conversation_id=ctx.conversation_id,
    )
    return ToolOutput({"forgotten": args.factId})


TOOLS = [
    Tool(
        "forget_memory",
        "Forget one saved preference (an id from <memory>) when the shopper asks you to. "
        "To forget everything or switch memory off, point them to their account page.",
        ForgetMemory, forget_memory, requires_auth=True,
    ),
]
