"""Tool definition, validation, guest filtering and schema export.

One tool = Pydantic input model + `requires_auth` + `confirm` + handler (which also
builds the widget card from the full API response).
"""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from pydantic import BaseModel, ValidationError

from app.auth import Auth
from app.commerce_client import ApiError, CommerceClient
from app.config import Settings

LOGIN_REQUIRED: dict[str, Any] = {"error": "login_required"}


@dataclass
class ToolContext:
    auth: Auth
    conversation_id: str
    client: CommerceClient
    settings: Settings
    idempotency_key: str | None = None


@dataclass
class ToolOutput:
    for_model: dict[str, Any]
    card: dict[str, Any] | None = None
    is_error: bool = False


Handler = Callable[[Any, ToolContext], Awaitable[ToolOutput]]


def card(kind: str, data: Any) -> dict[str, Any]:
    return {"type": kind, "data": data}


def error_output(status: int, message: str) -> ToolOutput:
    return ToolOutput({"error": {"status": status, "message": message}}, is_error=True)


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    input_model: type[BaseModel]
    handler: Handler
    requires_auth: bool = False
    # True → the model's call only creates a pending action; it runs from
    # /v1/actions/{id}/confirm after the shopper presses Confirm.
    confirm: bool = False
    summarize: Callable[[Any], str] | None = field(default=None, compare=False)

    def schema(self) -> dict[str, Any]:
        input_schema = self.input_model.model_json_schema()
        input_schema.pop("title", None)
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": input_schema,
            # Inputs stream as generated; we validate them ourselves in prepare().
            "eager_input_streaming": True,
        }

    def prepare(self, raw: Any, auth: Auth) -> BaseModel | ToolOutput:
        """Validate model input. Returns the parsed args, or a result to send back instead."""
        if self.requires_auth and auth.is_guest:
            return ToolOutput(LOGIN_REQUIRED, is_error=True)
        try:
            return self.input_model.model_validate(raw)
        except ValidationError as exc:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in e['loc']) or 'input'}: {e['msg']}"
                for e in exc.errors()[:5]
            )
            return error_output(422, f"Invalid arguments: {problems}")

    async def run(self, raw: Any, ctx: ToolContext) -> ToolOutput:
        prepared = self.prepare(raw, ctx.auth)
        if isinstance(prepared, ToolOutput):
            return prepared
        try:
            return await self.handler(prepared, ctx)
        except ApiError as exc:
            if exc.status == 401:
                return ToolOutput(LOGIN_REQUIRED, is_error=True)
            return error_output(exc.status, exc.message)

    def describe(self, args: BaseModel) -> str:
        return self.summarize(args) if self.summarize else self.name.replace("_", " ")


class Registry:
    def __init__(self, tools: list[Tool]) -> None:
        names = [t.name for t in tools]
        if len(names) != len(set(names)):
            raise ValueError("duplicate tool name")
        self._tools = {t.name: t for t in tools}

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def for_auth(self, auth: Auth) -> list[Tool]:
        """Guests only see tools that don't need login. Order is fixed so the prompt cache holds."""
        return [t for t in self._tools.values() if not (t.requires_auth and auth.is_guest)]

    def schemas(self, auth: Auth) -> list[dict[str, Any]]:
        return [t.schema() for t in self.for_auth(auth)]


def build_registry() -> Registry:
    from app.tools import cart, catalog, faq, orders, support

    return Registry([*catalog.TOOLS, *faq.TOOLS, *cart.TOOLS, *orders.TOOLS, *support.TOOLS])
