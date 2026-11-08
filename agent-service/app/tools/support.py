"""Human handoff tickets. Confirm-first; guests allowed."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.tools.registry import Tool, ToolContext, ToolOutput, card


class CreateTicket(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subject: str = Field(min_length=1, max_length=200)
    summary: str = Field(min_length=1, max_length=4000)
    priority: Literal["low", "normal", "high", "urgent"] | None = None
    contactEmail: EmailStr | None = Field(
        None, description="Only for guests, only if the shopper gave it"
    )


async def create_support_ticket(args: CreateTicket, ctx: ToolContext) -> ToolOutput:
    # conversationId is set by the service (X-Conversation-Id), never by the model.
    data = await ctx.client.request(
        "POST", "support/tickets", auth=ctx.auth, conversation_id=ctx.conversation_id,
        json=args.model_dump(exclude_none=True), idempotency_key=ctx.idempotency_key,
    )
    return ToolOutput(
        {k: data.get(k) for k in ("ticketId", "status", "expectedResponse")},
        card("ticket_created", data),
    )


TOOLS = [
    Tool("create_support_ticket",
         "Hand off to a human. Requires shopper confirmation. Write a clear subject and "
         "summary of the issue and what was tried.",
         CreateTicket, create_support_ticket, confirm=True,
         summarize=lambda a: f"Contact support: {a.subject}"),
]
